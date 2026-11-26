import { Server, type CallToolResult, type Tool } from '@modelcontextprotocol/server';
import type { CatalogTool } from './catalog.js';
import type { Gate, GateSession } from './gate.js';
import { countTokens } from './ledger-tokens.js';
import { messageOf } from './log.js';
import { NAME, VERSION } from './version.js';

const META_PREFIX = 'gate_';

const INSTRUCTIONS = `This server fronts other MCP servers and shows only the tools it has enabled. At first you see just the gate_* tools.
To use a capability: call gate_route with the task (it ranks the tools and enables the best matches), or gate_search_tools and then gate_enable_tools with the names. Enabled tools then appear in your tool list, named <server>__<tool>.
If gate_route finds nothing, no tool fits: carry on without. Disable tools you no longer need with gate_disable_tools.`;

const META_TOOLS: Tool[] = [
  {
    name: 'gate_list_servers',
    description: 'List the downstream MCP servers behind this gate, whether each is reachable, and how many tools it offers. Does not enable anything.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'gate_search_tools',
    description: 'Search the tools of the downstream servers by words (names and descriptions). Returns names and one-line descriptions only, never schemas, and does not enable anything.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What you want to do, in a few words.' },
        server: { type: 'string', description: 'Only search this server.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most results to return (default 10).' }
      },
      required: ['query']
    },
    annotations: { readOnlyHint: true }
  },
  {
    name: 'gate_route',
    description:
      'Describe your task and let the gate decide which tools to enable. It ranks the allowed tools and, by default, enables the best matches. Returns an empty match list when no tool fits the task: then use what you already have.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task, in your own words.' },
        enable: { type: 'boolean', description: 'Enable the matches (default true). Set false to only see them.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Most tools to match.' }
      },
      required: ['task']
    }
  },
  {
    name: 'gate_enable_tools',
    description:
      'Enable specific tools by name (<server>__<tool>; * matches any characters). Enabled tools appear in your tool list. Tools the policy blocks are refused; tools marked as needing confirmation are enabled only with confirm: true.',
    inputSchema: {
      type: 'object',
      properties: {
        tools: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Tool names or patterns.' },
        confirm: { type: 'boolean', description: 'Confirm that tools marked as needing confirmation may be enabled.' }
      },
      required: ['tools']
    }
  },
  {
    name: 'gate_disable_tools',
    description: 'Disable tools you no longer need, by name or pattern, or all of them. Keeps your tool list short.',
    inputSchema: {
      type: 'object',
      properties: {
        tools: { type: 'array', items: { type: 'string' }, description: 'Tool names or patterns.' },
        all: { type: 'boolean', description: 'Disable every enabled tool.' }
      }
    }
  },
  {
    name: 'gate_status',
    description: 'Show which tools are enabled for you right now, how often each was used, and the limits.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true }
  }
];

const toolDefinition = (tool: CatalogTool): Tool => ({
  name: tool.qualified,
  description: tool.description,
  inputSchema: tool.inputSchema as Tool['inputSchema'],
  ...(tool.outputSchema !== undefined && { outputSchema: tool.outputSchema as Tool['outputSchema'] }),
  ...(tool.annotations !== undefined && { annotations: tool.annotations as Tool['annotations'] })
});

/**
 * One `tools_list` event per listing: what the gate sends (its own tools, the enabled ones and its instructions)
 * against every tool the policy lets through, which is what a client would be sent without a gate. Denied tools stay
 * out of the baseline, so the saving is not inflated by tools the client could never have used.
 */
function recordListing(gate: Gate, listed: Tool[]): void {
  if (gate.ledger === undefined) return;
  const offered = gate
    .catalog()
    .filter((tool) => gate.decisionFor(tool).verdict !== 'deny')
    .map(toolDefinition);
  gate.ledger.record({
    kind: 'tools_list',
    sent: countTokens(JSON.stringify(listed)) + countTokens(INSTRUCTIONS),
    baseline: countTokens(JSON.stringify(offered)),
    meta: { enabled: listed.length - META_TOOLS.length, offered: offered.length }
  });
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
const failure = (message: string): CallToolResult => ({ content: [{ type: 'text', text: message }], isError: true });

const strings = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;

function metaCall(gate: Gate, session: GateSession, name: string, args: Record<string, unknown>): CallToolResult {
  switch (name) {
    case 'gate_list_servers':
      return json({ servers: gate.statuses() });
    case 'gate_search_tools': {
      if (typeof args.query !== 'string' || args.query.trim() === '') return failure('query must be a non-empty string.');
      const hits = session.search(args.query, {
        ...(typeof args.server === 'string' && { server: args.server }),
        ...(typeof args.limit === 'number' && { limit: args.limit })
      });
      return json({ results: hits, hint: hits.length === 0 ? 'Nothing matches. Use the tools you already have.' : 'Enable with gate_enable_tools.' });
    }
    case 'gate_route': {
      if (typeof args.task !== 'string' || args.task.trim() === '') return failure('task must be a non-empty string.');
      const report = session.route(args.task, {
        enable: args.enable !== false,
        ...(typeof args.limit === 'number' && { limit: args.limit })
      });
      const result = json({
        matched: report.matched,
        ...(report.enable !== undefined && { enable: report.enable }),
        ...(report.matched.length === 0 && { hint: 'No tool fits this task. Use the tools you already have.' })
      });
      // Baseline 0: the answer is added cost on top of the listing, whose baseline already covers every tool.
      gate.ledger?.record({
        kind: 'route',
        sent: countTokens(JSON.stringify(result.content)),
        baseline: 0,
        meta: { matched: report.matched.length, enabled: report.enable?.enabled.length ?? 0 }
      });
      return result;
    }
    case 'gate_enable_tools': {
      const tools = strings(args.tools);
      if (tools === undefined || tools.length === 0) return failure('tools must be a non-empty array of strings.');
      return json(session.enable(tools, { confirm: args.confirm === true }));
    }
    case 'gate_disable_tools': {
      if (args.all === true) return json({ disabled: session.disable('all') });
      const tools = strings(args.tools);
      if (tools === undefined || tools.length === 0) return failure('Give tools (names or patterns) or all: true.');
      return json({ disabled: session.disable(tools) });
    }
    case 'gate_status':
      return json({ enabled: session.status(), limits: session.limits });
    default:
      return failure(`Unknown gate tool: ${name}`);
  }
}

/**
 * One serving unit of the gate: the `gate_*` tools plus whatever this session has enabled.
 * `ownsSession` is false when the session outlives this instance (a per-request instance on stateless HTTP).
 */
export function createGateServer(gate: Gate, session: GateSession, options: { ownsSession?: boolean } = {}): Server {
  const server = new Server(
    { name: NAME, version: VERSION },
    { capabilities: { tools: { listChanged: true } }, instructions: INSTRUCTIONS }
  );

  server.setRequestHandler('tools/list', () => {
    const tools = [...META_TOOLS, ...session.enabledTools().map(toolDefinition)];
    recordListing(gate, tools);
    return { tools };
  });

  server.setRequestHandler('tools/call', async (request, ctx) => {
    const { name } = request.params;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    if (name.startsWith(META_PREFIX)) {
      return server.projectCallToolResult(metaCall(gate, session, name, args), undefined);
    }

    const tool = session.isEnabled(name) ? gate.find(name) : undefined;
    if (tool === undefined || gate.decisionFor(tool).verdict === 'deny') {
      return failure(`Tool "${name}" is not enabled. Find it with gate_search_tools or gate_route, then enable it with gate_enable_tools.`);
    }

    session.touch(name);
    try {
      const result = await gate.call(name, args, ctx.mcpReq.signal);
      return server.projectCallToolResult(result, tool.outputSchema);
    } catch (error) {
      return failure(`Calling ${name} failed: ${messageOf(error)}`);
    }
  });

  if (options.ownsSession !== false) server.onclose = () => session.dispose();
  return server;
}
