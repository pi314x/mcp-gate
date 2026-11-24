// Records the tools a real MCP server offers, exactly as a model is shown them (name, description, input
// schema), so `token-report.ts` can run offline and anyone can re-run it on their own servers.
//
//   npx tsx scripts/capture-tools.ts <name> --source "<how it was started>" [--cwd DIR] [--env KEY=VALUE]... -- <command> [args...]
//
// Example:
//   npx tsx scripts/capture-tools.ts filesystem --source "npx -y @modelcontextprotocol/server-filesystem <dir>" \
//     -- npx -y @modelcontextprotocol/server-filesystem .
//
// `--source` is written to the fixture as free text. It is never derived from the command line, so absolute
// paths and secrets on your machine do not end up in a committed file. Output: bench/fixtures/<name>.tools.json
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

interface Args {
  name: string;
  source: string;
  cwd?: string;
  env: Record<string, string>;
  command: string;
  commandArgs: string[];
}

function parseArgs(argv: string[]): Args {
  const split = argv.indexOf('--');
  const head = split === -1 ? argv : argv.slice(0, split);
  const tail = split === -1 ? [] : argv.slice(split + 1);
  const [name, ...flags] = head;
  if (name === undefined || name.startsWith('--') || tail.length === 0) {
    throw new Error('Usage: capture-tools.ts <name> --source "<text>" [--cwd DIR] [--env KEY=VALUE]... -- <command> [args...]');
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error('name must be lowercase letters, digits and single hyphens.');
  const out: Args = { name, source: '', env: {}, command: tail[0] as string, commandArgs: tail.slice(1) };
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i];
    const value = flags[i + 1];
    if (value === undefined) throw new Error(`${flag} needs a value.`);
    if (flag === '--source') out.source = value;
    else if (flag === '--cwd') out.cwd = value;
    else if (flag === '--env') {
      const eq = value.indexOf('=');
      if (eq < 1) throw new Error('--env needs KEY=VALUE.');
      out.env[value.slice(0, eq)] = value.slice(eq + 1);
    } else throw new Error(`Unknown flag ${flag}.`);
  }
  if (out.source === '') throw new Error('--source is required: say in words how the server was started (no secrets, no local paths).');
  return out;
}

const args = parseArgs(process.argv.slice(2));
const transport = new StdioClientTransport({
  command: args.command,
  args: args.commandArgs,
  env: args.env,
  ...(args.cwd !== undefined && { cwd: args.cwd }),
  stderr: 'pipe'
});
const client = new Client({ name: 'mcp-gate-capture', version: '0.0.0' });
await client.connect(transport, { timeout: 120_000 });

const tools: Tool[] = [];
let cursor: string | undefined;
do {
  const page = await client.listTools(cursor === undefined ? undefined : { cursor });
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor !== undefined);
const info = client.getServerVersion();
await client.close();

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = resolve(root, 'bench', 'fixtures', `${args.name}.tools.json`);
await mkdir(dirname(file), { recursive: true });
await writeFile(
  file,
  `${JSON.stringify(
    {
      server: args.name,
      source: args.source,
      serverInfo: info === undefined ? null : { name: info.name, version: info.version },
      capturedOn: new Date().toISOString().slice(0, 10),
      // Only what a model is shown. Output schemas and annotations are not sent to the model by typical clients.
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description ?? tool.title ?? '', inputSchema: tool.inputSchema }))
    },
    null,
    2
  )}\n`
);
console.error(`${args.name}: ${tools.length} tools -> bench/fixtures/${args.name}.tools.json`);
