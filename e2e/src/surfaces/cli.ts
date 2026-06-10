// CLI/TUI surface: a real PTY via terminal-control. The scenario drives the
// session (type/press/waitForText) and asserts on the rendered screen with
// vitest; pass `record` to save an asciicast v2 the viewer can replay. The
// recording is written in release so a timeout still leaves the evidence.
import { writeFileSync } from "node:fs";

import { Effect } from "effect";
import { TerminalControl, type Session } from "@kitlangton/terminal-control";

export interface CliSurface {
  readonly session: <T>(
    command: readonly [string, ...string[]],
    drive: (session: Session) => Promise<T>,
    options?: {
      readonly cwd?: string;
      readonly env?: Record<string, string>;
      /** Path to write an asciicast v2 (.cast) of the whole session. */
      readonly record?: string;
      readonly viewport?: { readonly cols: number; readonly rows: number };
    },
  ) => Effect.Effect<T>;
}

/** terminal-control's JSONL recording → asciicast v2 (what asciinema plays). */
const toAsciicast = (recording: Uint8Array): string => {
  const events = new TextDecoder()
    .decode(recording)
    .split("\n")
    .filter(Boolean)
    .map(
      (line) =>
        JSON.parse(line) as {
          type: string;
          cols?: number;
          rows?: number;
          at_ms?: number;
          bytes?: number[];
        },
    );
  const header = events.find((event) => event.type === "header");
  const lines = [
    JSON.stringify({ version: 2, width: header?.cols ?? 80, height: header?.rows ?? 24 }),
  ];
  // One streaming decoder so multi-byte UTF-8 split across events survives.
  const decoder = new TextDecoder();
  for (const event of events) {
    if (event.type !== "output") continue;
    const text = decoder.decode(Uint8Array.from(event.bytes ?? []), { stream: true });
    if (text) lines.push(JSON.stringify([(event.at_ms ?? 0) / 1000, "o", text]));
  }
  return `${lines.join("\n")}\n`;
};

// acquireUseRelease so a vitest timeout (fiber interruption) still tears the
// PTY down instead of leaking the child process.
export const makeCliSurface = (): CliSurface => ({
  session: (command, drive, options) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const tc = await TerminalControl.make();
        const session: Session = await tc.launch({
          command,
          cwd: options?.cwd,
          env: options?.env,
          record: options?.record ? true : undefined,
          viewport: options?.viewport,
        });
        return { tc, session };
      }),
      ({ session }) => Effect.promise(() => drive(session)),
      ({ tc, session }) =>
        Effect.promise(async () => {
          if (options?.record) {
            const recording = await session.recording().catch(() => undefined);
            if (recording) writeFileSync(options.record, toAsciicast(recording));
          }
          await session.stop().catch(() => {});
          await tc[Symbol.asyncDispose]();
        }),
    ),
});
