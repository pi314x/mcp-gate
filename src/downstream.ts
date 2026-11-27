import {
  Client,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool,
  type Transport
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { qualify, type CatalogTool } from './catalog.js';
import { isStdio, type ServerConfig } from './config.js';
import { messageOf } from './log.js';
import type { Policy } from './policy.js';
import { NAME, VERSION } from './version.js';

/** Builds a fresh transport to one downstream server. Injected in tests; real servers use {@link connectorFor}. */
export type Connector = () => Transport | Promise<Transport>;

export function connectorFor(config: ServerConfig): Connector {
  if (isStdio(config)) {
    return () =>
      new StdioClientTransport({
        command: config.command,
        args: config.args,
        env: config.env,
        ...(config.cwd !== undefined && { cwd: config.cwd }),
        // The child's stdout is protocol; its stderr must not end up in ours.
        stderr: 'pipe'
      });
  }
  return () =>
    new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: { headers: config.headers }
    });
}

export type DownstreamState = 'idle' | 'connecting' | 'connected' | 'failed';

export interface DownstreamStatus {
  name: string;
  state: DownstreamState;
  tools: number;
  error?: string;
}

export interface DownstreamOptions {
  /** Ceiling for connecting and for each call, so a hung server fails instead of blocking a session. */
  timeoutMs?: number;
  /** Called after the server's tool list changed. */
  onToolsChanged?: () => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

/** One downstream MCP server: connects lazily, keeps its tool list, reconnects once when a call finds the link dead. */
export class Downstream {
  state: DownstreamState = 'idle';
  error: string | undefined;
  tools: CatalogTool[] = [];

  private client: Client | undefined;
  private starting: Promise<void> | undefined;
  private readonly timeoutMs: number;

  constructor(
    readonly name: string,
    readonly policy: Policy,
    private readonly connector: Connector,
    private readonly options: DownstreamOptions = {}
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  get status(): DownstreamStatus {
    return {
      name: this.name,
      state: this.state,
      tools: this.tools.length,
      ...(this.error !== undefined && { error: this.error })
    };
  }

  /** Connects once; concurrent callers share the attempt. */
  connect(): Promise<void> {
    if (this.client !== undefined) return Promise.resolve();
    this.starting ??= this.open().finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }

  private async open(): Promise<void> {
    this.state = 'connecting';
    this.error = undefined;
    const client = new Client(
      { name: NAME, version: VERSION },
      {
        listChanged: {
          tools: {
            onChanged: (error, tools) => {
              if (error === null || error === undefined) this.setTools((tools ?? []) as Tool[]);
            }
          }
        }
      }
    );
    client.onclose = () => {
      if (this.client === client) {
        this.client = undefined;
        this.state = 'idle';
      }
    };
    try {
      await client.connect(await this.connector(), { timeout: this.timeoutMs });
      this.client = client;
      await this.refresh();
      this.state = 'connected';
    } catch (error) {
      this.client = undefined;
      await client.close().catch(() => undefined);
      this.state = 'failed';
      this.error = messageOf(error);
      throw error;
    }
  }

  /** Reads the full tool list, following pagination. */
  async refresh(): Promise<void> {
    const client = this.client;
    if (client === undefined) return;
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? undefined : { cursor });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    this.setTools(tools);
  }

  private setTools(tools: readonly Tool[]): void {
    this.tools = tools.map((tool) => ({
      qualified: qualify(this.name, tool.name),
      server: this.name,
      tool: tool.name,
      description: tool.description ?? tool.title ?? '',
      inputSchema: tool.inputSchema as Record<string, unknown>,
      ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema as Record<string, unknown> }),
      ...(tool.annotations !== undefined && { annotations: tool.annotations as Record<string, unknown> }),
      ...(tool._meta !== undefined && { meta: tool._meta as Record<string, unknown> })
    }));
    this.options.onToolsChanged?.();
  }

  async call(tool: string, args: Record<string, unknown> | undefined, signal?: AbortSignal, meta?: Record<string, unknown>): Promise<CallToolResult> {
    for (let attempt = 0; ; attempt += 1) {
      await this.connect();
      const client = this.client;
      if (client === undefined) throw new Error(`server "${this.name}" is not connected`);
      try {
        return await client.callTool(
          { name: tool, ...(args !== undefined && { arguments: args }), ...(meta !== undefined && { _meta: meta }) },
          { timeout: this.timeoutMs, ...(signal !== undefined && { signal }) }
        );
      } catch (error) {
        const linkLost =
          SdkError.isInstance(error) &&
          (error.code === SdkErrorCode.ConnectionClosed || error.code === SdkErrorCode.NotConnected);
        if (!linkLost || attempt > 0) throw error;
        // The link died between calls: drop it and let the next loop turn reconnect once.
        this.client = undefined;
        await client.close().catch(() => undefined);
      }
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.state = 'idle';
    await client?.close().catch(() => undefined);
  }
}
