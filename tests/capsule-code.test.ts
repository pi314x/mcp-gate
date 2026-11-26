import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { afterEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { ledgerFromEnv } from '../src/ledger.js';
import { CALENDAR, FILES, fakeServer, jsonOf, rig, toolNames, type Rig } from './helpers.js';

// The lean-context part of the capsule: code areas that match the task, ranked by the code server.

interface Route {
  name: string;
  tools: string[];
}

/** A skills-router stand-in: routes any task that mentions a calendar to `route`, and serves one procedure. */
function skillsServer(route: Route) {
  return fakeServer({
    route_skill: {
      description: 'Shortlist the skills worth considering for a task description',
      schema: z.object({ task: z.string(), top_k: z.number().optional() }),
      run: (args) => JSON.stringify({ task: args.task, matches: String(args.task).includes('calendar') ? [{ ...route, score: 20 }] : [] })
    },
    get_skill: { description: 'Full procedure for one skill', schema: z.object({ name: z.string() }), run: () => '# Skill: plan-event\n\nCreate the event.\n' }
  });
}

interface CodeCalls {
  searches: Record<string, unknown>[];
}

/** A lean-context stand-in. ctx_search answers a hit list for a task that mentions "rate", and "No matches" otherwise. */
function codeServer(calls: CodeCalls, options: { fail?: boolean } = {}) {
  return fakeServer({
    ctx_search: {
      description: 'Ranked code search over the project',
      schema: z.object({ query: z.string(), budget_tokens: z.number().optional(), max_results: z.number().optional() }),
      run: (args) => {
        calls.searches.push(args);
        if (options.fail === true) throw new Error('index is locked');
        return String(args.query).includes('rate')
          ? `2 results for "${String(args.query).slice(0, 20)}" (2 matching chunks)\nsrc/http/middleware.ts:10-40 function rateLimit\nsrc/http/limits.ts:1-12 const LIMITS\nExpand: ctx_symbol {"name":"rateLimit"}`
          : `No matches for "${String(args.query).slice(0, 20)}". Try other words or an identifier.`;
      }
    },
    ctx_symbol: { description: 'The full body of one function, class or method' },
    ctx_read: { description: 'Read lines of a file with line numbers' },
    ctx_outline: { description: 'Skeleton of one file' }
  });
}

const PLAN: Route = { name: 'plan-event', tools: ['calendar__create_event'] };

const dirs: string[] = [];
let current: Rig | undefined;
afterEach(async () => {
  await current?.close();
  current = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function start(
  calls: CodeCalls,
  options: { codePolicy?: Record<string, unknown>; fail?: boolean; gate?: Record<string, unknown>; ledger?: ReturnType<typeof ledgerFromEnv> } = {}
): Promise<Rig> {
  current = await rig({
    downstreams: {
      calendar: fakeServer(CALENDAR).connector,
      skills: skillsServer(PLAN).connector,
      context: codeServer(calls, { ...(options.fail !== undefined && { fail: options.fail }) }).connector
    },
    servers: {
      calendar: { command: 'unused' },
      skills: { command: 'unused' },
      context: { command: 'unused', ...(options.codePolicy !== undefined && { policy: options.codePolicy }) }
    },
    gate: { skillsServer: 'skills', codeServer: 'context', ...(options.gate ?? {}) },
    ...(options.ledger !== undefined && { ledger: options.ledger })
  });
  return current;
}

const capsule = (r: Rig, task: string) => r.client.callTool({ name: 'gate_capsule', arguments: { task } });
type Report = { skill?: string; codeAreas?: string; note?: string; tools?: { enabled: string[] } };

describe('gate_capsule with a code server', () => {
  it('adds the code areas that match the task, and the tools to expand them', async () => {
    const calls: CodeCalls = { searches: [] };
    const r = await start(calls);
    const report = jsonOf<Report>(await capsule(r, 'plan a calendar event and add rate limiting'));
    expect(report.skill).toBe('plan-event');
    expect(report.codeAreas).toMatch(/^2 results for /);
    expect(report.codeAreas).toContain('src/http/middleware.ts:10-40 function rateLimit');
    expect(report.tools?.enabled.sort()).toEqual(['calendar__create_event', 'context__ctx_read', 'context__ctx_symbol']);
    const listed = await toolNames(r.client);
    expect(listed).toEqual(expect.arrayContaining(['context__ctx_symbol', 'context__ctx_read']));
    expect(listed).not.toContain('context__ctx_outline');
    expect(listed).not.toContain('context__ctx_search');
  });

  it('asks ctx_search for the task, with the configured budget and result count', async () => {
    const calls: CodeCalls = { searches: [] };
    const r = await start(calls, { gate: { codeBudgetTokens: 300, codeMaxResults: 2 } });
    await capsule(r, 'plan a calendar event');
    expect(calls.searches).toEqual([{ query: 'plan a calendar event', budget_tokens: 300, max_results: 2 }]);
  });

  it('cuts a long task to the 500 characters ctx_search accepts', async () => {
    const calls: CodeCalls = { searches: [] };
    const r = await start(calls);
    await capsule(r, `plan a calendar event ${'and more '.repeat(200)}`);
    expect(String(calls.searches[0]?.query)).toHaveLength(500);
  });

  it('leaves code areas out, and enables no expand tool, when the code server finds nothing', async () => {
    const calls: CodeCalls = { searches: [] };
    const r = await start(calls);
    const report = jsonOf<Report>(await capsule(r, 'plan a calendar event'));
    expect(report.skill).toBe('plan-event');
    expect(report.codeAreas).toBeUndefined();
    expect(report.note).toBeUndefined();
    expect(report.tools?.enabled).toEqual(['calendar__create_event']);
  });

  it('does not search the code at all when no skill fits: the code is part of the bundle, not a second route', async () => {
    const calls: CodeCalls = { searches: [] };
    const r = await start(calls);
    const report = jsonOf<Report>(await capsule(r, 'explain rate limiting in general'));
    expect(report.skill).toBeUndefined();
    expect(report.codeAreas).toBeUndefined();
    expect(calls.searches).toEqual([]);
  });

  it('does not ask a code server whose policy denies ctx_search, and still serves the skill', async () => {
    const calls: CodeCalls = { searches: [] };
    const r = await start(calls, { codePolicy: { deny: ['ctx_search'] } });
    const report = jsonOf<Report>(await capsule(r, 'plan a calendar event and add rate limiting'));
    expect(report.skill).toBe('plan-event');
    expect(report.codeAreas).toBeUndefined();
    expect(report.note).toMatch(/does not allow context__ctx_search/);
    expect(calls.searches).toEqual([]);
  });

  it('serves the skill and says why when the code server fails', async () => {
    const calls: CodeCalls = { searches: [] };
    const r = await start(calls, { fail: true });
    const result = await capsule(r, 'plan a calendar event and add rate limiting');
    expect(result.isError).not.toBe(true);
    const report = jsonOf<Report>(result);
    expect(report.skill).toBe('plan-event');
    expect(report.codeAreas).toBeUndefined();
    expect(report.note).toMatch(/context__ctx_search failed/);
  });

  it('says so when the configured code server is not lean-context', async () => {
    current = await rig({
      downstreams: { calendar: fakeServer(CALENDAR).connector, skills: skillsServer(PLAN).connector, files: fakeServer(FILES).connector },
      servers: { calendar: { command: 'unused' }, skills: { command: 'unused' }, files: { command: 'unused' } },
      gate: { skillsServer: 'skills', codeServer: 'files' }
    });
    const report = jsonOf<Report>(await capsule(current, 'plan a calendar event'));
    expect(report.skill).toBe('plan-event');
    expect(report.note).toMatch(/does not offer ctx_search/);
  });

  it('is off, and the report has no code fields, without a code server', async () => {
    current = await rig({
      downstreams: { calendar: fakeServer(CALENDAR).connector, skills: skillsServer(PLAN).connector },
      servers: { calendar: { command: 'unused' }, skills: { command: 'unused' } },
      gate: { skillsServer: 'skills' }
    });
    const report = jsonOf<Report>(await capsule(current, 'plan a calendar event'));
    expect('codeAreas' in report).toBe(false);
    expect('note' in report).toBe(false);
  });

  it('is a configuration error to name a code server that is not configured, or to name one without a skills server', () => {
    const servers = { skills: { command: 'x' }, context: { command: 'x' } };
    expect(() => parseConfig({ servers, gate: { skillsServer: 'skills', codeServer: 'nowhere' } })).toThrow(/gate\.codeServer: "nowhere" is not one of the configured servers/);
    expect(() => parseConfig({ servers, gate: { codeServer: 'context' } })).toThrow(/codeServer needs skillsServer/);
    expect(parseConfig({ servers, gate: { skillsServer: 'skills', codeServer: 'context' } }).gate).toMatchObject({ codeServer: 'context', codeBudgetTokens: 800, codeMaxResults: 4 });
  });

  it('bounds the budget and the result count the capsule may ask for', () => {
    const servers = { skills: { command: 'x' }, context: { command: 'x' } };
    const gate = { skillsServer: 'skills', codeServer: 'context' };
    expect(() => parseConfig({ servers, gate: { ...gate, codeBudgetTokens: 50 } })).toThrow(/codeBudgetTokens/);
    expect(() => parseConfig({ servers, gate: { ...gate, codeMaxResults: 0 } })).toThrow(/codeMaxResults/);
  });

  it('records whether the capsule carried code areas, and nothing of the code', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcp-gate-capsule-code-'));
    dirs.push(dir);
    const file = join(dir, 'ledger.jsonl');
    const ledger = ledgerFromEnv('gate', 'heuristic-v1', { CTX_LEDGER_FILE: file, CTX_LEDGER_SESSION: 'test-session' });
    const r = await start({ searches: [] }, { ledger });
    await capsule(r, 'plan a calendar event and add rate limiting');
    const raw = readFileSync(file, 'utf8');
    expect(JSON.parse(raw.trim().split('\n').find((line) => line.includes('"capsule"'))!)).toMatchObject({ meta: { matched: true, code: true } });
    expect(raw).not.toContain('middleware');
    expect(raw).not.toContain('rateLimit');
  });
});
