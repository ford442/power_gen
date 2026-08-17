/**
 * Required WebGPU boot probe. Does not open WebGL2.
 * The multi-device visualizer still owns the long-lived GPUDevice (one device).
 * This probe may create a short-lived device to validate requestDevice, then destroy it.
 */

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
  try {
    adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (e) {
    return fail(browser, `requestAdapter threw: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!adapter) {
    return fail(browser, 'No adapter');
  }

  const info = adapter.info || ({} as GPUAdapterInfo);
  const adapterSnap = {
    vendor: info.vendor || 'unknown',
    architecture: info.architecture || 'unknown',
    device: info.device || 'unknown',
    description: info.description || '',
    isFallbackAdapter: !!(adapter as GPUAdapter & { isFallbackAdapter?: boolean }).isFallbackAdapter
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

/** Blocking hard-fail UI — does not call getContext('webgl2'). */
export function showWebGPUHardFail(probe: WebGPUProbeResult): void {
  document.body.classList.add('webgpu-hard-fail');
  const canvas = document.getElementById('gpuCanvas');
  if (canvas) {
    canvas.dataset.renderer = 'none';
    canvas.dataset.webgpuFail = '1';
  }
  window.currentRenderer = null;

  let host = document.getElementById('webgpu-hard-fail');
  if (!host) {
    host = document.createElement('div');
    host.id = 'webgpu-hard-fail';
    host.setAttribute('role', 'alert');
    document.body.appendChild(host);
  }

  const json = JSON.stringify(probe, null, 2);
  host.innerHTML = `
    <div class="webgpu-hard-fail-card">
      <h2>WebGPU required</h2>
      <p class="webgpu-hard-fail-lead">
        This build does <strong>not</strong> fall back to WebGL2 when WebGPU fails
        (automatic dual-hot path removed — see ADR-0001 / gpu-chores exclusive session).
      </p>
      <p><strong>Browser:</strong> ${escapeHtml(probe.browser.brand)} ${escapeHtml(probe.browser.version)}</p>
      <p><strong>Error:</strong> ${escapeHtml(probe.error || 'unknown')}</p>
      <p class="webgpu-hard-fail-hint">${escapeHtml(probe.chromeVsEdge)}</p>
      <details open>
        <summary>window.webgpuProbe JSON</summary>
        <pre class="webgpu-hard-fail-pre">${escapeHtml(json)}</pre>
      </details>
      <p class="webgpu-hard-fail-foot">
        In-tree WebGL2 remains available only via explicit <code>?renderer=webgl2</code> for agents —
        not as an automatic rescue path.
      </p>
    </div>
  `;

  console.error('[boot] WebGPU hard-fail — WebGL2 not started. window.webgpuProbe =', probe);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
