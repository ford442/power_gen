/**
 * The running page as a {@link LabHost}: `window.lab` (loadConfig, and the
 * runExperiment / captureSnapshot hooks the §3 / §2 chunks install), plus a
 * status row for rosters. Hooks are looked up per call, so a chunk that
 * installs after the embed host is still reached.
 */
import { LAB_CONFIG_SCHEMA_HASH } from '../../generated/lab-config';
import { labConfig } from '../config/lab-config';
import { telemetryHub } from '../telemetry-hub';
import type { LabStatus } from './embed-protocol';
import type { LabHost } from './lab-requests';

type HookFn = (...args: unknown[]) => unknown;

function hook(name: string): HookFn | undefined {
  const fn = (window.lab as Record<string, unknown> | undefined)?.[name];
  return typeof fn === 'function' ? (fn as HookFn).bind(window.lab) : undefined;
}

export function labStatus(): LabStatus {
  const snap = telemetryHub.getSnapshot();
  return {
    view: window.multiVisualizer?.currentView ?? snap.view ?? 'overview',
    labMode: window.getLabMode?.() ?? null,
    renderer: window.currentRenderer ?? null,
    experiment: labConfig().experiment,
    simTimeS: snap.simTimeS,
    title: document.title
  };
}

export function browserLabHost(): LabHost {
  return {
    schema: LAB_CONFIG_SCHEMA_HASH,
    loadConfig(config) {
      const load = hook('loadConfig');
      if (!load) return Promise.reject(new Error('window.lab.loadConfig unavailable'));
      return Promise.resolve(load(config));
    },
    get runExperiment() {
      const run = hook('runExperiment');
      return run ? (experiment: unknown, opts: unknown) => Promise.resolve(run(experiment, opts)) : undefined;
    },
    get captureSnapshot() {
      return hook('captureSnapshot');
    },
    status: labStatus
  };
}
