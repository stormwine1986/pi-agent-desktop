/**
 * The `filter:` expression in `subscriptions.yaml`.
 *
 * Deliberately *not* `eval`/`new Function`: the yaml travels with a workspace,
 * so a cloned repository could otherwise execute code inside the app the moment
 * the workspace is opened. This evaluates a fixed grammar instead:
 *
 *   path            aggregateType, payload.toState, payload.fields.name
 *   literals        "MR", 'MR', 7, true, false, null
 *   comparison      == != > < >= <=
 *   membership      path in ["MR", "OR"]
 *   boolean         && || ! and parentheses
 *
 * An unsupported expression is an error shown next to the source, never a
 * silently empty filter.
 */
export interface CompiledFilter {
  test(value: unknown): boolean;
  /** Number of AST nodes, only used by tests to prove parsing happened. */
  size: number;
}

type Token =
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "ident"; value: string }
  | { kind: "punct"; value: string };

const STRING_RE = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/y;
const NUMBER_RE = /-?\d+(?:\.\d+)?/y;
const IDENT_RE = /[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/y;
const MULTI_PUNCT = ["==", "!=", ">=", "<=", "&&", "||"];
const SINGLE_PUNCT = ["(", ")", "[", "]", ",", "!", ">", "<"];

class FilterError extends Error {}

function unescape(body: string): string {
  return body.replace(/\\(.)/g, (_, char: string) => {
    if (char === "n") return "\n";
    if (char === "t") return "\t";
    return char;
  });
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    STRING_RE.lastIndex = index;
    const stringMatch = STRING_RE.exec(input);
    if (stringMatch) {
      const raw = stringMatch[0];
      tokens.push({ kind: "string", value: unescape(raw.slice(1, -1)) });
      index += raw.length;
      continue;
    }
    NUMBER_RE.lastIndex = index;
    const numberMatch = NUMBER_RE.exec(input);
    if (numberMatch) {
      tokens.push({ kind: "number", value: Number(numberMatch[0]) });
      index += numberMatch[0].length;
      continue;
    }
    IDENT_RE.lastIndex = index;
    const identMatch = IDENT_RE.exec(input);
    if (identMatch) {
      tokens.push({ kind: "ident", value: identMatch[0] });
      index += identMatch[0].length;
      continue;
    }
    const multi = MULTI_PUNCT.find((op) => input.startsWith(op, index));
    if (multi) {
      tokens.push({ kind: "punct", value: multi });
      index += multi.length;
      continue;
    }
    const single = SINGLE_PUNCT.find((op) => input.startsWith(op, index));
    if (single) {
      tokens.push({ kind: "punct", value: single });
      index += single.length;
      continue;
    }
    throw new FilterError(`无法识别的字符 "${char}"（位置 ${index}）`);
  }
  return tokens;
}

type Node = (scope: unknown) => unknown;

function readPath(scope: unknown, path: string): unknown {
  let current = scope;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

/** `revision == "7"` and `revision == 7` both work; everything else compares strictly. */
function looseEquals(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  const leftNumber = typeof left === "number" ? left : typeof left === "string" && left.trim() !== "" ? Number(left) : NaN;
  const rightNumber = typeof right === "number" ? right : typeof right === "string" && right.trim() !== "" ? Number(right) : NaN;
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) return leftNumber === rightNumber;
  if (typeof left === "string" && typeof right === "string") return left === right;
  return false;
}

function compare(op: string, left: unknown, right: unknown): boolean {
  if (op === "==") return looseEquals(left, right);
  if (op === "!=") return !looseEquals(left, right);
  const leftNumber = typeof left === "number" ? left : Number(left);
  const rightNumber = typeof right === "number" ? right : Number(right);
  if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    if (op === ">") return leftNumber > rightNumber;
    if (op === "<") return leftNumber < rightNumber;
    if (op === ">=") return leftNumber >= rightNumber;
    return leftNumber <= rightNumber;
  }
  if (typeof left === "string" && typeof right === "string") {
    if (op === ">") return left > right;
    if (op === "<") return left < right;
    if (op === ">=") return left >= right;
    return left <= right;
  }
  return false;
}

function parse(tokens: Token[]): { node: Node; size: number } {
  let index = 0;
  let size = 0;

  const peek = (): Token | undefined => tokens[index];
  const eatPunct = (value: string): boolean => {
    const token = peek();
    if (token?.kind === "punct" && token.value === value) {
      index += 1;
      return true;
    }
    return false;
  };
  const expectPunct = (value: string): void => {
    if (!eatPunct(value)) throw new FilterError(`缺少 "${value}"`);
  };

  const parseOr = (): Node => {
    let left = parseAnd();
    while (peek()?.kind === "punct" && (peek() as { value: string }).value === "||") {
      index += 1;
      const right = parseAnd();
      const previous = left;
      left = (scope) => truthy(previous(scope)) || truthy(right(scope));
      size += 1;
    }
    return left;
  };

  const parseAnd = (): Node => {
    let left = parseComparison();
    while (peek()?.kind === "punct" && (peek() as { value: string }).value === "&&") {
      index += 1;
      const right = parseComparison();
      const previous = left;
      left = (scope) => truthy(previous(scope)) && truthy(right(scope));
      size += 1;
    }
    return left;
  };

  const parseComparison = (): Node => {
    const left = parseUnary();
    const token = peek();
    if (token?.kind === "punct" && ["==", "!=", ">", "<", ">=", "<="].includes(token.value)) {
      index += 1;
      const operator = token.value;
      const right = parseUnary();
      size += 1;
      return (scope) => compare(operator, left(scope), right(scope));
    }
    if (token?.kind === "ident" && token.value === "in") {
      index += 1;
      const right = parseUnary();
      size += 1;
      return (scope) => {
        const haystack = right(scope);
        const needle = left(scope);
        if (Array.isArray(haystack)) return haystack.some((entry) => looseEquals(entry, needle));
        if (typeof haystack === "string" && typeof needle === "string") return haystack.includes(needle);
        return false;
      };
    }
    return left;
  };

  const parseUnary = (): Node => {
    if (eatPunct("!")) {
      const operand = parseUnary();
      size += 1;
      return (scope) => !truthy(operand(scope));
    }
    return parsePrimary();
  };

  const parsePrimary = (): Node => {
    const token = peek();
    if (!token) throw new FilterError("表达式不完整");

    if (token.kind === "punct" && token.value === "(") {
      index += 1;
      const inner = parseOr();
      expectPunct(")");
      return inner;
    }
    if (token.kind === "punct" && token.value === "[") {
      index += 1;
      const items: Node[] = [];
      if (!eatPunct("]")) {
        do {
          items.push(parseOr());
        } while (eatPunct(","));
        expectPunct("]");
      }
      size += 1;
      return (scope) => items.map((item) => item(scope));
    }
    if (token.kind === "string" || token.kind === "number") {
      index += 1;
      const value = token.value;
      return () => value;
    }
    if (token.kind === "ident") {
      index += 1;
      if (token.value === "true") return () => true;
      if (token.value === "false") return () => false;
      if (token.value === "null") return () => null;
      if (token.value === "undefined") return () => undefined;
      const path = token.value;
      size += 1;
      return (scope) => readPath(scope, path);
    }
    throw new FilterError(`无法解析 "${token.value}"`);
  };

  const node = parseOr();
  if (index < tokens.length) throw new FilterError(`多余的内容 "${tokens[index].value}"`);
  return { node, size };
}

export type CompileResult = { ok: true; filter: CompiledFilter } | { ok: false; error: string };

export function compileFilter(expression: string): CompileResult {
  const source = expression.trim();
  if (!source) return { ok: true, filter: { test: () => true, size: 0 } };
  try {
    const { node, size } = parse(tokenize(source));
    return { ok: true, filter: { test: (value: unknown) => truthy(node(value)), size } };
  } catch (error) {
    return { ok: false, error: error instanceof FilterError ? error.message : String(error) };
  }
}
