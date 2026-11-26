// Canonical copy. Each layer copies this file byte for byte to src/ledger.ts, and ctx-ledger's conformance test
// fails when a copy drifts or writes a line that parseEvent rejects. Change it here, then copy it out.
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const MAX_LINE_BYTES = 4096;
const MAX_META_KEYS = 12;
const MAX_META_VALUE = 128;

export interface LedgerCall {
  kind: string;
  /** Tokens sent to the model for this call. */
  sent: number;
  /** Tokens the naive alternative would have sent. Leave it out when there is no honest baseline. */
  baseline?: number;
  task?: string;
  /** Small scalar facts only: never task text, arguments, paths or tool output. */
  meta?: Record<string, string | number | boolean>;
}

export interface LedgerRecorder {
  record(call: LedgerCall): void;
  /** Calls that could not be written (invalid, too large or an unwritable file). Recording never throws. */
  readonly dropped: number;
}

const idOr = (value: string | undefined, fallback: string | undefined): string | undefined => (value !== undefined && ID.test(value) ? value : fallback);

/**
 * A recorder for one layer, or undefined when `CTX_LEDGER_FILE` is not set: the ledger is opt-in and costs nothing off.
 * `CTX_LEDGER_SESSION` and `CTX_LEDGER_TASK` let a host that launches several layers give them one session or task id;
 * without them each process is its own session and no task spans layers.
 */
export function ledgerFromEnv(layer: string, counter: string, env: NodeJS.ProcessEnv = process.env): LedgerRecorder | undefined {
  const file = env.CTX_LEDGER_FILE;
  if (file === undefined || file === '') return undefined;
  const session = idOr(env.CTX_LEDGER_SESSION, `p-${randomBytes(4).toString('hex')}`) as string;
  const envTask = idOr(env.CTX_LEDGER_TASK, undefined);
  let dropped = 0;

  return {
    get dropped() {
      return dropped;
    },
    record(call) {
      try {
        const count = (n: number): number => {
          if (!Number.isFinite(n) || n < 0) throw new RangeError('count');
          return Math.round(n);
        };
        if (!ID.test(call.kind)) throw new RangeError('kind');
        const event: Record<string, unknown> = {
          v: 1,
          ts: new Date().toISOString(),
          session,
          layer,
          kind: call.kind,
          sent: count(call.sent),
          counter
        };
        if (call.baseline !== undefined) event.baseline = count(call.baseline);
        const task = idOr(call.task, envTask);
        if (task !== undefined) event.task = task;
        if (call.meta !== undefined) {
          const meta: Record<string, string | number | boolean> = {};
          for (const [key, value] of Object.entries(call.meta).slice(0, MAX_META_KEYS)) {
            if (!ID.test(key)) continue;
            if (typeof value === 'string') meta[key] = value.slice(0, MAX_META_VALUE);
            else if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) meta[key] = value;
          }
          if (Object.keys(meta).length > 0) event.meta = meta;
        }
        const line = `${JSON.stringify(event)}\n`;
        if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new RangeError('size');
        mkdirSync(dirname(file), { recursive: true });
        appendFileSync(file, line, 'utf8');
      } catch {
        dropped += 1;
      }
    }
  };
}
