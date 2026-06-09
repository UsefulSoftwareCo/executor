// CLI/TUI surface: a real PTY via terminal-control. Every keystroke/wait
// snapshots the rendered screen, and the whole session lands in the transcript
// as an animated terminal pane (termFrames evidence) — watchable in the viewer
// like an asciinema cast, no local run needed.
import { Effect } from "effect";
import { TerminalControl, type Session } from "@kitlangton/terminal-control";

import type { Recorder } from "../recorder";

export interface RecordedCliSession {
  readonly type: (text: string) => Promise<void>;
  readonly press: (key: string) => Promise<void>;
  readonly waitForText: (text: string) => Promise<void>;
  readonly screen: () => string;
  /** Snapshot the current screen explicitly (actions snapshot automatically). */
  readonly snap: () => void;
}

export interface CliSurface {
  readonly session: <T>(
    command: readonly [string, ...string[]],
    drive: (session: RecordedCliSession) => Promise<T>,
    options?: { readonly cwd?: string; readonly env?: Record<string, string> },
  ) => Effect.Effect<T>;
}

// acquireUseRelease so a vitest timeout (fiber interruption) still tears the
// PTY down instead of leaking the child process.
export const makeCliSurface = (rec: Recorder): CliSurface => ({
  session: (command, drive, options) =>
    Effect.acquireUseRelease(
      Effect.promise(async () => {
        const tc = await TerminalControl.make();
        const session: Session = await tc.launch({
          command,
          cwd: options?.cwd,
          env: options?.env,
        });
        return { tc, session };
      }),
      ({ session }) =>
        Effect.promise(async () => {
          const startedAt = Date.now();
          const frames: Array<{ t: number; text: string }> = [];
          const snap = () => {
            const text = session.screen.text();
            if (frames.at(-1)?.text !== text) frames.push({ t: Date.now() - startedAt, text });
          };

          const recorded: RecordedCliSession = {
            type: async (text) => {
              await session.keyboard.type(text);
              snap();
            },
            press: async (key) => {
              await session.keyboard.press(key);
              snap();
            },
            waitForText: async (text) => {
              await session.screen.waitForText(text);
              snap();
            },
            screen: () => session.screen.text(),
            snap,
          };

          const label = `$ ${command.join(" ")}`;
          try {
            const result = await drive(recorded);
            snap();
            rec.step("cli", label, [{ kind: "termFrames", frames }]);
            return result;
          } catch (error) {
            snap();
            rec.error(`cli: ${error instanceof Error ? error.message : String(error)}`, [
              { kind: "termFrames", frames },
            ]);
            throw error;
          }
        }),
      ({ tc, session }) =>
        Effect.promise(async () => {
          await session.stop().catch(() => {});
          await tc[Symbol.asyncDispose]();
        }),
    ),
});
