/**
 * How Executor reports its own failures to send an app's request. Deployed, Cloudflare's network
 * does not reject a fetch when the service fails: it answers with its own error, which reaches the
 * app unchanged like any other answer from the service's side. A fetch that rejects is the network
 * or Executor failing, and is reported.
 */
import { Schema } from "effect";
import { RecordedMessage } from "@executor-js/utils/recorded-message";

/**
 * Executor's app network failed to send an app's request, or the outbound itself failed. The
 * category is fixed; hosts, URLs, apps and the underlying message never enter the report.
 * - `send`: the network rejected the request. On Cloudflare a service that does not answer is
 *   answered by the network instead, so this is the network's or Executor's failure.
 * - `outbound`: Executor's outbound code failed before or after sending.
 */
export class AppEgressFailed extends Schema.TaggedError<AppEgressFailed>()("AppEgressFailed", {
  stage: Schema.Literals(["send", "outbound"]),
  /** A known failure of the platform's network, matched from the rejection's message. */
  failure: Schema.Literals(["connection_lost", "internal", "subrequest_limit", "other"]),
}) {
  override get message() {
    return this.stage === "send"
      ? `Executor's app network could not send an app's request (${this.failure}).`
      : `Executor's app outbound failed while handling an app's request (${this.failure}).`;
  }
  /** Fixed text and closed fields: telemetry records the message itself. */
  get [RecordedMessage]() {
    return this.message;
  }
}

/** The fixed category of a rejection. Its message is matched, never kept. */
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
