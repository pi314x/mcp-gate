// How many tokens does mcp-gate keep out of a model's context?
//
// Runs the real gate (real policy, real `gate_route`, real `tools/list`) in memory over tool lists captured from
// real MCP servers (bench/fixtures, made with scripts/capture-tools.ts), and counts what a model would be sent:
//
//   without gate   every tool definition of every connected server
//   gate idle      the six gate_* definitions plus the gate's instructions, before any task is known
//   gate + route   idle, plus the tools gate_route enabled for one task, plus gate_route's own result
//
// A saving only counts if the right tools are still reachable, so each task names the tools it needs and the
// report states how many tasks were served.
//
//   npm install --no-save gpt-tokenizer      # once; does not touch package.json
//   npx tsx scripts/token-report.ts          # print the tables
//   npx tsx scripts/token-report.ts --write  # also refresh the block between the markers in README.md
//
// Counting is described in scripts/counters.ts. Tool definitions are counted as the JSON each API takes; providers
// re-encode them internally, so billed numbers differ somewhat. The percentages are the portable result.
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, Server, type Tool } from '@modelcontextprotocol/server';
import { parseConfig } from '../src/config.js';
import type { Connector } from '../src/downstream.js';
import { Gate } from '../src/gate.js';
import { createGateServer } from '../src/server.js';
import { CLAUDE_FACTOR, ROWS, counterFor, loadEncoder, type Payload, type ToolDef } from './counters.js';

type Profile = 'core' | 'standard' | 'full';
const RANK: Record<Profile, number> = { core: 0, standard: 1, full: 2 };

interface Fixture {
  server: string;
  tools: ToolDef[];
}
interface Task {
  task: string;
  expect: string[];
  minProfile: Profile;
}
interface Stack {
  id: string;
  label: string;
  profile: Profile;
  fixtures: string[];
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

/** A client talking to a fresh gate session, as a host would after connecting. */
async function openClient(gate: Gate) {
  const session = gate.createSession();
  const server = createGateServer(gate, session);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'token-report', version: '0.0.0' });
  await client.connect(clientSide);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    }
  };
}

const listed = async (client: Client): Promise<ToolDef[]> =>
  (await client.listTools()).tools.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema }));
const textOf = (result: { content?: unknown }): string =>
  (result.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('');

interface TaskResult {
  task: string;
  expect: string[];
  enabled: string[];
  served: boolean;
  payload: Payload;
}
interface StackResult {
  stack: Stack;
  toolCount: number;
  without: Payload;
  idle: Payload;
  tasks: TaskResult[];
}

async function measure(stack: Stack, tasks: Task[]): Promise<StackResult> {
  const fixtures = await Promise.all(stack.fixtures.map((name) => readJson<Fixture>(`bench/fixtures/${name}.tools.json`)));
  const servers = Object.fromEntries(fixtures.map((f) => [f.server, { command: 'unused' }]));
  const downstreams = Object.fromEntries(fixtures.map((f) => [f.server, fixtureConnector(f)]));
  const gate = new Gate(parseConfig({ servers, gate: {} }), downstreams);
  await gate.start();
  try {
    const without: Payload = {
      tools: gate.catalog().map((t) => ({ name: t.qualified, description: t.description, inputSchema: t.inputSchema }))
    };

    const idleClient = await openClient(gate);
    const idle: Payload = { tools: await listed(idleClient.client), system: idleClient.client.getInstructions() ?? '' };
    await idleClient.close();

    const results: TaskResult[] = [];
    for (const task of tasks.filter((t) => RANK[t.minProfile] <= RANK[stack.profile])) {
      const open = await openClient(gate);
      const routed = await open.client.callTool({ name: 'gate_route', arguments: { task: task.task } });
      const routeText = textOf(routed);
      const tools = await listed(open.client);
      const enabled = tools.map((t) => t.name).filter((name) => !name.startsWith('gate_'));
      const qualified = task.expect.map((tool) => `${fixtures[0]?.server ?? ''}__${tool}`);
      results.push({
        task: task.task,
        expect: qualified,
        enabled,
        served: qualified.length === 0 ? enabled.length === 0 : qualified.every((name) => enabled.includes(name)),
        payload: { tools, system: idle.system ?? '', extra: routeText }
      });
      await open.close();
    }
    return { stack, toolCount: without.tools.length, without, idle, tasks: results };
  } finally {
    await gate.close();
  }
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};
const n = (value: number): string => Math.round(value).toLocaleString('en-US');
const pct = (saved: number, base: number): string => `${((saved / base) * 100).toFixed(1)}%`;

async function main(): Promise<void> {
  const o200k = await loadEncoder();
  const { default: defaultId, stacks } = await readJson<{ default: string; stacks: Stack[] }>('bench/stacks.json');
  const { tasks } = await readJson<{ tasks: Task[] }>('bench/tasks.json');
  const results: StackResult[] = [];
  for (const stack of stacks) results.push(await measure(stack, tasks));
  const main = results.find((r) => r.stack.id === defaultId) ?? (results[0] as StackResult);
  const exact = ROWS.find((row) => row.models === 'GPT-5.5') ?? (ROWS[0] as (typeof ROWS)[number]);

  const out: string[] = [];
  const served = main.tasks.filter((t) => t.served).length;
  const fit = main.tasks.filter((t) => t.expect.length > 0);
  const noFit = main.tasks.filter((t) => t.expect.length === 0);

  out.push(`Measured on **${main.stack.label}**: ${main.toolCount} tools. Tokens a model is sent for tool use, per request.`);
  out.push('');
  out.push('**Before any task is known** (gate idle: six `gate_*` tools plus the gate\'s instructions):');
  out.push('');
  out.push('| Model | Counted as | Without gate | With gate | Saved | Saved % |');
  out.push('|---|---|---:|---:|---:|---:|');
  for (const row of ROWS) {
    const count = counterFor(row, o200k);
    const base = count(main.without);
    const idle = count(main.idle);
    out.push(`| ${row.models} | ${row.basis} | ${n(base)} | ${n(idle)} | ${n(base - idle)} | ${pct(base - idle, base)} |`);
  }
  out.push('');
  out.push(
    `**After \`gate_route\` for one task** (median of ${main.tasks.length} tasks; counts the enabled tools and \`gate_route\`'s own result):`
  );
  out.push('');
  out.push('| Model | Counted as | Without gate | With gate (median) | Saved | Saved % |');
  out.push('|---|---|---:|---:|---:|---:|');
  for (const row of ROWS) {
    const count = counterFor(row, o200k);
    const base = count(main.without);
    const withGate = median(main.tasks.map((t) => count(t.payload)));
    out.push(`| ${row.models} | ${row.basis} | ${n(base)} | ${n(withGate)} | ${n(base - withGate)} | ${pct(base - withGate, base)} |`);
  }
  out.push('');
  out.push(
    `The right tools were enabled for **${served} of ${main.tasks.length}** tasks (${fit.filter((t) => t.served).length} of ${fit.length} that need tools; ${noFit.filter((t) => t.served).length} of ${noFit.length} where no tool fits and the gate enabled none).`
  );
  const missed = main.tasks.filter((t) => !t.served);
  if (missed.length > 0) {
    out.push('');
    out.push('Not served:');
    out.push('');
    for (const t of missed) {
      const want = t.expect.length === 0 ? 'nothing' : t.expect.join(', ');
      out.push(`- "${t.task}": needed ${want}; enabled ${t.enabled.length === 0 ? 'nothing' : t.enabled.join(', ')}`);
    }
  }
  out.push('');
  out.push(`**The saving grows with the tool list** (counted as ${exact.models}, ${exact.basis}):`);
  out.push('');
  out.push('| Tools behind the gate | Without gate | Gate idle | Idle saved | After one task (median) | Saved |');
  out.push('|---:|---:|---:|---:|---:|---:|');
  const count = counterFor(exact, o200k);
  for (const r of results) {
    const base = count(r.without);
    const idle = count(r.idle);
    const routed = median(r.tasks.map((t) => count(t.payload)));
    out.push(`| ${r.toolCount} (${r.stack.id}) | ${n(base)} | ${n(idle)} | ${pct(base - idle, base)} | ${n(routed)} | ${pct(base - routed, base)} |`);
  }
  out.push('');
  out.push(`Claude rows use a factor of ${CLAUDE_FACTOR} on the o200k_base count; see \`scripts/counters.ts\`.`);

  const block = out.join('\n');
  console.log(block);

  if (process.argv.includes('--write')) {
    const file = resolve(root, 'README.md');
    const readme = await readFile(file, 'utf8');
    const re = /(<!-- token-report:start -->)[\s\S]*?(<!-- token-report:end -->)/;
    if (!re.test(readme)) throw new Error('README.md has no <!-- token-report:start --> / <!-- token-report:end --> markers.');
    await writeFile(file, readme.replace(re, (_m, a: string, b: string) => `${a}\n${block}\n${b}`));
    console.error('README.md updated.');
  }
}

await main();
