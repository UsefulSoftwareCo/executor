import { HostedAppUi } from "@executor-js/hosted-server/app-ui/contracts";
import { HostedApi, hostedApiDocument } from "@executor-js/hosted-server/contracts";
import { RequestRejection } from "@executor-js/sdk/core";
import { OpenApi } from "effect/http-api";

/** Complete Executor Self-host API. Compose every self-host product endpoint here. */
export const ExecutorSelfHostApi = HostedApi.add(HostedAppUi)
  .middleware(RequestRejection)
  .annotate(OpenApi.Title, "Executor Self-host");

/** The exact product contract used by the router, published spec and generated Executor app. */
export const executorSelfHostApiDocument = (origin: string) =>
  hostedApiDocument(ExecutorSelfHostApi, origin, "executor-hosted");
