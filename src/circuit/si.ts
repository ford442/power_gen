/**
 * SI-prefix values for the wiring view and SPICE (#256): `4.7k`, `100n`,
 * `2.2m`, `1meg`, `10µ` / `10u`, `3e-6`, optionally followed by a unit
 * (`4.7kΩ`, `100nF`, `1.5mH`).
 *
 * SPICE is case-insensitive and reads `m` as milli and `meg` as mega; the
 * wiring view follows it except for an uppercase `M` *on its own* (`2M`),
 * which a person typing a resistor means as mega — SPICE import uses
 * `{ spice: true }` and gets milli, as SPICE would.
 */

const PREFIX: Readonly<Record<string, number>> = {
  f: 1e-15, p: 1e-12, n: 1e-9, u: 1e-6, 'µ': 1e-6, 'μ': 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, meg: 1e6, MEG: 1e6, Meg: 1e6, g: 1e9, G: 1e9, t: 1e12, T: 1e12
};

const NUM = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(meg|Meg|MEG|[fpnuµμmkKMgGtT])?\s*([A-Za-zΩ°/²]*)\s*$/;

/** Parse `4.7k`, `100nF`, `2.2e-3` … → number, or NaN. */
export function parseSi(text: string, opts: { spice?: boolean } = {}): number {
  const m = NUM.exec(text);
  if (!m) return Number.NaN;
  const base = Number(m[1]);
  const prefix = m[2];
  if (prefix === 'M') return base * (opts.spice ? 1e-3 : 1e6);
  const scale = prefix ? PREFIX[prefix] : 1;
  return scale === undefined ? Number.NaN : base * scale;
}

const ENG: readonly [number, string][] = [
  [1e12, 'T'], [1e9, 'G'], [1e6, 'M'], [1e3, 'k'], [1, ''],
  [1e-3, 'm'], [1e-6, 'µ'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']
];

/** 4700 → `4.7 k` (+ unit). `digits` significant figures (default 3). */
export function formatSi(value: number, unit = '', digits = 3): string {
  if (!Number.isFinite(value)) return `${value}${unit ? ` ${unit}` : ''}`;
  if (value === 0) return `0${unit ? ` ${unit}` : ''}`;
  const a = Math.abs(value);
  const row = ENG.find(([s]) => a >= s * 0.9995) ?? ENG[ENG.length - 1];
  const scaled = value / row[0];
  let text = scaled.toPrecision(digits);
  if (text.includes('e')) text = String(Number(text));
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return `${text} ${row[1]}${unit}`.trimEnd();
}

/** SPICE spelling: 4700 → `4.7k`, 1e-6 → `1u`, 2e6 → `2meg`. */
export function formatSpice(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const a = Math.abs(value);
  const rows: readonly [number, string][] = [
    [1e12, 't'], [1e9, 'g'], [1e6, 'meg'], [1e3, 'k'], [1, ''],
    [1e-3, 'm'], [1e-6, 'u'], [1e-9, 'n'], [1e-12, 'p'], [1e-15, 'f']
  ];
  const row = rows.find(([s]) => a >= s * 0.9999995) ?? rows[rows.length - 1];
  return `${Number((value / row[0]).toPrecision(7))}${row[1]}`;
}
