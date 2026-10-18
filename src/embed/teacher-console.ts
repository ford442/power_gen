/**
 * Teacher console (#224 §5) — `?teacher=1` or `window.lab.openTeacherConsole()`.
 * Lazy chunk. Broadcasts `lab:loadConfig` / `lab:runExperiment` / `lab:ping`
 * on `BroadcastChannel('seg-lab')` to every student tab of this lab on the
 * same origin, and keeps a roster from their ping replies.
 *
 * Same-origin only: a BroadcastChannel never leaves this origin, so a class on
 * different machines each opens the lab locally and nothing here reaches them.
 * Simulated, not metrology.
 */
import { createTeacherClient, type CollectedRun, type TeacherClient } from './classroom-channel';
import { classroomTabId } from './classroom';
import { LAB_CHANNEL_NAME, LAB_DISCLAIMER } from './embed-protocol';

const PANEL_ID = 'lab-teacher-console';
const PING_MS = 4000;
/**
 * A student silent this long drops off the roster. Generous: a tab busy
 * rendering (software GL, a background throttle) can answer a ping late.
 */
const STALE_MS = 30_000;
const EXPERIMENT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

interface Open {
  panel: HTMLElement;
  client: TeacherClient;
  channel: BroadcastChannel;
  timer: number;
}

let open: Open | null = null;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  style = ''
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  if (style) node.setAttribute('style', style);
  return node;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', { type: 'button', className: 'ctrl-btn', textContent: text });
  b.addEventListener('click', onClick);
  return b;
}

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 2 ? 'now' : `${s}s ago`;
}

function downloadJson(name: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = el('a', { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function runsForAnalysis(runs: CollectedRun[]): unknown[] {
  return runs.map(({ student, run }) => {
    const r = run as { id?: string; title?: string };
    return { ...r, id: `${r.id ?? 'run'}-${student}`, title: `${r.title ?? 'Run'} — tab ${student}` };
  });
}

export function closeTeacherConsole(): void {
  if (!open) return;
  window.clearInterval(open.timer);
  open.client.dispose();
  open.channel.close();
  open.panel.remove();
  open = null;
}

export function openTeacherConsole(): HTMLElement | null {
  if (open) {
    open.panel.scrollIntoView?.();
    return open.panel;
  }
  if (typeof BroadcastChannel !== 'function') {
    console.warn('[teacher] BroadcastChannel unavailable in this browser');
    return null;
  }

  const panel = el('section', { id: PANEL_ID },
    'position:fixed;top:56px;right:12px;z-index:900;width:min(92vw,440px);max-height:calc(100vh - 80px);overflow:auto;'
    + 'background:#0d1420;color:#d8e6f5;border:1px solid #2a3b52;border-radius:8px;padding:12px;font:12px system-ui,sans-serif;box-shadow:0 6px 24px #0008;');
  panel.setAttribute('role', 'region');
  panel.setAttribute('aria-label', 'Teacher console');

  const head = el('div', {}, 'display:flex;align-items:center;justify-content:space-between;gap:8px;');
  head.append(el('h2', { textContent: 'Teacher console' }, 'margin:0;font-size:14px;'), button('×', closeTeacherConsole));
  const sub = el('p', {
    textContent: `Reaches every tab of this lab open on ${location.origin} in this browser (BroadcastChannel). ${LAB_DISCLAIMER}.`
  }, 'margin:4px 0 8px;font-size:11px;opacity:0.7;');

  const rosterTitle = el('div', {}, 'display:flex;align-items:center;justify-content:space-between;margin-top:4px;');
  const rosterCount = el('strong', { textContent: 'Students (0)' });
  const runsLine = el('span', { textContent: 'Runs collected: 0' }, 'flex:1;');
  const table = el('table', {}, 'width:100%;border-collapse:collapse;margin:6px 0;font-size:11px;');
  table.setAttribute('data-role', 'roster');
  const tbody = el('tbody');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['', 'Tab', 'View', 'Mode', 'Last']) hr.append(el('th', { textContent: h }, 'text-align:left;padding:2px 4px;opacity:0.7;font-weight:600;'));
  thead.append(hr);
  table.append(thead, tbody);
  const empty = el('p', { textContent: 'No student tabs yet — open this lab in another tab.' }, 'margin:4px 0;opacity:0.6;');

  const target = el('p', { textContent: 'Sends go to every student (tick rows to pick some).' }, 'margin:6px 0;font-size:11px;opacity:0.75;');
  const status = el('p', { textContent: '' }, 'margin:6px 0 0;font-size:11px;color:#8cf;min-height:1em;');
  status.setAttribute('aria-live', 'polite');

  const checked = new Set<string>();
  const say = (text: string): void => {
    status.textContent = text;
    console.info(`[teacher] ${text}`);
  };
  const recipients = (): string[] | undefined => (checked.size ? Array.from(checked) : undefined);
  const who = (): string => (checked.size ? `${checked.size} selected student(s)` : 'all students');

  let client: TeacherClient;
  const render = (): void => {
    const rows = client.roster();
    rosterCount.textContent = `Students (${rows.length})`;
    for (const id of Array.from(checked)) if (!rows.some((r) => r.id === id)) checked.delete(id);
    tbody.replaceChildren(...rows.map((r) => {
      const tr = el('tr');
      tr.dataset.student = r.id;
      const box = el('input', { type: 'checkbox', checked: checked.has(r.id) });
      box.setAttribute('aria-label', `Select tab ${r.id}`);
      box.addEventListener('change', () => {
        if (box.checked) checked.add(r.id);
        else checked.delete(r.id);
        target.textContent = checked.size ? `Sends go to ${who()}.` : 'Sends go to every student (tick rows to pick some).';
      });
      const last = r.last ? `${r.last.ok ? '✓' : '✗'} ${r.last.request.slice(4)}: ${r.last.detail}` : ago(r.lastSeenMs);
      const cells = [r.id, r.status?.view ?? '?', r.status?.labMode ?? '—', last];
      const tdBox = el('td', {}, 'padding:2px 4px;');
      tdBox.append(box);
      tr.append(tdBox, ...cells.map((c) => el('td', { textContent: c }, 'padding:2px 4px;border-top:1px solid #1c2a3c;')));
      return tr;
    }));
    table.hidden = rows.length === 0;
    empty.hidden = rows.length > 0;
    runsLine.textContent = `Runs collected: ${client.runs().length}`;
  };

  const channel = new BroadcastChannel(LAB_CHANNEL_NAME);
  client = createTeacherClient({ channel, tabId: classroomTabId, onChange: () => render() });

  rosterTitle.append(rosterCount, button('Ping', () => { client.ping(); say('Pinged'); }));

  // ── Send a lab ──
  const sendRow = el('div', {}, 'display:flex;gap:6px;flex-wrap:wrap;margin:6px 0;');
  const fileInput = el('input', { type: 'file', accept: '.json,application/json' });
  fileInput.hidden = true;
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    fileInput.value = '';
    if (!f) return;
    void f.text().then((text) => {
      let config: unknown;
      try {
        config = JSON.parse(text);
      } catch {
        say(`${f.name} is not valid JSON`);
        return;
      }
      client.send('lab:loadConfig', { config }, recipients());
      say(`Sent ${f.name} to ${who()}`);
    });
  });
  sendRow.append(
    button('Send this lab', () => {
      const exportFile = window.lab?.exportLabFile;
      if (typeof exportFile !== 'function') return say('window.lab.exportLabFile unavailable');
      void exportFile().then((file) => {
        // Students keep their own recorded runs.
        const { runs: _runs, ...config } = file;
        client.send('lab:loadConfig', { config }, recipients());
        say(`Sent this lab's setup to ${who()}`);
      }, (err: unknown) => say(`Could not export this lab: ${err instanceof Error ? err.message : String(err)}`));
    }),
    button('Send .lab.json…', () => fileInput.click()),
    fileInput
  );

  // ── Run an experiment ──
  const runRow = el('div', {}, 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0;');
  const expInput = el('input', { type: 'text', placeholder: 'experiment id' },
    'flex:1;min-width:140px;font:12px ui-monospace,monospace;padding:4px;background:#081018;color:#cfe;border:1px solid #2a3b52;border-radius:4px;');
  expInput.setAttribute('aria-label', 'Experiment id');
  runRow.append(expInput, button('Run on students', () => {
    const id = expInput.value.trim();
    if (!EXPERIMENT_ID.test(id)) return say('Experiment ids are lowercase letters, digits and dashes');
    client.send('lab:runExperiment', { id }, recipients());
    say(`Asked ${who()} to run ${id}`);
  }));

  // ── Runs ──
  const runsRow = el('div', {}, 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:6px 0;');
  runsRow.append(
    runsLine,
    button('Download runs', () => {
      const runs = client.runs();
      if (!runs.length) return say('No runs collected yet');
      downloadJson('seg-class-runs.json', { disclaimer: LAB_DISCLAIMER, runs });
    }),
    button('Open in analysis', () => {
      const runs = client.runs();
      const importRuns = window.lab?.importRuns;
      if (!runs.length) return say('No runs collected yet');
      if (typeof importRuns !== 'function') return say('Analysis panel unavailable in this build');
      const n = (importRuns as (r: unknown[]) => number)(runsForAnalysis(runs));
      say(`Added ${n} run(s) to the analysis panel`);
    })
  );

  panel.append(head, sub, rosterTitle, table, empty, target, sendRow, runRow, runsRow, status);
  document.body.appendChild(panel);

  const timer = window.setInterval(() => {
    client.prune(STALE_MS);
    client.ping();
    render();
  }, PING_MS);
  open = { panel, client, channel, timer };
  client.ping();
  render();
  return panel;
}
