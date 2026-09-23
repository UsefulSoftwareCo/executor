import {
  OrganizationReference,
  RequireOrganization,
} from "@executor-js/hosted-server/organization";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

/** Explicit feedback text; arbitrary event properties and caller identities are not accepted. */
export const Feedback = Schema.Struct({
  message: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(10_000),
    Schema.isPattern(/\S/),
  ),
});
export type Feedback = typeof Feedback.Type;

/** Feedback cannot be accepted when analytics is disabled or ingestion fails. */
export class FeedbackUnavailable extends Schema.TaggedError<FeedbackUnavailable>()(
  "FeedbackUnavailable",
  {},
  { httpApiStatus: 503 },
) {}

/** Organization members can submit feedback through a browser session or API authorization. */
export const feedbackGroup = HttpApiGroup.make("feedback")
  .add(
    HttpApiEndpoint.post("submit", "/api/organizations/:organization/feedback", {
      params: { organization: OrganizationReference },
      payload: Feedback,
      success: Schema.Struct({ status: Schema.Literal("accepted") }),
      error: FeedbackUnavailable,
    })
      .annotate(OpenApi.Summary, "Submit feedback")
      .annotate(
        OpenApi.Description,
        "Send feedback about Executor to PostHog. Returns accepted only after ingestion succeeds. Do not include credentials or other sensitive information.",
      ),
  )
  .middleware(RequireOrganization);
