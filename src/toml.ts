// A minimal TOML writer (spec §14.7): strings, integers, floats, booleans,
// string arrays and one level of tables — exactly what a Codex agent role
// needs. Not a dependency on purpose: the runtime dependency stays Nunjucks.
//
// Strings are the whole game. Single-line values are basic strings with every
// `\`, `"` and control character escaped. A key listed in `multiline` is written
// as a multi-line literal string when its content allows (readable, no escapes),
// else as a multi-line basic string that escapes every `\` and `"` — so no
// content can close the string early. The newline right after an opening
// multi-line delimiter is trimmed by TOML, so one is always emitted.

export class TomlWriteError extends Error {
  override name = "TomlWriteError";
}

/** Marks a number as a TOML float (JS cannot tell `1` from `1.0`). */
export class TomlFloat {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}

export type TomlScalar = string | number | boolean | TomlFloat;
export type TomlValue = TomlScalar | string[];
export type TomlTable = Record<string, TomlValue | Record<string, TomlValue>>;

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

export function tomlKey(key: string): string {
  return BARE_KEY.test(key) ? key : basicString(key);
}

/** Escape for a basic string; `keepNewlines` leaves LF and tab literal (multi-line form). */
function escapeBasic(s: string, keepNewlines: boolean): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === '"') out += '\\"';
    else if (ch === "\n") out += keepNewlines ? "\n" : "\\n";
    else if (ch === "\t") out += keepNewlines ? "\t" : "\\t";
    else if (ch === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += "\\u" + code.toString(16).padStart(4, "0").toUpperCase();
    else out += ch;
  }
  return out;
}

function basicString(s: string): string {
  return `"${escapeBasic(s, false)}"`;
}

/** Control characters a literal string cannot hold (tab and LF are fine; CR is refused too,
 *  so CRLF survives exactly). A trailing `'` is legal in TOML 1.0 before the closing
 *  delimiter; it is still routed to the basic form, for parsers that get that edge wrong. */
const LITERAL_UNSAFE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

function multilineString(s: string): string {
  const literalOk = !s.includes("'''") && !s.endsWith("'") && !LITERAL_UNSAFE.test(s.replace(/\n/g, ""));
  if (literalOk) return `'''\n${s}'''`;
  return `"""\n${escapeBasic(s, true)}"""`;
}

function scalar(v: unknown, where: string, multiline: boolean): string {
  if (typeof v === "string") return multiline ? multilineString(v) : basicString(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new TomlWriteError(`${where}: ${v} is not an integer (use TomlFloat)`);
    return String(v);
  }
  if (v instanceof TomlFloat) {
    if (!Number.isFinite(v.value)) throw new TomlWriteError(`${where}: ${v.value} is not a finite float`);
    const text = String(v.value);
    return /[.eE]/.test(text) ? text : `${text}.0`;
  }
  throw new TomlWriteError(`${where}: unsupported value ${JSON.stringify(v)}`);
}

function value(v: unknown, where: string, multiline: boolean): string {
  if (Array.isArray(v)) {
    for (const item of v) if (typeof item !== "string") throw new TomlWriteError(`${where}: only string arrays are supported`);
    return `[${(v as string[]).map(basicString).join(", ")}]`;
  }
  return scalar(v, where, multiline);
}

function isTable(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof TomlFloat);
}

/** Serialize a table; keys in `multiline` are written as multi-line strings. */
export function stringifyToml(table: TomlTable, opts: { multiline?: string[] } = {}): string {
  const ml = new Set(opts.multiline ?? []);
  const lines: string[] = [];
  const tables: [string, Record<string, unknown>][] = [];
  for (const [k, v] of Object.entries(table)) {
    if (isTable(v)) tables.push([k, v]);
    else lines.push(`${tomlKey(k)} = ${value(v, k, ml.has(k))}`);
  }
  for (const [k, t] of tables) {
    lines.push("", `[${tomlKey(k)}]`);
    for (const [sk, sv] of Object.entries(t)) {
      if (isTable(sv)) throw new TomlWriteError(`${k}.${sk}: nested tables are not supported`);
      lines.push(`${tomlKey(sk)} = ${value(sv, `${k}.${sk}`, false)}`);
    }
  }
  return lines.join("\n") + "\n";
}
