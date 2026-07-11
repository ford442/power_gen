/**
 * Shareable lab links — encode mode, layout, and experiment params in the URL hash.
 *
 * Format: #lab=v1;mode=seg;layout=searl;drive=0.5;field=0.5;bmult=1;class=0;tour=0
 */

export const LAB_URL_VERSION = 1;

/**
 * @param {object} opts
 * @returns {string} hash fragment (includes leading #)
 */
export function encodeLabHash(opts = {}) {
  const parts = [`v${LAB_URL_VERSION}`];
  if (opts.mode) parts.push(`mode=${opts.mode}`);
  if (opts.layout) parts.push(`layout=${opts.layout}`);
  if (opts.heronLayout) parts.push(`heron=${opts.heronLayout}`);
  if (opts.drive != null) parts.push(`drive=${Number(opts.drive).toFixed(2)}`);
  if (opts.field != null) parts.push(`field=${Number(opts.field).toFixed(2)}`);
  if (opts.bmult != null && opts.bmult !== 1) parts.push(`bmult=${Number(opts.bmult).toFixed(2)}`);
  if (opts.classroom) parts.push('class=1');
  if (opts.tour) parts.push('tour=1');
  if (opts.renderer) parts.push(`renderer=${opts.renderer}`);
  return `#lab=${parts.join(';')}`;
}

/**
 * @param {string} [hash]  location.hash
 * @returns {object|null}
 */
export function decodeLabHash(hash = typeof location !== 'undefined' ? location.hash : '') {
  const m = hash.match(/#lab=([^&]+)/);
  if (!m) return null;
  const out = { version: LAB_URL_VERSION };
  for (const seg of m[1].split(';')) {
    if (seg === 'v1' || seg.startsWith('v')) {
      out.version = parseInt(seg.slice(1), 10) || 1;
      continue;
    }
    const eq = seg.indexOf('=');
    if (eq < 0) continue;
    const k = seg.slice(0, eq);
    const v = seg.slice(eq + 1);
    if (k === 'mode') out.mode = v;
    else if (k === 'layout') out.layout = v;
    else if (k === 'heron') out.heronLayout = v;
    else if (k === 'drive') out.drive = parseFloat(v);
    else if (k === 'field') out.field = parseFloat(v);
    else if (k === 'bmult') out.bmult = parseFloat(v);
    else if (k === 'class') out.classroom = v === '1';
    else if (k === 'tour') out.tour = v === '1';
    else if (k === 'renderer') out.renderer = v;
  }
  return out;
}

/**
 * Apply decoded lab state to the live dashboard.
 * @param {object} lab
 */
export async function applyLabState(lab) {
  if (!lab) return;

  if (lab.renderer && typeof window.setRenderer === 'function') {
    // Renderer requires reload — only apply if already on page without mismatch
  }

  const v = window.multiVisualizer;
  if (lab.layout && v?.setSEGLayoutPreset) {
    await v.setSEGLayoutPreset(lab.layout);
  } else if (lab.layout && typeof window.setSEGLayout === 'function') {
    await window.setSEGLayout(lab.layout);
  }

  if (lab.heronLayout && v?.setHeronLayoutPreset) {
    v.setHeronLayoutPreset(lab.heronLayout);
  }

  if (lab.mode && typeof window.setMode === 'function') {
    window.setMode(lab.mode);
  }

  const op = window.segOperator;
  if (op) {
    if (lab.drive != null) {
      op.targetDrive = lab.drive;
      const dc = document.getElementById('driveControl');
      const dv = document.getElementById('driveVal');
      if (dc) dc.value = String(Math.round(lab.drive * 100));
      if (dv) dv.textContent = `${Math.round(lab.drive * 100)}%`;
    }
    if (lab.field != null) {
      window.explainerState?.setBaseFieldStrength(lab.field);
      const fc = document.getElementById('fieldControl');
      if (fc) fc.value = String(Math.round(lab.field * 100));
    }
  }

  if (lab.bmult != null && window.explainerState) {
    window.explainerState.setFieldMultiplier(lab.bmult);
    const el = document.getElementById('explainerBMult');
    if (el) el.value = String(lab.bmult);
  }

  if (lab.classroom && window.explainerState) {
    window.explainerState.setClassroomMode(true);
    const cb = document.getElementById('explainerClassroom');
    if (cb) cb.checked = true;
  }
}

export function captureLabState() {
  const v = window.multiVisualizer;
  const op = window.segOperator;
  const es = window.explainerState;
  return {
    mode: v?.currentView === 'overview' ? 'overview' : (v?.currentView || 'seg'),
    layout: v?.getSEGLayoutPreset?.() ?? v?.segLayoutPreset ?? 'searl',
    heronLayout: v?.heronLayoutPreset,
    drive: op?.targetDrive ?? 0.5,
    field: es?.baseFieldStrength ?? op?.magneticFieldStrength ?? 0.5,
    bmult: es?.fieldMultiplier ?? 1,
    classroom: es?.classroomMode ?? false,
    renderer: window.currentRenderer
  };
}

export function shareLabLink() {
  const hash = encodeLabHash(captureLabState());
  const url = `${location.origin}${location.pathname}${location.search}${hash}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).catch(() => {});
  }
  history.replaceState(null, '', hash);
  return url;
}
