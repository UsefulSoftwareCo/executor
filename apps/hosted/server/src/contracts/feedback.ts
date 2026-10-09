import {
  Feedback,
  FeedbackDisabled,
  FeedbackUnavailable,
} from "@executor-js/telemetry/product-analytics";
import { Schema } from "effect";
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import { OrganizationReference, RequireOrganization } from "./organization.ts";

/** Organization members can submit feedback through a browser session or API authorization. */
export const HostedFeedback = HttpApiGroup.make("feedback")
  .add(
    HttpApiEndpoint.post("submit", "/api/organizations/:organization/feedback", {
      params: { organization: OrganizationReference },
      payload: Feedback,
      success: Schema.Struct({ status: Schema.Literal("accepted") }),
      error: [FeedbackUnavailable, FeedbackDisabled],
    })
      .annotate(OpenApi.Summary, "Submit feedback")
      .annotate(
        OpenApi.Description,
        "Send feedback about Executor to the Executor team. Returns accepted only after ingestion succeeds. Returns FeedbackDisabled when this instance has analytics turned off. Do not include credentials or other sensitive information.",
      ),
  )
  .middleware(RequireOrganization);
