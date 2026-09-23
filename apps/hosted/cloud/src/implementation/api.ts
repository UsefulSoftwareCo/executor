import { billingHandlers } from "./billing.ts";
import { feedbackHandlers } from "./feedback.ts";
import { onboardingHandlers } from "./onboarding-handlers.ts";
import { organizationRemovalHandlers } from "./organization-removal.ts";
import { hostedHandlers } from "@executor-js/hosted-server";
import { Effect, Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import type { HostedApiDocument } from "@executor-js/hosted-server/contracts";
import { ExecutorCloudApi } from "../contracts/api.ts";

/** Register this host's complete API and one OpenAPI document. */
export const cloudApi = (document: HostedApiDocument) =>
  Layer.mergeAll(
    HttpApiBuilder.layer(ExecutorCloudApi),
    HttpRouter.add("GET", "/openapi.json", Effect.succeed(HttpServerResponse.jsonUnsafe(document))),
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        hostedHandlers,
        billingHandlers,
        feedbackHandlers,
        onboardingHandlers,
        organizationRemovalHandlers,
      ),
    ),
  );
