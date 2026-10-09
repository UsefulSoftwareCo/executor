/** Feedback from agents and people using this local Executor; local has no organizations. */
import {
  Feedback,
  FeedbackDisabled,
  FeedbackUnavailable,
} from "@executor-js/telemetry/product-analytics";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

/** The same `feedback.submit` operation as hosted Executor, without an organization parameter. */
export const LocalFeedbackApi = HttpApi.make("local-feedback").add(
  HttpApiGroup.make("feedback").add(
    HttpApiEndpoint.post("submit", "/v1/feedback", {
      payload: Feedback,
      success: Schema.Struct({ status: Schema.Literal("accepted") }),
      error: [FeedbackUnavailable, FeedbackDisabled],
    })
      .annotate(OpenApi.Summary, "Submit feedback")
      .annotate(
        OpenApi.Description,
        "Send feedback about Executor to the Executor team. Returns accepted only after ingestion succeeds. Returns FeedbackDisabled when this installation has analytics turned off. Do not include credentials or other sensitive information.",
      ),
  ),
);
