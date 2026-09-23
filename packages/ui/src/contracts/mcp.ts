import { Effect, Redacted, Schema } from "effect";
import { Atom } from "effect/unstable/reactivity";

/** Supported installation instructions for a Streamable HTTP endpoint. */
export const McpInstallFormat = Schema.Literals(["installer", "claude", "json"]);
export type McpInstallFormat = typeof McpInstallFormat.Type;

/** The browser could not write to the clipboard. */
export class ClipboardUnavailable extends Schema.TaggedError<ClipboardUnavailable>()(
  "ClipboardUnavailable",
  {},
) {}

/** Copy instructions without retaining cleartext credentials in mutation inputs. */
export const copyMcpInstallAtom = Atom.fn((text: Redacted.Redacted<string>) =>
  Effect.tryPromise({
    try: () => navigator.clipboard.writeText(Redacted.value(text)),
    catch: () => new ClipboardUnavailable(),
  }),
);
