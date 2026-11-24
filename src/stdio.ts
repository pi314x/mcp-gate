import { serveStdio } from '@modelcontextprotocol/server/stdio';
import type { Gate } from './gate.js';
import { messageOf } from './log.js';
import { createGateServer } from './server.js';

/** One process is one connection is one session: the host that spawned the gate owns it. */
export function serveOverStdio(gate: Gate): { close(): Promise<void> } {
  return serveStdio(
    () => {
      const session = gate.createSession();
      const server = createGateServer(gate, session);
      session.setNotifier(() => {
        void server.sendToolListChanged().catch(() => undefined);
      });
      return server;
    },
    { onerror: (error) => gate.log(`stdio: ${messageOf(error)}`) }
  );
}
