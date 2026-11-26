import { describe, expect, it } from 'vitest';
import { corroborated, qualify, rank, splitQualified, tokenize, type CatalogTool } from '../src/catalog.js';
import { interpolateEnv, parseConfig } from '../src/config.js';
import { globToRegExp, matchesAny } from '../src/glob.js';
import { decide, OPEN_POLICY } from '../src/policy.js';

const tool = (server: string, name: string, description: string): CatalogTool => ({
  qualified: qualify(server, name),
  server,
  tool: name,
  description,
  inputSchema: { type: 'object' }
});

describe('glob', () => {
  it('matches * as any run of characters and everything else literally', () => {
    expect(globToRegExp('write_*').test('write_file')).toBe(true);
    expect(globToRegExp('write_*').test('overwrite_file')).toBe(false);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
    expect(matchesAny(['x', '*_y'], 'z_y')).toBe(true);
    expect(matchesAny([], 'anything')).toBe(false);
  });
});

describe('policy', () => {
  it('lets deny win over allow, requires the allow list, and marks confirmation', () => {
    const policy = { allow: ['get_*', 'delete_all'], deny: ['delete_*'], confirm: ['get_secret'] };
    expect(decide(policy, 'get_file')).toEqual({ verdict: 'allow' });
    expect(decide(policy, 'get_secret')).toEqual({ verdict: 'confirm' });
    expect(decide(policy, 'delete_all')).toMatchObject({ verdict: 'deny' });
    expect(decide(policy, 'put_file')).toMatchObject({ verdict: 'deny', reason: 'not on the allow list' });
    expect(decide(OPEN_POLICY, 'anything')).toEqual({ verdict: 'allow' });
  });
});

describe('qualified names', () => {
  it('splits at the first separator only', () => {
    expect(splitQualified('files__read_file')).toEqual({ server: 'files', tool: 'read_file' });
    expect(splitQualified('files__a__b')).toEqual({ server: 'files', tool: 'a__b' });
    expect(splitQualified('nosep')).toBeUndefined();
    expect(splitQualified('__x')).toBeUndefined();
    expect(splitQualified('x__')).toBeUndefined();
  });
});

describe('search ranking', () => {
  const tools = [
    tool('files', 'read_file', 'Read the contents of a file from disk'),
    tool('files', 'write_file', 'Write text to a file on disk'),
    tool('calendar', 'create_event', 'Create a calendar event with a title and a time'),
    tool('calendar', 'list_events', 'List upcoming calendar events')
  ];

  it('tokenizes camelCase and snake_case and drops stop words', () => {
    expect(tokenize('readFile of the_disk')).toEqual(['read', 'file', 'disk']);
  });

  it('ranks the matching tool first, name matches above description matches', () => {
    expect(rank(tools, 'read a file')[0]?.tool.qualified).toBe('files__read_file');
    expect(rank(tools, 'schedule calendar event')[0]?.tool.server).toBe('calendar');
  });

  it('returns nothing when nothing matches', () => {
    expect(rank(tools, 'quantum chromodynamics')).toEqual([]);
    expect(rank(tools, '')).toEqual([]);
    expect(rank([], 'file')).toEqual([]);
  });

  it('drops question words and pronouns, which separate nothing', () => {
    expect(tokenize('what is my file and how can I read it')).toEqual(['file', 'read']);
  });
});

describe('corroboration', () => {
  const tools = [
    tool('files', 'read_file', 'Read the contents of a file from disk'),
    tool('calendar', 'create_event', 'Create a calendar event with a title and a time')
  ];
  const top = (query: string) => rank(tools, query)[0]!;

  it('counts the distinct words a tool shares with the task, and every word of the task', () => {
    expect(top('read a file')).toMatchObject({ matched: 2, total: 2 });
    expect(top('read a file quickly')).toMatchObject({ matched: 2, total: 3 });
  });

  it('does not accept one shared word among several: it is how an unrelated task reaches a tool', () => {
    const entry = top('create a birthday cake recipe');
    expect(entry.tool.tool).toBe('create_event');
    expect(entry).toMatchObject({ matched: 1, total: 4 });
    expect(corroborated(entry, 2, 0.34)).toBe(false);
    expect(corroborated(entry, 1, 0)).toBe(true);
  });

  it('judges a task of one word on that word', () => {
    expect(corroborated(top('calendar'), 2, 0.34)).toBe(true);
  });

  it('enforces coverage on its own: two shared words are not enough when the rest of the task is unknown', () => {
    const entry = top('read file today sometime later maybe');
    expect(entry).toMatchObject({ matched: 2, total: 6 });
    expect(corroborated(entry, 2, 0.34)).toBe(false);
    expect(corroborated(entry, 2, 0.3)).toBe(true);
  });
});

describe('configuration', () => {
  it('fills in defaults', () => {
    const config = parseConfig({ servers: { files: { command: 'node' } } });
    expect(config.servers.files).toMatchObject({ args: [], policy: { allow: ['*'], deny: [], confirm: [] } });
    expect(config.gate).toEqual({
      maxEnabled: 25,
      idleTtlSec: 0,
      routeFloor: 1,
      routeMinMatched: 2,
      routeMinCoverage: 0.34,
      routeTopK: 5,
      autoEnable: [],
      skillsMinScore: 12,
      codeBudgetTokens: 800,
      codeMaxResults: 4
    });
  });

  it('rejects a server name that would break the tool prefix', () => {
    expect(() => parseConfig({ servers: { Bad_Name: { command: 'x' } } })).toThrow(/invalid configuration/);
    expect(() => parseConfig({ servers: { 'a__b': { command: 'x' } } })).toThrow(/invalid configuration/);
  });

  it('rejects a server that is neither stdio nor http', () => {
    expect(() => parseConfig({ servers: { x: { args: [] } } })).toThrow(/invalid configuration/);
  });

  it('substitutes ${VAR} from the environment and names a missing variable, never a value', () => {
    const config = parseConfig(
      { servers: { api: { url: 'https://example.com/mcp', headers: { Authorization: 'Bearer ${TOKEN}' } } } },
      { TOKEN: 'secret-value' }
    );
    expect(config.servers.api).toMatchObject({ headers: { Authorization: 'Bearer secret-value' } });
    expect(() => interpolateEnv('${MISSING}', {})).toThrow('environment variable MISSING is not set');
    expect(() => interpolateEnv('${MISSING}', { OTHER: 'x' })).not.toThrow(/x/);
  });
});
