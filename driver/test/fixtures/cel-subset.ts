/**
 * The subset of CEL the chart's admission policies are written in, evaluated over plain JSON: field
 * selection, `has()`, `!` `&&` `||` `==` `!=` `in`, `+` (list and string concatenation), the ternary, list literals, `size()`, the
 * `all`/`exists`/`filter`/`map` macros and the string `matches`/`startsWith`/`endsWith`/`contains`.
 * Anything outside it throws at parse time, so a policy rule written in more CEL than this knows
 * fails the suite instead of passing unevaluated. A field that is absent throws when selected, as
 * the apiserver's does, and a throwing validation is a refusal (`failurePolicy: Fail`).
 */

type Node =
    | { k: 'lit'; v: unknown }
    | { k: 'id'; name: string }
    | { k: 'sel'; of: Node; field: string }
    | { k: 'idx'; of: Node; at: Node }
    | { k: 'call'; fn: string; of: Node | null; args: Node[] }
    | { k: 'list'; items: Node[] }
    | { k: 'not'; of: Node }
    | { k: 'bin'; op: string; l: Node; r: Node }
    | { k: 'cond'; test: Node; then: Node; else: Node };

const TOKEN =
    /\s*(?:(\d+)|'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"|([A-Za-z_][A-Za-z0-9_]*)|(&&|\|\||==|!=|<=|>=|[!?:.,()[\]<>+]))/y;

function tokenize(src: string): string[] {
    const tokens: string[] = [];
    TOKEN.lastIndex = 0;
    while (TOKEN.lastIndex < src.length) {
        if (/^\s*$/.test(src.slice(TOKEN.lastIndex))) break;
        const at = TOKEN.lastIndex;
        const m = TOKEN.exec(src);
        if (!m) throw new Error(`cel-subset: unsupported syntax at ${at}: ${src.slice(at, at + 20)}`);
        if (m[1] !== undefined) tokens.push(`#${m[1]}`);
        else if (m[2] !== undefined) tokens.push(`'${m[2]}`);
        else if (m[3] !== undefined) tokens.push(`'${m[3]}`);
        else tokens.push(m[4] ?? m[5]!);
    }
    return tokens;
}

const MACROS = new Set(['all', 'exists', 'filter', 'map']);
const METHODS = new Set(['matches', 'startsWith', 'endsWith', 'contains']);
const FUNCTIONS = new Set(['has', 'size']);

export function parse(src: string): Node {
    const tokens = tokenize(src);
    let i = 0;
    const peek = () => tokens[i];
    const take = (want?: string): string => {
        const t = tokens[i++];
        if (t === undefined || (want !== undefined && t !== want)) {
            throw new Error(`cel-subset: expected ${want ?? 'a token'}, got ${t} in ${src}`);
        }
        return t;
    };
    const args = (): Node[] => {
        const out: Node[] = [];
        take('(');
        while (peek() !== ')') {
            out.push(ternary());
            if (peek() === ',') take(',');
        }
        take(')');
        return out;
    };
    function primary(): Node {
        const t = take();
        if (t === '(') {
            const e = ternary();
            take(')');
            return e;
        }
        if (t === '[') {
            const items: Node[] = [];
            while (peek() !== ']') {
                items.push(ternary());
                if (peek() === ',') take(',');
            }
            take(']');
            return { k: 'list', items };
        }
        if (t.startsWith('#')) return { k: 'lit', v: Number(t.slice(1)) };
        if (t.startsWith("'")) return { k: 'lit', v: t.slice(1).replace(/\\(.)/g, '$1') };
        if (t === 'true' || t === 'false') return { k: 'lit', v: t === 'true' };
        if (t === 'null') return { k: 'lit', v: null };
        if (!/^[A-Za-z_]/.test(t)) throw new Error(`cel-subset: unexpected ${t} in ${src}`);
        if (peek() === '(') {
            if (!FUNCTIONS.has(t)) throw new Error(`cel-subset: unsupported function ${t}`);
            return { k: 'call', fn: t, of: null, args: args() };
        }
        return { k: 'id', name: t };
    }
    function member(): Node {
        let e = primary();
        for (;;) {
            if (peek() === '.') {
                take('.');
                const field = take();
                if (peek() === '(') {
                    if (!MACROS.has(field) && !METHODS.has(field)) {
                        throw new Error(`cel-subset: unsupported method ${field}`);
                    }
                    e = { k: 'call', fn: field, of: e, args: args() };
                } else e = { k: 'sel', of: e, field };
            } else if (peek() === '[') {
                take('[');
                e = { k: 'idx', of: e, at: ternary() };
                take(']');
            } else return e;
        }
    }
    function unary(): Node {
        if (peek() === '!') {
            take('!');
            return { k: 'not', of: unary() };
        }
        return member();
    }
    function sum(): Node {
        let l = unary();
        while (peek() === '+') {
            take();
            l = { k: 'bin', op: '+', l, r: unary() };
        }
        return l;
    }
    function relation(): Node {
        const l = sum();
        const op = peek();
        if (op === '==' || op === '!=' || op === 'in' || op === '<' || op === '>' || op === '<=' || op === '>=') {
            take();
            return { k: 'bin', op, l, r: sum() };
        }
        return l;
    }
    function and(): Node {
        let l = relation();
        while (peek() === '&&') {
            take();
            l = { k: 'bin', op: '&&', l, r: relation() };
        }
        return l;
    }
    function or(): Node {
        let l = and();
        while (peek() === '||') {
            take();
            l = { k: 'bin', op: '||', l, r: and() };
        }
        return l;
    }
    function ternary(): Node {
        const test = or();
        if (peek() !== '?') return test;
        take('?');
        const then = ternary();
        take(':');
        return { k: 'cond', test, then, else: ternary() };
    }
    const root = ternary();
    if (i !== tokens.length) throw new Error(`cel-subset: trailing ${tokens[i]} in ${src}`);
    return root;
}

type Scope = Record<string, unknown>;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function select(of: unknown, field: string): unknown {
    if (!isObject(of) || !(field in of) || of[field] === undefined) throw new Error(`no such key: ${field}`);
    return of[field];
}

function bool(v: unknown): boolean {
    if (typeof v !== 'boolean') throw new Error(`not a bool: ${JSON.stringify(v)}`);
    return v;
}

function list(v: unknown): unknown[] {
    if (!Array.isArray(v)) throw new Error(`not a list: ${JSON.stringify(v)}`);
    return v;
}

function str(v: unknown): string {
    if (typeof v !== 'string') throw new Error(`not a string: ${JSON.stringify(v)}`);
    return v;
}

/** CEL's commutative `&&`/`||`: an error on one side is absorbed when the other side decides. */
function logic(op: '&&' | '||', l: Node, r: Node, scope: Scope): boolean {
    const decides = op === '||';
    let left: boolean | Error;
    try {
        left = bool(evaluate(l, scope));
    } catch (e) {
        left = e as Error;
    }
    if (left === decides) return decides;
    const right = bool(evaluate(r, scope));
    if (left instanceof Error && right !== decides) throw left;
    return right;
}

function call(node: Extract<Node, { k: 'call' }>, scope: Scope): unknown {
    const { fn, of, args } = node;
    if (fn === 'has') {
        const target = args[0];
        if (target?.k !== 'sel') throw new Error('has() takes a field selection');
        const owner = evaluate(target.of, scope);
        return isObject(owner) && owner[target.field] !== undefined;
    }
    if (fn === 'size') {
        const v = evaluate(args[0]!, scope);
        if (typeof v === 'string' || Array.isArray(v)) return v.length;
        if (isObject(v)) return Object.keys(v).length;
        throw new Error(`size() of ${JSON.stringify(v)}`);
    }
    const receiver = evaluate(of!, scope);
    if (MACROS.has(fn)) {
        const variable = args[0];
        if (variable?.k !== 'id') throw new Error(`${fn}() takes a variable name first`);
        const each = (item: unknown) => evaluate(args[1]!, { ...scope, [variable.name]: item });
        const items = list(receiver);
        if (fn === 'map') return items.map(each);
        if (fn === 'filter') return items.filter((item) => bool(each(item)));
        // `all`/`exists` absorb an element's error when another element decides, as `&&`/`||` do.
        const decides = fn === 'exists';
        let error: Error | null = null;
        for (const item of items) {
            try {
                if (bool(each(item)) === decides) return decides;
            } catch (e) {
                error = e as Error;
            }
        }
        if (error) throw error;
        return !decides;
    }
    const s = str(receiver);
    const arg = str(evaluate(args[0]!, scope));
    if (fn === 'matches') return new RegExp(arg).test(s);
    if (fn === 'startsWith') return s.startsWith(arg);
    if (fn === 'endsWith') return s.endsWith(arg);
    return s.includes(arg);
}

export function evaluate(node: Node, scope: Scope): unknown {
    switch (node.k) {
        case 'lit':
            return node.v;
        case 'id':
            if (!(node.name in scope)) throw new Error(`undeclared reference: ${node.name}`);
            return scope[node.name];
        case 'sel':
            return select(evaluate(node.of, scope), node.field);
        case 'idx': {
            const of = evaluate(node.of, scope);
            const at = evaluate(node.at, scope);
            if (Array.isArray(of) && typeof at === 'number' && at in of) return of[at];
            return select(of, str(at));
        }
        case 'list':
            return node.items.map((item) => evaluate(item, scope));
        case 'not':
            return !bool(evaluate(node.of, scope));
        case 'cond':
            return bool(evaluate(node.test, scope)) ? evaluate(node.then, scope) : evaluate(node.else, scope);
        case 'call':
            return call(node, scope);
        case 'bin': {
            if (node.op === '&&' || node.op === '||') return logic(node.op, node.l, node.r, scope);
            const l = evaluate(node.l, scope);
            const r = evaluate(node.r, scope);
            if (node.op === 'in') return Array.isArray(r) ? r.includes(l) : isObject(r) && str(l) in r;
            if (node.op === '+') {
                if (Array.isArray(l)) return [...l, ...list(r)];
                return str(l) + str(r);
            }
            if (node.op === '==') return l === r;
            if (node.op === '!=') return l !== r;
            if (typeof l !== 'number' || typeof r !== 'number') throw new Error(`${node.op} of non-numbers`);
            if (node.op === '<') return l < r;
            if (node.op === '>') return l > r;
            if (node.op === '<=') return l <= r;
            return l >= r;
        }
    }
}

/** One ValidatingAdmissionPolicy's `variables` and `validations`, as written in its spec. */
export interface CelPolicy {
    variables: { name: string; expression: string }[];
    validations: { expression: string; message: string }[];
}

/**
 * The messages of every validation `policy` refuses `object` with, `[]` when it admits it. The
 * variables resolve in order, each seeing those before it; a throwing one fails only the validations
 * that read it.
 */
export function refusals(policy: CelPolicy, object: unknown, request: unknown): string[] {
    const variables: Record<string, unknown> = {};
    const scope: Scope = { object, request, variables };
    for (const { name, expression } of policy.variables) {
        const node = parse(expression);
        Object.defineProperty(variables, name, { enumerable: true, get: () => evaluate(node, scope) });
    }
    return policy.validations
        .filter(({ expression }) => {
            try {
                return evaluate(parse(expression), scope) !== true;
            } catch {
                return true;
            }
        })
        .map(({ message }) => message);
}
