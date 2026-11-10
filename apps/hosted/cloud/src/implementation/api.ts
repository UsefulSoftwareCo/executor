import { billingHandlers } from "./billing.ts";
import { onboardingHandlers, setupHandlers } from "./onboarding-handlers.ts";
import { organizationRemovalHandlers } from "./organization-removal.ts";
import { userRemovalHandlers } from "./user-removal.ts";
import {
  hostedApiDocumentRoute,
  hostedHandlers,
  type LazyHostedApiDocument,
} from "@executor-js/hosted-server";
import { requestRejections } from "@executor-js/sdk/core";
import { Layer } from "effect";
import { layerWithBatches } from "@executor-js/dashboard-start/batch-host";
import { layerBuildHeader } from "@executor-js/dashboard-start/build-header";
import { ExecutorCloudApi } from "../contracts/api.ts";

/**
 * Register this host's complete API, the batch route for its dashboard reads, and one OpenAPI
 * document, generated when first requested. Every response names the server's build.
 */
export const cloudApi = (document: LazyHostedApiDocument) =>
  Layer.mergeAll(
    layerWithBatches(ExecutorCloudApi),
    hostedApiDocumentRoute(document),
    layerBuildHeader,
  ).pipe(
    Layer.provide(
      Layer.mergeAll(
        hostedHandlers,
        Layer.mergeAll(
          billingHandlers,
          onboardingHandlers,
          setupHandlers,
          organizationRemovalHandlers,
          userRemovalHandlers,
        ).pipe(Layer.provide(requestRejections)),
      ),
    ),
  );
