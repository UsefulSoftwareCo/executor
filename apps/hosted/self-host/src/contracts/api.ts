import { HostedAppUi } from "@executor-js/hosted-server/app-ui/contracts";
import { HostedApi, hostedApiDocument } from "@executor-js/hosted-server/contracts";
import { RequestRejection } from "@executor-js/sdk/core";
import { OpenApi } from "effect/http-api";

export const ExecutorSelfHostApi = HostedApi.add(HostedAppUi)
  .middleware(RequestRejection)
  .annotate(OpenApi.Title, "Executor Self-host");

export const executorSelfHostApiDocument = (origin: string) =>
  hostedApiDocument(ExecutorSelfHostApi, origin, "executor-hosted");
