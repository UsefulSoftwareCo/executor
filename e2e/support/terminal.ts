/** Terminal Control sessions share the browser's focus clock; maintenance never steals focus. */
import { TerminalControl, type LaunchOptions, type Session } from "@kitlangton/terminal-control";
import { Clock, Context, Effect, Layer } from "effect";
import { randomUUID } from "node:crypto";
import { Evidence } from "./evidence.ts";
import { RecordingFocus } from "./recording-focus.ts";
import { driver } from "./platform.ts";
import { terminalCaptureType } from "./terminal-recording.ts";

const make = Effect.gen(function* () {
  const evidence = yield* Evidence,
    recording = yield* RecordingFocus;
  return {
    launch: (title: string, options: Omit<LaunchOptions, "record">) =>
      Effect.gen(function* () {
        const name = `terminal-${randomUUID().slice(0, 8)}`;
        const control = yield* Effect.acquireRelease(
          driver("start Terminal Control", () => TerminalControl.make({ artifacts: false })),
          (control) => driver("close Terminal Control", () => control.close()).pipe(Effect.orDie),
        );
        const startedAtMs = yield* Clock.currentTimeMillis;
        const session = yield* Effect.acquireRelease(
          driver(`open ${title}`, () => control.launch({ ...options, record: true })),
          (session) => driver("stop terminal", () => session.stop()).pipe(Effect.orDie),
        );
        const window = yield* recording.open({
          kind: "terminal",
          title,
          startedAtMs,
          file: `${name}.mp4`,
        });
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            // These calls save an existing capture, rather than representing a user's operation.
            const source = `${evidence.directory}/${name}.termctrl`;
            yield* driver("save terminal capture", () => session.saveRecording(source));
            const text = yield* driver("save terminal output", () => session.logs.text());
            yield* evidence.attach(`${name}.txt`, "text/plain", text);
            const screen = yield* driver("save terminal screen", () =>
              session.screen.capture({ allowIncomplete: true }),
            );
            yield* evidence.attach(`${name}-screen.txt`, "text/plain", screen.text);
            yield* driver("stop recorded terminal", () => session.stop());
            yield* evidence.artifact(
              `${title} raw capture`,
              terminalCaptureType,
              `${name}.termctrl`,
            );
          }).pipe(Effect.orDie),
        );
        return {
          use: <A>(label: string, action: (session: Session) => Promise<A>) =>
            evidence.step(
              label,
              window.use(
                label,
                driver(label, () => action(session)),
              ),
            ),
        };
      }),
  };
});
/** A new scope owns each terminal. All public session operations go through its focused use adapter. */
export class Terminal extends Context.Service<Terminal, Effect.Success<typeof make>>()(
  "e2e/Terminal",
) {
  static readonly layer = Layer.effect(Terminal, make);
}
