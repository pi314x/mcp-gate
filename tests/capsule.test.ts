import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { ledgerFromEnv } from '../src/ledger.js';
import { CALENDAR, FILES, fakeServer, jsonOf, rig, textOf, toolNames, type Rig } from './helpers.js';

const BODY = '# Skill: plan-event\n\nCreate the event, then read the agenda file.\n';

interface Route {
  name: string;
  tools: string[];
  /** What the fake skills server reports as its score; 20 (a clear match) when absent, and no score at all for `null`. */
  score?: number | null;
}

/** A skills-router stand-in: routes any task that mentions a calendar to `route`, and serves one procedure. */
function skillsServer(route: Route | undefined) {
  return fakeServer({
    route_skill: {
      description: 'Shortlist the skills worth considering for a task description',
      schema: z.object({ task: z.string(), top_k: z.number().optional() }),
      run: (args) => JSON.stringify({ task: args.task, matches: route !== undefined && String(args.task).includes('calendar') ? [route.score === null ? { name: route.name, tools: route.tools } : { ...route, score: route.score ?? 20 }] : [] })
    },
    get_skill: {
      description: 'Full procedure for one skill',
      schema: z.object({ name: z.string() }),
      run: (args) => (args.name === route?.name ? BODY : 'no such skill')
    }
  });
}

const PLAN: Route = { name: 'plan-event', tools: ['calendar__create_event', 'files__read_file', 'nowhere__missing_tool'] };

const dirs: string[] = [];
let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(
  options: {
    route?: Route | undefined;
    policy?: Record<string, unknown>;
    skillsPolicy?: Record<string, unknown>;
    configured?: boolean;
    gate?: Record<string, unknown>;
    ledger?: ReturnType<typeof ledgerFromEnv>;
  } = {}
): Promise<Rig> {
  const route = 'route' in options ? options.route : PLAN;
  current = await rig({
    downstreams: { files: fakeServer(FILES).connector, calendar: fakeServer(CALENDAR).connector, skills: skillsServer(route).connector },
    servers: {
      files: { command: 'unused' },
      calendar: { command: 'unused', ...(options.policy !== undefined && { policy: options.policy }) },
      skills: { command: 'unused', ...(options.skillsPolicy !== undefined && { policy: options.skillsPolicy }) }
    },
    gate: options.configured === false ? {} : (options.gate ?? { skillsServer: 'skills' }),
    ...(options.ledger !== undefined && { ledger: options.ledger })
  });
  return current;
}

const capsule = async (r: Rig, task: string) => r.client.callTool({ name: 'gate_capsule', arguments: { task } });
type Report = { skill?: string; procedure?: string; tools?: { enabled: string[]; denied: { name: string }[]; needsConfirmation: string[] }; unresolved?: string[]; hint?: string };

describe('gate_capsule', () => {
  it('is a seventh tool only when a skills server is configured', async () => {
    const without = await start({ configured: false });
    expect((await toolNames(without.client)).filter((name) => name.startsWith('gate_'))).toHaveLength(6);
    expect(await toolNames(without.client)).not.toContain('gate_capsule');
    const refused = await capsule(without, 'plan a calendar event');
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/No skills server is configured/);
    await without.close();

    const configured = await start();
    expect((await toolNames(configured.client)).filter((name) => name.startsWith('gate_'))).toHaveLength(7);
    expect(configured.client.getInstructions()).toMatch(/gate_capsule/);
  });

  it('returns the procedure and enables exactly the tools it names, in one call', async () => {
    const r = await start();
    const report = jsonOf<Report>(await capsule(r, 'plan a calendar event for tomorrow'));
    expect(report.skill).toBe('plan-event');
    expect(report.procedure).toBe(BODY);
    expect(report.tools?.enabled.sort()).toEqual(['calendar__create_event', 'files__read_file']);
    // A tool the skill names that exists nowhere behind the gate is reported, never invented.
    expect(report.unresolved).toEqual(['nowhere__missing_tool']);
    const listed = await toolNames(r.client);
    expect(listed).toContain('calendar__create_event');
    expect(listed).toContain('files__read_file');
    expect(listed).not.toContain('files__write_file');
    expect(listed.some((name) => name.startsWith('skills__'))).toBe(false);
  });

  it('returns no skill, and enables nothing, when the skills server finds none that fits', async () => {
    const r = await start();
    const report = jsonOf<Report>(await capsule(r, 'explain quantum chromodynamics'));
    expect(report.skill).toBeUndefined();
    expect(report.procedure).toBeUndefined();
    expect(report.hint).toMatch(/No skill fits/);
    expect((await toolNames(r.client)).filter((name) => !name.startsWith('gate_'))).toEqual([]);
  });

  it('lets deny win: the procedure is returned, the denied tool is reported and never enabled', async () => {
    const r = await start({ policy: { deny: ['create_*'] } });
    const report = jsonOf<Report>(await capsule(r, 'plan a calendar event'));
    expect(report.skill).toBe('plan-event');
    expect(report.tools?.denied.map((entry) => entry.name)).toEqual(['calendar__create_event']);
    expect(report.tools?.enabled).toEqual(['files__read_file']);
    expect(await toolNames(r.client)).not.toContain('calendar__create_event');
  });

  it('leaves a tool that needs confirmation unenabled and says so', async () => {
    const r = await start({ policy: { confirm: ['create_event'] } });
    const report = jsonOf<Report>(await capsule(r, 'plan a calendar event'));
    expect(report.tools?.needsConfirmation).toEqual(['calendar__create_event']);
    expect(await toolNames(r.client)).not.toContain('calendar__create_event');
  });

  it('resolves a tool the skill names without a server prefix when exactly one tool has that name', async () => {
    const r = await start({ route: { name: 'plan-event', tools: ['create_event', 'list_events'] } });
    const report = jsonOf<Report>(await capsule(r, 'plan a calendar event'));
    expect(report.tools?.enabled.sort()).toEqual(['calendar__create_event', 'calendar__list_events']);
    expect(report.unresolved).toEqual([]);
  });

  it('does not guess between two tools that share the name the skill gave', async () => {
    current = await rig({
      downstreams: {
        files: fakeServer({ ping: { description: 'Ping the file server' } }).connector,
        calendar: fakeServer({ ping: { description: 'Ping the calendar server' } }).connector,
        skills: skillsServer({ name: 'plan-event', tools: ['ping'] }).connector
      },
      servers: { files: { command: 'unused' }, calendar: { command: 'unused' }, skills: { command: 'unused' } },
      gate: { skillsServer: 'skills' }
    });
    const report = jsonOf<Report>(await capsule(current, 'plan a calendar event'));
    expect(report.unresolved).toEqual(['ping']);
    expect(report.tools?.enabled).toEqual([]);
  });

  it('does not ask a skills server whose policy denies route_skill or get_skill', async () => {
    for (const denied of ['route_skill', 'get_skill']) {
      const r = await start({ skillsPolicy: { deny: [denied] } });
      const refused = await capsule(r, 'plan a calendar event');
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toMatch(new RegExp(`does not allow skills__${denied}`));
      expect((await toolNames(r.client)).filter((name) => !name.startsWith('gate_'))).toEqual([]);
      await r.close();
    }
  });

  it('says so when the configured server is not a skills server', async () => {
    current = await rig({
      downstreams: { files: fakeServer(FILES).connector, calendar: fakeServer(CALENDAR).connector },
      servers: { files: { command: 'unused' }, calendar: { command: 'unused' } },
      gate: { skillsServer: 'files' }
    });
    const refused = await capsule(current, 'plan a calendar event');
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toMatch(/does not offer route_skill and get_skill/);
  });

  it('refuses a task that is not a non-empty string', async () => {
    const r = await start();
    expect((await r.client.callTool({ name: 'gate_capsule', arguments: { task: '  ' } })).isError).toBe(true);
  });

  it('does not serve a skill the skills server scores below the floor: a lexical router names a best guess for almost any task', async () => {
    const weak = await start({ route: { ...PLAN, score: 7.84 } });
    const report = jsonOf<Report>(await capsule(weak, 'plan a calendar event'));
    expect(report.skill).toBeUndefined();
    expect(report.procedure).toBeUndefined();
    expect(report.hint).toMatch(/No skill fits/);
    expect((await toolNames(weak.client)).filter((name) => !name.startsWith('gate_'))).toEqual([]);
  });

  it('serves a skill that scores exactly the floor, and moves with skillsMinScore', async () => {
    const exact = await start({ route: { ...PLAN, score: 12 } });
    expect(jsonOf<Report>(await capsule(exact, 'plan a calendar event')).skill).toBe('plan-event');
    await exact.close();

    const strict = await start({ route: { ...PLAN, score: 20 }, gate: { skillsServer: 'skills', skillsMinScore: 25 } });
    expect(jsonOf<Report>(await capsule(strict, 'plan a calendar event')).skill).toBeUndefined();
    await strict.close();

    const lenient = await start({ route: { ...PLAN, score: 7.84 }, gate: { skillsServer: 'skills', skillsMinScore: 0 } });
    expect(jsonOf<Report>(await capsule(lenient, 'plan a calendar event')).skill).toBe('plan-event');
  });

  it('does not hold a skills server that reports no score to the floor', async () => {
    const unscored = await start({ route: { ...PLAN, score: null } });
    expect(jsonOf<Report>(await capsule(unscored, 'plan a calendar event')).skill).toBe('plan-event');
  });

  it('is a configuration error to name a skills server that is not configured', () => {
    expect(() => parseConfig({ servers: { files: { command: 'x' } }, gate: { skillsServer: 'skills' } })).toThrow(/gate\.skillsServer: "skills" is not one of the configured servers/);
    expect(parseConfig({ servers: { skills: { command: 'x' } }, gate: { skillsServer: 'skills' } }).gate.skillsServer).toBe('skills');
  });

  it('records a capsule event as added cost, with counts only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gate-capsule-'));
    dirs.push(dir);
    const file = join(dir, 'ledger.jsonl');
    const r = await start({ ledger: ledgerFromEnv('gate', 'heuristic-v1', { CTX_LEDGER_FILE: file, CTX_LEDGER_SESSION: 'test-session' }) });
    await capsule(r, 'plan a calendar event for tomorrow');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as { kind: string; baseline?: number; sent: number; meta?: Record<string, unknown> });
    const line = lines.find((entry) => entry.kind === 'capsule')!;
    expect(line).toMatchObject({ baseline: 0, meta: { matched: true, enabled: 2 } });
    expect(line.sent).toBeGreaterThan(0);
    const raw = readFileSync(file, 'utf8');
    expect(raw).not.toContain('plan a calendar event');
    expect(raw).not.toContain('plan-event');
  });
});
