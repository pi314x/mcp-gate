// Does the gate say "nothing fits" when nothing fits, and still serve the tasks that need a tool?
//
// Runs the real `GateSession.route` over bench/abstain.json against a tool list captured from a real MCP server,
// once with corroboration switched off (one shared word is enough) and once with the shipped defaults. Both use
// the same stop words, so the difference is the rule alone.
// `tuning` tasks were used to choose the rule; `final` tasks were written afterwards and scored once, so those
// are the numbers to quote.
//
//   npx tsx scripts/abstain.ts            # print the tables
//   npx tsx scripts/abstain.ts --misses   # also list every task served wrongly or not at all
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryTransport, Server, type Tool } from '@modelcontextprotocol/server';
import { parseConfig } from '../src/config.js';
import type { Connector } from '../src/downstream.js';
import { Gate } from '../src/gate.js';

interface Task {
  task: string;
  expect: string[];
  split: 'tuning' | 'final';
}
interface Fixture {
  server: string;
  tools: { name: string; description: string; inputSchema: unknown }[];
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(resolve(root, path), 'utf8')) as T;

function fixtureConnector(fixture: Fixture): Connector {
  return async () => {
    const server = new Server({ name: fixture.server, version: '0.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler('tools/list', () => ({
      tools: fixture.tools.map((t): Tool => ({ name: t.name, description: t.description, inputSchema: t.inputSchema as Tool['inputSchema'] }))
    }));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    return clientSide;
  };
}

interface Outcome {
  task: Task;
  routed: string[];
  served: boolean;
}

async function run(fixture: Fixture, tasks: Task[], gateSettings: Record<string, number>): Promise<Outcome[]> {
  const config = parseConfig({ servers: { [fixture.server]: { command: 'unused' } }, gate: gateSettings });
  const gate = new Gate(config, { [fixture.server]: fixtureConnector(fixture) });
  await gate.start();
  try {
    return tasks.map((task) => {
      const routed = gate.createSession().route(task.task, { enable: false }).matched.map((m) => m.name.slice(fixture.server.length + 2));
      const served = task.expect.length === 0 ? routed.length === 0 : task.expect.every((tool) => routed.includes(tool));
      return { task, routed, served };
    });
  } finally {
    await gate.close();
  }
}

const pct = (n: number, of: number): string => (of === 0 ? 'n/a' : `${((100 * n) / of).toFixed(0)}%`);

function summarize(label: string, outcomes: Outcome[]): string {
  const needTool = outcomes.filter((o) => o.task.expect.length > 0);
  const needNone = outcomes.filter((o) => o.task.expect.length === 0);
  const served = needTool.filter((o) => o.served).length;
  const abstained = needNone.filter((o) => o.served).length;
  return `${label.padEnd(34)} serves ${String(served).padStart(2)} of ${needTool.length} tasks that need a tool (${pct(served, needTool.length).padStart(4)})   abstains on ${String(abstained).padStart(2)} of ${needNone.length} that need none (${pct(abstained, needNone.length).padStart(4)})`;
}

const bench = await readJson<{ fixture: string; tasks: Task[] }>('bench/abstain.json');
const fixture = await readJson<Fixture>(`bench/fixtures/${bench.fixture}.tools.json`);

const before = { routeMinMatched: 1, routeMinCoverage: 0 };
const lines: string[] = [];
const misses: string[] = [];

for (const split of ['tuning', 'final'] as const) {
  const tasks = bench.tasks.filter((t) => t.split === split);
  const old = await run(fixture, tasks, before);
  const now = await run(fixture, tasks, {});
  lines.push(`${split} (${tasks.length} tasks)`, `  ${summarize('without corroboration (1 word, 0%)', old)}`, `  ${summarize('now: shipped defaults', now)}`);
  if (split === 'final') {
    for (const o of now.filter((x) => !x.served)) {
      misses.push(`  ${o.task.expect.length === 0 ? 'enabled for a task that needs none' : 'not served'}: "${o.task.task}"  expected [${o.task.expect.join(', ')}]  routed [${o.routed.join(', ')}]`);
    }
  }
}

console.log(lines.join('\n'));
if (process.argv.includes('--misses') && misses.length > 0) console.log(`\nfinal-split tasks the shipped defaults get wrong:\n${misses.join('\n')}`);
