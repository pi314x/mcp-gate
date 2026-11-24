import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer, type Server } from '@modelcontextprotocol/server';
import * as z from 'zod/v4';
import { parseConfig, type GateConfig } from '../src/config.js';
import type { Connector } from '../src/downstream.js';
import { Gate, type GateSession } from '../src/gate.js';
import { createGateServer } from '../src/server.js';

export interface FakeTool {
  description: string;
  run?: (args: Record<string, unknown>) => string;
}

/** A downstream MCP server living in memory. Each connect builds a fresh instance, so reconnects work. */
export function fakeServer(tools: Record<string, FakeTool>): { connector: Connector; instances: McpServer[] } {
  const instances: McpServer[] = [];
  const connector: Connector = async () => {
    const server = new McpServer({ name: 'fake', version: '1.0.0' });
    for (const [name, tool] of Object.entries(tools)) {
      server.registerTool(
        name,
        { description: tool.description, inputSchema: z.object({ text: z.string().optional() }) },
        (args: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: tool.run?.(args) ?? `${name} ran` }] })
      );
    }
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await server.connect(serverSide);
    instances.push(server);
    return clientSide;
  };
  return { connector, instances };
}

export const FILES = {
  read_file: { description: 'Read the contents of a file from disk', run: (a: Record<string, unknown>) => `contents of ${String(a.text)}` },
  list_directory: { description: 'List the files in a directory' },
  write_file: { description: 'Write text to a file on disk' }
};

export const CALENDAR = {
  create_event: { description: 'Create a calendar event with a title and a time' },
  list_events: { description: 'List upcoming calendar events' }
};

export function configOf(overrides: { servers?: Record<string, unknown>; gate?: Record<string, unknown> } = {}): GateConfig {
  return parseConfig({
    servers: overrides.servers ?? { files: { command: 'unused' }, calendar: { command: 'unused' } },
    gate: overrides.gate ?? {}
  });
}

export interface Rig {
  gate: Gate;
  session: GateSession;
  server: Server;
  client: Client;
  changes: number;
  close(): Promise<void>;
}

/** A gate with in-memory downstreams and a real MCP client connected to one of its sessions. */
export async function rig(options: {
  servers?: Record<string, unknown>;
  gate?: Record<string, unknown>;
  downstreams?: Record<string, ReturnType<typeof fakeServer>['connector']>;
} = {}): Promise<Rig> {
  const downstreams = options.downstreams ?? { files: fakeServer(FILES).connector, calendar: fakeServer(CALENDAR).connector };
  const gate = new Gate(configOf(options), downstreams);
  await gate.start();

  const session = gate.createSession();
  const server = createGateServer(gate, session);
  session.setNotifier(() => {
    void server.sendToolListChanged().catch(() => undefined);
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);

  const state = { changes: 0 };
  const client = new Client(
    { name: 'test', version: '0.0.0' },
    { listChanged: { tools: { debounceMs: 0, onChanged: () => void (state.changes += 1) } } }
  );
  await client.connect(clientSide);

  return {
    gate,
    session,
    server,
    client,
    get changes() {
      return state.changes;
    },
    async close() {
      await client.close();
      await server.close();
      await gate.close();
    }
  };
}

export const textOf = (result: { content?: unknown }): string =>
  (result.content as { type: string; text?: string }[]).map((part) => part.text ?? '').join('');

export const jsonOf = <T = Record<string, unknown>>(result: { content?: unknown }): T => JSON.parse(textOf(result)) as T;

export const toolNames = async (client: Client): Promise<string[]> => (await client.listTools()).tools.map((tool) => tool.name);
