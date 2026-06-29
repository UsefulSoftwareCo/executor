// CLI/TUI surface: a real PTY via terminal-control. The scenario drives the
// session (type/press/waitForText) and asserts on the rendered screen with
// vitest; pass `record` to save an asciicast v2 the viewer can replay. The
// recording is written in release so a timeout still leaves the evidence.
import { writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Effect } from "effect";
import { TerminalControl, type Session } from "@kitlangton/terminal-control";

import { beat, enterFocus, markRecordingStart } from "../timeline";

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

interface AsciicastEvent {
  type: string;
  cols?: number;
  rows?: number;
  at_ms?: number;
  bytes?: number[];
}

/** terminal-control's JSONL recording → asciicast v2 (what asciinema plays). */
const toAsciicast = (recording: Uint8Array): string => {
  const events = new TextDecoder()
    .decode(recording)
    .split("\n")
    .filter(Boolean)
    .flatMap((line): AsciicastEvent[] => {
      // The PTY can be killed mid-write on teardown (e.g. a vitest timeout
      // interrupts the fiber), leaving a truncated final JSONL line. A line
      // that doesn't parse is one dropped frame, never a failed test: skip it
      // instead of throwing.
      // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: lenient parse of a best-effort recording artifact
      try {
        return [JSON.parse(line) as AsciicastEvent];
      } catch {
        return [];
      }
    });
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
        // Anchor the terminal recording on the run's focus timeline (symmetric
        // with the browser surface), so a combined cli+browser scenario gets the
        // synced SessionPlayer view (terminal/browser cuts + URL bar) for free.
        const runDir = options?.record ? dirname(options.record) : null;
        if (runDir) markRecordingStart(runDir, "terminal");
        return { tc, session, runDir };
      }),
      ({ session, runDir }) =>
        Effect.promise(async () => {
          if (runDir) await enterFocus(runDir, "terminal");
          const result = await drive(session);
          // Hold the terminal's final frame (e.g. "connected") before the
          // recording stops, so it isn't a single flash in the film. Filming
          // only — fast runs return immediately.
          await beat();
          return result;
        }),
      ({ tc, session }) =>
        Effect.promise(async () => {
          if (options?.record) {
            const recording = await session.recording().catch(() => undefined);
            // Writing the cast is a best-effort film artifact (symmetric with the
            // fetch above): a serialization or IO hiccup in teardown must never
            // fail an otherwise-passing test.
            // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: best-effort artifact write
            try {
              if (recording) writeFileSync(options.record, toAsciicast(recording));
            } catch {
              // drop the cast; the test result stands
            }
          }
          await session.stop().catch(() => {});
          await tc[Symbol.asyncDispose]();
        }),
    ),
});
