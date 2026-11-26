import { Schema } from "effect";
import { RecordedMessage } from "@executor-js/utils/recorded-message";

export class AppEgressFailed extends Schema.TaggedError<AppEgressFailed>()("AppEgressFailed", {
  stage: Schema.Literals(["send", "outbound"]),
  failure: Schema.Literals(["connection_lost", "internal", "subrequest_limit", "other"]),
}) {
  override get message() {
    return this.stage === "send"
      ? `Executor's app network could not send an app's request (${this.failure}).`
      : `Executor's app outbound failed while handling an app's request (${this.failure}).`;
  }
  get [RecordedMessage]() {
    return this.message;
  }
}

export const egressFailure = (stage: AppEgressFailed["stage"], error: unknown) => {
  const message = error instanceof Error ? error.message : "";
  return new AppEgressFailed({
    stage,
    failure: /^network connection lost/i.test(message)
      ? "connection_lost"
      : /^internal error/i.test(message)
        ? "internal"
        : /too many subrequests/i.test(message)
          ? "subrequest_limit"
          : "other",
  });
};
