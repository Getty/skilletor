// Read an agent file's YAML frontmatter (spec §14.7) — a deliberately small
// subset of YAML, enough for what agent files use: nested block mappings, block
// and flow sequences of scalars, flat flow mappings, plain / quoted / block
// (`|`, `>`) scalars, comments. Anything else (anchors, aliases, tags, mappings
// inside sequences, nested flow collections) is a FrontmatterError naming the
// line, never a silent misread. No dependency: the runtime stays Nunjucks-only.

export class FrontmatterError extends Error {
  override name = "FrontmatterError";
}

/** A YAML float (JS cannot tell `1` from `1.0`; TOML can). */
export class YamlFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export type YamlValue = string | number | boolean | null | YamlFloat | YamlValue[] | { [key: string]: YamlValue };

export interface Frontmatter {
  data: Record<string, YamlValue>;
  /** The text after the closing fence, leading blank lines removed, otherwise verbatim. */
  body: string;
}

const OPEN = /^---[ \t]*\r?\n/;
const CLOSE = /^---[ \t]*(?:\r?\n|$)/gm;

export function splitFrontmatter(text: string): Frontmatter {
  const open = OPEN.exec(text);
  if (!open) return { data: {}, body: text };
  CLOSE.lastIndex = open[0].length;
  const close = CLOSE.exec(text);
  if (!close) throw new FrontmatterError("frontmatter: no closing --- line");
  const yaml = text.slice(open[0].length, close.index);
  const body = text.slice(close.index + close[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
  return { data: parseYaml(yaml), body };
}

// ---- the parser -------------------------------------------------------------

interface Line {
  /** 1-based line number in the file (the opening fence is line 1). */
  no: number;
  raw: string;
}

function fail(line: Line | undefined, message: string): never {
  throw new FrontmatterError(`frontmatter line ${line?.no ?? "?"}: ${message}`);
}

function indentOf(line: Line): number {
  const m = /^[ \t]*/.exec(line.raw)![0];
  if (m.includes("\t")) fail(line, "tabs are not allowed in indentation");
  return m.length;
}

function skippable(line: Line): boolean {
  const t = line.raw.trim();
  return t === "" || t.startsWith("#");
}

function isSeqItem(text: string): boolean {
  return text === "-" || text.startsWith("- ");
}

// "key": / 'key': / plain key, then `:` followed by whitespace or the end.
const KEY_RE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s"'#&*!|>[\]{},?:-][^:#]*?))[ \t]*:(?:[ \t]+(.*))?$/;

function parseYaml(yaml: string): Record<string, YamlValue> {
  const lines: Line[] = yaml.split(/\r?\n/).map((raw, i) => ({ no: i + 2, raw }));
  const p = new Parser(lines);
  const [value, pos] = p.mapping(0, 0);
  if (pos < lines.length) fail(lines[pos], "unexpected content");
  return value;
}

class Parser {
  lines: Line[];

  constructor(lines: Line[]) {
    this.lines = lines;
  }

  nextContent(pos: number): number {
    while (pos < this.lines.length && skippable(this.lines[pos]!)) pos++;
    return pos;
  }

  mapping(start: number, indent: number): [Record<string, YamlValue>, number] {
    const obj: Record<string, YamlValue> = {};
    let pos = start;
    for (;;) {
      pos = this.nextContent(pos);
      if (pos >= this.lines.length) break;
      const line = this.lines[pos]!;
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) fail(line, "unexpected indentation");
      const text = line.raw.slice(ind);
      if (isSeqItem(text)) fail(line, "unexpected sequence item");
      const m = KEY_RE.exec(text);
      if (!m) fail(line, "expected `key: value`");
      const key = m[1] !== undefined ? unescapeDouble(m[1], line) : m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3]!.trim();
      if (Object.prototype.hasOwnProperty.call(obj, key)) fail(line, `duplicate key "${key}"`);
      const [value, next] = this.value(m[4] ?? "", pos + 1, indent, line);
      obj[key] = value;
      pos = next;
    }
    return [obj, pos];
  }

  /** The value after `key:` on `line`; `pos` is the line after it. */
  value(rest: string, pos: number, indent: number, line: Line): [YamlValue, number] {
    const r = rest.trim();
    if (r.startsWith("|") || r.startsWith(">")) return this.blockScalar(r, pos, indent, line);
    if (r === "" || r.startsWith("#")) {
      const q = this.nextContent(pos);
      if (q >= this.lines.length) return [null, q];
      const next = this.lines[q]!;
      const ind = indentOf(next);
      const text = next.raw.slice(ind);
      if (ind > indent) return isSeqItem(text) ? this.sequence(q, ind) : this.mapping(q, ind);
      if (ind === indent && isSeqItem(text)) return this.sequence(q, ind);
      return [null, q];
    }
    // An inline value, possibly continued on more-indented lines (folded with spaces).
    const parts = [r];
    let p = pos;
    for (;;) {
      const q = this.nextContent(p);
      if (q >= this.lines.length || indentOf(this.lines[q]!) <= indent) break;
      parts.push(this.lines[q]!.raw.trim());
      p = q + 1;
    }
    if (parts.length === 1) return [inline(r, line), pos];
    if (/^["'[{]/.test(r)) return [inline(parts.join(" "), line), p];
    if (/^[&*!]/.test(r)) fail(line, "anchors, aliases and tags are not supported");
    return [parts.map((s) => stripComment(s)).join(" "), p];
  }

  sequence(start: number, indent: number): [YamlValue[], number] {
    const arr: YamlValue[] = [];
    let pos = start;
    for (;;) {
      pos = this.nextContent(pos);
      if (pos >= this.lines.length) break;
      const line = this.lines[pos]!;
      const ind = indentOf(line);
      if (ind < indent) break;
      if (ind > indent) fail(line, "unexpected indentation in a sequence");
      const text = line.raw.slice(ind);
      if (!isSeqItem(text)) break;
      const item = text.slice(1).trim();
      if (item === "" || item.startsWith("#")) fail(line, "nested blocks inside sequences are not supported");
      if (KEY_RE.test(item)) fail(line, "mappings inside sequences are not supported");
      if (/^[[{]/.test(item)) fail(line, "nested collections are not supported");
      arr.push(inline(item, line));
      pos++;
    }
    return [arr, pos];
  }

  blockScalar(header: string, pos: number, indent: number, line: Line): [string, number] {
    const h = /^([|>])([+-]?)([1-9]?)[ \t]*(?:#.*)?$/.exec(header);
    if (!h) fail(line, `unsupported block scalar header "${header}"`);
    const folded = h[1] === ">";
    const chomp = h[2];
    let contentIndent = h[3] ? indent + Number(h[3]) : -1;
    const collected: Line[] = [];
    let p = pos;
    while (p < this.lines.length) {
      const l = this.lines[p]!;
      if (l.raw.trim() === "") {
        collected.push(l);
        p++;
        continue;
      }
      const ind = indentOf(l);
      if (ind <= indent) break;
      if (contentIndent === -1) contentIndent = ind;
      if (ind < contentIndent) fail(l, "block scalar line is less indented than its first line");
      collected.push(l);
      p++;
    }
    const texts = collected.map((l) => (l.raw.trim() === "" ? "" : l.raw.slice(contentIndent)));
    let trailing = 0;
    while (texts.length && texts[texts.length - 1] === "") {
      texts.pop();
      trailing++;
    }
    let body: string;
    if (!folded) {
      body = texts.join("\n");
    } else {
      body = "";
      let pending = 0;
      let first = true;
      let prevMore = false;
      for (const t of texts) {
        if (t === "") {
          pending++;
          continue;
        }
        const more = t.startsWith(" ") || t.startsWith("\t");
        if (first) body = t;
        else if (pending > 0) body += "\n".repeat(pending) + t;
        else if (more || prevMore) body += "\n" + t;
        else body += " " + t;
        first = false;
        pending = 0;
        prevMore = more;
      }
    }
    if (chomp === "-") return [body, p];
    if (body === "" && chomp !== "+") return ["", p];
    return [body + "\n" + (chomp === "+" ? "\n".repeat(trailing) : ""), p];
  }
}

// ---- inline values ------------------------------------------------------------

function stripComment(s: string): string {
  const i = s.search(/(^|[ \t])#/);
  return (i === -1 ? s : s.slice(0, i)).trim();
}

function typedPlain(s: string): YamlValue {
  if (s === "" || s === "~" || /^(null|Null|NULL)$/.test(s)) return null;
  if (/^(true|True|TRUE)$/.test(s)) return true;
  if (/^(false|False|FALSE)$/.test(s)) return false;
  if (/^[-+]?[0-9]+$/.test(s)) {
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : s;
  }
  if (/^[-+]?(\.[0-9]+|[0-9]+\.[0-9]*|[0-9]+(?=[eE]))([eE][-+]?[0-9]+)?$/.test(s)) return new YamlFloat(Number(s));
  return s;
}

const ESCAPES: Record<string, string> = {
  "0": "\0", a: "\x07", b: "\b", t: "\t", "\t": "\t", n: "\n", v: "\v", f: "\f", r: "\r", e: "\x1b",
  " ": " ", '"': '"', "/": "/", "\\": "\\", N: "\u0085", _: " ", L: " ", P: " ",
};

function unescapeDouble(s: string, line: Line): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const e = s[++i];
    if (e === undefined) fail(line, "dangling backslash in a double-quoted string");
    const hexLen = e === "x" ? 2 : e === "u" ? 4 : e === "U" ? 8 : 0;
    if (hexLen) {
      const hex = s.slice(i + 1, i + 1 + hexLen);
      if (!new RegExp(`^[0-9a-fA-F]{${hexLen}}$`).test(hex)) fail(line, `bad \\${e} escape`);
      out += String.fromCodePoint(parseInt(hex, 16));
      i += hexLen;
    } else if (e in ESCAPES) {
      out += ESCAPES[e];
    } else {
      fail(line, `unknown escape \\${e}`);
    }
  }
  return out;
}

/** Read one quoted scalar at s[i] (a quote); returns the value and the index after it. */
function quoted(s: string, i: number, line: Line): [string, number] {
  const q = s[i];
  let j = i + 1;
  if (q === "'") {
    let out = "";
    for (;;) {
      if (j >= s.length) fail(line, "unterminated single-quoted string");
      if (s[j] === "'") {
        if (s[j + 1] === "'") {
          out += "'";
          j += 2;
          continue;
        }
        return [out, j + 1];
      }
      out += s[j++];
    }
  }
  for (;;) {
    if (j >= s.length) fail(line, "unterminated double-quoted string");
    if (s[j] === "\\") {
      j += 2;
      continue;
    }
    if (s[j] === '"') return [unescapeDouble(s.slice(i + 1, j), line), j + 1];
    j++;
  }
}

function assertEnd(s: string, i: number, line: Line): void {
  const rest = s.slice(i).trim();
  if (rest !== "" && !rest.startsWith("#")) fail(line, `unexpected text after a value: "${rest}"`);
}

/** A scalar inside a flow collection: quoted, or plain up to `,` or the closing bracket. */
function flowScalar(s: string, i: number, closer: string, line: Line): [YamlValue, number] {
  while (s[i] === " " || s[i] === "\t") i++;
  if (s[i] === '"' || s[i] === "'") {
    const [v, j] = quoted(s, i, line);
    return [v, j];
  }
  if (s[i] === "[" || s[i] === "{") fail(line, "nested collections are not supported");
  let j = i;
  while (j < s.length && s[j] !== "," && s[j] !== closer) j++;
  return [typedPlain(s.slice(i, j).trim()), j];
}

function flowSeparator(s: string, j: number, closer: string, line: Line): [boolean, number] {
  while (s[j] === " " || s[j] === "\t") j++;
  if (s[j] === ",") return [false, j + 1];
  if (s[j] === closer) return [true, j + 1];
  return fail(line, `expected "," or "${closer}"`);
}

function inline(value: string, line: Line): YamlValue {
  const s = value.trim();
  if (/^[&*!]/.test(s)) fail(line, "anchors, aliases and tags are not supported");
  if (s.startsWith('"') || s.startsWith("'")) {
    const [v, j] = quoted(s, 0, line);
    assertEnd(s, j, line);
    return v;
  }
  if (s.startsWith("[")) {
    const arr: YamlValue[] = [];
    let j = 1;
    if (/^\[\s*\]/.test(s)) {
      assertEnd(s, s.indexOf("]") + 1, line);
      return arr;
    }
    for (;;) {
      const [v, k] = flowScalar(s, j, "]", line);
      arr.push(v);
      const [done, n] = flowSeparator(s, k, "]", line);
      j = n;
      if (done) break;
    }
    assertEnd(s, j, line);
    return arr;
  }
  if (s.startsWith("{")) {
    const obj: Record<string, YamlValue> = {};
    let j = 1;
    if (/^\{\s*\}/.test(s)) {
      assertEnd(s, s.indexOf("}") + 1, line);
      return obj;
    }
    for (;;) {
      while (s[j] === " ") j++;
      const colon = s.indexOf(":", j);
      if (colon === -1) fail(line, "expected `key: value` in a flow mapping");
      const key = s.slice(j, colon).trim().replace(/^(["'])(.*)\1$/, "$2");
      if (key === "" || /[,{}[\]]/.test(key)) fail(line, "bad key in a flow mapping");
      const [v, k] = flowScalar(s, colon + 1, "}", line);
      obj[key] = v;
      const [done, n] = flowSeparator(s, k, "}", line);
      j = n;
      if (done) break;
    }
    assertEnd(s, j, line);
    return obj;
  }
  return typedPlain(stripComment(s));
}
