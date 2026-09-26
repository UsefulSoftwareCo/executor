import { billingHandlers } from "./billing.ts";
import { feedbackHandlers } from "./feedback.ts";
import { onboardingHandlers } from "./onboarding-handlers.ts";
import { organizationRemovalHandlers } from "./organization-removal.ts";
import {
  hostedApiDocumentRoute,
  hostedHandlers,
  type LazyHostedApiDocument,
} from "@executor-js/hosted-server";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ExecutorCloudApi } from "../contracts/api.ts";

/** Register this host's complete API and one OpenAPI document, generated when first requested. */
export const cloudApi = (document: LazyHostedApiDocument) =>
  Layer.mergeAll(HttpApiBuilder.layer(ExecutorCloudApi), hostedApiDocumentRoute(document)).pipe(
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
