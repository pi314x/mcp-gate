import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const policySchema = z
  .object({
    allow: z.array(z.string()).default(['*']),
    deny: z.array(z.string()).default([]),
    confirm: z.array(z.string()).default([])
  })
  .default({ allow: ['*'], deny: [], confirm: [] });

// Server names become the prefix of every tool (`<server>__<tool>`), so they stay simple and never contain `__`.
const SERVER_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

const stdioServer = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  policy: policySchema
});

const httpServer = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  policy: policySchema
});

const gateSchema = z
  .object({
    /** Most downstream tools one session may have enabled at once. */
    maxEnabled: z.number().int().min(1).max(500).default(25),
    /** Enabled tools nobody called for this many seconds are switched off again. 0 = never. */
    idleTtlSec: z.number().min(0).default(0),
    /** A tool must score at least this to be enabled by `gate_route`. Below it, nothing is enabled. */
    routeFloor: z.number().min(0).default(1),
    /** Most tools `gate_route` enables for one task. */
    routeTopK: z.number().int().min(1).max(50).default(5),
    /** Qualified names or patterns enabled in every new session (`server__tool`, `*` wildcard). */
    autoEnable: z.array(z.string()).default([])
  })
  .default({ maxEnabled: 25, idleTtlSec: 0, routeFloor: 1, routeTopK: 5, autoEnable: [] });

export const configSchema = z.object({
  servers: z
    .record(z.string(), z.union([stdioServer, httpServer]))
    .superRefine((servers, ctx) => {
      for (const name of Object.keys(servers)) {
        if (!SERVER_NAME.test(name)) {
          ctx.addIssue({ code: 'custom', path: [name], message: 'a server name uses lowercase letters, digits and single hyphens only' });
        }
      }
    })
    .default({}),
  gate: gateSchema
});

export type GateConfig = z.infer<typeof configSchema>;
export type ServerConfig = GateConfig['servers'][string];
export type StdioServerConfig = z.infer<typeof stdioServer>;
export type HttpServerConfig = z.infer<typeof httpServer>;

export const isStdio = (server: ServerConfig): server is StdioServerConfig => 'command' in server;

/**
 * Replaces `${NAME}` in every string of the config with the environment variable, so secrets stay out of the
 * file. A missing variable is an error that names the variable, never a value.
 */
export function interpolateEnv<T>(value: T, env: NodeJS.ProcessEnv = process.env): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
      const found = env[name];
      if (found === undefined) throw new Error(`environment variable ${name} is not set`);
      return found;
    }) as T;
  }
  if (Array.isArray(value)) return value.map((item) => interpolateEnv(item, env)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, interpolateEnv(item, env)])) as T;
  }
  return value;
}

export function parseConfig(raw: unknown, env: NodeJS.ProcessEnv = process.env): GateConfig {
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return interpolateEnv(parsed.data, env);
}

export async function loadConfig(path: string, env: NodeJS.ProcessEnv = process.env): Promise<GateConfig> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new Error(`cannot read the configuration file ${path}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return parseConfig(json, env);
}
