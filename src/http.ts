import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import {
  NodeStreamableHTTPServerTransport,
  hostHeaderValidation,
  originValidation,
  toNodeHandler,
  toWebRequest
} from '@modelcontextprotocol/node';
import { createMcpHandler, isInitializeRequest, isLegacyRequest, type McpRequestContext } from '@modelcontextprotocol/server';
import type { Gate, GateSession } from './gate.js';
import { messageOf } from './log.js';
import { createGateServer } from './server.js';

export const MCP_PATH = '/mcp';
export const SCOPE_HEADER = 'x-mcp-gate-scope';

export interface HttpOptions {
  host: string;
  /** 0 picks a free port. */
  port: number;
  /** When set, every MCP request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Extra host names this endpoint answers to (a reverse proxy's public name). Loopback is always allowed. */
  allowedHosts?: string[];
  maxLegacySessions?: number;
  idleSessionMs?: number;
}

export interface HttpHandle {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      rpcError(res, 413, -32000, 'Request body too large');
      return { ok: false };
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return { ok: true, body: undefined };
  try {
    return { ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown };
  } catch {
    rpcError(res, 400, -32700, 'Parse error');
    return { ok: false };
  }
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const given = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The stateless era keeps no connection between requests, so one client's enabled tools are found by this key. */
function scopeKey(ctx: McpRequestContext): string {
  const clientId = ctx.authInfo?.clientId;
  if (clientId !== undefined && clientId !== '') return `client:${clientId}`;
  const header = ctx.requestInfo?.headers.get(SCOPE_HEADER);
  if (header !== null && header !== undefined && /^[A-Za-z0-9._-]{1,64}$/.test(header)) return `scope:${header}`;
  return 'shared';
}

interface LegacySession {
  transport: NodeStreamableHTTPServerTransport;
  open: number;
  lastActive: number;
}

/**
 * Serves one endpoint to both protocol eras. A 2025-era client gets a real session (one transport per
 * `Mcp-Session-Id`), so the gate can push "tools changed" on its notification stream. A 2026-07-28 client is
 * stateless: its enabled tools live in a scope found by auth identity or the `x-mcp-gate-scope` header, and
 * change notifications go to whoever opened a `subscriptions/listen` stream.
 */
export async function serveOverHttp(gate: Gate, options: HttpOptions): Promise<HttpHandle> {
  const maxLegacy = options.maxLegacySessions ?? 200;
  const idleMs = options.idleSessionMs ?? 30 * 60_000;

  // ---- stateless leg -------------------------------------------------------------------------------------------
  const scopes = new Map<string, { session: GateSession; lastUsed: number }>();
  const scopeSession = (key: string): GateSession => {
    let entry = scopes.get(key);
    if (entry === undefined) {
      entry = { session: gate.createSession(() => modern.notify.toolsChanged()), lastUsed: Date.now() };
      scopes.set(key, entry);
      if (scopes.size > 500) {
        const oldest = [...scopes].sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (oldest !== undefined) {
          oldest[1].session.dispose();
          scopes.delete(oldest[0]);
        }
      }
    }
    entry.lastUsed = Date.now();
    return entry.session;
  };
  const modern = createMcpHandler(
    (ctx) => createGateServer(gate, scopeSession(scopeKey(ctx)), { ownsSession: false }),
    { legacy: 'reject', onerror: (error) => gate.log(`http: ${messageOf(error)}`) }
  );
  const modernNode = toNodeHandler(modern, { onerror: (error) => gate.log(`http adapter: ${messageOf(error)}`) });

  // ---- sessionful leg ------------------------------------------------------------------------------------------
  const legacy = new Map<string, LegacySession>();

  async function legacyRoute(req: IncomingMessage, res: ServerResponse, body: unknown): Promise<void> {
    const header = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(header) ? header[0] : header;
    const known = sessionId === undefined ? undefined : legacy.get(sessionId);

    if (known !== undefined) {
      // A long request or an open notification stream is not idle.
      known.open += 1;
      res.on('close', () => {
        known.open -= 1;
        known.lastActive = Date.now();
      });
      await known.transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId === undefined && isInitializeRequest(body)) {
      if (legacy.size >= maxLegacy) {
        rpcError(res, 503, -32000, 'Too many open sessions');
        return;
      }
      const transport: NodeStreamableHTTPServerTransport = new NodeStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          legacy.set(id, { transport, open: 0, lastActive: Date.now() });
        }
      });
      transport.onclose = () => {
        if (transport.sessionId !== undefined) legacy.delete(transport.sessionId);
      };
      const session = gate.createSession();
      const server = createGateServer(gate, session);
      session.setNotifier(() => {
        void server.sendToolListChanged().catch(() => undefined);
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }
    if (sessionId !== undefined) {
      rpcError(res, 404, -32001, 'Session not found');
      return;
    }
    rpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header required');
  }

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - idleMs;
    for (const entry of legacy.values()) {
      if (entry.open === 0 && entry.lastActive < cutoff) void entry.transport.close().catch(() => undefined);
    }
    for (const [key, entry] of scopes) {
      if (entry.lastUsed < cutoff) {
        entry.session.dispose();
        scopes.delete(key);
      }
    }
  }, 60_000);
  sweeper.unref();

  // ---- the endpoint --------------------------------------------------------------------------------------------
  const allowedHostnames = [...new Set(['localhost', '127.0.0.1', '[::1]', options.host, ...(options.allowedHosts ?? [])])];
  const validateHost = hostHeaderValidation(allowedHostnames);
  const validateOrigin = originValidation(allowedHostnames);

  const server: HttpServer = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname.replace(/\/+$/, '');
      if (path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path !== MCP_PATH) {
        sendJson(res, 404, { error: 'not_found' });
        return;
      }
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      if (options.token !== undefined && !tokenMatches(req.headers.authorization, options.token)) {
        sendJson(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
        return;
      }

      const parsed = req.method === 'POST' ? await readJson(req, res) : ({ ok: true, body: undefined } as const);
      if (!parsed.ok) return;

      const probe = await toWebRequest(req, parsed.body);
      if (await isLegacyRequest(probe)) await legacyRoute(req, res, parsed.body);
      else await modernNode(req, res, parsed.body);
    })().catch((error: unknown) => {
      gate.log(`http: ${messageOf(error)}`);
      if (!res.headersSent) rpcError(res, 500, -32603, 'Internal error');
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host, resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : options.port;
  const host = options.host.includes(':') ? `[${options.host}]` : options.host;

  return {
    url: `http://${host}:${port}${MCP_PATH}`,
    port,
    async close() {
      clearInterval(sweeper);
      await Promise.all([...legacy.values()].map((entry) => entry.transport.close().catch(() => undefined)));
      await modern.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}
