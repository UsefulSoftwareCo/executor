import { RequestRejection } from "@executor-js/sdk/core";
import {
  Feedback,
  FeedbackDisabled,
  FeedbackUnavailable,
} from "@executor-js/telemetry/product-analytics";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";

const localFeedbackApi = HttpApi.make("local-feedback").add(
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
export const LocalFeedbackApi = localFeedbackApi.middleware(RequestRejection);
