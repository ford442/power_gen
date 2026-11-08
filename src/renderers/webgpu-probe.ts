import {
  WebGPUManager,
  type AdapterFeatureLevel,
  type AdapterInfoSnapshot
} from '../webgpu-manager';
import { compatibilityOnlyAdapter } from '../webgpu-init/adapter';
import { reloadWithLabParam } from '../config/lab-config';
import { RENDERER_WEBGL2, resolveRenderer } from './renderer-selector';

export interface BrowserBrandSnapshot {
  brand: string;
  version: string;
  userAgent: string;
  brands: Array<{ brand: string; version: string }>;
}

export interface WebGPUProbeResult {
  ok: boolean;
  timestamp: string;
  browser: BrowserBrandSnapshot;
  hasNavigatorGpu: boolean;
  adapter: {
    vendor: string;
    architecture: string;
    device: string;
    description: string;
    isFallbackAdapter: boolean;
    software: boolean;
    featureLevel: AdapterFeatureLevel | null;
  } | null;
  features: string[];
  limits: Record<string, number>;
  preferredCanvasFormat: string | null;
  error: string | null;
  /** Human-readable Chrome vs Edge / environment guidance. */
  chromeVsEdge: string;
  /** True only while a probe-only device was briefly alive (always destroyed before return). */
  probeDeviceDestroyed: boolean;
}

function browserBrand(): BrowserBrandSnapshot {
  const nav = typeof navigator !== 'undefined' ? navigator : null;
  const ua = nav?.userAgent || '';
  const brands = (nav as Navigator & {
    userAgentData?: { brands?: Array<{ brand: string; version: string }> };
  })?.userAgentData?.brands?.map((b) => ({ brand: b.brand, version: b.version })) || [];
  let brand = 'unknown';
  let version = '';
  const edge = ua.match(/Edg\/([\d.]+)/);
  const chrome = ua.match(/Chrome\/([\d.]+)/);
  const firefox = ua.match(/Firefox\/([\d.]+)/);
  const safari = !chrome && ua.match(/Version\/([\d.]+).*Safari/);
  if (edge) {
    brand = 'Edge';
    version = edge[1];
  } else if (chrome) {
    brand = 'Chrome';
    version = chrome[1];
  } else if (firefox) {
    brand = 'Firefox';
    version = firefox[1];
  } else if (safari) {
    brand = 'Safari';
    version = safari[1];
  }
  return { brand, version, userAgent: ua, brands };
}

function chromeVsEdgeReason(browser: BrowserBrandSnapshot, err: string | null, hasGpu: boolean): string {
  if (!hasGpu) {
    if (browser.brand === 'Firefox') {
      return 'Firefox: enable dom.webgpu.enabled (and gfx.webgpu.force-enabled on some builds); Chrome/Edge 113+ recommended.';
    }
    if (browser.brand === 'Safari') {
      return 'Safari WebGPU is limited; Chrome or Edge 113+ recommended for this app.';
    }
    if (browser.brand === 'Edge') {
      return 'Edge reports no navigator.gpu — update Edge, check chrome://gpu (edge://gpu), disable software-only / remote desktop GPU block.';
    }
    if (browser.brand === 'Chrome') {
      return 'Chrome reports no navigator.gpu — update Chrome, check chrome://gpu, disable --disable-gpu / software rendering.';
    }
    return 'navigator.gpu missing — use Chrome or Edge 113+ with hardware GPU access.';
  }
  if (!err) {
    if (browser.brand === 'Edge') {
      return 'Edge WebGPU probe OK. If Chrome works and Edge fails later, compare edge://gpu vs chrome://gpu feature flags.';
    }
    if (browser.brand === 'Chrome') {
      return 'Chrome WebGPU probe OK.';
    }
    return `WebGPU probe OK on ${browser.brand}.`;
  }
  const lower = err.toLowerCase();
  if (lower.includes('no adapter') || lower.includes('adapter')) {
    if (browser.brand === 'Edge') {
      return 'Edge: requestAdapter returned null — often headless VM / no GPU / remote session. Chrome may report the same; check edge://gpu.';
    }
    if (browser.brand === 'Chrome') {
      return 'Chrome: requestAdapter returned null — no GPU adapter (common on headless CI). edge://gpu / chrome://gpu for details.';
    }
    return `requestAdapter failed (${browser.brand}): ${err}`;
  }
  if (lower.includes('device')) {
    return `${browser.brand}: requestDevice failed — ${err}. Compare Chrome vs Edge GPU blocklists.`;
  }
  return `${browser.brand}: ${err}`;
}

function limitSnapshot(limits: GPUSupportedLimits): Record<string, number> {
  const keys = [
    'maxTextureDimension2D',
    'maxBufferSize',
    'maxStorageBufferBindingSize',
    'maxComputeWorkgroupStorageSize',
    'maxComputeInvocationsPerWorkgroup',
    'maxComputeWorkgroupSizeX',
    'maxStorageBuffersPerShaderStage',
    'maxBindGroups'
  ] as const;
  const out: Record<string, number> = {};
  for (const k of keys) {
    const v = limits[k];
    if (typeof v === 'number') out[k] = v;
  }
  return out;
}

function fail(
  browser: BrowserBrandSnapshot,
  err: string,
  partial: Partial<WebGPUProbeResult> = {}
): WebGPUProbeResult {
  const hasGpu = !!navigator.gpu;
  const result: WebGPUProbeResult = {
    ok: false,
    timestamp: new Date().toISOString(),
    browser,
    hasNavigatorGpu: hasGpu,
    adapter: null,
    features: [],
    limits: {},
    preferredCanvasFormat: null,
    error: err,
    chromeVsEdge: chromeVsEdgeReason(browser, err, hasGpu),
    probeDeviceDestroyed: false,
    ...partial
  };
  console.error('[webgpuProbe] FAIL', result);
  return result;
}

/**
 * Probe WebGPU availability. Never opens a WebGL2 context.
 * Destroys any probe-only GPUDevice before returning so MultiDeviceVisualizer
 * owns the single long-lived device.
 */
export async function probeWebGPU(): Promise<WebGPUProbeResult> {
  const browser = browserBrand();
  console.log('[webgpuProbe] browser', browser);

  if (typeof navigator === 'undefined' || !navigator.gpu) {
    return fail(browser, 'navigator.gpu is undefined');
  }

  let adapter: GPUAdapter | null = null;
  let featureLevel: AdapterFeatureLevel | null = null;
  try {
    const preferred = await WebGPUManager.requestPreferredAdapter(navigator.gpu);
    if (preferred) {
      adapter = preferred.adapter;
      featureLevel = preferred.featureLevel;
    }
  } catch (e) {
    return fail(browser, `requestAdapter threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!adapter) {
    if (await compatibilityOnlyAdapter(navigator.gpu)) {
      return fail(
        browser,
        'Only a WebGPU compatibility-mode adapter is available. This app needs core WebGPU ' +
        '(storage buffers in vertex shaders, sRGB canvas views, textureLoad on depth). ' +
        'Try ?renderer=webgl2.'
      );
    }
    return fail(browser, 'No adapter');
  }

  const info: AdapterInfoSnapshot = WebGPUManager.readAdapterInfo(adapter, featureLevel);
  const adapterSnap = {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: info.fallback,
    software: info.software,
    featureLevel: info.featureLevel
  };
  const features = [...adapter.features].sort();
  const limits = limitSnapshot(adapter.limits);
  const preferredCanvasFormat = navigator.gpu.getPreferredCanvasFormat?.() ?? null;

  console.log('[webgpuProbe] adapter.info', adapterSnap);
  console.log('[webgpuProbe] features', features);
  console.log('[webgpuProbe] limits', limits);

  let probeDeviceDestroyed = false;
  try {
    const device = await adapter.requestDevice({
      label: 'seg-webgpu-probe-ephemeral'
    });
    try {
      device.destroy();
      probeDeviceDestroyed = true;
    } catch {
      probeDeviceDestroyed = true;
    }
  } catch (e) {
    return fail(browser, `requestDevice failed: ${e instanceof Error ? e.message : String(e)}`, {
      adapter: adapterSnap,
      features,
      limits,
      preferredCanvasFormat
    });
  }

  const ok: WebGPUProbeResult = {
    ok: true,
    timestamp: new Date().toISOString(),
    browser,
    hasNavigatorGpu: true,
    adapter: adapterSnap,
    features,
    limits,
    preferredCanvasFormat,
    error: null,
    chromeVsEdge: chromeVsEdgeReason(browser, null, true),
    probeDeviceDestroyed
  };
  console.log('[webgpuProbe] OK', ok);
  return ok;
}

const HARD_FAIL_ID = 'webgpu-hard-fail';
let hardFailKeyHandler: ((e: KeyboardEvent) => void) | null = null;

/** Page regions made inert while the modal card is open (the card is its own focus scope). */
const MODAL_BACKGROUND = ['#header', '#main', '#footer'];

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

function setModalBackgroundInert(inert: boolean): void {
  for (const sel of MODAL_BACKGROUND) {
    document.querySelector<HTMLElement>(sel)?.toggleAttribute('inert', inert);
  }
}

/** Keep Tab / Shift+Tab inside the open card. */
function trapTab(host: HTMLElement, e: KeyboardEvent): void {
  const items = [...host.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
  if (items.length === 0) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement as HTMLElement | null;
  if (!active || !host.contains(active)) {
    e.preventDefault();
    first.focus();
  } else if (e.shiftKey && active === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Without a renderer the controls drive nothing (sliders move, Spin-up is a
 * no-op, status stays STANDBY). Make them inert — unfocusable and unclickable
 * — and say why, in a note that is itself outside the inert subtree.
 */
export function disableSimulationControls(reason: string): void {
  const message = `Simulation unavailable — ${reason}`;
  const left = document.getElementById('left-panel');
  if (left) {
    let note = document.getElementById('sim-unavailable-note');
    if (!note) {
      note = document.createElement('div');
      note.id = 'sim-unavailable-note';
      note.setAttribute('role', 'status');
      left.prepend(note);
    }
    note.textContent = message;
    for (const child of Array.from(left.children)) {
      if (child !== note) child.toggleAttribute('inert', true);
    }
  }
  for (const id of ['lab-mode-switch', 'canvas-wrapper']) {
    document.getElementById(id)?.toggleAttribute('inert', true);
  }
  document.body.dataset.simUnavailable = message;
}

/**
 * Show or hide the hard-fail card. Hiding only reveals the static content
 * (About / Reference / Learning); the simulation stays disabled
 * (`body.webgpu-hard-fail` is untouched) and the header badge reopens it.
 */
export function setWebGPUHardFailOpen(open: boolean): void {
  const host = document.getElementById(HARD_FAIL_ID);
  if (!host) return;
  host.hidden = !open;
  const badge = document.getElementById('renderer-badge');
  if (badge) badge.setAttribute('aria-expanded', String(open));
  if (hardFailKeyHandler) {
    document.removeEventListener('keydown', hardFailKeyHandler);
    hardFailKeyHandler = null;
  }
  setModalBackgroundInert(open);
  if (open) {
    hardFailKeyHandler = (e) => {
      if (e.key === 'Escape') setWebGPUHardFailOpen(false);
      else if (e.key === 'Tab') trapTab(host, e);
    };
    document.addEventListener('keydown', hardFailKeyHandler);
    host.querySelector<HTMLElement>('[data-hard-fail-focus]')?.focus();
  } else {
    badge?.focus();
  }
}

/** Header badge: "WebGL2 mode" (explicit opt-in) or "WebGPU off" (reopens the card). */
export function setRendererBadge(state: 'webgl2' | 'webgpu-unavailable' | null): void {
  const badge = document.getElementById('renderer-badge') as HTMLButtonElement | null;
  const text = document.getElementById('rendererBadgeText');
  if (!badge || !text) return;
  badge.hidden = state === null;
  if (state === null) return;
  badge.dataset.state = state;
  if (state === 'webgl2') {
    text.textContent = 'WebGL2 mode';
    badge.title = 'Running on the opt-in WebGL2 renderer (?renderer=webgl2). Some WebGPU-only effects are unavailable.';
    badge.disabled = true;
    badge.removeAttribute('aria-expanded');
  } else {
    text.textContent = 'WebGPU unavailable';
    badge.title = 'WebGPU is unavailable — click for details';
    badge.disabled = false;
    badge.setAttribute('aria-expanded', 'false');
  }
}

/**
 * Blocking-but-dismissible hard-fail UI — does not call getContext('webgl2').
 * WebGL2 is offered only as an explicit button; nothing starts automatically.
 */
export function showWebGPUHardFail(probe: WebGPUProbeResult): void {
  document.body.classList.add('webgpu-hard-fail');
  const canvas = document.getElementById('gpuCanvas');
  if (canvas) {
    canvas.dataset.renderer = 'none';
    canvas.dataset.webgpuFail = '1';
  }
  window.currentRenderer = null;
  disableSimulationControls(probe.hasNavigatorGpu ? 'WebGPU adapter not available' : 'WebGPU not available');

  let host = document.getElementById(HARD_FAIL_ID);
  if (!host) {
    host = document.createElement('div');
    host.id = HARD_FAIL_ID;
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.setAttribute('aria-labelledby', 'webgpu-hard-fail-title');
    document.body.appendChild(host);
  }

  // If the explicit WebGL2 opt-in is what failed, offer the way back instead of a reload loop.
  const triedWebGL2 = resolveRenderer() === RENDERER_WEBGL2;
  const json = JSON.stringify(probe, null, 2);
  const alt = triedWebGL2
    ? `<button type="button" class="ctrl-btn" data-hard-fail-action="webgpu">Reload with WebGPU</button>`
    : `<button type="button" class="ctrl-btn" data-hard-fail-action="webgl2">Reload with WebGL2 (?renderer=webgl2)</button>`;
  const altNote = triedWebGL2
    ? 'The WebGL2 renderer failed to start as well.'
    : 'WebGL2 is a reduced-fidelity opt-in; it is never started automatically.';

  host.innerHTML = `
    <div class="webgpu-hard-fail-card">
      <button type="button" class="webgpu-hard-fail-close" data-hard-fail-action="close"
        aria-label="Close (Esc)" title="Close (Esc)">✕</button>
      <h2 id="webgpu-hard-fail-title">WebGPU required</h2>
      <p class="webgpu-hard-fail-lead">
        This browser could not start WebGPU, so the live simulation is disabled.
        You can close this message to read the About, Reference and Learning content.
      </p>
      <p><strong>Browser:</strong> ${escapeHtml(probe.browser.brand)} ${escapeHtml(probe.browser.version)}</p>
      <p><strong>Problem:</strong> ${escapeHtml(probe.error || 'unknown')}</p>
      <p class="webgpu-hard-fail-hint">${escapeHtml(probe.chromeVsEdge)}</p>
      <div class="webgpu-hard-fail-actions">
        <button type="button" class="ctrl-btn" data-hard-fail-action="close" data-hard-fail-focus>Close and read the docs</button>
        ${alt}
      </div>
      <p class="webgpu-hard-fail-foot">${altNote}</p>
      <h3>Things to try</h3>
      <ul class="webgpu-hard-fail-tips">
        <li>Turn on <strong>hardware acceleration</strong> (Chrome/Edge: Settings → System → “Use graphics acceleration when available”), then restart the browser.</li>
        <li>Update your <strong>GPU drivers</strong> and the browser. Remote desktops, VMs and headless sessions often have no GPU adapter.</li>
        <li>Use a recent <strong>Chrome or Edge</strong> (113+ on Windows, macOS and ChromeOS; Android 121+). Recent Safari and Firefox releases have WebGPU on some platforms.</li>
        <li><strong>Linux Chrome:</strong> WebGPU may need Vulkan — try <code>chrome://flags/#enable-unsafe-webgpu</code> and <code>chrome://flags/#enable-vulkan</code>, or launch with <code>--enable-features=Vulkan</code>. Check <code>chrome://gpu</code> for “WebGPU: Hardware accelerated”.</li>
        <li><strong>Firefox:</strong> set <code>dom.webgpu.enabled</code> to true in <code>about:config</code> if your version has it off.</li>
      </ul>
      <details class="webgpu-hard-fail-details">
        <summary>Details (probe JSON)</summary>
        <pre class="webgpu-hard-fail-pre">${escapeHtml(json)}</pre>
      </details>
    </div>
  `;

  host.onclick = (e) => {
    const target = e.target as HTMLElement;
    const action = target.closest<HTMLElement>('[data-hard-fail-action]')?.dataset.hardFailAction;
    if (action === 'close') setWebGPUHardFailOpen(false);
    else if (action === 'webgl2') reloadWithLabParam('renderer', RENDERER_WEBGL2);
    else if (action === 'webgpu') reloadWithLabParam('renderer', null);
    else if (target === host) setWebGPUHardFailOpen(false); // backdrop click
  };

  const badge = document.getElementById('renderer-badge');
  if (badge) badge.onclick = () => setWebGPUHardFailOpen(true);
  setRendererBadge('webgpu-unavailable');
  setWebGPUHardFailOpen(true);

  console.error('[boot] WebGPU hard-fail — WebGL2 not started. window.webgpuProbe =', probe);
}

/**
 * Non-fatal boot problem: the renderer is running but part of the UI wiring
 * threw. A dismissible strip (not the hard-fail card) plus a
 * `window.webgpuProbe.bootWarnings` entry, so agents can see it too.
 */
export function showBootWarning(message: string): void {
  if (typeof document === 'undefined') return;
  const probe = window.webgpuProbe as (WebGPUProbeResult & { bootWarnings?: string[] }) | undefined;
  if (probe) (probe.bootWarnings ??= []).push(message);

  let host = document.getElementById('boot-warning');
  if (!host) {
    host = document.createElement('div');
    host.id = 'boot-warning';
    host.setAttribute('role', 'alert');
    host.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:3000;'
      + 'max-width:min(640px,calc(100vw - 32px));padding:8px 36px 8px 12px;border-radius:6px;'
      + 'background:#2a1600;border:1px solid #fa0;color:#fc6;font:12px/1.4 system-ui,sans-serif;';
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '✕';
    close.setAttribute('aria-label', 'Dismiss');
    close.style.cssText = 'position:absolute;right:6px;top:6px;background:none;border:0;color:inherit;cursor:pointer;';
    close.addEventListener('click', () => host?.remove(), { once: true });
    host.appendChild(close);
    document.body.appendChild(host);
  }
  const line = document.createElement('div');
  line.textContent = message;
  host.insertBefore(line, host.lastElementChild);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
