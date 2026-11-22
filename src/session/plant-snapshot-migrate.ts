/**
 * Plant-state migrations — what `plantStateVersion` (physics/devices.json,
 * generated `PLANT_STATE_VERSION`) buys.
 *
 * The layout hash already says "this C++ vector is not ours". It cannot say
 * what an old snapshot's *keyed* values mean once a plant has changed
 * underneath them. Each step below takes the keyed device values written at
 * one version and rewrites them for the next, so `parsePlantSnapshot` hands
 * every caller values of the reader's own version.
 *
 * Rules for a new step: pure, keyed values only (no physicsState, no wasm), and
 * a warning that says what was kept and what was made up.
 */
import { PELTIER } from '../../generated/physics-constants';
import { PLANT_STATE_VERSION } from '../../generated/device-state';

type DeviceStateValues = Record<string, number>;
type DeviceValues = Record<string, DeviceStateValues>;

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * 1 → 2: the Peltier bench stopped being a two-node thermoelectric generator
 * (heater in, Seebeck power out) and became a current-driven cooler with a
 * resolved leg (#fluids epic). A version-1 snapshot knows two plate
 * temperatures and nothing about the 28 nodes.
 *
 * Kept: the two plate temperatures, on the plates they were read from. Made
 * up: the cold block takes the cold plate's temperature, the sink the hot
 * plate's, and the leg cells the straight line between them — the steady
 * conduction profile with no current. The old electrical outputs described a
 * different machine and are zeroed; the next step recomputes them.
 */
function peltierResolvedLeg(devices: DeviceValues, warnings: string[]): string[] {
  const p = devices.peltier;
  if (!p || 'peltierNodesK[0]' in p) return [];
  const nodes = PELTIER.legCells + 4;
  const hot = finite(p.peltierHotK) ?? PELTIER.ambientK;
  const cold = finite(p.peltierColdK) ?? PELTIER.ambientK;
  for (let i = 0; i < nodes; i++) {
    const cell = i - 2;
    p[`peltierNodesK[${i}]`] = i <= 1 ? cold
      : i >= nodes - 2 ? hot
      : cold + ((hot - cold) * (cell + 0.5)) / PELTIER.legCells;
  }
  p.peltierHotK = hot;
  p.peltierColdK = cold;
  p.peltierDeltaT = hot - cold;
  p.peltierLoadW = 0;
  p.peltierPolarity = 1;
  p.peltierVoltage = 0;
  p.peltierCurrent = 0;
  p.peltierPowerW = 0;
  p.peltierCOP = 0;
  p.peltierQcW = 0;
  p.peltierQhW = 0;
  p.peltierStepH = 0;
  p.peltierStepErrOld = 1e-4;
  warnings.push(
    'peltier: snapshot predates the resolved cooler (plant state version 1) — plate temperatures kept, '
    + 'leg profile seeded as the straight line between them, electrical outputs reset'
  );
  return ['peltier'];
}

/** `MIGRATIONS[v - 1]` takes values written at version `v` to `v + 1`. */
const MIGRATIONS: readonly ((devices: DeviceValues, warnings: string[]) => string[])[] = [
  peltierResolvedLeg
];

/**
 * Bring keyed device values from `fromVersion` up to this build's
 * `PLANT_STATE_VERSION`, in place. Returns the ids of the devices it rewrote
 * (a C++ vector saved for one of them is no longer loadable as it stands).
 */
export function migratePlantState(devices: DeviceValues, fromVersion: number, warnings: string[] = []): string[] {
  const touched = new Set<string>();
  for (let v = Math.max(1, fromVersion); v < PLANT_STATE_VERSION; v++) {
    for (const id of MIGRATIONS[v - 1]?.(devices, warnings) ?? []) touched.add(id);
  }
  return [...touched];
}
