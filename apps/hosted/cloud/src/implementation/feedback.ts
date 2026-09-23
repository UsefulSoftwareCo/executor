import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ExecutorCloudApi } from "../contracts/api.ts";
import { submitFeedback } from "./product-analytics.ts";

/** Authenticate through the API middleware, then await PostHog before acknowledging feedback. */
export const feedbackHandlers = HttpApiBuilder.group(ExecutorCloudApi, "feedback", (handlers) =>
  Effect.succeed(
    handlers.handle("submit", ({ payload }) =>
      submitFeedback(payload).pipe(Effect.as({ status: "accepted" as const })),
    ),
  ),
);
