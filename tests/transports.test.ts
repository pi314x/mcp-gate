import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gate } from '../src/gate.js';
import { serveOverHttp, type HttpHandle } from '../src/http.js';
import { CALENDAR, FILES, configOf, fakeServer, jsonOf, textOf, toolNames } from './helpers.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup().catch(() => undefined);
});

async function httpGate(options: { token?: string } = {}): Promise<{ gate: Gate; handle: HttpHandle }> {
  const gate = new Gate(configOf(), { files: fakeServer(FILES).connector, calendar: fakeServer(CALENDAR).connector });
  await gate.start();
  const handle = await serveOverHttp(gate, { host: '127.0.0.1', port: 0, ...(options.token !== undefined && { token: options.token }) });
  cleanups.push(async () => {
    await handle.close();
    await gate.close();
  });
  return { gate, handle };
}

async function httpClient(
  handle: HttpHandle,
  options: { era: 'legacy' | 'modern'; headers?: Record<string, string>; onChanged?: () => void }
): Promise<Client> {
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    {
      versionNegotiation: { mode: options.era === 'modern' ? 'auto' : 'legacy' },
      ...(options.onChanged !== undefined && { listChanged: { tools: { debounceMs: 0, onChanged: options.onChanged } } })
    }
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(handle.url), { requestInit: { headers: options.headers ?? {} } })
  );
  cleanups.push(() => client.close());
  return client;
}

describe('Streamable HTTP, 2025-era client (sessions)', () => {
  it('serves the gate tools, enables a tool, notifies over the session stream and forwards the call', async () => {
    const { handle } = await httpGate();
    let changes = 0;
    const client = await httpClient(handle, { era: 'legacy', onChanged: () => void (changes += 1) });
    expect(client.getProtocolEra()).toBe('legacy');

    expect(await toolNames(client)).toContain('gate_route');
    expect(await toolNames(client)).not.toContain('files__read_file');

    const report = jsonOf<{ enabled: string[] }>(await client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__read_file'] } }));
    expect(report.enabled).toEqual(['files__read_file']);
    await vi.waitFor(() => expect(changes).toBeGreaterThan(0), { timeout: 5000 });

    expect(await toolNames(client)).toContain('files__read_file');
    expect(textOf(await client.callTool({ name: 'files__read_file', arguments: { text: 'a.txt' } }))).toBe('contents of a.txt');
  });

  it('keeps each session\'s enabled tools separate', async () => {
    const { handle } = await httpGate();
    const one = await httpClient(handle, { era: 'legacy' });
    const two = await httpClient(handle, { era: 'legacy' });
    await one.callTool({ name: 'gate_enable_tools', arguments: { tools: ['calendar__list_events'] } });
    expect(await toolNames(one)).toContain('calendar__list_events');
    expect(await toolNames(two)).not.toContain('calendar__list_events');
  });
});

describe('Streamable HTTP, 2026-07-28 client (stateless)', () => {
  it('enables a tool in the caller\'s scope and forwards the call', async () => {
    const { handle } = await httpGate();
    const client = await httpClient(handle, { era: 'modern' });
    expect(client.getProtocolEra()).toBe('modern');

    await client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__read_file'] } });
    expect(await toolNames(client)).toContain('files__read_file');
    expect(textOf(await client.callTool({ name: 'files__read_file', arguments: { text: 'b.txt' } }))).toBe('contents of b.txt');
  });

  it('separates clients by the x-mcp-gate-scope header', async () => {
    const { handle } = await httpGate();
    const alice = await httpClient(handle, { era: 'modern', headers: { 'x-mcp-gate-scope': 'alice' } });
    const bob = await httpClient(handle, { era: 'modern', headers: { 'x-mcp-gate-scope': 'bob' } });
    await alice.callTool({ name: 'gate_enable_tools', arguments: { tools: ['calendar__create_event'] } });
    expect(await toolNames(alice)).toContain('calendar__create_event');
    expect(await toolNames(bob)).not.toContain('calendar__create_event');
  });

  it('delivers the tool-list change to a client that listens', async () => {
    const { handle } = await httpGate();
    let changes = 0;
    const client = await httpClient(handle, { era: 'modern', onChanged: () => void (changes += 1) });
    await client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__list_directory'] } });
    await vi.waitFor(() => expect(changes).toBeGreaterThan(0), { timeout: 5000 });
  });
});

describe('HTTP endpoint', () => {
  it('answers health checks and rejects other paths', async () => {
    const { handle } = await httpGate();
    const base = handle.url.replace(/\/mcp$/, '');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/other`)).status).toBe(404);
  });

  it('requires the bearer token when one is set', async () => {
    const { handle } = await httpGate({ token: 's3cret-token' });
    const denied = await fetch(handle.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(401);
    expect(denied.headers.get('www-authenticate')).toBe('Bearer');
    const wrong = await fetch(handle.url, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{}' });
    expect(wrong.status).toBe(401);

    const client = await httpClient(handle, { era: 'legacy', headers: { authorization: 'Bearer s3cret-token' } });
    expect(await toolNames(client)).toContain('gate_status');
  });

  it('rejects a request with a body that is not JSON, and a foreign host header', async () => {
    const { handle } = await httpGate();
    const bad = await fetch(handle.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
    expect(bad.status).toBe(400);
  });
});

describe('stdio, end to end with a real downstream process', () => {
  it('spawns the gate, which spawns a downstream server, and only shows what it enabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-gate-'));
    const configPath = join(directory, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        servers: {
          text: {
            command: process.execPath,
            args: ['--import', 'tsx', join(process.cwd(), 'tests/fixtures/downstream.ts')],
            policy: { deny: ['delete_*'] }
          }
        }
      })
    );

    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ['--import', 'tsx', join(process.cwd(), 'src/index.ts'), '--config', configPath],
        stderr: 'pipe'
      })
    );
    cleanups.push(() => client.close());

    expect(await toolNames(client)).not.toContain('text__shout');
    const routed = jsonOf<{ matched: { name: string }[]; enable: { enabled: string[] } }>(
      await client.callTool({ name: 'gate_route', arguments: { task: 'turn some text into capital letters' } })
    );
    expect(routed.enable.enabled).toContain('text__shout');
    expect(textOf(await client.callTool({ name: 'text__shout', arguments: { text: 'hello' } }))).toBe('HELLO');

    const denied = jsonOf<{ denied: { name: string }[] }>(
      await client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['text__delete_everything'] } })
    );
    expect(denied.denied.map((entry) => entry.name)).toEqual(['text__delete_everything']);
    expect(await toolNames(client)).not.toContain('text__delete_everything');
  }, 60_000);
});
