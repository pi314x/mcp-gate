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

const AMOUNT = /^\d+(\.\d+)?$/;
const amount = z.string().regex(AMOUNT, 'a plain decimal amount such as "0.002"');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'an 0x-prefixed 20-byte address');
const network = z.string().regex(/^eip155:\d+$/, 'a CAIP-2 EVM network such as eip155:8453 (Base) or eip155:84532 (Base Sepolia)');

/** Seller side: what a call to each tool of this server costs, in the seller's asset (e.g. { "analyze_pool": "0.002" }). */
const pricingSchema = z.record(z.string(), amount).default({});

const stdioServer = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).default({}),
  cwd: z.string().optional(),
  policy: policySchema,
  pricing: pricingSchema
});

const httpServer = z.object({
  url: z.string().url(),
  headers: z.record(z.string(), z.string()).default({}),
  policy: policySchema,
  pricing: pricingSchema
});

/** Seller side: where payments for priced tools go, and who verifies and settles them. */
const sellerSchema = z.object({
  payTo: address,
  network,
  /** The EIP-3009 token, e.g. USDC. */
  asset: address,
  /** The token's EIP-712 domain name and version (USDC: "USDC" and "2"; check them for the token on your network). */
  assetName: z.string().default('USDC'),
  assetVersion: z.string().default('2'),
  decimals: z.number().int().min(0).max(36).default(6),
  /** An x402 facilitator (POST /verify, /settle). */
  facilitatorUrl: z.string().url(),
  maxTimeoutSeconds: z.number().int().min(10).max(3600).default(60)
});

/** Buyer side: a wallet that pays priced tools of downstream servers, inside hard caps. There are no default caps. */
const buyerSchema = z.object({
  /** Hex private key. Put it in the environment and reference it: "${MCP_GATE_WALLET_KEY}". */
  privateKey: z.string().regex(/^(0x)?[0-9a-fA-F]{64}$/, 'a 32-byte hex private key (use ${ENV_VAR}, never the key itself)'),
  /** The only network/asset pairs this wallet pays in. Anything else is refused. */
  allow: z
    .array(z.object({ network, asset: address, decimals: z.number().int().min(0).max(36).default(6), symbol: z.string().default('USDC') }))
    .min(1),
  /** Caps in the allowed asset's units. A call over any of them is refused, never paid. */
  maxPerCall: amount,
  maxPerSession: amount,
  maxPerDay: amount,
  /** When non-empty, only these recipients are paid. */
  payTo: z.array(address).default([])
});

const gateSchema = z
  .object({
    /** Most downstream tools one session may have enabled at once. */
    maxEnabled: z.number().int().min(1).max(500).default(25),
    /** Enabled tools nobody called for this many seconds are switched off again. 0 = never. */
    idleTtlSec: z.number().min(0).default(0),
    /** A tool must score at least this to be enabled by `gate_route`. Below it, nothing is enabled. */
    routeFloor: z.number().min(0).default(1),
    /** A tool must also share at least this many distinct words with the task (all of them, for a shorter task). */
    routeMinMatched: z.number().int().min(1).default(2),
    /** ... and at least this fraction of the task's distinct words. Words no tool knows count against it. */
    routeMinCoverage: z.number().min(0).max(1).default(0.34),
    /** Most tools `gate_route` enables for one task. */
    routeTopK: z.number().int().min(1).max(50).default(5),
    /** Qualified names or patterns enabled in every new session (`server__tool`, `*` wildcard). */
    autoEnable: z.array(z.string()).default([]),
    /**
     * Name of a downstream server that serves skills (skills-router: `route_skill` and `get_skill`). When set, the gate
     * offers a seventh tool, `gate_capsule`, that returns the procedure that fits a task and enables the tools it names.
     */
    skillsServer: z.string().optional(),
    /**
     * The least score the skills server must give its best match for `gate_capsule` to serve it. The scale is the skills
     * server's own (skills-router's lexical score grows with the words a task shares with a skill and shifts with the
     * size of the catalog), so calibrate it on your catalog with `npm run capsule -- --scores`. A server that reports no
     * score is not held to it.
     */
    skillsMinScore: z.number().min(0).default(12),
    /**
     * Name of a downstream server that is lean-context (`ctx_search`, `ctx_symbol`, `ctx_read`). With `skillsServer`, a
     * capsule that found a skill also carries the code areas that match the task, ranked by that server, and the tools to expand them.
     */
    codeServer: z.string().optional(),
    /** Token budget the capsule gives `ctx_search` for its code areas. */
    codeBudgetTokens: z.number().int().min(100).max(4000).default(800),
    /** Most code areas the capsule asks `ctx_search` for. */
    codeMaxResults: z.number().int().min(1).max(20).default(4)
  })
  .default({
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
  gate: gateSchema,
  seller: sellerSchema.optional(),
  buyer: buyerSchema.optional()
}).superRefine((config, ctx) => {
  for (const [name, server] of Object.entries(config.servers)) {
    if (Object.keys(server.pricing).length > 0 && config.seller === undefined) {
      ctx.addIssue({ code: 'custom', path: ['servers', name, 'pricing'], message: 'priced tools need a seller section (payTo, network, asset, facilitatorUrl)' });
    }
  }
  if (config.buyer !== undefined) {
    const { maxPerCall, maxPerSession, maxPerDay } = config.buyer;
    if (Number(maxPerCall) > Number(maxPerSession) || Number(maxPerSession) > Number(maxPerDay)) {
      ctx.addIssue({ code: 'custom', path: ['buyer'], message: 'caps must satisfy maxPerCall <= maxPerSession <= maxPerDay' });
    }
  }
  const { skillsServer, codeServer } = config.gate;
  if (skillsServer !== undefined && !(skillsServer in config.servers)) {
    ctx.addIssue({ code: 'custom', path: ['gate', 'skillsServer'], message: `"${skillsServer}" is not one of the configured servers` });
  }
  if (codeServer !== undefined && !(codeServer in config.servers)) {
    ctx.addIssue({ code: 'custom', path: ['gate', 'codeServer'], message: `"${codeServer}" is not one of the configured servers` });
  }
  if (codeServer !== undefined && skillsServer === undefined) {
    ctx.addIssue({ code: 'custom', path: ['gate', 'codeServer'], message: 'codeServer needs skillsServer: code areas are part of a capsule, which only exists with a skills server' });
  }
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
  // Interpolate first, so formats (a URL, a private key) are checked on the real value, not on "${NAME}". No
  // validation message repeats a value, so a secret cannot end up in an error.
  const parsed = configSchema.safeParse(interpolateEnv(raw, env));
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`);
    throw new Error(`invalid configuration:\n  ${problems.join('\n  ')}`);
  }
  return parsed.data;
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
