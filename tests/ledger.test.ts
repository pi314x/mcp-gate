import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ledgerFromEnv } from '../src/ledger.js';
import { jsonOf, rig, type Rig } from './helpers.js';

interface Line {
  layer: string;
  kind: string;
  sent: number;
  baseline?: number;
  counter: string;
  meta?: Record<string, number | string | boolean>;
}

const dirs: string[] = [];
let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function ledgerFile() {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-gate-ledger-'));
  dirs.push(dir);
  const file = join(dir, 'ledger.jsonl');
  const ledger = ledgerFromEnv('gate', 'heuristic-v1', { CTX_LEDGER_FILE: file, CTX_LEDGER_SESSION: 'test-session' });
  const lines = (): Line[] => {
    try {
      return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as Line);
    } catch {
      return [];
    }
  };
  return { dir, file, ledger, lines };
}

describe('the ledger', () => {
  it('records one tools_list event per listing: what the gate sent against every tool the client could otherwise see', async () => {
    const { ledger, lines } = ledgerFile();
    current = await rig({ ledger });
    await current.client.listTools();
    await current.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__*'] } });
    await current.client.listTools();
    const listings = lines().filter((line) => line.kind === 'tools_list');
    const [idle, after] = listings.filter((line) => line.meta?.enabled !== undefined);
    expect(idle).toMatchObject({ layer: 'gate', counter: 'heuristic-v1', meta: { enabled: 0, offered: 5 } });
    expect(after).toMatchObject({ meta: { enabled: 3, offered: 5 } });
    expect(after!.sent).toBeGreaterThan(idle!.sent);
    expect(after!.baseline).toBe(idle!.baseline);
    expect(idle!.baseline).toBeGreaterThan(0);
  });

  it('keeps tools the policy denies out of the baseline, so a saving is never inflated by tools nobody could use', async () => {
    const open = ledgerFile();
    current = await rig({ ledger: open.ledger });
    await current.client.listTools();
    const full = open.lines().find((line) => line.kind === 'tools_list')!;
    await current.close();

    const denied = ledgerFile();
    current = await rig({
      ledger: denied.ledger,
      servers: { files: { command: 'unused', policy: { deny: ['write_*'] } }, calendar: { command: 'unused' } }
    });
    await current.client.listTools();
    const narrowed = denied.lines().find((line) => line.kind === 'tools_list')!;
    expect(narrowed.meta?.offered).toBe(4);
    expect(narrowed.baseline!).toBeLessThan(full.baseline!);
  });

  it('records a route event as pure added cost (baseline 0), with the size of the answer and counts, never the task', async () => {
    const { file, ledger, lines } = ledgerFile();
    current = await rig({ ledger });
    const report = jsonOf<{ matched: unknown[] }>(await current.client.callTool({ name: 'gate_route', arguments: { task: 'read a file from disk' } }));
    const route = lines().find((line) => line.kind === 'route')!;
    expect(route).toMatchObject({ layer: 'gate', meta: { matched: report.matched.length } });
    expect(route.sent).toBeGreaterThan(0);
    expect(route.baseline).toBe(0);
    expect(readFileSync(file, 'utf8')).not.toContain('read a file from disk');
  });

  it('never fails a request because the ledger cannot be written', async () => {
    const { dir } = ledgerFile();
    const blocker = join(dir, 'a-file');
    writeFileSync(blocker, '');
    const ledger = ledgerFromEnv('gate', 'heuristic-v1', { CTX_LEDGER_FILE: join(blocker, 'ledger.jsonl') });
    current = await rig({ ledger });
    expect((await current.client.listTools()).tools.length).toBeGreaterThan(0);
    await current.client.callTool({ name: 'gate_route', arguments: { task: 'read a file from disk' } });
    expect(ledger?.dropped).toBeGreaterThan(0);
  });
});
