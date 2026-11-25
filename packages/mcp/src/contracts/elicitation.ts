import { Match, Schema } from "effect";
import { RecordedMessage } from "@executor-js/utils/recorded-message";

export const ElicitationMode = Schema.Literals(["model", "native", "browser", "automatic"]);
export type ElicitationMode = typeof ElicitationMode.Type;

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
          "Native elicitation requires an MCP client and protocol with form elicitation support. Reconnect with a compatible client, or connect again and choose model approval.",
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
  get [RecordedMessage]() {
    return this.message;
  }
}
