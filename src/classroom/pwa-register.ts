/**
 * Service-worker registration and the update prompt (#224 §5,
 * docs/CLASSROOM.md). Part of the lazy classroom chunk; `installClassroom()`
 * calls it only on production http(s) boots where `navigator.serviceWorker` exists.
 *
 * Updates never land mid-lesson. A new `sw.js` installs in the background and
 * then waits; this module shows "Update available — reload", and only that
 * click tells the waiting worker to `skip-waiting` and reloads the page.
 * "Later" hides the toast; the update then applies whenever every tab of the
 * lab has been closed, as browsers do by default.
 */

/** A lesson tab can stay open all day; look for a new deploy hourly (applied only on click). */
const UPDATE_CHECK_MS = 60 * 60 * 1000;
const TOAST_ID = 'pwaUpdateToast';

/** Set by the toast's Reload click; a `controllerchange` without it never reloads. */
let reloadRequested = false;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  const sw = navigator.serviceWorker;
  // BASE_URL is './' by default, so this resolves against the page: Pages
  // /power_gen/ and Contabo /powergen/ both get <deploy root>/sw.js, scoped to
  // that root. An absolute VITE_BASE_PATH works the same way.
  const reg = await sw.register(`${import.meta.env.BASE_URL}sw.js`);

  // Fires after our skip-waiting (and on first install via clients.claim(),
  // which must not reload — hence the flag).
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (!reloadRequested || reloading) return;
    reloading = true;
    location.reload();
  });

  // An update that installed on an earlier visit and is still waiting.
  if (reg.waiting && sw.controller) showUpdateToast(reg);
  reg.addEventListener('updatefound', () => {
    const next = reg.installing;
    next?.addEventListener('statechange', () => {
      // No controller = first install: nothing to update *from*.
      if (next.state === 'installed' && sw.controller) showUpdateToast(reg);
    });
  });

  setInterval(() => { reg.update().catch(() => { /* offline — try next hour */ }); }, UPDATE_CHECK_MS);
  return reg;
}

/** Kill switch: drop this deployment's worker (its caches go when the browser evicts them). */
export async function unregisterServiceWorker(): Promise<boolean> {
  const reg = await navigator.serviceWorker.getRegistration(`${import.meta.env.BASE_URL}`);
  return reg ? reg.unregister() : false;
}

function showUpdateToast(reg: ServiceWorkerRegistration): void {
  if (document.getElementById(TOAST_ID)) return;
  const toast = document.createElement('div');
  toast.id = TOAST_ID;
  toast.setAttribute('role', 'status');
  toast.style.cssText = [
    'position:fixed', 'left:50%', 'bottom:16px', 'transform:translateX(-50%)', 'z-index:10000',
    'display:flex', 'flex-wrap:wrap', 'align-items:center', 'gap:8px', 'max-width:calc(100vw - 32px)',
    'padding:8px 12px', 'background:rgba(0,10,20,0.95)', 'border:1px solid #0ff6', 'border-radius:6px',
    'color:#0ff', 'font:0.75rem monospace', 'box-shadow:0 0 12px #0ff3'
  ].join(';');
  toast.innerHTML = '<span>Update available —</span>'
    + '<button type="button" class="ctrl-btn" id="pwaUpdateReload">Reload</button>'
    + '<button type="button" class="ctrl-btn" id="pwaUpdateLater">Later</button>';
  document.body.appendChild(toast);

  toast.querySelector('#pwaUpdateLater')!.addEventListener('click', () => toast.remove());
  toast.querySelector('#pwaUpdateReload')!.addEventListener('click', () => {
    reloadRequested = true;
    const waiting = reg.waiting;
    // Another tab may already have applied it: then just reload onto it.
    if (waiting) waiting.postMessage({ type: 'skip-waiting' });
    else location.reload();
  });
}
