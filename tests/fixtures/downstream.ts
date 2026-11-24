// A tiny real downstream MCP server over stdio, used to test the gate end to end.
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import * as z from 'zod/v4';

serveStdio(() => {
  const server = new McpServer({ name: 'fixture', version: '1.0.0' });
  const input = z.object({ text: z.string() });
  server.registerTool('shout', { description: 'Turn text into capital letters', inputSchema: input }, ({ text }: { text: string }) => ({
    content: [{ type: 'text' as const, text: text.toUpperCase() }]
  }));
  server.registerTool('reverse', { description: 'Reverse the letters of a text', inputSchema: input }, ({ text }: { text: string }) => ({
    content: [{ type: 'text' as const, text: [...text].reverse().join('') }]
  }));
  server.registerTool('delete_everything', { description: 'Delete everything', inputSchema: input }, () => ({
    content: [{ type: 'text' as const, text: 'deleted' }]
  }));
  return server;
});
