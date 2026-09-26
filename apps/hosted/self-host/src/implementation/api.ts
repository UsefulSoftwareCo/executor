import {
  hostedApiDocumentRoute,
  hostedHandlers,
  type LazyHostedApiDocument,
} from "@executor-js/hosted-server";
import { Layer } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ExecutorSelfHostApi } from "../contracts/api.ts";

/** Register this host's complete API and one OpenAPI document, generated when first requested. */
export const selfHostApi = (document: LazyHostedApiDocument) =>
  Layer.mergeAll(HttpApiBuilder.layer(ExecutorSelfHostApi), hostedApiDocumentRoute(document)).pipe(
    Layer.provide(hostedHandlers),
  );
