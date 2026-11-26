// How good is `gate_capsule`, end to end?
//
// Starts the real gate over the real skills-router (TypeScript build) and the real lean-context, with the skills of
// skills-router's two catalogs (11 procedures) and lean-context's bundled fixture repo, and runs bench/capsule.json
// through `GateSession.capsule`. The downstream GitHub, Postgres and radar tools the skills name do not exist here, so
// a stand-in server offers tools of those names (generated from the skills' own `tools:` lines, with no real
// definitions): only the names matter to a capsule, and the benchmark says so.
//
// It measures four things, on the `tuning` tasks and on the `final` tasks separately:
//   skill   did the capsule serve the right skill, and return none (enabling nothing) when none fits?
//   tools   did it enable exactly the tools of that skill?
//   code    did its code areas hold a right file, for the tasks that have one in the fixture repo?
//   tokens  what does the capsule's answer cost, against the same information fetched by hand with each tool's
//           defaults (route_skill top 3, get_skill, one enable, ctx_search at 1500 tokens and 6 results)?
// Tokens are the `heuristic-v1` estimate, not a model tokenizer.
//
//   npx tsx scripts/capsule-bench.ts            # print the tables
//   npx tsx scripts/capsule-bench.ts --misses   # also list every task the capsule got wrong
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, Server, type Tool } from '@modelcontextprotocol/server';
import { parseConfig } from '../src/config.js';
import type { Connector } from '../src/downstream.js';
import { Gate, type CapsuleReport } from '../src/gate.js';
import { countTokens } from '../src/ledger-tokens.js';

interface Task {
  task: string;
  skill: string | null;
  code?: string[];
  split: 'tuning' | 'final';
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const siblings = resolve(root, '..');
const skillsRouter = join(siblings, 'skills-router');
const skillsTs = join(skillsRouter, 'ts-mcp-server');
const leanContext = join(siblings, 'lean-context');
const codeRepo = join(leanContext, 'bench', 'fixtures', 'repo');

const missing = [
  [join(skillsTs, 'node_modules'), 'skills-router with its dependencies installed (ts-mcp-server: npm ci)'],
  [join(leanContext, 'dist', 'index.js'), 'lean-context, built (npm run build)'],
  [codeRepo, "lean-context's bench/fixtures/repo"]
].filter(([path]) => !existsSync(path as string));
if (missing.length > 0) {
  console.error(`The capsule benchmark needs, next to this repository: ${missing.map(([, what]) => what).join('; ')}.`);
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'capsule-bench-'));
const skillsDir = join(work, 'skills');
mkdirSync(skillsDir);
for (const catalog of [join(skillsRouter, 'examples', 'skills'), join(skillsRouter, 'skills')]) {
  for (const file of readdirSync(catalog).filter((name) => name.endsWith('.md'))) cpSync(join(catalog, file), join(skillsDir, file));
}

/** The `tools:` of each skill, from its frontmatter: what a capsule should enable for it. */
const skillTools = new Map<string, string[]>();
for (const file of readdirSync(skillsDir)) {
  const text = readFileSync(join(skillsDir, file), 'utf8');
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.trim();
  const tools = /^tools:\s*(.*)$/m.exec(text)?.[1] ?? '';
  if (name !== undefined) skillTools.set(name, tools.split(',').map((tool) => tool.trim()).filter(Boolean));
}
const standInNames = [...new Set([...skillTools.values()].flat())].sort();

const standIn: Connector = async () => {
  const server = new Server({ name: 'stand-in', version: '0.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler('tools/list', () => ({
    tools: standInNames.map((name): Tool => ({ name, description: `Stand-in for ${name} (benchmark fixture, not a real definition)`, inputSchema: { type: 'object', properties: {} } }))
  }));
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  return clientSide;
};

const config = parseConfig({
  servers: {
    skills: { command: process.execPath, args: ['--import', 'tsx', 'src/server.ts', '--transport', 'stdio'], cwd: skillsTs, env: { SKILLS_DIR: skillsDir } },
    context: { command: process.execPath, args: ['dist/index.js', '--root', codeRepo, '--cache-dir', join(work, 'cache'), '--no-watch'], cwd: leanContext },
    tools: { command: 'unused' }
  },
  gate: { skillsServer: 'skills', codeServer: 'context' }
});
const gate = new Gate(config, { tools: standIn });
await gate.start();

const textOf = (result: { content: { type: string; text?: string }[] }): string => result.content.map((part) => part.text ?? '').join('');
const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? 0 : sorted.length % 2 === 1 ? sorted[(sorted.length - 1) / 2]! : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2;
};
const pct = (n: number, of: number): string => (of === 0 ? 'n/a' : `${Math.round((100 * n) / of)}%`);

interface Outcome {
  task: Task;
  report: CapsuleReport | undefined;
  error?: string;
  /** The skills server's own score for its best match, or undefined when it matched nothing. */
  score: number | undefined;
  skillRight: boolean;
  toolsRight: boolean;
  codeRight: boolean | undefined;
  capsuleTokens: number;
  manualTokens: number;
  manualCalls: number;
}

async function evaluate(task: Task): Promise<Outcome> {
  let report: CapsuleReport | undefined;
  let error: string | undefined;
  try {
    report = await gate.createSession().capsule(task.task);
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }
  const served = report?.skill;
  const skillRight = task.skill === null ? served === undefined && error === undefined : served === task.skill;

  const expectedTools = task.skill === null ? [] : (skillTools.get(task.skill) ?? []).map((tool) => `tools__${tool}`).sort();
  const enabled = (report?.tools?.enabled ?? []).filter((name) => name.startsWith('tools__')).sort();
  const toolsRight = task.skill === null ? enabled.length === 0 : skillRight && JSON.stringify(enabled) === JSON.stringify(expectedTools) && (report?.unresolved ?? []).length === 0;

  const codeRight = task.code === undefined ? undefined : task.code.some((path) => (report?.codeAreas ?? '').includes(path));

  const best = (JSON.parse(textOf(await gate.call('skills__route_skill', { task: task.task, top_k: 1 }))) as { matches?: { score?: number }[] }).matches?.[0];

  // The same information by hand, with each tool's defaults.
  let manualTokens = 0;
  let manualCalls = 0;
  if (skillRight && task.skill !== null) {
    const routed = await gate.call('skills__route_skill', { task: task.task, top_k: 3 });
    const fetched = await gate.call('skills__get_skill', { name: task.skill });
    const enableReport = gate.createSession().enable(expectedTools);
    manualTokens = countTokens(textOf(routed)) + countTokens(textOf(fetched)) + countTokens(JSON.stringify(enableReport, null, 2));
    manualCalls = 3;
    if (task.code !== undefined) {
      const searched = await gate.call('context__ctx_search', { query: task.task, budget_tokens: 1500, max_results: 6 });
      manualTokens += countTokens(textOf(searched));
      manualCalls += 1;
    }
  }
  return { task, report, ...(error !== undefined && { error }), score: best?.score, skillRight, toolsRight, codeRight, capsuleTokens: report === undefined ? 0 : countTokens(JSON.stringify(report, null, 2)), manualTokens, manualCalls };
}

const bench = JSON.parse(readFileSync(join(root, 'bench', 'capsule.json'), 'utf8')) as { tasks: Task[] };
const outcomes: Outcome[] = [];
try {
  for (const task of bench.tasks) outcomes.push(await evaluate(task));
} finally {
  await gate.close();
  rmSync(work, { recursive: true, force: true });
}

const lines: string[] = [];
const wrong: string[] = [];
for (const split of ['tuning', 'final'] as const) {
  const rows = outcomes.filter((o) => o.task.split === split);
  const positives = rows.filter((o) => o.task.skill !== null);
  const negatives = rows.filter((o) => o.task.skill === null);
  const served = positives.filter((o) => o.skillRight);
  const withCode = positives.filter((o) => o.task.code !== undefined);
  const grouped = (subset: Outcome[]) => {
    const ok = subset.filter((o) => o.skillRight);
    return ok.length === 0 ? 'n/a' : `capsule ${median(ok.map((o) => o.capsuleTokens))} tokens in 1 call against ${median(ok.map((o) => o.manualTokens))} tokens in ${median(ok.map((o) => o.manualCalls))} calls by hand`;
  };
  lines.push(
    `${split} (${rows.length} tasks: ${positives.length} with a skill, ${negatives.length} with none)`,
    `  skill   served the right skill for ${served.length} of ${positives.length} (${pct(served.length, positives.length)}); returned none for ${negatives.filter((o) => o.skillRight).length} of ${negatives.length} that need none (${pct(negatives.filter((o) => o.skillRight).length, negatives.length)})`,
    `  tools   enabled exactly the skill's tools for ${positives.filter((o) => o.toolsRight).length} of ${positives.length}`,
    `  code    a right file among the code areas for ${withCode.filter((o) => o.codeRight === true).length} of ${withCode.length} tasks that have one; code areas returned for ${served.filter((o) => o.report?.codeAreas !== undefined).length} of ${served.length} served tasks`,
    `  tokens  tasks with code: ${grouped(withCode)}`,
    `          tasks without:   ${grouped(positives.filter((o) => o.task.code === undefined))}`
  );
  if (split === 'final') {
    for (const o of rows) {
      if (!o.skillRight) wrong.push(`  ${o.task.skill === null ? 'served a skill for a task that needs none' : 'wrong or no skill'}: "${o.task.task}" expected ${o.task.skill ?? 'none'}, got ${o.report?.skill ?? (o.error !== undefined ? `error: ${o.error}` : 'none')}`);
      else if (!o.toolsRight) wrong.push(`  wrong tools: "${o.task.task}" enabled [${(o.report?.tools?.enabled ?? []).join(', ')}] unresolved [${(o.report?.unresolved ?? []).join(', ')}]`);
      if (o.codeRight === false) wrong.push(`  no right file in the code areas: "${o.task.task}" wanted one of ${o.task.code?.join(', ')}`);
    }
  }
}
console.log(lines.join('\n'));
// Tuning tasks only: a floor is chosen by looking at these, never at the final ones.
if (process.argv.includes('--scores')) {
  console.log('\nscore of the skills server\'s best match, tuning tasks (a task that needs no skill should score low):');
  for (const o of outcomes.filter((row) => row.task.split === 'tuning').sort((a, b) => (b.score ?? 0) - (a.score ?? 0))) {
    console.log(`  ${(o.score === undefined ? 'none' : o.score.toFixed(2)).padStart(5)}  ${o.task.skill === null ? 'NEEDS NONE' : `needs ${o.task.skill}`}  got ${o.report?.skill ?? 'none'}  "${o.task.task.slice(0, 60)}"`);
  }
}
if (process.argv.includes('--misses') && wrong.length > 0) console.log(`\nfinal-split tasks the capsule gets wrong:\n${wrong.join('\n')}`);
