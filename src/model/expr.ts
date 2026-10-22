/**
 * Integer expressions for parameter bindings, e.g. "N", "N*2 - 1", "clog2(DEPTH)".
 *
 * Grammar:
 *   expr    := term (('+' | '-') term)*
 *   term    := unary (('*' | '/' | '%') unary)*
 *   unary   := '-' unary | primary
 *   primary := number | name | name '(' expr (',' expr)* ')' | '(' expr ')'
 *
 * Numbers are decimal or 0x hexadecimal. Division truncates toward zero.
 * Functions: min, max, clog2 (ceiling of log2), pow2.
 * There is no access to anything but the given parameter values.
 */

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

type Node =
  | { kind: 'num'; value: number }
  | { kind: 'name'; name: string }
  | { kind: 'neg'; arg: Node }
  | { kind: 'bin'; op: string; left: Node; right: Node }
  | { kind: 'call'; fn: string; args: Node[] };

const FUNCTIONS: Record<string, { arity: [number, number]; fn: (args: number[]) => number }> = {
  min: { arity: [1, 16], fn: (a) => Math.min(...a) },
  max: { arity: [1, 16], fn: (a) => Math.max(...a) },
  clog2: {
    arity: [1, 1],
    fn: ([x]) => {
      if (x < 1) throw new ExprError('clog2 needs a value of at least 1');
      return Math.ceil(Math.log2(x) - 1e-12);
    },
  },
  pow2: {
    arity: [1, 1],
    fn: ([x]) => {
      if (x < 0 || x > 52) throw new ExprError('pow2 needs a value from 0 to 52');
      return 2 ** x;
    },
  },
};

function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /\s*(0x[0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*|[-+*/%(),])\s*/y;
  let i = 0;
  while (i < text.length) {
    re.lastIndex = i;
    const m = re.exec(text);
    if (!m) {
      if (/^\s*$/.test(text.slice(i))) break;
      throw new ExprError(`unexpected "${text.slice(i).trim()[0]}"`);
    }
    tokens.push(m[1]);
    i = re.lastIndex;
  }
  return tokens;
}

function parse(text: string): Node {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const expect = (t: string) => {
    if (take() !== t) throw new ExprError(`expected "${t}"`);
  };

  const primary = (): Node => {
    const t = take();
    if (t === undefined) throw new ExprError('unexpected end of expression');
    if (t === '(') {
      const e = expr();
      expect(')');
      return e;
    }
    if (/^0x/i.test(t)) return { kind: 'num', value: parseInt(t.slice(2), 16) };
    if (/^\d+$/.test(t)) return { kind: 'num', value: Number(t) };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        take();
        const args = [expr()];
        while (peek() === ',') {
          take();
          args.push(expr());
        }
        expect(')');
        const f = FUNCTIONS[t];
        if (!f) throw new ExprError(`unknown function "${t}"`);
        if (args.length < f.arity[0] || args.length > f.arity[1]) throw new ExprError(`${t} takes ${f.arity[0] === f.arity[1] ? f.arity[0] : `${f.arity[0]}–${f.arity[1]}`} argument(s)`);
        return { kind: 'call', fn: t, args };
      }
      return { kind: 'name', name: t };
    }
    throw new ExprError(`unexpected "${t}"`);
  };
  const unary = (): Node => {
    if (peek() === '-') {
      take();
      return { kind: 'neg', arg: unary() };
    }
    if (peek() === '+') {
      take();
      return unary();
    }
    return primary();
  };
  const term = (): Node => {
    let left = unary();
    while (peek() === '*' || peek() === '/' || peek() === '%') {
      const op = take();
      left = { kind: 'bin', op, left, right: unary() };
    }
    return left;
  };
  const expr = (): Node => {
    let left = term();
    while (peek() === '+' || peek() === '-') {
      const op = take();
      left = { kind: 'bin', op, left, right: term() };
    }
    return left;
  };

  if (tokens.length === 0) throw new ExprError('empty expression');
  const result = expr();
  if (pos < tokens.length) throw new ExprError(`unexpected "${tokens[pos]}"`);
  return result;
}

function evaluate(node: Node, scope: Readonly<Record<string, number>>): number {
  switch (node.kind) {
    case 'num':
      return node.value;
    case 'name': {
      const v = scope[node.name];
      if (v === undefined) throw new ExprError(`unknown parameter "${node.name}"`);
      return v;
    }
    case 'neg':
      return -evaluate(node.arg, scope);
    case 'call':
      return FUNCTIONS[node.fn].fn(node.args.map((a) => evaluate(a, scope)));
    case 'bin': {
      const l = evaluate(node.left, scope);
      const r = evaluate(node.right, scope);
      switch (node.op) {
        case '+':
          return l + r;
        case '-':
          return l - r;
        case '*':
          return l * r;
        case '/':
          if (r === 0) throw new ExprError('division by zero');
          return Math.trunc(l / r);
        default:
          if (r === 0) throw new ExprError('remainder by zero');
          return l % r;
      }
    }
  }
}

const parsed = new Map<string, Node | ExprError>();

/** Evaluate an expression; throws ExprError with a readable message. */
export function evalExpr(text: string, scope: Readonly<Record<string, number>>): number {
  let node = parsed.get(text);
  if (node === undefined) {
    try {
      node = parse(text);
    } catch (e) {
      node = e instanceof ExprError ? e : new ExprError(String(e));
    }
    if (parsed.size > 10_000) parsed.clear();
    parsed.set(text, node);
  }
  if (node instanceof ExprError) throw node;
  const v = evaluate(node, scope);
  if (!Number.isSafeInteger(v)) throw new ExprError('result is not a whole number in range');
  return v;
}

/** Parameter names an expression refers to (empty if it does not parse). */
export function exprNames(text: string): string[] {
  try {
    const out = new Set<string>();
    const walk = (n: Node) => {
      if (n.kind === 'name') out.add(n.name);
      else if (n.kind === 'neg') walk(n.arg);
      else if (n.kind === 'bin') {
        walk(n.left);
        walk(n.right);
      } else if (n.kind === 'call') n.args.forEach(walk);
    };
    walk(parse(text));
    return [...out];
  } catch {
    return [];
  }
}

/** Rename a parameter inside an expression, keeping its formatting. Function names are left alone. */
export function renameInExpr(text: string, from: string, to: string): string {
  return text.replace(/0x[0-9a-fA-F]+|\d+|[A-Za-z_][A-Za-z0-9_]*/g, (m, offset: number) => {
    if (m !== from) return m;
    const rest = text.slice(offset + m.length).trimStart();
    return rest.startsWith('(') ? m : to;
  });
}

/** True for names reserved by the expression language. */
export function isReservedName(name: string): boolean {
  return Object.hasOwn(FUNCTIONS, name);
}
