/**
 * A local evaluator for the pokemontcg.io-style Lucene subset this server's
 * tools generate (and that users may pass to search_cards):
 *
 *   field:value   field:"a phrase"   field:pre*   field:*suf   field:[1 TO 100]
 *   field:(a OR b)   a OR b   a AND b   a b (implicit AND)   NOT x   -x   ( … )
 *
 * Matching rules, chosen to mirror pokemontcg.io closely enough for our
 * queries:
 * - Everything is case- and accent-insensitive ("pokemon" matches "Pokémon").
 * - Keyword fields (supertype, subtypes, types, ids, numbers, marks…) match the
 *   whole value.
 * - Text fields (name, attack/ability text, rules…) match a phrase as a run of
 *   consecutive words; a wildcard term matches any single word.
 * - Nested paths walk arrays: `attacks.text` checks every attack's text.
 * - A bare word with no field searches the card name.
 *
 * Pure functions — unit tested in test/lucene.test.ts.
 */

export type Node =
  | { kind: "and"; children: Node[] }
  | { kind: "or"; children: Node[] }
  | { kind: "not"; child: Node }
  | { kind: "term"; field: string; value: string; phrase: boolean }
  | { kind: "range"; field: string; min?: number; max?: number; minInclusive: boolean; maxInclusive: boolean }
  | { kind: "all" };

export class LuceneSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LuceneSyntaxError";
  }
}

type Token =
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "minus" }
  | { t: "op"; v: "AND" | "OR" | "NOT" }
  | { t: "word"; v: string }
  | { t: "phrase"; v: string }
  | { t: "range"; v: string; minInclusive: boolean; maxInclusive: boolean };

/** Fields compared as whole values rather than word runs. */
const KEYWORD_FIELDS = new Set([
  "id",
  "supertype",
  "subtypes",
  "types",
  "regulationmark",
  "number",
  "set.id",
  "set.ptcgocode",
  "set.series",
  "legalities.standard",
  "legalities.expanded",
  "legalities.unlimited",
  "retreatcost",
  "weaknesses.type",
  "resistances.type",
  "attacks.cost",
  "evolvesto",
]);

export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim();
}

function words(text: string): string[] {
  return normalize(text)
    .split(/[^a-z0-9'&?*-]+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ""))
    .filter((w) => w.length > 0);
}

// ---------------------------------------------------------------- tokenizer

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ t: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: "rparen" });
      i++;
      continue;
    }
    if (ch === '"') {
      const end = input.indexOf('"', i + 1);
      if (end === -1) throw new LuceneSyntaxError("unterminated quote");
      tokens.push({ t: "phrase", v: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    if (ch === "[" || ch === "{") {
      const close = input.slice(i + 1).search(/[\]}]/);
      if (close === -1) throw new LuceneSyntaxError("unterminated range");
      const end = i + 1 + close;
      tokens.push({ t: "range", v: input.slice(i + 1, end), minInclusive: ch === "[", maxInclusive: input[end] === "]" });
      i = end + 1;
      continue;
    }
    if (ch === "-" && (i === 0 || /[\s(]/.test(input[i - 1]))) {
      tokens.push({ t: "minus" });
      i++;
      continue;
    }
    if (ch === "!") {
      // pokemontcg.io's "!name:" exact-match prefix: treat as a plain term.
      i++;
      continue;
    }
    // A word runs until whitespace, a paren, or a quote. ':' stays inside so
    // the parser can split field from value.
    let j = i;
    while (j < input.length && !/[\s()"]/.test(input[j])) {
      if ((input[j] === "[" || input[j] === "{") && input[j - 1] === ":") break;
      j++;
    }
    const word = input.slice(i, j);
    if (word === "AND" || word === "OR" || word === "NOT") tokens.push({ t: "op", v: word });
    else if (word === "&&") tokens.push({ t: "op", v: "AND" });
    else if (word === "||") tokens.push({ t: "op", v: "OR" });
    else tokens.push({ t: "word", v: word });
    i = j;
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

export function parse(input: string): Node {
  const tokens = tokenize(input);
  let pos = 0;

  const peek = () => tokens[pos];

  function parseOr(): Node {
    const children = [parseAnd()];
    while (peek()?.t === "op" && (peek() as { v: string }).v === "OR") {
      pos++;
      children.push(parseAnd());
    }
    return children.length === 1 ? children[0] : { kind: "or", children };
  }

  function parseAnd(): Node {
    const children = [parseUnary()];
    for (;;) {
      const tok = peek();
      if (!tok || tok.t === "rparen") break;
      if (tok.t === "op" && tok.v === "OR") break;
      if (tok.t === "op" && tok.v === "AND") pos++;
      children.push(parseUnary());
    }
    return children.length === 1 ? children[0] : { kind: "and", children };
  }

  function parseUnary(): Node {
    const tok = peek();
    if (!tok) throw new LuceneSyntaxError("unexpected end of query");
    if (tok.t === "minus" || (tok.t === "op" && tok.v === "NOT")) {
      pos++;
      return { kind: "not", child: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary(): Node {
    const tok = tokens[pos++];
    if (!tok) throw new LuceneSyntaxError("unexpected end of query");
    if (tok.t === "lparen") {
      const inner = parseOr();
      if (tokens[pos++]?.t !== "rparen") throw new LuceneSyntaxError("missing closing parenthesis");
      return inner;
    }
    if (tok.t === "phrase") return { kind: "term", field: "name", value: tok.v, phrase: true };
    if (tok.t === "word") {
      const colon = tok.v.indexOf(":");
      if (colon <= 0) return { kind: "term", field: "name", value: tok.v, phrase: false };
      const field = tok.v.slice(0, colon);
      const rest = tok.v.slice(colon + 1);
      if (rest.length > 0) return { kind: "term", field, value: rest, phrase: false };
      return parseFieldValue(field);
    }
    throw new LuceneSyntaxError(`unexpected token ${describe(tok)}`);
  }

  /** The value after "field:" when it is a separate token: phrase, range or group. */
  function parseFieldValue(field: string): Node {
    const tok = tokens[pos++];
    if (!tok) throw new LuceneSyntaxError(`missing value for ${field}:`);
    if (tok.t === "phrase") return { kind: "term", field, value: tok.v, phrase: true };
    if (tok.t === "range") return rangeNode(field, tok);
    if (tok.t === "lparen") {
      const group = parseOr();
      if (tokens[pos++]?.t !== "rparen") throw new LuceneSyntaxError("missing closing parenthesis");
      return rebind(group, field);
    }
    throw new LuceneSyntaxError(`unexpected ${describe(tok)} after ${field}:`);
  }

  if (tokens.length === 0) return { kind: "all" };
  const root = parseOr();
  if (pos < tokens.length) throw new LuceneSyntaxError(`unexpected ${describe(tokens[pos])}`);
  return root;
}

function describe(tok: Token): string {
  switch (tok.t) {
    case "lparen":
      return "'('";
    case "rparen":
      return "')'";
    case "minus":
      return "'-'";
    case "op":
      return tok.v;
    default:
      return `'${tok.v}'`;
  }
}

/** field:(a OR b) — re-target bare name terms inside the group to `field`. */
function rebind(node: Node, field: string): Node {
  switch (node.kind) {
    case "term":
      return node.field === "name" && !node.value.includes(":") ? { ...node, field } : node;
    case "range":
    case "all":
      return node;
    case "not":
      return { kind: "not", child: rebind(node.child, field) };
    default:
      return { kind: node.kind, children: node.children.map((c) => rebind(c, field)) };
  }
}

function rangeNode(field: string, tok: Extract<Token, { t: "range" }>): Node {
  const m = /^\s*(\S+)\s+TO\s+(\S+)\s*$/i.exec(tok.v);
  if (!m) throw new LuceneSyntaxError(`bad range [${tok.v}]`);
  const bound = (s: string) => (s === "*" ? undefined : Number(s));
  const min = bound(m[1]);
  const max = bound(m[2]);
  if ((min !== undefined && Number.isNaN(min)) || (max !== undefined && Number.isNaN(max))) {
    throw new LuceneSyntaxError(`ranges must be numeric: [${tok.v}]`);
  }
  return { kind: "range", field, min, max, minInclusive: tok.minInclusive, maxInclusive: tok.maxInclusive };
}

// ---------------------------------------------------------------- evaluation

/** All primitive values reachable at a dotted path, walking arrays. */
export function valuesAt(obj: unknown, path: string): string[] {
  const parts = path.split(".");
  let current: unknown[] = [obj];
  for (const part of parts) {
    const next: unknown[] = [];
    for (const item of current) {
      if (item === null || item === undefined) continue;
      const items = Array.isArray(item) ? item : [item];
      for (const it of items) {
        if (it === null || typeof it !== "object") continue;
        const key = Object.keys(it).find((k) => k.toLowerCase() === part.toLowerCase());
        if (key !== undefined) next.push((it as Record<string, unknown>)[key]);
      }
    }
    current = next;
  }
  const out: string[] = [];
  for (const v of current.flat(2)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "object") continue;
    out.push(String(v));
  }
  return out;
}

function wildcardRegex(pattern: string): RegExp {
  const escaped = normalize(pattern)
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`);
}

function matchTerm(card: unknown, field: string, value: string, phrase: boolean): boolean {
  const values = valuesAt(card, field);
  if (values.length === 0) return false;
  const keyword = KEYWORD_FIELDS.has(field.toLowerCase());
  const hasWildcard = value.includes("*");

  if (keyword) {
    if (hasWildcard) {
      const re = wildcardRegex(value);
      return values.some((v) => re.test(normalize(v)));
    }
    const target = normalize(value);
    return values.some((v) => normalize(v) === target);
  }

  // Text field.
  if (hasWildcard && !phrase) {
    const re = wildcardRegex(value);
    return values.some((v) => words(v).some((w) => re.test(w)));
  }
  const needle = words(value);
  if (needle.length === 0) return false;
  return values.some((v) => {
    const hay = words(v);
    outer: for (let i = 0; i + needle.length <= hay.length; i++) {
      for (let k = 0; k < needle.length; k++) {
        const n = needle[k];
        const ok = n.includes("*") ? wildcardRegex(n).test(hay[i + k]) : hay[i + k] === n;
        if (!ok) continue outer;
      }
      return true;
    }
    return false;
  });
}

function matchRange(card: unknown, node: Extract<Node, { kind: "range" }>): boolean {
  return valuesAt(card, node.field).some((raw) => {
    const n = Number(raw);
    if (Number.isNaN(n)) return false;
    if (node.min !== undefined && (node.minInclusive ? n < node.min : n <= node.min)) return false;
    if (node.max !== undefined && (node.maxInclusive ? n > node.max : n >= node.max)) return false;
    return true;
  });
}

export function matches(card: unknown, node: Node): boolean {
  switch (node.kind) {
    case "all":
      return true;
    case "and":
      return node.children.every((c) => matches(card, c));
    case "or":
      return node.children.some((c) => matches(card, c));
    case "not":
      return !matches(card, node.child);
    case "term":
      return matchTerm(card, node.field, node.value, node.phrase);
    case "range":
      return matchRange(card, node);
  }
}

// ---------------------------------------------------------------- scoping

/**
 * What a query pins down, so a backend knows which slice of the card data to
 * load before evaluating it locally. Only positive constraints that every
 * match must satisfy count: a top-level AND contributes its narrowest child,
 * an OR contributes only when every branch pins the same kind of thing.
 */
export type Scope =
  | { kind: "sets"; values: string[] }
  | { kind: "setCodes"; values: string[] }
  | { kind: "ids"; values: string[] }
  | { kind: "names"; values: { value: string; phrase: boolean }[] }
  | { kind: "none" };

const SCOPE_RANK: Record<Scope["kind"], number> = { ids: 0, sets: 1, setCodes: 2, names: 3, none: 9 };

export function scopeOf(node: Node): Scope {
  switch (node.kind) {
    case "term": {
      const f = node.field.toLowerCase();
      if (f === "id") return { kind: "ids", values: [node.value] };
      if (f === "set.id" && !node.value.includes("*")) return { kind: "sets", values: [node.value] };
      if (f === "set.ptcgocode" && !node.value.includes("*")) return { kind: "setCodes", values: [node.value] };
      if (f === "name") return { kind: "names", values: [{ value: node.value, phrase: node.phrase }] };
      return { kind: "none" };
    }
    case "and": {
      let best: Scope = { kind: "none" };
      for (const child of node.children) {
        const s = scopeOf(child);
        if (SCOPE_RANK[s.kind] < SCOPE_RANK[best.kind]) best = s;
      }
      return best;
    }
    case "or": {
      const scopes = node.children.map(scopeOf);
      const first = scopes[0];
      if (first.kind === "none" || scopes.some((s) => s.kind !== first.kind)) return { kind: "none" };
      // Same kind on every branch: union the values.
      const values = scopes.flatMap((s) => (s as { values: unknown[] }).values);
      return { kind: first.kind, values } as Scope;
    }
    default:
      return { kind: "none" };
  }
}

// ---------------------------------------------------------------- ordering

function compareValues(a: string, b: string): number {
  if (a === b) return 0;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true });
}

/** Sort a copy by a pokemontcg.io-style orderBy ("-set.releaseDate,number"). */
export function sortBy<T>(items: T[], orderBy: string | undefined): T[] {
  if (!orderBy) return [...items];
  const keys = orderBy
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean)
    .map((k) => ({ desc: k.startsWith("-"), path: k.replace(/^-/, "") }));
  return [...items].sort((x, y) => {
    for (const { desc, path } of keys) {
      const a = valuesAt(x, path)[0];
      const b = valuesAt(y, path)[0];
      // Missing values sort last in either direction.
      if (a === undefined || b === undefined) {
        if (a !== b) return a === undefined ? 1 : -1;
        continue;
      }
      const cmp = compareValues(a, b);
      if (cmp !== 0) return desc ? -cmp : cmp;
    }
    return 0;
  });
}
