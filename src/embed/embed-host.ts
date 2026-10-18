/**
 * `?embed=1` — the lab inside someone else's page (#224 §5). Lazy chunk,
 * loaded only when LabConfig `embed` is on. The chrome is already hidden by
 * the `data-lab-embed` attribute the entry sets (seg-overlays.css); this
 * adds the "Simulated, not metrology" badge and the `postMessage` endpoint,
 * then tells the parent it is ready.
 */
import { LAB_CONFIG_SCHEMA_HASH } from '../../generated/lab-config';
import { labConfig } from '../config/lab-config';
import { telemetryHub } from '../telemetry-hub';
import { browserLabHost } from './browser-host';
import { createEmbedEndpoint, type EmbedEndpoint } from './embed-endpoint';
import { EMBED_PROTOCOL_VERSION, LAB_DISCLAIMER, buildAllowlist, type EmbedAllowlist } from './embed-protocol';
import { hostCapabilities } from './lab-requests';

const BADGE_ID = 'lab-embed-badge';

let installed: { allowlist: EmbedAllowlist; endpoint: EmbedEndpoint } | null = null;

function addBadge(): void {
  if (document.getElementById(BADGE_ID)) return;
  const badge = document.createElement('div');
  badge.id = BADGE_ID;
  badge.textContent = LAB_DISCLAIMER;
  badge.title = 'Every number in this lab is simulation state, not a calibrated measurement.';
  (document.getElementById('canvas-wrapper') ?? document.body).appendChild(badge);
}

/**
 * `lab:ready` to the parent. Where the browser names the parent's origin
 * (`location.ancestorOrigins`, Chromium / WebKit) it goes there only if that
 * origin is allowed; elsewhere once per allowed origin, and the browser drops
 * the copies whose origin is not the parent's.
 */
function announceReady(allowlist: EmbedAllowlist): void {
  if (window.parent === window) return;
  const host = browserLabHost();
  const msg = {
    type: 'lab:ready',
    protocol: EMBED_PROTOCOL_VERSION,
    schema: LAB_CONFIG_SCHEMA_HASH,
    capabilities: hostCapabilities(host, 'postMessage')
  };
  const parentOrigin = location.ancestorOrigins?.[0];
  let targets = Array.from(allowlist.allowed);
  if (parentOrigin) {
    targets = allowlist.allowed.has(parentOrigin) ? [parentOrigin] : [];
    if (!targets.length) console.debug(`[embed] parent ${parentOrigin} is not in embedOrigins — no lab:ready`);
  }
  for (const origin of targets) {
    try {
      window.parent.postMessage(msg, origin);
    } catch {
      /* parent gone */
    }
  }
}

export function installEmbedHost(): EmbedAllowlist {
  if (installed) return installed.allowlist;
  document.documentElement.dataset.labEmbed = '';
  const allowlist = buildAllowlist(labConfig().embedOrigins, location.origin);
  if (allowlist.refused.length) {
    console.warn(`[embed] refused embedOrigins entr${allowlist.refused.length === 1 ? 'y' : 'ies'} ${allowlist.refused.map((o) => JSON.stringify(o)).join(', ')} — exact scheme://host[:port] only, no wildcards`);
  }
  const endpoint = createEmbedEndpoint({ allowlist, host: browserLabHost(), hub: telemetryHub });
  window.addEventListener('message', (ev) => {
    void endpoint.onMessage(ev);
  });
  installed = { allowlist, endpoint };
  if (window.lab) window.lab.embedOrigins = () => Array.from(allowlist.allowed);
  addBadge();
  announceReady(allowlist);
  console.info(`[embed] postMessage protocol ${EMBED_PROTOCOL_VERSION} ready for ${Array.from(allowlist.allowed).join(', ') || '(no origin)'}`);
  return allowlist;
}
