import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gate } from '../src/gate.js';
import { CALENDAR, FILES, configOf, fakeServer, jsonOf, rig, textOf, toolNames, type Rig } from './helpers.js';

let current: Rig | undefined;
const start = async (options: Parameters<typeof rig>[0] = {}): Promise<Rig> => (current = await rig(options));
afterEach(async () => {
  await current?.close();
  current = undefined;
});

const GATE_TOOLS = ['gate_disable_tools', 'gate_enable_tools', 'gate_list_servers', 'gate_route', 'gate_search_tools', 'gate_status'];

describe('what a client sees', () => {
  it('starts with only the gate tools, however many tools the downstream servers have', async () => {
    const r = await start();
    expect((await toolNames(r.client)).sort()).toEqual(GATE_TOOLS);
    expect(r.gate.catalog().length).toBe(5);
  });

  it('lists the servers and their state without enabling anything', async () => {
    const r = await start();
    const { servers } = jsonOf<{ servers: { name: string; state: string; tools: number }[] }>(
      await r.client.callTool({ name: 'gate_list_servers' })
    );
    expect(servers).toEqual([
      { name: 'files', state: 'connected', tools: 3 },
      { name: 'calendar', state: 'connected', tools: 2 }
    ]);
    expect((await toolNames(r.client)).length).toBe(GATE_TOOLS.length);
  });

  it('enables tools from the always-on list at session start', async () => {
    const r = await start({ gate: { autoEnable: ['files__read_file'] } });
    expect(await toolNames(r.client)).toContain('files__read_file');
  });
});

describe('enabling', () => {
  it('searches without enabling, then enables, notifies, and the tool works', async () => {
    const r = await start();
    const found = jsonOf<{ results: { name: string; enabled: boolean }[] }>(
      await r.client.callTool({ name: 'gate_search_tools', arguments: { query: 'read a file' } })
    );
    expect(found.results[0]).toMatchObject({ name: 'files__read_file', enabled: false });
    expect(await toolNames(r.client)).not.toContain('files__read_file');

    const report = jsonOf<{ enabled: string[] }>(
      await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__read_file'] } })
    );
    expect(report.enabled).toEqual(['files__read_file']);
    await vi.waitFor(() => expect(r.changes).toBeGreaterThan(0));

    expect(await toolNames(r.client)).toContain('files__read_file');
    const result = await r.client.callTool({ name: 'files__read_file', arguments: { text: 'notes.txt' } });
    expect(textOf(result)).toBe('contents of notes.txt');
  });

  it('refuses a call to a tool that is not enabled', async () => {
    const r = await start();
    const result = await r.client.callTool({ name: 'files__read_file', arguments: { text: 'x' } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not enabled/);
  });

  it('enables by pattern, but only up to maxEnabled', async () => {
    const r = await start({ gate: { maxEnabled: 2 } });
    const report = jsonOf<{ enabled: string[]; overCapacity: string[] }>(
      await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__*'] } })
    );
    expect(report.enabled.length).toBe(2);
    expect(report.overCapacity.length).toBe(1);
    expect((await toolNames(r.client)).length).toBe(GATE_TOOLS.length + 2);
  });

  it('reports unknown names and already-enabled ones', async () => {
    const r = await start();
    await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__read_file'] } });
    const report = jsonOf<{ unknown: string[]; alreadyEnabled: string[] }>(
      await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__read_file', 'nope__tool'] } })
    );
    expect(report.alreadyEnabled).toEqual(['files__read_file']);
    expect(report.unknown).toEqual(['nope__tool']);
  });

  it('rejects a malformed request', async () => {
    const r = await start();
    expect((await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: [] } })).isError).toBe(true);
    expect((await r.client.callTool({ name: 'gate_search_tools', arguments: { query: '  ' } })).isError).toBe(true);
    expect((await r.client.callTool({ name: 'gate_nonsense' })).isError).toBe(true);
  });
});

describe('policy', () => {
  const servers = {
    files: { command: 'unused', policy: { deny: ['write_*'], confirm: ['list_directory'] } },
    calendar: { command: 'unused' }
  };

  it('never enables or reveals a denied tool', async () => {
    const r = await start({ servers });
    const search = jsonOf<{ results: { name: string }[] }>(
      await r.client.callTool({ name: 'gate_search_tools', arguments: { query: 'write text to a file' } })
    );
    expect(search.results.map((hit) => hit.name)).not.toContain('files__write_file');

    const report = jsonOf<{ denied: { name: string }[]; enabled: string[] }>(
      await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__write_file'] } })
    );
    expect(report.denied.map((entry) => entry.name)).toEqual(['files__write_file']);
    expect(report.enabled).toEqual([]);
    expect(await toolNames(r.client)).not.toContain('files__write_file');
  });

  it('does not let a wildcard sneak a denied tool in', async () => {
    const r = await start({ servers });
    await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['*'], confirm: true } });
    expect(await toolNames(r.client)).not.toContain('files__write_file');
  });

  it('enables a confirm tool only when the caller confirms', async () => {
    const r = await start({ servers });
    const first = jsonOf<{ needsConfirmation: string[]; enabled: string[] }>(
      await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__list_directory'] } })
    );
    expect(first.needsConfirmation).toEqual(['files__list_directory']);
    expect(first.enabled).toEqual([]);

    const second = jsonOf<{ enabled: string[] }>(
      await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__list_directory'], confirm: true } })
    );
    expect(second.enabled).toEqual(['files__list_directory']);
  });
});

describe('the gate deciding', () => {
  it('routes a task: ranks, enables the best matches, and says why', async () => {
    const r = await start();
    const report = jsonOf<{ matched: { name: string }[]; enable: { enabled: string[] } }>(
      await r.client.callTool({ name: 'gate_route', arguments: { task: 'create a calendar event for tomorrow' } })
    );
    expect(report.matched[0]?.name).toBe('calendar__create_event');
    expect(report.enable.enabled).toContain('calendar__create_event');
    expect(await toolNames(r.client)).toContain('calendar__create_event');
  });

  it('only previews when asked not to enable', async () => {
    const r = await start();
    const report = jsonOf<{ matched: unknown[]; enable?: unknown }>(
      await r.client.callTool({ name: 'gate_route', arguments: { task: 'read a file', enable: false } })
    );
    expect(report.matched.length).toBeGreaterThan(0);
    expect(report.enable).toBeUndefined();
    expect((await toolNames(r.client)).length).toBe(GATE_TOOLS.length);
  });

  it('returns nothing, and enables nothing, when no tool fits', async () => {
    const r = await start();
    const report = jsonOf<{ matched: unknown[]; hint: string }>(
      await r.client.callTool({ name: 'gate_route', arguments: { task: 'explain quantum chromodynamics' } })
    );
    expect(report.matched).toEqual([]);
    expect(report.hint).toMatch(/already have/);
    expect((await toolNames(r.client)).length).toBe(GATE_TOOLS.length);
  });

  it('applies the score floor: a weak match is not enough to enable anything', async () => {
    const strict = await start({ gate: { routeFloor: 50 } });
    const none = jsonOf<{ matched: unknown[]; enable?: unknown }>(
      await strict.client.callTool({ name: 'gate_route', arguments: { task: 'read a file' } })
    );
    expect(none.matched).toEqual([]);
    expect(none.enable).toBeUndefined();
    expect((await toolNames(strict.client)).length).toBe(GATE_TOOLS.length);
    await strict.close();

    const lenient = await start({ gate: { routeFloor: 0 } });
    const some = jsonOf<{ matched: unknown[] }>(
      await lenient.client.callTool({ name: 'gate_route', arguments: { task: 'read a file' } })
    );
    expect(some.matched.length).toBeGreaterThan(0);
  });

  it('respects the score floor and top-k', async () => {
    const r = await start({ gate: { routeTopK: 1 } });
    const report = jsonOf<{ matched: unknown[] }>(
      await r.client.callTool({ name: 'gate_route', arguments: { task: 'list files and read a file', limit: 10 } })
    );
    expect(report.matched.length).toBe(1);
  });
});

describe('disabling and expiry', () => {
  it('disables by name, by pattern and all, and notifies', async () => {
    const r = await start();
    await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__*', 'calendar__*'] } });
    expect((await toolNames(r.client)).length).toBe(GATE_TOOLS.length + 5);

    const one = jsonOf<{ disabled: string[] }>(
      await r.client.callTool({ name: 'gate_disable_tools', arguments: { tools: ['files__read_file'] } })
    );
    expect(one.disabled).toEqual(['files__read_file']);
    expect(await toolNames(r.client)).not.toContain('files__read_file');

    await r.client.callTool({ name: 'gate_disable_tools', arguments: { tools: ['calendar__*'] } });
    expect(await toolNames(r.client)).not.toContain('calendar__create_event');

    await r.client.callTool({ name: 'gate_disable_tools', arguments: { all: true } });
    expect((await toolNames(r.client)).sort()).toEqual(GATE_TOOLS);
  });

  it('switches off tools nobody used for idleTtlSec, and keeps the busy ones', async () => {
    const r = await start({ gate: { idleTtlSec: 60 } });
    await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__read_file', 'files__list_directory'] } });
    const later = Date.now() + 61_000;
    r.session.touch('files__read_file');
    r.session.sweep(later - 30_000);
    expect(r.session.status().length).toBe(2);
    r.session.sweep(later + 30_000);
    expect(r.session.status().length).toBe(0);
    await vi.waitFor(async () => expect(await toolNames(r.client)).not.toContain('files__read_file'));
  });
});

describe('downstream servers', () => {
  it('survives a server that cannot connect and reports it', async () => {
    const downstreams = {
      files: fakeServer(FILES).connector,
      calendar: () => {
        throw new Error('spawn failed');
      }
    };
    const r = await start({ downstreams });
    const { servers } = jsonOf<{ servers: { name: string; state: string; error?: string }[] }>(
      await r.client.callTool({ name: 'gate_list_servers' })
    );
    expect(servers.find((server) => server.name === 'calendar')).toMatchObject({ state: 'failed', error: 'spawn failed' });
    expect(servers.find((server) => server.name === 'files')?.state).toBe('connected');
  });

  it('reports a downstream failure as a tool error, not a crash', async () => {
    const boom = fakeServer({ explode: { description: 'Always fails', run: () => { throw new Error('kaboom'); } } });
    const r = await start({ servers: { boom: { command: 'unused' } }, downstreams: { boom: boom.connector } });
    await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['boom__explode'] } });
    const result = await r.client.callTool({ name: 'boom__explode', arguments: {} });
    expect(result.isError).toBe(true);
  });

  it('drops an enabled tool its server removed and tells the client', async () => {
    const files = fakeServer(FILES);
    const r = await start({ servers: { files: { command: 'unused' } }, downstreams: { files: files.connector } });
    await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__read_file', 'files__list_directory'] } });
    const before = r.changes;

    const instance = files.instances[0]!;
    const registered = (instance as unknown as { _registeredTools: Record<string, { remove(): void }> })._registeredTools;
    registered.read_file?.remove();

    await vi.waitFor(async () => expect(await toolNames(r.client)).not.toContain('files__read_file'), { timeout: 3000 });
    expect(await toolNames(r.client)).toContain('files__list_directory');
    expect(r.changes).toBeGreaterThan(before);
  });

  it('handles an empty configuration', async () => {
    const gate = new Gate(configOf({ servers: {} }));
    await gate.start();
    expect(gate.catalog()).toEqual([]);
    await gate.close();
  });
});

describe('sessions are independent', () => {
  it('keeps one client\'s enabled tools away from another client', async () => {
    const r = await start();
    const other = r.gate.createSession();
    await r.client.callTool({ name: 'gate_enable_tools', arguments: { tools: ['files__read_file'] } });
    expect(r.session.isEnabled('files__read_file')).toBe(true);
    expect(other.isEnabled('files__read_file')).toBe(false);
    other.dispose();
    expect(CALENDAR).toBeDefined();
  });
});
