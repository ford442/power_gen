/**
 * catalog-ports.mjs — the `ports` half of codegen-device-catalog (#256, ADR-0018).
 *
 * A bench the Circuit Lab can wire declares its electrical ports in
 * physics/devices.json:
 *
 *   "ports": [
 *     { "id": "out",                         port id (unique per device)
 *       "label": "Disc brushes",             wiring-view glyph label
 *       "terminals": ["rim +", "axle −"],    the two terminal labels (+ first)
 *       "driver": "homopolar-emf",           a driver in src/circuit/ports.ts
 *       "model": "one line: what the circuit sees" }
 *   ]
 *
 * The driver owns the bench's own R / L / source (its numbers come from
 * physics/constants.json through generated/physics-constants.ts, never from
 * here), the plant ⇄ circuit exchange per substep and the port's energy.
 * Codegen checks every `driver` is a name src/circuit/ports.ts registers.
 *
 * Emits generated/circuit-ports.ts and the "Circuit Lab ports" section of
 * docs/MODE_MATRIX.md (emitPortsMatrix).
 */

const PORT_KEYS = ['id', 'label', 'terminals', 'driver', 'model'];
const ID = /^[a-z][a-z0-9-]{0,15}$/;

/** Validation errors for every device's `ports`. `driverNames`: what ports.ts registers. */
export function validatePorts(devices, driverNames) {
  const errors = [];
  for (const d of devices) {
    if (d.ports === undefined) continue;
    const where = `${d.id}.ports`;
    if (!Array.isArray(d.ports) || d.ports.length === 0) {
      errors.push(`${where}: a non-empty array`);
      continue;
    }
    const seen = new Set();
    d.ports.forEach((p, i) => {
      const at = `${where}[${i}]`;
      if (!p || typeof p !== 'object') return void errors.push(`${at}: an object`);
      for (const k of Object.keys(p)) if (!PORT_KEYS.includes(k)) errors.push(`${at}: unknown property "${k}"`);
      if (typeof p.id !== 'string' || !ID.test(p.id)) errors.push(`${at}.id: lowercase id`);
      else if (seen.has(p.id)) errors.push(`${at}.id: duplicate ${p.id}`);
      seen.add(p.id);
      if (typeof p.label !== 'string' || !p.label) errors.push(`${at}.label: a string`);
      if (typeof p.model !== 'string' || !p.model) errors.push(`${at}.model: one line on what is idealised`);
      if (!Array.isArray(p.terminals) || p.terminals.length !== 2 || p.terminals.some((t) => typeof t !== 'string' || !t)) {
        errors.push(`${at}.terminals: two labels [+, −]`);
      }
      if (typeof p.driver !== 'string' || !driverNames.includes(p.driver)) {
        errors.push(`${at}.driver: ${JSON.stringify(p.driver)} is not a driver in src/circuit/ports.ts (${driverNames.join(', ')})`);
      }
    });
  }
  return errors;
}

export function emitCircuitPortsTs(devices, header) {
  const rows = [];
  for (const d of devices) {
    for (const p of d.ports ?? []) {
      rows.push(`  ${JSON.stringify({ device: d.id, id: p.id, label: p.label, terminals: p.terminals, driver: p.driver, model: p.model })}`);
    }
  }
  return `${header}
export interface CircuitPortDecl {
  /** Catalog device id. */
  device: string;
  id: string;
  label: string;
  terminals: readonly [string, string];
  /** Driver in src/circuit/ports.ts. */
  driver: string;
  model: string;
}

export const CIRCUIT_PORTS: readonly CircuitPortDecl[] = [
${rows.join(',\n')}
];

/** Devices with at least one port. */
export const CIRCUIT_PORT_DEVICES: readonly string[] = ${JSON.stringify([...new Set(devices.filter((d) => d.ports).map((d) => d.id))])};
`;
}

/** The MODE_MATRIX.md section: every port, and which backend solves it. */
export function emitPortsMatrix(devices) {
  const md = (t) => String(t).replace(/\|/g, '\\|');
  const rows = [];
  for (const d of devices) {
    for (const p of d.ports ?? []) {
      rows.push(`| \`${d.id}\` | \`${p.id}\` (${md(p.label)}) | ${p.terminals.map(md).join(' / ')} | \`${p.driver}\` | ${md(p.model)} |`);
    }
  }
  return `## Circuit Lab ports

A \`ports\` block lets the Circuit Lab (#256, [ADR-0018](adr/0018-circuit-lab.md),
[\`CIRCUIT.md\`](CIRCUIT.md)) wire a bench into a drawn circuit. The circuit is
solved by the C++ MNA solver in \`sim_core.wasm\` on **both renderers and
whatever \`wasmPhysics\` says** — \`wasmPhysics\` picks the plant backend, and
sim_core loads at boot either way. While a circuit owns a bench, that
bench's own plant (JS or C++) does not step it: its port driver does, with
the circuit, once per substep — from the plant's own equations where it has
mechanics (the disc's drive and drag), with the circuit's current in place
of the bench's fixed load. Other benches keep their backend.
Without \`sim_core.wasm\` the wiring view opens read-only with a
"needs WASM" note: there is no TS mirror of the solver.

| Device \`id\` | Port | Terminals (+ / −) | Driver | What the circuit sees |
|---|---|---|---|---|
${rows.join('\n')}
`;
}
