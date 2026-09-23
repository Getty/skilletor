// Per-target output conversion (spec §14.7): a Claude agent's rendered Markdown
// becomes a Codex agent-role TOML file. Runs in the engine between render and
// apply; knows neither sources nor the target filesystem.
import type { Harness, ItemType } from "./config.ts";
import { FrontmatterError, splitFrontmatter, YamlFloat, type YamlValue } from "./frontmatter.ts";
import { stringifyToml, TomlFloat, type TomlTable, type TomlValue } from "./toml.ts";

export class ConvertError extends Error {
  override name = "ConvertError";
}

export interface AgentConversion {
  /** The TOML text; undefined when the body is blank (not applicable for Codex). */
  toml?: string;
  /** One line per dropped `codex:` key ("codex.key: reason; dropped"). */
  warnings: string[];
  /** The agent declared `briefing.skills`, which was not written (see `briefingTable`). */
  briefingDropped: boolean;
}

export interface ConvertOptions {
  /**
   * Write `briefing.skills` as a `[briefing]` table. Off: Codex 0.153 rejects
   * unknown keys in agent-role files and then ignores the whole role (spec §14.7).
   */
  briefingTable?: boolean;
}

/** The switch for `briefing.skills` → `[briefing]`; flip once Codex tolerates it. */
export const CODEX_BRIEFING_TABLE = false;

type Scalar = string | number | boolean | TomlFloat;

/** A YAML value as a TOML scalar or string array, or a reason it cannot be one. */
function tomlLeaf(v: YamlValue): TomlValue | { reason: string } {
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return v;
  if (v instanceof YamlFloat) return new TomlFloat(v.value);
  if (v === null) return { reason: "null has no TOML form" };
  if (Array.isArray(v)) {
    return v.every((x) => typeof x === "string") ? (v as string[]) : { reason: "only arrays of strings are supported" };
  }
  return { reason: "nested tables are not supported" };
}

function isReason(leaf: TomlValue | { reason: string }): leaf is { reason: string } {
  return typeof leaf === "object" && !Array.isArray(leaf) && !(leaf instanceof TomlFloat);
}

function isMapping(v: YamlValue | undefined): v is { [key: string]: YamlValue } {
  return v !== null && v !== undefined && typeof v === "object" && !Array.isArray(v) && !(v instanceof YamlFloat);
}

function asText(v: YamlValue | undefined): string | undefined {
  if (v === undefined || v === null || typeof v === "object") return undefined;
  return String(v);
}

export function codexAgentToml(markdown: string, itemName: string, opts: ConvertOptions = {}): AgentConversion {
  let fm: ReturnType<typeof splitFrontmatter>;
  try {
    fm = splitFrontmatter(markdown);
  } catch (err) {
    if (err instanceof FrontmatterError) throw new ConvertError(err.message);
    throw err;
  }
  const { data, body } = fm;
  const warnings: string[] = [];

  const top: Record<string, Scalar | string[]> = {
    name: asText(data.name) || itemName,
    description: asText(data.description) ?? "",
  };
  const tables: Record<string, Record<string, TomlValue>> = {};

  const briefing = data.briefing;
  const skills = isMapping(briefing) ? briefing.skills : undefined;
  let briefingDropped = false;
  if (Array.isArray(skills)) {
    if (opts.briefingTable ?? CODEX_BRIEFING_TABLE) {
      const leaf = tomlLeaf(skills);
      if (isReason(leaf)) warnings.push(`briefing.skills: ${leaf.reason}; dropped`);
      else tables.briefing = { skills: leaf };
    } else {
      briefingDropped = true;
    }
  }

  let instructions: TomlValue = body;
  const codex = data.codex;
  if (codex !== undefined && !isMapping(codex)) {
    warnings.push("codex: must be a mapping; ignored");
  } else if (codex) {
    for (const [key, v] of Object.entries(codex)) {
      if (isMapping(v) && (key in top || key === "developer_instructions" || key in tables)) {
        warnings.push(`codex.${key}: a table cannot replace the ${key} key; dropped`);
        continue;
      }
      if (isMapping(v)) {
        const t: Record<string, TomlValue> = {};
        for (const [sk, sv] of Object.entries(v)) {
          const leaf = tomlLeaf(sv);
          if (isReason(leaf)) {
            warnings.push(`codex.${key}.${sk}: ${leaf.reason}; dropped`);
          } else {
            t[sk] = leaf;
          }
        }
        tables[key] = t;
        continue;
      }
      const leaf = tomlLeaf(v);
      if (isReason(leaf)) {
        warnings.push(`codex.${key}: ${leaf.reason}; dropped`);
      } else if (key === "developer_instructions") {
        instructions = leaf;
      } else {
        top[key] = leaf;
      }
    }
  }

  if (typeof top.name !== "string" || top.name.trim() === "") throw new ConvertError("name must be a non-empty string");
  if (typeof top.description !== "string" || top.description.trim() === "") {
    throw new ConvertError("has no description (Codex rejects an agent role without one)");
  }
  if (typeof instructions !== "string") throw new ConvertError("developer_instructions must be a string");
  if (instructions.trim() === "") return { warnings, briefingDropped };

  const table: TomlTable = { ...top, developer_instructions: instructions, ...tables };
  return { toml: stringifyToml(table, { multiline: ["developer_instructions"] }), warnings, briefingDropped };
}

// ---- per-target output mapping -------------------------------------------------

export interface TargetConversion {
  /** The files to install for this target (install-relative path -> bytes). */
  output: Map<string, Buffer>;
  /** Not applicable for this target (e.g. a blank Codex agent body): skip, like an empty render. */
  skipped: boolean;
  warnings: string[];
  briefingDropped: boolean;
}

/**
 * Map an item's rendered output to what a harness installs. Claude, and Codex
 * skills, take it as it is; a Codex agent becomes `agents/<name>.toml`.
 * Throws a ConvertError when the item cannot be converted.
 */
export function convertForTarget(
  harness: Harness, type: ItemType, name: string, output: Map<string, Buffer>, opts: ConvertOptions = {},
): TargetConversion {
  if (harness !== "codex" || type !== "agent") return { output, skipped: false, warnings: [], briefingDropped: false };
  const md = output.get(`agents/${name}.md`);
  if (md === undefined) throw new ConvertError(`agents/${name}.md missing from the build`);
  const conv = codexAgentToml(md.toString("utf8"), name, opts);
  const out = new Map<string, Buffer>();
  if (conv.toml !== undefined) out.set(`agents/${name}.toml`, Buffer.from(conv.toml, "utf8"));
  return { output: out, skipped: conv.toml === undefined, warnings: conv.warnings, briefingDropped: conv.briefingDropped };
}
