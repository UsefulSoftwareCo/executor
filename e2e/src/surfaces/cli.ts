// CLI/TUI surface driver: run a command in a real PTY (terminal-control), drive
// it (type/press), and read the rendered screen — recoverable as an asciinema-
// grade recording. `drive` gets the live Session; the PTY is disposed after.
import { Effect } from "effect";
import { TerminalControl, type Session } from "@kitlangton/terminal-control";

export const runCli = <T>(
  command: readonly [string, ...string[]],
  drive: (session: Session) => Promise<T>,
  opts?: { cwd?: string; env?: Record<string, string>; record?: string },
) =>
  Effect.promise(async () => {
    const tc = await TerminalControl.make();
    const session = await tc.launch({ command, cwd: opts?.cwd, env: opts?.env, record: opts?.record });
    try {
      return await drive(session);
    } finally {
      await session.stop().catch(() => {});
      await tc[Symbol.asyncDispose]();
    }
  });
