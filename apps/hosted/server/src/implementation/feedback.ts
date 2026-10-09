import { Effect } from "effect";
import { HttpApiBuilder } from "effect/http-api";
import { HostedApi } from "../contracts/api.ts";
import { CurrentUserId } from "../contracts/auth.ts";
import { CurrentOrganization } from "../contracts/organization.ts";
import { ProductAnalytics } from "../contracts/product-analytics.ts";
import { FeedbackUnavailable } from "@executor-js/telemetry/product-analytics";

/** Send only the declared text, with identity from the authenticated request, and await ingestion. */
export const hostedFeedbackHandlers = HttpApiBuilder.group(HostedApi, "feedback", (handlers) =>
  Effect.succeed(
    handlers.handle("submit", ({ payload }) =>
      Effect.gen(function* () {
        const userId = yield* CurrentUserId;
        if (userId === undefined) return yield* new FeedbackUnavailable();
        const organization = yield* CurrentOrganization;
        const sink = yield* ProductAnalytics;
        yield* sink.submitFeedback({
          message: payload.message,
          userId,
          organizationId: organization.organization,
        });
        return { status: "accepted" as const };
      }),
    ),
  ),
);
