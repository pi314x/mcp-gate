// Token counting for the savings report.
//
// OpenAI models: exact for the o200k_base encoding (what the GPT-4o, GPT-4.1 and GPT-5 families use), counted
// with the `gpt-tokenizer` package. Whether the GPT-6 family also uses o200k_base is not confirmed, so those rows
// say "assumed".
//
// Claude models: an OpenAI tokenizer undercounts Claude tokens (Anthropic's own guidance: roughly 15-20% on
// typical text, more on code), so Claude rows are an ESTIMATE: the o200k_base count times CLAUDE_FACTOR, and are
// labelled as one. Exact Claude counts need Anthropic's count_tokens endpoint with an API key; this script does
// not call any network service. The percentage saved does not depend on the factor, because it cancels.
//
// `gpt-tokenizer` is optional: install it without touching package.json with
//   npm install --no-save gpt-tokenizer

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
}

/** What a model is sent for tool use: definitions, plus any server instructions and tool-result text. */
export interface Payload {
  tools: ToolDef[];
  system?: string;
  extra?: string;
}

export const CLAUDE_FACTOR = 1.2;

export interface ModelRow {
  family: 'claude' | 'openai';
  /** Models that share a tokenizer, hence a count, share a row. */
  models: string;
  basis: string;
}

// Lineup as listed by third-party model/pricing pages on 2026-11-24 (OpenAI's own page was not consulted);
// suffixes such as 6.1 or 6.2 differ between those pages, so the family name is used.
export const ROWS: ModelRow[] = [
  { family: 'claude', models: 'Claude Fable 5.2, Opus 5.5, Sonnet 5.5, Haiku 5.5', basis: `estimate: o200k_base x ${CLAUDE_FACTOR}` },
  { family: 'openai', models: 'GPT-6 Astra, Sol, Terra, Luna', basis: 'o200k_base (assumed for GPT-6)' },
  { family: 'openai', models: 'GPT-5.5', basis: 'o200k_base' }
];

export async function loadEncoder(): Promise<(text: string) => number> {
  try {
    const spec = 'gpt-tokenizer/encoding/o200k_base';
    const mod = (await import(spec)) as { encode?: (text: string) => number[] };
    const encode = mod.encode;
    if (typeof encode === 'function') return (text) => encode(text).length;
  } catch {
    // fall through to the message below
  }
  throw new Error('gpt-tokenizer is not installed. Run: npm install --no-save gpt-tokenizer');
}

/** The tool definitions the way each API takes them. */
const claudeTools = (tools: ToolDef[]) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
const openAiTools = (tools: ToolDef[]) =>
  tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

export type Counter = (payload: Payload) => number;

export function counterFor(row: ModelRow, o200k: (text: string) => number): Counter {
  return (payload) => {
    const defs = JSON.stringify(row.family === 'claude' ? claudeTools(payload.tools) : openAiTools(payload.tools));
    const raw = o200k(defs) + o200k(payload.system ?? '') + o200k(payload.extra ?? '');
    return row.family === 'claude' ? Math.round(raw * CLAUDE_FACTOR) : raw;
  };
}
