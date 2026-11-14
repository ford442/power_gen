#!/usr/bin/env node
/**
 * codegen-lab-config.mjs
 *
 * Reads config/lab-config.json and emits:
 *   generated/lab-config.ts            — typed `LabConfig`, field specs, defaults
 *   docs/AGENTS.md (marked block)      — the query-parameter matrix
 *
 * `--check` also fails when src/ reads `location.search` / `location.hash`,
 * `localStorage` / `sessionStorage` or builds a `URLSearchParams` anywhere
 * outside src/config/ — every knob goes through the one reader (#224). This is
 * the gate the epic asks an ESLint rule to be; it lives here until the repo
 * has ESLint (#222), and is a plain source scan so it needs no parser.
 *
 * Usage:
 *   node scripts/codegen-lab-config.mjs
 *   node scripts/codegen-lab-config.mjs --check
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_JSON = join(ROOT, 'config', 'lab-config.json');
const OUT_TS = join(ROOT, 'generated', 'lab-config.ts');
const AGENTS_MD = join(ROOT, 'docs', 'AGENTS.md');
const CHECK = process.argv.includes('--check');

const BEGIN = '<!-- lab-config:begin — AUTO-GENERATED from config/lab-config.json; edit that file, then npm run codegen:lab-config -->';
const END = '<!-- lab-config:end -->';

const TYPES = new Set(['bool', 'enum', 'number', 'int', 'string', 'list', 'setpoints']);
const CODECS = new Set(['bool', 'raw', 'int']);
const KEY_RE = /^[a-z][A-Za-z0-9]*$/;

/**
 * Raw config access is banned outside src/config/. Each pattern runs on the
 * source with comments stripped, so prose like "localStorage seg-lab-mode" in
 * a doc comment is fine.
 */
const RAW_ACCESS = [
  { re: /\blocation\.search\b/, what: 'location.search' },
  { re: /\blocation\.hash\b/, what: 'location.hash' },
  // Access, not mention: `localStorage.getItem`, `localStorage[k]`, `typeof localStorage`.
  { re: /\blocalStorage\s*[.[]|typeof\s+localStorage\b/, what: 'localStorage' },
  { re: /\bsessionStorage\s*[.[]|typeof\s+sessionStorage\b/, what: 'sessionStorage' },
  { re: /\bnew\s+URLSearchParams\s*\(/, what: 'new URLSearchParams(' }
];
const RAW_ACCESS_ALLOWED_DIRS = ['src/config/', 'src/public/'];

function fail(errors) {
  for (const e of errors) console.error(`[lab-config] ${e}`);
  process.exit(1);
}

function validate(data) {
  const errors = [];
  if (!Array.isArray(data.fields)) return ['`fields` must be an array'];
  const keys = new Set();
  const urls = new Map();
  const stores = new Map();
  for (const f of data.fields) {
    const where = `field ${JSON.stringify(f.key)}`;
    if (typeof f.key !== 'string' || !KEY_RE.test(f.key)) errors.push(`${where}: key must be camelCase`);
    if (keys.has(f.key)) errors.push(`${where}: duplicate key`);
    keys.add(f.key);
    if (!TYPES.has(f.type)) errors.push(`${where}: unknown type ${JSON.stringify(f.type)}`);
    if (!Array.isArray(f.url)) errors.push(`${where}: url must be an array of aliases (may be empty)`);
    for (const u of f.url ?? []) {
      if (urls.has(u)) errors.push(`${where}: URL alias ${u} already used by ${urls.get(u)}`);
      urls.set(u, f.key);
    }
    if (f.storage) {
      if (!CODECS.has(f.storage.codec)) errors.push(`${where}: storage codec must be bool | raw | int`);
      if (stores.has(f.storage.key)) errors.push(`${where}: storage key ${f.storage.key} already used by ${stores.get(f.storage.key)}`);
      stores.set(f.storage.key, f.key);
    }
    if (typeof f.share !== 'boolean' || typeof f.live !== 'boolean') errors.push(`${where}: share and live must be booleans`);
    if (typeof f.doc !== 'string' || !f.doc.trim()) errors.push(`${where}: doc is required (it is the matrix row)`);
    if (f.type === 'enum') {
      if (!Array.isArray(f.values) || !f.values.length) errors.push(`${where}: enum needs values`);
      if (f.default !== null && !f.values?.includes(f.default)) errors.push(`${where}: default ${f.default} not in values`);
      for (const [alias, to] of Object.entries(f.aliases ?? {})) {
        if (!f.values?.includes(to)) errors.push(`${where}: alias ${alias} → ${to} not in values`);
      }
      for (const v of f.storage?.values ?? []) {
        if (!f.values?.includes(v)) errors.push(`${where}: storage value ${v} not in values`);
      }
    }
    if (f.type === 'number' || f.type === 'int') {
      if (typeof f.min !== 'number' || typeof f.max !== 'number' || f.min > f.max) {
        errors.push(`${where}: ${f.type} needs min <= max`);
      }
      if (f.default !== null && (typeof f.default !== 'number' || f.default < f.min || f.default > f.max)) {
        errors.push(`${where}: default must be null or inside [min, max]`);
      }
    }
    if (f.type === 'bool' && f.default !== null && typeof f.default !== 'boolean') errors.push(`${where}: bool default must be true / false / null`);
    if (f.type === 'string' && f.pattern) {
      try { new RegExp(f.pattern); } catch (e) { errors.push(`${where}: bad pattern (${e.message})`); }
    }
    if (f.type === 'list' && !Array.isArray(f.default)) errors.push(`${where}: list default must be an array`);
    if (f.type === 'setpoints' && (typeof f.default !== 'object' || Array.isArray(f.default))) {
      errors.push(`${where}: setpoints default must be an object`);
    }
  }
  return errors;
}

function tsType(f) {
  const nul = f.default === null ? ' | null' : '';
  switch (f.type) {
    case 'bool': return `boolean${nul}`;
    case 'enum': return `${f.values.map((v) => `'${v}'`).join(' | ')}${nul}`;
    case 'number':
    case 'int': return `number${nul}`;
    case 'string': return `string${nul}`;
    case 'list': return 'readonly string[]';
    case 'setpoints': return 'Readonly<Record<string, number>>';
    default: throw new Error(f.type);
  }
}

function lit(v) {
  return JSON.stringify(v);
}

function specRow(f) {
  const parts = [
    `key: '${f.key}'`,
    `type: '${f.type}'`,
    `default: ${lit(f.default)}`
  ];
  if (f.values) parts.push(`values: ${lit(f.values)}`);
  if (f.aliases) parts.push(`aliases: ${lit(f.aliases)}`);
  if (f.min !== undefined) parts.push(`min: ${f.min}`);
  if (f.max !== undefined) parts.push(`max: ${f.max}`);
  if (f.exclusiveMin !== undefined) parts.push(`exclusiveMin: ${f.exclusiveMin}`);
  if (f.pattern) parts.push(`pattern: ${lit(f.pattern)}`);
  // Compact rows (entry-chunk bytes): `url` only when it is not `[key]`,
  // `share` / `live` only when true — LAB_CONFIG_FIELDS fills them back in.
  if (!(f.url.length === 1 && f.url[0] === f.key)) parts.push(`url: ${lit(f.url)}`);
  if (f.storage) {
    const s = [`key: '${f.storage.key}'`, `codec: '${f.storage.codec}'`];
    if (f.storage.values) s.push(`values: ${lit(f.storage.values)}`);
    parts.push(`storage: { ${s.join(', ')} }`);
  }
  if (f.share) parts.push('share: true');
  if (f.live) parts.push('live: true');
  return `  { ${parts.join(', ')} }`;
}

function emitTs(data, schemaHash) {
  const fields = data.fields;
  const iface = fields.map((f) => `  ${f.key}: ${tsType(f)};`).join('\n');
  return `/**
 * AUTO-GENERATED from config/lab-config.json — do not edit.
 * Regenerate: npm run codegen:lab-config
 *
 * Precedence for every field: URL > share hash (#lab2= / #lab=) > localStorage
 * > default. The reader is src/config/lab-config.ts; docs/AGENTS.md carries the
 * generated matrix (doc text stays out of this file to keep the entry chunk small).
 */

export type LabFieldType = 'bool' | 'enum' | 'number' | 'int' | 'string' | 'list' | 'setpoints';

export interface LabFieldStorage {
  key: string;
  /** \`bool\`: 'true'/'false' · \`raw\`: the value itself · \`int\`: decimal. */
  codec: 'bool' | 'raw' | 'int';
  /** Values honoured when read back from storage (others are ignored). */
  values?: readonly string[];
}

export interface LabFieldSpec {
  key: LabConfigKey;
  type: LabFieldType;
  default: unknown;
  values?: readonly string[];
  aliases?: Readonly<Record<string, string>>;
  min?: number;
  max?: number;
  /** A number at or below this is invalid (falls through), not clamped. */
  exclusiveMin?: number;
  pattern?: string;
  /** URL aliases; the first is canonical. */
  url: readonly string[];
  storage?: LabFieldStorage;
  /** Carried by #lab2= share links and \`.lab.json\`. */
  share: boolean;
  /** Applied to a running lab without a reload. */
  live: boolean;
}

export interface LabConfig {
${iface}
}

export type LabConfigKey = keyof LabConfig;

type LabFieldRow = Omit<LabFieldSpec, 'url' | 'share' | 'live'> & { url?: readonly string[]; share?: true; live?: true };

const ROWS: readonly LabFieldRow[] = [
${fields.map(specRow).join(',\n')}
];

export const LAB_CONFIG_FIELDS: readonly LabFieldSpec[] = ROWS.map((r) => ({ url: [r.key], share: false, live: false, ...r }));

/** Every field's default (validated against its type by the codegen). */
export const LAB_CONFIG_DEFAULTS = Object.fromEntries(
  LAB_CONFIG_FIELDS.map((f) => [f.key, f.default])
) as unknown as Readonly<LabConfig>;

/** Hash of the field specs — versions \`.lab.json\` and #lab2= payloads. */
export const LAB_CONFIG_SCHEMA_HASH = '${schemaHash}';
`;
}

function mdEscape(s) {
  return String(s).replace(/\|/g, '\\|');
}

function docValues(f) {
  if (f.docValues) return f.docValues;
  switch (f.type) {
    case 'bool': return '`1` \\| `0`';
    case 'enum': return f.values.map((v) => `\`${v}\``).join(' \\| ');
    case 'number':
    case 'int': return `\`${f.min}\`–\`${f.max}\``;
    default: return f.type;
  }
}

function docDefault(f) {
  if (f.docDefault) return f.docDefault;
  if (f.default === null) return 'unset';
  if (f.type === 'bool') return f.default ? 'on' : 'off';
  return `\`${f.default}\``;
}

function emitMatrix(data) {
  const params = data.fields.filter((f) => f.url.length);
  const stateOnly = data.fields.filter((f) => !f.url.length);
  const rows = params.map((f) => {
    const name = f.url.map((u) => `\`${u}\``).join(' / ');
    const stored = f.storage ? `\`${f.storage.key}\`` : '—';
    return `| ${name} | ${docValues(f)} | ${docDefault(f)} | ${stored} | ${f.share ? 'yes' : '—'} | ${f.doc} |`;
  });
  const stateRows = stateOnly.map((f) =>
    `| \`${f.key}\` | ${docValues(f)} | ${docDefault(f)} | ${f.doc} |`);
  return `${BEGIN}

**Precedence (every field):** URL query param > share-link hash (\`#lab2=\`, or a
legacy \`#lab=v1;…\`) > \`localStorage\` > default. Booleans accept
\`1/0/on/off/true/false/yes/no\` everywhere; numbers are finite-checked and
clamped, so NaN from a hand-edited link never reaches a plant; anything
unparsable falls through to the next layer. One reader —
\`src/config/lab-config.ts\` — and \`npm run check:lab-config\` fails on drift or on
raw \`location.search\` / \`localStorage\` access anywhere else in \`src/\`.

| Param | Values | Default | Stored | Share | Effect |
|-------|--------|---------|--------|-------|--------|
${rows.join('\n')}

**Share-link state** — not query params; carried by \`#lab2=\` links and
\`.lab.json\` (\`window.lab.loadConfig\`), applied live:

| Field | Values | Default | Effect |
|-------|--------|---------|--------|
${stateRows.join('\n')}

**Share links v2:** \`#lab2=\` + base64url(\`deflate-raw\`(JSON of the non-default
share fields)), native \`CompressionStream\` (an uncompressed \`j\` codec where
it is missing), no library. Only share fields travel — a link cannot pick the
renderer or GPU flags. Old \`#lab=v1;…\` links still parse. A query param
still outranks the hash, so loading a \`.lab.json\` also drops the params it
overrides from the address bar. Details: [\`LAB_CONFIG.md\`](./LAB_CONFIG.md).

${END}`;
}

function spliceAgents(md, block) {
  const a = md.indexOf(BEGIN);
  const b = md.indexOf(END);
  if (a >= 0 && b > a) return md.slice(0, a) + block + md.slice(b + END.length);
  // First run: replace the hand-written matrix (header line through the
  // "Related (not always query)" storage table) with the generated block.
  const start = md.indexOf('All params are on the page URL search string');
  const stop = md.indexOf('Example:', start);
  if (start < 0 || stop < 0) throw new Error('docs/AGENTS.md: cannot find the query-parameter matrix to replace');
  return `${md.slice(0, start)}${block}\n\n${md.slice(stop)}`;
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

function checkRawAccess() {
  const errors = [];
  for (const file of walk(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split(sep).join('/');
    if (RAW_ACCESS_ALLOWED_DIRS.some((d) => rel.startsWith(d))) continue;
    const lines = stripComments(readFileSync(file, 'utf8')).split('\n');
    lines.forEach((line, i) => {
      for (const { re, what } of RAW_ACCESS) {
        if (re.test(line)) {
          errors.push(`${rel}:${i + 1}: raw ${what} — read/write it through src/config/lab-config.ts`);
        }
      }
    });
  }
  return errors;
}

function writeOrCheck(path, content) {
  let existing = null;
  try { existing = readFileSync(path, 'utf8'); } catch { /* missing */ }
  if (CHECK) {
    if (existing !== content) fail([`stale: ${relative(ROOT, path)} — run npm run codegen:lab-config`]);
    return;
  }
  if (existing === content) return;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function main() {
  const raw = readFileSync(SRC_JSON, 'utf8');
  const data = JSON.parse(raw);
  const errors = validate(data);
  if (errors.length) fail(errors);

  // Hash the machine-relevant spec only, so a doc-text edit does not
  // invalidate saved .lab.json files.
  const specOnly = data.fields.map(({ doc, docValues: _v, docDefault: _d, group: _g, ...rest }) => rest);
  const schemaHash = createHash('sha256').update(JSON.stringify(specOnly)).digest('hex').slice(0, 12);

  writeOrCheck(OUT_TS, emitTs(data, schemaHash));
  const agents = readFileSync(AGENTS_MD, 'utf8');
  writeOrCheck(AGENTS_MD, spliceAgents(agents, emitMatrix(data)));

  if (CHECK) {
    const rawErrors = checkRawAccess();
    if (rawErrors.length) fail(rawErrors);
    console.log(`[lab-config] OK — ${data.fields.length} fields, generated files current, no raw config access outside src/config/`);
  } else {
    console.log(`[lab-config] wrote generated/lab-config.ts + docs/AGENTS.md matrix (${data.fields.length} fields, schema ${schemaHash})`);
  }
}

main();
