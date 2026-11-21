/**
 * wgsl-mini.mjs — run a compute shader's own WGSL text on the CPU (test-only).
 *
 * CI has no GPU and naga validates but does not execute, so the field-volume
 * golden (test:field-volume) compiles the shader text into JS with this:
 * a parser for the WGSL subset the field passes use, a light type pass
 * (scalar kind + vector width, so `u32` arithmetic wraps and `f32` rounds),
 * and code generation in which every f32 operation is rounded with
 * Math.fround. `workgroupBarrier()` becomes a generator `yield`, and a
 * dispatch steps every invocation of a workgroup in lockstep between
 * barriers — so a kernel that tiles through `var<workgroup>` memory runs
 * with the semantics it has on a GPU.
 *
 * Supported: struct / const / override-free module scope; `var<uniform>`,
 * `var<storage>`, `var<workgroup>`, `texture_storage_3d` (textureStore into
 * a Float32Array, rounded to f16 for *16float formats); fn with typed params;
 * let / var / assignment / compound assignment / ++ / if-else / for / break /
 * continue / return; vecNf / vecNu / vecNi constructors and splats, swizzles,
 * struct constructors, array indexing; the builtins listed in BUILTINS.
 * Not supported (throws): pointers, textures other than the storage write,
 * matrices, `loop` / `while` / `switch`, atomics.
 *
 * Semantics are close, not bit-exact: transcendental builtins use double
 * then round, and a GPU may fuse multiply-adds. Compare under a tolerance.
 * Replaced by a real Dawn-in-Node readback once #258 lands.
 */
/** Nearest IEEE half (Node ≥ 24 ships Math.f16round). */
const roundF16Value = (v) => Math.f16round(v);

// ── Lexer ───────────────────────────────────────────────────────────────
const TOKEN_RE = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|(0x[0-9a-fA-F]+[ui]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[fuih]?)|([A-Za-z_][A-Za-z0-9_]*)|(->|\+\+|--|\+=|-=|\*=|\/=|%=|&&|\|\||<=|>=|==|!=|<<|>>|[-+*/%<>=!&|^~(){}[\];:,.@])/y;

function lex(src) {
  const toks = [];
  TOKEN_RE.lastIndex = 0;
  let m;
  while (TOKEN_RE.lastIndex < src.length && (m = TOKEN_RE.exec(src))) {
    if (m[1] !== undefined) toks.push({ t: 'num', v: m[1] });
    else if (m[2] !== undefined) toks.push({ t: 'id', v: m[2] });
    else if (m[3] !== undefined) toks.push({ t: 'op', v: m[3] });
  }
  if (TOKEN_RE.lastIndex < src.length) throw new Error(`wgsl-mini: cannot lex at ${src.slice(TOKEN_RE.lastIndex, TOKEN_RE.lastIndex + 30)}`);
  toks.push({ t: 'eof', v: '' });
  return toks;
}

// ── Types ───────────────────────────────────────────────────────────────
// { k: 'f'|'u'|'i'|'b'|'af'|'ai', n: 1..4 } | { struct: name } | { array: T, len } | { tex: format } | { v: 'void' }
const SCALARS = { f32: 'f', u32: 'u', i32: 'i', bool: 'b' };
const VECS = { f: 'f', u: 'u', i: 'i' };

function parseTypeName(p) {
  const name = p.ident();
  if (SCALARS[name]) return { k: SCALARS[name], n: 1 };
  let vm = name.match(/^vec([234])([fui])$/);
  if (vm) return { k: VECS[vm[2]], n: Number(vm[1]) };
  vm = name.match(/^vec([234])$/);
  if (vm) {
    p.expect('<');
    const inner = parseTypeName(p);
    p.expect('>');
    return { k: inner.k, n: Number(vm[1]) };
  }
  if (name === 'array') {
    p.expect('<');
    const el = parseTypeName(p);
    let len = null;
    if (p.eat(',')) len = Number(p.next().v.replace(/[ui]$/, ''));
    p.expect('>');
    return { array: el, len };
  }
  if (name === 'texture_storage_3d') {
    p.expect('<');
    const fmt = p.ident();
    p.expect(',');
    p.ident();
    p.expect('>');
    return { tex: fmt };
  }
  if (name === 'ptr' || name.startsWith('mat') || name.startsWith('texture') || name === 'sampler' || name.startsWith('atomic')) {
    throw new Error(`wgsl-mini: unsupported type ${name}`);
  }
  return { struct: name };
}

const isVec = (t) => t && t.n > 1;
const concrete = (k) => (k === 'af' ? 'f' : k === 'ai' ? 'i' : k);
function unify(a, b) {
  // abstract literals adopt the other side's kind
  const ka = a.k, kb = b.k;
  let k;
  if (ka === kb) k = ka;
  else if (ka === 'ai' || ka === 'af') k = kb === 'ai' && ka === 'af' ? 'af' : kb;
  else if (kb === 'ai' || kb === 'af') k = ka;
  else throw new Error(`wgsl-mini: kind mismatch ${ka} vs ${kb}`);
  return { k, n: Math.max(a.n, b.n) };
}

// ── Parser → AST ───────────────────────────────────────────────────────
class Parser {
  constructor(toks) { this.toks = toks; this.i = 0; }
  peek(o = 0) { return this.toks[this.i + o]; }
  next() { return this.toks[this.i++]; }
  is(v) { return this.peek().v === v; }
  eat(v) { if (this.is(v)) { this.i++; return true; } return false; }
  expect(v) { const t = this.next(); if (t.v !== v) throw new Error(`wgsl-mini: expected '${v}' got '${t.v}'`); return t; }
  ident() { const t = this.next(); if (t.t !== 'id') throw new Error(`wgsl-mini: expected identifier, got '${t.v}'`); return t.v; }
  attrs() {
    const out = {};
    while (this.is('@')) {
      this.next();
      const name = this.ident();
      const args = [];
      if (this.eat('(')) {
        while (!this.is(')')) { args.push(this.next().v); this.eat(','); }
        this.expect(')');
      }
      out[name] = args;
    }
    return out;
  }

  module() {
    const mod = { structs: {}, consts: [], globals: [], fns: {} };
    while (this.peek().t !== 'eof') {
      const at = this.attrs();
      const kw = this.ident();
      if (kw === 'enable' || kw === 'requires' || kw === 'diagnostic') { while (!this.eat(';')) this.next(); continue; }
      if (kw === 'struct') {
        const name = this.ident();
        const fields = [];
        this.expect('{');
        while (!this.eat('}')) {
          this.attrs();
          const f = this.ident();
          this.expect(':');
          fields.push({ name: f, type: parseTypeName(this) });
          this.eat(',');
        }
        this.eat(';');
        mod.structs[name] = fields;
      } else if (kw === 'const') {
        const name = this.ident();
        let type = null;
        if (this.eat(':')) type = parseTypeName(this);
        this.expect('=');
        const init = this.expr();
        this.expect(';');
        mod.consts.push({ name, type, init });
      } else if (kw === 'var') {
        let space = null;
        if (this.eat('<')) { space = this.ident(); if (this.eat(',')) this.ident(); this.expect('>'); }
        const name = this.ident();
        this.expect(':');
        const type = parseTypeName(this);
        this.expect(';');
        mod.globals.push({ name, type, space, binding: at.binding ? Number(at.binding[0]) : null, group: at.group ? Number(at.group[0]) : null });
      } else if (kw === 'fn') {
        const name = this.ident();
        this.expect('(');
        const params = [];
        while (!this.eat(')')) {
          const pa = this.attrs();
          const pn = this.ident();
          this.expect(':');
          params.push({ name: pn, type: parseTypeName(this), builtin: pa.builtin?.[0] ?? null });
          this.eat(',');
        }
        let ret = { v: 'void' };
        if (this.eat('->')) { this.attrs(); ret = parseTypeName(this); }
        const body = this.block();
        mod.fns[name] = { name, params, ret, body, compute: !!at.compute, workgroupSize: at.workgroup_size?.map((v) => Number(v.replace(/u$/, ''))) };
      } else {
        throw new Error(`wgsl-mini: unsupported module item '${kw}'`);
      }
    }
    return mod;
  }

  block() {
    this.expect('{');
    const stmts = [];
    while (!this.eat('}')) stmts.push(this.stmt());
    return { s: 'block', stmts };
  }

  stmt() {
    if (this.is('{')) return this.block();
    const t = this.peek();
    if (t.v === 'let' || t.v === 'var' || t.v === 'const') {
      this.next();
      const name = this.ident();
      let type = null;
      if (this.eat(':')) type = parseTypeName(this);
      let init = null;
      if (this.eat('=')) init = this.expr();
      this.expect(';');
      return { s: 'decl', mut: t.v === 'var', name, type, init };
    }
    if (t.v === 'if') {
      this.next();
      const cond = this.expr();
      const then = this.block();
      let els = null;
      if (this.eat('else')) els = this.is('if') ? this.stmt() : this.block();
      return { s: 'if', cond, then, els };
    }
    if (t.v === 'for') {
      this.next();
      this.expect('(');
      const init = this.is(';') ? null : this.simple();
      this.expect(';');
      const cond = this.is(';') ? null : this.expr();
      this.expect(';');
      const update = this.is(')') ? null : this.simple(true);
      this.expect(')');
      return { s: 'for', init, cond, update, body: this.block() };
    }
    if (t.v === 'return') { this.next(); const e = this.is(';') ? null : this.expr(); this.expect(';'); return { s: 'return', e }; }
    if (t.v === 'break') { this.next(); this.expect(';'); return { s: 'break' }; }
    if (t.v === 'continue') { this.next(); this.expect(';'); return { s: 'continue' }; }
    if (t.v === 'loop' || t.v === 'while' || t.v === 'switch') throw new Error(`wgsl-mini: unsupported statement ${t.v}`);
    const s = this.simple();
    this.expect(';');
    return s;
  }

  /** decl / assignment / increment / call statement (no trailing ';'). */
  simple() {
    const t = this.peek();
    if (t.v === 'var' || t.v === 'let') {
      this.next();
      const name = this.ident();
      let type = null;
      if (this.eat(':')) type = parseTypeName(this);
      this.expect('=');
      return { s: 'decl', mut: t.v === 'var', name, type, init: this.expr() };
    }
    const lhs = this.expr();
    if (this.eat('++')) return { s: 'assign', op: '+', lhs, rhs: { e: 'num', v: '1', t: null } };
    if (this.eat('--')) return { s: 'assign', op: '-', lhs, rhs: { e: 'num', v: '1', t: null } };
    const op = this.peek().v;
    if (['=', '+=', '-=', '*=', '/=', '%='].includes(op)) {
      this.next();
      return { s: 'assign', op: op === '=' ? null : op[0], lhs, rhs: this.expr() };
    }
    return { s: 'expr', e: lhs };
  }

  expr(minPrec = 0) {
    const PREC = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '>': 7, '<=': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
    let left = this.unary();
    for (;;) {
      const op = this.peek().v;
      const p = this.peek().t === 'op' ? PREC[op] : undefined;
      if (p === undefined || p < minPrec) return left;
      this.next();
      const right = this.expr(p + 1);
      left = { e: 'bin', op, a: left, b: right };
    }
  }

  unary() {
    if (this.eat('-')) return { e: 'un', op: '-', a: this.unary() };
    if (this.eat('!')) return { e: 'un', op: '!', a: this.unary() };
    if (this.eat('&') || this.eat('*')) throw new Error('wgsl-mini: pointers are not supported');
    return this.postfix(this.primary());
  }

  primary() {
    const t = this.next();
    if (t.t === 'num') return { e: 'num', v: t.v };
    if (t.v === '(') { const e = this.expr(); this.expect(')'); return e; }
    if (t.t === 'id') {
      if (t.v === 'true' || t.v === 'false') return { e: 'bool', v: t.v === 'true' };
      // Templated constructor: vec3<f32>(…) / array<T, N>(…)
      if (this.is('<') && (/^vec[234]$/.test(t.v) || t.v === 'array')) {
        this.i--;
        const type = parseTypeName(this);
        return { e: 'call', name: t.v, ctorType: type, args: this.args() };
      }
      if (this.is('(')) return { e: 'call', name: t.v, args: this.args() };
      return { e: 'id', name: t.v };
    }
    throw new Error(`wgsl-mini: unexpected '${t.v}'`);
  }

  args() {
    this.expect('(');
    const out = [];
    while (!this.eat(')')) { out.push(this.expr()); this.eat(','); }
    return out;
  }

  postfix(e) {
    for (;;) {
      if (this.eat('.')) e = { e: 'member', a: e, name: this.ident() };
      else if (this.eat('[')) { const i = this.expr(); this.expect(']'); e = { e: 'index', a: e, i }; }
      else return e;
    }
  }
}

// ── Code generation ─────────────────────────────────────────────────────
const SWZ = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 };
const BUILTINS = new Set(['abs', 'min', 'max', 'clamp', 'sqrt', 'inverseSqrt', 'log', 'log2', 'exp', 'exp2', 'pow', 'sin', 'cos', 'tan',
  'atan', 'atan2', 'floor', 'ceil', 'round', 'fract', 'sign', 'length', 'distance', 'dot', 'cross', 'normalize', 'mix', 'select',
  'all', 'any', 'f32', 'u32', 'i32', 'bool', 'textureStore', 'workgroupBarrier', 'tanh', 'smoothstep', 'step']);

class Gen {
  constructor(mod) {
    this.mod = mod;
    this.scopes = [];
    this.fnTypes = {};
    for (const f of Object.values(mod.fns)) this.fnTypes[f.name] = f.ret;
    this.inEntry = false;
  }
  push() { this.scopes.push(new Map()); }
  pop() { this.scopes.pop(); }
  declare(name, type) { this.scopes[this.scopes.length - 1].set(name, type); }
  lookup(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    throw new Error(`wgsl-mini: unknown identifier ${name}`);
  }
  js(name) { return `v_${name}`; }

  /** → [jsSource, type] */
  ex(n) {
    switch (n.e) {
      case 'num': {
        let v = n.v;
        if (/[uih]$/.test(v) && !v.startsWith('0x')) {
          const suf = v.at(-1);
          v = v.slice(0, -1);
          return [String(Number(v)), { k: suf === 'u' ? 'u' : suf === 'i' ? 'i' : 'f', n: 1 }];
        }
        if (v.endsWith('f')) return [`${Math.fround(Number(v.slice(0, -1)))}`, { k: 'f', n: 1 }];
        const isFloat = /[.eE]/.test(v) && !v.startsWith('0x');
        return [String(Number(v)), { k: isFloat ? 'af' : 'ai', n: 1 }];
      }
      case 'bool': return [String(n.v), { k: 'b', n: 1 }];
      case 'id': return [this.js(n.name), this.lookup(n.name)];
      case 'un': {
        const [a, t] = this.ex(n.a);
        if (n.op === '!') return [`$not(${a})`, t];
        return [`$neg(${a},'${concrete(t.k)}')`, t];
      }
      case 'bin': return this.bin(n);
      case 'member': {
        const [a, t] = this.ex(n.a);
        if (t.struct) {
          const f = this.mod.structs[t.struct]?.find((x) => x.name === n.name);
          if (!f) throw new Error(`wgsl-mini: ${t.struct} has no field ${n.name}`);
          return [`${a}.${n.name}`, f.type];
        }
        if (isVec(t)) {
          const idx = [...n.name].map((c) => SWZ[c]);
          if (idx.length === 1) return [`${a}[${idx[0]}]`, { k: t.k, n: 1 }];
          return [`$swz(${a},[${idx.join(',')}])`, { k: t.k, n: idx.length }];
        }
        throw new Error(`wgsl-mini: member ${n.name} of non-struct`);
      }
      case 'index': {
        const [a, t] = this.ex(n.a);
        const [i] = this.ex(n.i);
        if (t.array) return [`${a}[${i}]`, t.array];
        if (isVec(t)) return [`${a}[${i}]`, { k: t.k, n: 1 }];
        throw new Error('wgsl-mini: index of non-array');
      }
      case 'call': return this.call(n);
    }
    throw new Error(`wgsl-mini: bad expression ${n.e}`);
  }

  bin(n) {
    const [a, ta] = this.ex(n.a);
    const [b, tb] = this.ex(n.b);
    const op = n.op;
    if (op === '&&' || op === '||') return [`(${a} ${op} ${b})`, { k: 'b', n: 1 }];
    const u = unify(ta, tb);
    const k = concrete(u.k);
    if (['<', '>', '<=', '>=', '==', '!='].includes(op)) return [`$cmp('${op}',${a},${b})`, { k: 'b', n: u.n }];
    const name = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '&': 'band', '|': 'bor', '^': 'bxor', '<<': 'shl', '>>': 'shr' }[op];
    return [`$${name}(${a},${b},'${k}')`, u];
  }

  call(n) {
    const name = n.name;
    const args = n.args.map((x) => this.ex(x));
    const src = args.map((x) => x[0]);
    const types = args.map((x) => x[1]);
    // constructors
    const vm = name.match(/^vec([234])([fui])?$/);
    if (vm) {
      const t = n.ctorType ?? { k: vm[2] ? VECS[vm[2]] : concrete(types[0]?.k ?? 'f'), n: Number(vm[1]) };
      return [`$vec(${t.n},'${t.k}',[${src.join(',')}])`, t];
    }
    if (name === 'array') return [`[${src.join(',')}]`, n.ctorType];
    if (this.mod.structs[name]) {
      const fields = this.mod.structs[name];
      return [`({${fields.map((f, i) => `${f.name}: $copy(${src[i]})`).join(', ')}})`, { struct: name }];
    }
    if (this.mod.fns[name]) return [`f_${name}(${src.join(',')})`, this.fnTypes[name]];
    if (!BUILTINS.has(name)) throw new Error(`wgsl-mini: unsupported builtin ${name}`);
    const t0 = types[0] ?? { k: 'f', n: 1 };
    const k0 = concrete(t0.k);
    switch (name) {
      case 'f32': return [`$cast(${src[0]},'f')`, { k: 'f', n: 1 }];
      case 'u32': return [`$cast(${src[0]},'u')`, { k: 'u', n: 1 }];
      case 'i32': return [`$cast(${src[0]},'i')`, { k: 'i', n: 1 }];
      case 'bool': return [`!!(${src[0]})`, { k: 'b', n: 1 }];
      case 'length': case 'distance': return [`$${name}(${src.join(',')})`, { k: 'f', n: 1 }];
      case 'dot': return [`$dot(${src.join(',')},'${k0}')`, { k: k0, n: 1 }];
      case 'all': case 'any': return [`$${name}(${src[0]})`, { k: 'b', n: 1 }];
      case 'select': {
        const u = unify(types[0], types[1]);
        return [`$select(${src[0]},${src[1]},${src[2]})`, { k: concrete(u.k), n: u.n }];
      }
      case 'min': case 'max': case 'clamp': {
        let u = types[0];
        for (const t of types.slice(1)) u = unify(u, t);
        return [`$${name}(${src.join(',')},'${concrete(u.k)}')`, { k: concrete(u.k), n: u.n }];
      }
      case 'textureStore': return [`$texStore(${src.join(',')})`, { v: 'void' }];
      case 'workgroupBarrier':
        if (!this.inEntry) throw new Error('wgsl-mini: workgroupBarrier() outside the entry point');
        return ['(yield)', { v: 'void' }];
      case 'abs': case 'sign': return [`$map1(${src[0]},'${name}','${k0}')`, { k: k0, n: t0.n }];
      default:
        // float math, component-wise
        return [`$fmath('${name}',[${src.join(',')}])`, { k: 'f', n: Math.max(...types.map((t) => t.n ?? 1)) }];
    }
  }

  lvalue(n) {
    if (n.e === 'id') return { base: null, ref: this.js(n.name), type: this.lookup(n.name) };
    const [a, t] = this.ex(n.e === 'member' ? n.a : n.a);
    if (n.e === 'member') {
      if (t.struct) {
        const f = this.mod.structs[t.struct].find((x) => x.name === n.name);
        return { ref: `${a}.${n.name}`, type: f.type };
      }
      if (n.name.length !== 1) throw new Error('wgsl-mini: multi-component swizzle assignment');
      return { ref: `${a}[${SWZ[n.name]}]`, type: { k: t.k, n: 1 } };
    }
    if (n.e === 'index') {
      const [i] = this.ex(n.i);
      return { ref: `${a}[${i}]`, type: t.array ?? { k: t.k, n: 1 } };
    }
    throw new Error('wgsl-mini: bad assignment target');
  }

  st(n, out) {
    switch (n.s) {
      case 'block':
        this.push();
        out.push('{');
        for (const s of n.stmts) this.st(s, out);
        out.push('}');
        this.pop();
        return;
      case 'decl': {
        let src, type = n.type;
        if (n.init) {
          const [s, t] = this.ex(n.init);
          type = type ?? (t.k ? { k: concrete(t.k), n: t.n } : t);
          src = t.k ? `$conv(${s},'${type.k}')` : `$copy(${s})`;
        } else {
          src = `$zero(${JSON.stringify(type)}, STRUCTS)`;
        }
        this.declare(n.name, type);
        out.push(`let ${this.js(n.name)} = ${src};`);
        return;
      }
      case 'assign': {
        const lv = this.lvalue(n.lhs);
        const [r, rt] = this.ex(n.rhs);
        if (!n.op) {
          out.push(`${lv.ref} = ${rt.k ? `$conv(${r},'${lv.type.k}')` : `$copy(${r})`};`);
        } else {
          const name = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod' }[n.op];
          out.push(`${lv.ref} = $${name}(${lv.ref},${r},'${lv.type.k}');`);
        }
        return;
      }
      case 'expr': out.push(`${this.ex(n.e)[0]};`); return;
      case 'if': {
        out.push(`if (${this.ex(n.cond)[0]})`);
        this.st(n.then, out);
        if (n.els) { out.push('else'); this.st(n.els, out); }
        return;
      }
      case 'for': {
        this.push();
        const init = [];
        if (n.init) this.st(n.init, init);
        out.push('{', ...init);
        const upd = [];
        if (n.update) this.st(n.update, upd);
        out.push(`for (; ${n.cond ? this.ex(n.cond)[0] : 'true'}; ${upd.join(' ').replace(/;$/, '').replace(/;/g, ',')})`);
        this.st(n.body, out);
        out.push('}');
        this.pop();
        return;
      }
      case 'return': out.push(n.e ? `return ${this.ex(n.e)[0]};` : 'return;'); return;
      case 'break': out.push('break;'); return;
      case 'continue': out.push('continue;'); return;
    }
    throw new Error(`wgsl-mini: bad statement ${n.s}`);
  }

  fn(f, entry) {
    this.inEntry = entry;
    this.push();
    const out = [];
    const params = f.params.map((p) => { this.declare(p.name, p.type); return this.js(p.name); });
    out.push(`function${entry ? '*' : ''} f_${f.name}(${params.join(', ')})`);
    this.st(f.body, out);
    this.pop();
    this.inEntry = false;
    return out.join('\n');
  }
}

// ── Runtime ─────────────────────────────────────────────────────────────
const fr = Math.fround;
const kindRound = (v, k) => (k === 'f' ? fr(v) : k === 'u' ? (Math.trunc(v) >>> 0) : k === 'i' ? (Math.trunc(v) | 0) : v);
const zip = (a, b, fn) => {
  const A = Array.isArray(a), B = Array.isArray(b);
  if (!A && !B) return fn(a, b);
  const n = A ? a.length : b.length;
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = fn(A ? a[i] : a, B ? b[i] : b);
  return out;
};
const RT = {
  $copy: (v) => (Array.isArray(v) ? v.map(RT.$copy) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, RT.$copy(x)])) : v),
  $conv: (v, k) => (Array.isArray(v) ? v.map((x) => kindRound(x, k)) : typeof v === 'number' ? kindRound(v, k) : v),
  $cast: (v, k) => (Array.isArray(v) ? v.map((x) => RT.$cast(x, k)) : k === 'f' ? fr(Number(v)) : k === 'u' ? (Math.max(0, Math.trunc(Number(v))) >>> 0) : Math.trunc(Number(v)) | 0),
  $zero(type, structs) {
    if (type.k) return type.n > 1 ? new Array(type.n).fill(type.k === 'b' ? false : 0) : (type.k === 'b' ? false : 0);
    if (type.struct) return Object.fromEntries(structs[type.struct].map((f) => [f.name, RT.$zero(f.type, structs)]));
    if (type.array) return Array.from({ length: type.len }, () => RT.$zero(type.array, structs));
    throw new Error('wgsl-mini: cannot zero type');
  },
  $vec(n, k, args) {
    const flat = [];
    for (const a of args) Array.isArray(a) ? flat.push(...a) : flat.push(a);
    if (flat.length === 0) return new Array(n).fill(0);
    if (flat.length === 1) return new Array(n).fill(kindRound(flat[0], k));
    if (flat.length !== n) throw new Error(`wgsl-mini: vec${n} from ${flat.length} components`);
    return flat.map((x) => kindRound(x, k));
  },
  $swz: (v, idx) => idx.map((i) => v[i]),
  $neg: (a, k) => zip(a, 0, (x) => kindRound(-x, k)),
  $not: (a) => zip(a, 0, (x) => !x),
  $add: (a, b, k) => zip(a, b, (x, y) => kindRound(x + y, k)),
  $sub: (a, b, k) => zip(a, b, (x, y) => kindRound(x - y, k)),
  $mul: (a, b, k) => zip(a, b, (x, y) => (k === 'u' || k === 'i' ? kindRound(Number(BigInt.asUintN(32, BigInt(x) * BigInt(y))), k) : kindRound(x * y, k))),
  $div: (a, b, k) => zip(a, b, (x, y) => (k === 'f' ? fr(x / y) : y === 0 ? x : kindRound(Math.trunc(x / y), k))),
  $mod: (a, b, k) => zip(a, b, (x, y) => (k === 'f' ? fr(x - y * Math.trunc(x / y)) : y === 0 ? 0 : kindRound(x % y, k))),
  $band: (a, b, k) => zip(a, b, (x, y) => kindRound(x & y, k)),
  $bor: (a, b, k) => zip(a, b, (x, y) => kindRound(x | y, k)),
  $bxor: (a, b, k) => zip(a, b, (x, y) => kindRound(x ^ y, k)),
  $shl: (a, b, k) => zip(a, b, (x, y) => kindRound(x << y, k)),
  $shr: (a, b, k) => zip(a, b, (x, y) => kindRound(k === 'u' ? x >>> y : x >> y, k)),
  $cmp: (op, a, b) => zip(a, b, (x, y) => (op === '<' ? x < y : op === '>' ? x > y : op === '<=' ? x <= y : op === '>=' ? x >= y : op === '==' ? x === y : x !== y)),
  $select: (f, t, c) => (Array.isArray(c) ? c.map((ci, i) => (ci ? t[i] : f[i])) : c ? t : f),
  $all: (v) => (Array.isArray(v) ? v.every(Boolean) : !!v),
  $any: (v) => (Array.isArray(v) ? v.some(Boolean) : !!v),
  $min: (a, b, k) => zip(a, b, (x, y) => kindRound(Math.min(x, y), k)),
  $max: (a, b, k) => zip(a, b, (x, y) => kindRound(Math.max(x, y), k)),
  $clamp: (v, lo, hi, k) => zip(zip(v, lo, Math.max), hi, (x, y) => kindRound(Math.min(x, y), k)),
  $map1: (v, fn, k) => zip(v, 0, (x) => kindRound(fn === 'abs' ? Math.abs(x) : Math.sign(x), k)),
  $dot: (a, b, k) => { let s = 0; for (let i = 0; i < a.length; i++) s = kindRound(s + kindRound(a[i] * b[i], k), k); return s; },
  $length: (v) => (Array.isArray(v) ? fr(Math.sqrt(RT.$dot(v, v, 'f'))) : fr(Math.abs(v))),
  $distance: (a, b) => RT.$length(RT.$sub(a, b, 'f')),
  $fmath(name, args) {
    const F = {
      sqrt: Math.sqrt, inverseSqrt: (x) => 1 / Math.sqrt(x), log: Math.log, log2: Math.log2, exp: Math.exp, exp2: (x) => 2 ** x,
      sin: Math.sin, cos: Math.cos, tan: Math.tan, atan: Math.atan, tanh: Math.tanh, floor: Math.floor, ceil: Math.ceil,
      round: (x) => { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r; },
      fract: (x) => x - Math.floor(x), pow: Math.pow, atan2: Math.atan2, step: (e, x) => (x >= e ? 1 : 0),
      mix: (a, b, t) => a * (1 - t) + b * t,
      smoothstep: (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); }
    };
    if (name === 'cross') {
      const [a, b] = args;
      return [fr(a[1] * b[2] - a[2] * b[1]), fr(a[2] * b[0] - a[0] * b[2]), fr(a[0] * b[1] - a[1] * b[0])];
    }
    if (name === 'normalize') { const l = RT.$length(args[0]); return args[0].map((x) => fr(x / l)); }
    const fn = F[name];
    if (!fn) throw new Error(`wgsl-mini: no builtin ${name}`);
    const n = Math.max(...args.map((a) => (Array.isArray(a) ? a.length : 1)));
    if (n === 1) return fr(fn(...args));
    return Array.from({ length: n }, (_, i) => fr(fn(...args.map((a) => (Array.isArray(a) ? a[i] : a)))));
  }
};

/**
 * Compile a (fully #include-expanded) WGSL module.
 * @returns {{ run(entry, opts): void, structs }} where opts = {
 *   bindings: { name: value },  // uniforms / storage as plain objects / arrays of structs; textures as { format, size:[x,y,z], data: Float32Array }
 *   workgroups: [x, y, z] }
 */
export function compileWgsl(source) {
  const mod = new Parser(lex(source)).module();
  const gen = new Gen(mod);
  gen.push();
  const body = [];
  for (const c of mod.consts) {
    const [s, t] = gen.ex(c.init);
    const type = c.type ?? { k: concrete(t.k), n: t.n };
    gen.declare(c.name, type);
    body.push(`const v_${c.name} = $conv(${s},'${type.k}');`);
  }
  for (const g of mod.globals) {
    gen.declare(g.name, g.type);
    body.push(g.space === 'workgroup' ? `let v_${g.name};` : `let v_${g.name} = BIND[${JSON.stringify(g.name)}];`);
  }
  for (const f of Object.values(mod.fns)) {
    if (!f.compute) body.push(gen.fn(f, false));
  }
  const entries = Object.values(mod.fns).filter((f) => f.compute);
  for (const f of entries) body.push(gen.fn(f, true));
  const workgroupGlobals = mod.globals.filter((g) => g.space === 'workgroup');
  body.push(`return {
    entries: { ${entries.map((f) => `${f.name}: f_${f.name}`).join(', ')} },
    resetWorkgroup() { ${workgroupGlobals.map((g) => `v_${g.name} = $zero(${JSON.stringify(g.type)}, STRUCTS);`).join(' ')} }
  };`);
  const rtNames = Object.keys(RT);
  const texStore = (tex, coord, value) => {
    const [sx, sy, sz] = tex.size;
    const [x, y, z] = coord;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) return;
    const o = ((z * sy + y) * sx + x) * 4;
    const half = /16float$/.test(tex.format);
    for (let c = 0; c < 4; c++) tex.data[o + c] = half ? roundF16Value(value[c]) : fr(value[c]);
  };
  const src = body.join('\n');
  // Test-only: compiles trusted repo shader source.
  const factory = new Function('BIND', 'STRUCTS', '$texStore', ...rtNames, src);

  return {
    source: src,
    structs: mod.structs,
    run(entryName, { bindings, workgroups }) {
      const inst = factory(bindings, mod.structs, texStore, ...rtNames.map((k) => RT[k]));
      const f = mod.fns[entryName];
      if (!f || !f.compute) throw new Error(`wgsl-mini: no compute entry ${entryName}`);
      const [wx, wy = 1, wz = 1] = f.workgroupSize;
      const [gx, gy = 1, gz = 1] = workgroups;
      for (let z = 0; z < gz; z++) for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) {
        inst.resetWorkgroup();
        const gens = [];
        for (let lz = 0; lz < wz; lz++) for (let ly = 0; ly < wy; ly++) for (let lx = 0; lx < wx; lx++) {
          const ids = {
            workgroup_id: [x, y, z],
            local_invocation_id: [lx, ly, lz],
            local_invocation_index: (lz * wy + ly) * wx + lx,
            global_invocation_id: [x * wx + lx, y * wy + ly, z * wz + lz],
            num_workgroups: [gx, gy, gz]
          };
          const args = f.params.map((p) => {
            if (!p.builtin || !(p.builtin in ids)) throw new Error(`wgsl-mini: unsupported builtin param ${p.builtin}`);
            return RT.$copy(ids[p.builtin]);
          });
          gens.push(inst.entries[entryName](...args));
        }
        // Lockstep between barriers: every invocation reaches the same yield.
        let live = gens.length;
        while (live > 0) {
          live = 0;
          for (const g of gens) if (!g.done) { const r = g.next(); if (r.done) g.done = true; else live++; }
        }
      }
    }
  };
}
