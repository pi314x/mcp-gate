#!/usr/bin/env node
import { loadConfig } from './config.js';
import { Gate } from './gate.js';
import { serveOverHttp } from './http.js';
import { messageOf, stderrLog } from './log.js';
import { serveOverStdio } from './stdio.js';
import { NAME, VERSION } from './version.js';

const HELP = `${NAME} ${VERSION}: an MCP server for MCP servers.

Usage:
  mcp-gate [--config FILE]                 serve over stdio (the default; for hosts that spawn it)
  mcp-gate --http [--port N] [--host H]    serve over Streamable HTTP at /mcp (default 127.0.0.1:3737)
  mcp-gate --check [--config FILE]         connect to every server, print what was found, exit

Options:
  --config FILE        configuration file (default: $MCP_GATE_CONFIG or ./mcp-gate.config.json)
  --http               serve over Streamable HTTP instead of stdio
  --port N, --host H   HTTP bind address (or MCP_GATE_PORT / MCP_GATE_HOST)
  --check              validate the configuration and the connections, then exit
  --help               this text

Environment:
  MCP_GATE_TOKEN           require "Authorization: Bearer <token>" on the HTTP endpoint
  MCP_GATE_ALLOWED_HOSTS   comma-separated extra host names for the HTTP endpoint (a reverse proxy's name)
`;

interface Args {
  config: string;
  http: boolean;
  check: boolean;
  help: boolean;
  port: number;
  host: string;
}

function parseArgs(argv: string[], env: NodeJS.ProcessEnv): Args {
  const args: Args = {
    config: env.MCP_GATE_CONFIG ?? 'mcp-gate.config.json',
    http: false,
    check: false,
    help: false,
    port: Number.parseInt(env.MCP_GATE_PORT ?? '3737', 10),
    host: env.MCP_GATE_HOST ?? '127.0.0.1'
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = (): string => {
      const next = argv[(i += 1)];
      if (next === undefined) throw new Error(`${arg} needs a value`);
      return next;
    };
    switch (arg) {
      case '--config':
        args.config = value();
        break;
      case '--http':
        args.http = true;
        break;
      case '--port':
        args.port = Number.parseInt(value(), 10);
        break;
      case '--host':
        args.host = value();
        break;
      case '--check':
        args.check = true;
        break;
      case '--help':
      case '-h':
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg ?? ''}`);
    }
  }
  if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) throw new Error('the port must be between 0 and 65535');
  return args;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2), process.env);
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  const config = await loadConfig(args.config);
  const gate = new Gate(config, {}, stderrLog);
  await gate.start();

  if (args.check) {
    const statuses = gate.statuses();
    for (const status of statuses) {
      process.stdout.write(`${status.name}: ${status.state}, ${status.tools} tool(s)${status.error ? `, ${status.error}` : ''}\n`);
    }
    if (statuses.length === 0) process.stdout.write('no servers configured\n');
    await gate.close();
    return statuses.some((status) => status.state !== 'connected') ? 1 : 0;
  }

  const shutdown = async (): Promise<void> => {
    await gate.close();
    process.exit(0);
  };

  if (args.http) {
    const token = process.env.MCP_GATE_TOKEN;
    const allowedHosts = (process.env.MCP_GATE_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim())
      .filter(Boolean);
    const handle = await serveOverHttp(gate, {
      host: args.host,
      port: args.port,
      ...(token !== undefined && token !== '' && { token }),
      allowedHosts
    });
    stderrLog(`serving ${handle.url}${token ? ' (bearer token required)' : ''}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => {
        void handle.close().then(shutdown);
      });
    }
    return -1;
  }

  const handle = serveOverStdio(gate);
  stderrLog(`ready on stdio, ${gate.statuses().length} server(s) configured`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void handle.close().then(shutdown);
    });
  }
  return -1;
}

main().then(
  (code) => {
    // -1: serving, the open handles keep the process alive.
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    stderrLog(`error: ${messageOf(error)}`);
    process.exit(1);
  }
);
