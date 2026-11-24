export type Logger = (message: string) => void;

/** Diagnostics always go to stderr: on stdio, stdout is the protocol channel. */
export const stderrLog: Logger = (message) => {
  process.stderr.write(`[mcp-gate] ${message}\n`);
};

export const silentLog: Logger = () => undefined;

export const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));
