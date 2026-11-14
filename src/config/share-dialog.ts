/**
 * Share dialog — `#lab2=` link, QR code, `.lab.json` download (#224 §1).
 * Lazy chunk; the QR encoder (`qrcode-generator`) is a further lazy import, so
 * nothing here costs the entry bundle.
 */
import { SHARE_LINK_SOFT_MAX } from './share-link';

const DIALOG_ID = 'lab-share-dialog';

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  style = ''
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  if (style) node.setAttribute('style', style);
  return node;
}

/** Draw `text` as a QR code on a canvas (error correction L, auto version). */
export async function drawQr(canvas: HTMLCanvasElement, text: string, px = 4): Promise<boolean> {
  try {
    const { default: qrcode } = await import('qrcode-generator');
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 4;
    const size = (n + quiet * 2) * px;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return false;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000';
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * px, (r + quiet) * px, px, px);
      }
    }
    return true;
  } catch (err) {
    console.warn('[share-dialog] QR code unavailable:', err);
    return false;
  }
}

export async function openShareDialog(): Promise<void> {
  const { shareLabLink } = await import('../seg-explainer/lab-url');
  const url = await shareLabLink();

  document.getElementById(DIALOG_ID)?.remove();
  const dialog = el('dialog', { id: DIALOG_ID },
    'max-width:min(92vw,420px);background:#0d1420;color:#d8e6f5;border:1px solid #2a3b52;border-radius:8px;padding:14px;font:13px system-ui,sans-serif;');
  dialog.setAttribute('aria-label', 'Share this lab');

  const title = el('h2', { textContent: 'Share this lab' }, 'margin:0 0 8px;font-size:15px;');
  const input = el('input', { type: 'text', readOnly: true, value: url },
    'width:100%;box-sizing:border-box;font:12px ui-monospace,monospace;padding:6px;background:#081018;color:#cfe;border:1px solid #2a3b52;border-radius:4px;');
  input.setAttribute('aria-label', 'Lab link');
  const meta = el('p', {
    textContent: url.length > SHARE_LINK_SOFT_MAX
      ? `${url.length} characters — long; some chat apps truncate links this size. The .lab.json file always works.`
      : `${url.length} characters · copied to the clipboard`
  }, 'margin:6px 0;opacity:0.8;font-size:12px;');

  const canvas = el('canvas', {}, 'display:block;margin:8px auto;image-rendering:pixelated;max-width:100%;');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'QR code of the lab link');

  const row = el('div', {}, 'display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;margin-top:8px;');
  const copy = el('button', { type: 'button', className: 'ctrl-btn', textContent: 'Copy link' });
  copy.addEventListener('click', () => {
    input.select();
    navigator.clipboard?.writeText(url).then(
      () => { meta.textContent = 'Copied.'; },
      () => { meta.textContent = 'Select the link and copy it by hand.'; }
    );
  });
  const download = el('button', { type: 'button', className: 'ctrl-btn', textContent: 'Download .lab.json' });
  download.addEventListener('click', () => {
    void import('./lab-file').then((m) => m.downloadLabFile());
  });
  const close = el('button', { type: 'button', className: 'ctrl-btn', textContent: 'Close' });
  close.addEventListener('click', () => dialog.close());
  row.append(copy, download, close);

  const note = el('p', {
    textContent: 'Simulated, not metrology — the link reproduces a simulation setup, not a measurement.'
  }, 'margin:8px 0 0;font-size:11px;opacity:0.65;');

  dialog.append(title, input, meta, canvas, row, note);
  dialog.addEventListener('close', () => dialog.remove());
  document.body.appendChild(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  input.select();

  if (!(await drawQr(canvas, url))) canvas.remove();
}
