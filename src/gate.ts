import type { CallToolResult } from '@modelcontextprotocol/client';
import { rank, splitQualified, type CatalogTool } from './catalog.js';
import type { GateConfig } from './config.js';
import { Downstream, connectorFor, type Connector, type DownstreamStatus } from './downstream.js';
import { globToRegExp } from './glob.js';
import { messageOf, silentLog, type Logger } from './log.js';
import { decide, type Decision } from './policy.js';

export interface EnableReport {
  enabled: string[];
  alreadyEnabled: string[];
  needsConfirmation: string[];
  denied: { name: string; reason: string }[];
  unknown: string[];
  overCapacity: string[];
}

export interface RouteReport {
  matched: { name: string; score: number; description: string }[];
  enable: EnableReport | undefined;
}

export interface SearchHit {
  name: string;
  description: string;
  enabled: boolean;
  access: 'allow' | 'confirm';
}

interface Usage {
  since: number;
  lastUsed: number;
  calls: number;
}

const oneLine = (text: string, max = 160): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/**
 * The process-wide part: the downstream servers, their combined tool catalog and the policies. It never exposes a
 * tool by itself. What a client sees is decided per {@link GateSession}.
 */
export class Gate {
  readonly downstreams = new Map<string, Downstream>();
  private readonly sessions = new Set<GateSession>();
  private sweeper: NodeJS.Timeout | undefined;

  constructor(
    readonly config: GateConfig,
    connectors: Record<string, Connector> = {},
    readonly log: Logger = silentLog
  ) {
    for (const [name, server] of Object.entries(config.servers)) {
      this.downstreams.set(
        name,
        new Downstream(name, server.policy, connectors[name] ?? connectorFor(server), {
          onToolsChanged: () => this.catalogChanged()
        })
      );
    }
  }

  /** Connects every downstream server. One that fails is reported and skipped, never fatal. */
  async start(): Promise<void> {
    await Promise.all(
      [...this.downstreams.values()].map((downstream) =>
        downstream.connect().catch((error: unknown) => {
          this.log(`server "${downstream.name}" is unavailable: ${messageOf(error)}`);
        })
      )
    );
    const ttl = this.config.gate.idleTtlSec;
    if (ttl > 0 && this.sweeper === undefined) {
      this.sweeper = setInterval(() => this.sweep(Date.now()), Math.min(30_000, (ttl * 1000) / 2));
      this.sweeper.unref();
    }
  }

  statuses(): DownstreamStatus[] {
    return [...this.downstreams.values()].map((downstream) => downstream.status);
  }

  catalog(): CatalogTool[] {
    return [...this.downstreams.values()].flatMap((downstream) => downstream.tools);
  }

  find(qualified: string): CatalogTool | undefined {
    const parts = splitQualified(qualified);
    if (parts === undefined) return undefined;
    return this.downstreams.get(parts.server)?.tools.find((tool) => tool.tool === parts.tool);
  }

  /** May this tool ever be enabled? Looks up the policy of its server. */
  decisionFor(tool: CatalogTool): Decision {
    const downstream = this.downstreams.get(tool.server);
    return downstream === undefined ? { verdict: 'deny', reason: 'unknown server' } : decide(downstream.policy, tool.tool);
  }

  async call(qualified: string, args: Record<string, unknown> | undefined, signal?: AbortSignal): Promise<CallToolResult> {
    const tool = this.find(qualified);
    const downstream = tool === undefined ? undefined : this.downstreams.get(tool.server);
    if (tool === undefined || downstream === undefined) throw new Error(`no such tool: ${qualified}`);
    return downstream.call(tool.tool, args, signal);
  }

  createSession(notify: () => void = () => undefined): GateSession {
    const session = new GateSession(this, notify);
    this.sessions.add(session);
    return session;
  }

  /** @internal */
  forget(session: GateSession): void {
    this.sessions.delete(session);
  }

  private catalogChanged(): void {
    for (const session of this.sessions) session.catalogChanged();
  }

  private sweep(now: number): void {
    for (const session of this.sessions) session.sweep(now);
  }

  async close(): Promise<void> {
    if (this.sweeper !== undefined) clearInterval(this.sweeper);
    this.sweeper = undefined;
    this.sessions.clear();
    await Promise.all([...this.downstreams.values()].map((downstream) => downstream.close()));
  }
}

/**
 * What one client may use right now. Starts with only the always-on tools (`autoEnable`), grows when the gate
 * decides to enable tools, shrinks on disable, on idleness and when a server drops a tool.
 */
export class GateSession {
  private readonly active = new Map<string, Usage>();

  constructor(
    private readonly gate: Gate,
    private notify: () => void
  ) {
    const patterns = gate.config.gate.autoEnable;
    if (patterns.length > 0) this.enable(patterns, { confirm: false, silent: true });
  }

  setNotifier(notify: () => void): void {
    this.notify = notify;
  }

  get limits(): { maxEnabled: number; idleTtlSec: number } {
    return { maxEnabled: this.gate.config.gate.maxEnabled, idleTtlSec: this.gate.config.gate.idleTtlSec };
  }

  isEnabled(qualified: string): boolean {
    return this.active.has(qualified);
  }

  /** The enabled tools that still exist and are still allowed. */
  enabledTools(): CatalogTool[] {
    const tools: CatalogTool[] = [];
    for (const name of this.active.keys()) {
      const tool = this.gate.find(name);
      if (tool !== undefined && this.gate.decisionFor(tool).verdict !== 'deny') tools.push(tool);
    }
    return tools;
  }

  touch(qualified: string): void {
    const usage = this.active.get(qualified);
    if (usage !== undefined) {
      usage.lastUsed = Date.now();
      usage.calls += 1;
    }
  }

  /** Enables tools by exact qualified name or `*` pattern. The policy of each server has the last word. */
  enable(patterns: readonly string[], options: { confirm?: boolean; silent?: boolean } = {}): EnableReport {
    const report: EnableReport = { enabled: [], alreadyEnabled: [], needsConfirmation: [], denied: [], unknown: [], overCapacity: [] };
    const catalog = this.gate.catalog();
    const now = Date.now();
    const seen = new Set<string>();

    for (const pattern of patterns) {
      const regexp = globToRegExp(pattern);
      const matches = catalog.filter((tool) => regexp.test(tool.qualified));
      if (matches.length === 0) report.unknown.push(pattern);
      for (const tool of matches) {
        if (seen.has(tool.qualified)) continue;
        seen.add(tool.qualified);
        if (this.active.has(tool.qualified)) {
          report.alreadyEnabled.push(tool.qualified);
          continue;
        }
        const decision = this.gate.decisionFor(tool);
        if (decision.verdict === 'deny') {
          report.denied.push({ name: tool.qualified, reason: decision.reason });
        } else if (decision.verdict === 'confirm' && options.confirm !== true) {
          report.needsConfirmation.push(tool.qualified);
        } else if (this.active.size >= this.gate.config.gate.maxEnabled) {
          report.overCapacity.push(tool.qualified);
        } else {
          this.active.set(tool.qualified, { since: now, lastUsed: now, calls: 0 });
          report.enabled.push(tool.qualified);
        }
      }
    }
    if (report.enabled.length > 0 && options.silent !== true) this.notify();
    return report;
  }

  disable(patterns: readonly string[] | 'all'): string[] {
    const regexps = patterns === 'all' ? [/^.*$/] : patterns.map(globToRegExp);
    const removed = [...this.active.keys()].filter((name) => regexps.some((regexp) => regexp.test(name)));
    for (const name of removed) this.active.delete(name);
    if (removed.length > 0) this.notify();
    return removed;
  }

  /** Tools that may be enabled (never the denied ones), best match first. */
  search(query: string, options: { server?: string; limit?: number } = {}): SearchHit[] {
    const limit = options.limit ?? 10;
    return rank(
      this.candidates(options.server).map((candidate) => candidate.tool),
      query
    )
      .slice(0, limit)
      .map(({ tool }) => ({
        name: tool.qualified,
        description: oneLine(tool.description),
        enabled: this.active.has(tool.qualified),
        access: this.accessOf(tool)
      }));
  }

  /**
   * The gate's own decision for a task: rank the allowed tools and, when asked, enable the best few. Returns
   * nothing when nothing clears the score floor. "Use what you already have" is a valid answer, and a router
   * that always names a best guess applies tools to tasks they were never meant for.
   */
  route(task: string, options: { enable: boolean; limit?: number }): RouteReport {
    const { routeFloor, routeTopK } = this.gate.config.gate;
    const limit = Math.min(options.limit ?? routeTopK, routeTopK);
    const matched = rank(
      this.candidates().map((candidate) => candidate.tool),
      task
    )
      .filter((entry) => entry.score >= routeFloor)
      .slice(0, limit);
    const report: RouteReport = {
      matched: matched.map(({ tool, score }) => ({
        name: tool.qualified,
        score: Math.round(score * 100) / 100,
        description: oneLine(tool.description)
      })),
      enable: undefined
    };
    if (options.enable && matched.length > 0) {
      report.enable = this.enable(matched.map(({ tool }) => tool.qualified));
    }
    return report;
  }

  status(now = Date.now()): { name: string; calls: number; idleSec: number }[] {
    return [...this.active].map(([name, usage]) => ({
      name,
      calls: usage.calls,
      idleSec: Math.round((now - usage.lastUsed) / 1000)
    }));
  }

  /** Switches off tools nobody used for `idleTtlSec`. */
  sweep(now: number): void {
    const ttl = this.gate.config.gate.idleTtlSec * 1000;
    if (ttl <= 0) return;
    const stale = [...this.active].filter(([, usage]) => now - usage.lastUsed >= ttl).map(([name]) => name);
    for (const name of stale) this.active.delete(name);
    if (stale.length > 0) this.notify();
  }

  /** A downstream server changed its tools: forget the ones that disappeared and tell the client to re-list. */
  catalogChanged(): void {
    let removed = false;
    for (const name of [...this.active.keys()]) {
      if (this.gate.find(name) === undefined) {
        this.active.delete(name);
        removed = true;
      }
    }
    if (removed || this.active.size > 0) this.notify();
  }

  dispose(): void {
    this.active.clear();
    this.gate.forget(this);
  }

  private accessOf(tool: CatalogTool): 'allow' | 'confirm' {
    return this.gate.decisionFor(tool).verdict === 'confirm' ? 'confirm' : 'allow';
  }

  private candidates(server?: string): { tool: CatalogTool; access: 'allow' | 'confirm' }[] {
    return this.gate
      .catalog()
      .filter((tool) => server === undefined || tool.server === server)
      .filter((tool) => this.gate.decisionFor(tool).verdict !== 'deny')
      .map((tool) => ({ tool, access: this.accessOf(tool) }));
  }
}
