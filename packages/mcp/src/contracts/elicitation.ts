/** Approval delivery is selected by the MCP endpoint, independently of tool policy. */
import { Match, Schema } from "effect";

/** The model collects decisions by default; native mode uses the client's MCP prompt. */
export const ElicitationMode = Schema.Literals(["model", "native", "browser"]);
export type ElicitationMode = typeof ElicitationMode.Type;

/** Native delivery failures never stand in for a user's decline or cancellation. */
export class NativeElicitationFailed extends Schema.TaggedError<NativeElicitationFailed>()(
  "NativeElicitationFailed",
  {
    reason: Schema.Literals(["unsupported", "transport", "expired"]),
  },
) {
  override get message(): string {
    return Match.value(this.reason).pipe(
      Match.when(
        "unsupported",
        () =>
          "Native elicitation requires an MCP client and protocol with form elicitation support. Reconnect with a compatible client or use elicitation_mode=model.",
      ),
      Match.when(
        "transport",
        () =>
          "The MCP input prompt failed. The program was stopped; earlier tool calls may have completed.",
      ),
      Match.when(
        "expired",
        () =>
          "The input request expired. The program was stopped; earlier tool calls may have completed.",
      ),
      Match.exhaustive,
    );
  }
}
