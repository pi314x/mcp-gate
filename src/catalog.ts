export interface CatalogTool {
  /** `<server>__<tool>`: the name a client sees once the tool is enabled. */
  qualified: string;
  server: string;
  tool: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export const SEPARATOR = '__';

export const qualify = (server: string, tool: string): string => `${server}${SEPARATOR}${tool}`;

/** Splits at the first separator; server names never contain one, tool names may. */
export function splitQualified(qualified: string): { server: string; tool: string } | undefined {
  const at = qualified.indexOf(SEPARATOR);
  if (at <= 0 || at + SEPARATOR.length >= qualified.length) return undefined;
  return { server: qualified.slice(0, at), tool: qualified.slice(at + SEPARATOR.length) };
}

/** Question words, pronouns and auxiliaries: they appear in nearly every task and tool description and separate nothing. */
const STOP_WORDS = new Set(
  `a an and the to of for in on with is it this that or by at from about
   what how which who why when my me i you your we our can could would should do does did are was were be been will please
   one some any there their them these those`.split(/\s+/)
);

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

export interface Scored {
  tool: CatalogTool;
  score: number;
  /** Distinct query words found in this tool's name or description. */
  matched: number;
  /** Distinct words of the query. Words no tool knows count here: they are the evidence that a task is about something else. */
  total: number;
}

/**
 * Whether a score is backed by enough of the task. One shared word is how "Cancel my gym membership" reaches
 * `job_cancel`, and a task that is mostly words no tool knows is about something else. A tool counts only when at
 * least `minMatched` of the task's words (or all of them, for a shorter task) and at least `minCoverage` of them
 * are found in it.
 */
export function corroborated(entry: Scored, minMatched: number, minCoverage: number): boolean {
  return entry.matched >= Math.min(minMatched, entry.total) && entry.matched / entry.total >= minCoverage;
}

/**
 * Lexical ranking, no model and no network. Matches in the tool name weigh three times those in the
 * description, rarer words weigh more. Only the metadata is scored (never schemas), so a word that merely
 * appears in a parameter description does not make a tool a match.
 */
export function rank(tools: readonly CatalogTool[], query: string): Scored[] {
  const words = [...new Set(tokenize(query))];
  if (words.length === 0 || tools.length === 0) return [];

  const docs = tools.map((tool) => ({
    tool,
    name: new Set(tokenize(`${tool.server} ${tool.tool}`)),
    description: new Set(tokenize(tool.description))
  }));
  const idf = new Map<string, number>();
  for (const word of words) {
    const containing = docs.filter((doc) => doc.name.has(word) || doc.description.has(word)).length;
    idf.set(word, Math.log(1 + (docs.length - containing + 0.5) / (containing + 0.5)));
  }

  return docs
    .map((doc) => {
      let score = 0;
      let matched = 0;
      for (const word of words) {
        const weight = idf.get(word) ?? 0;
        const inName = doc.name.has(word);
        const inDescription = doc.description.has(word);
        if (inName) score += 3 * weight;
        if (inDescription) score += weight;
        if (inName || inDescription) matched += 1;
      }
      return { tool: doc.tool, score, matched, total: words.length };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.qualified.localeCompare(b.tool.qualified));
}
