import { cloudSessionCookiePrefix } from "./browser.ts";
import { HostedAppUi } from "@executor-js/hosted-server/app-ui/contracts";
import { HostedApi, hostedApiDocument } from "@executor-js/hosted-server/contracts";
import { HostedOrganizationRemoval, HostedUserRemoval } from "@executor-js/hosted-server";
import { billingGroup } from "./billing.ts";
import { onboardingGroup, setupGroup } from "./onboarding.ts";
import { RequestRejection } from "@executor-js/sdk/core";
import { OpenApi } from "effect/http-api";

export const ExecutorCloudApi = HostedApi.add(HostedAppUi, billingGroup)
  .add(onboardingGroup)
  .add(setupGroup)
  .add(HostedOrganizationRemoval)
  .add(HostedUserRemoval)
  .middleware(RequestRejection)
  .annotate(OpenApi.Title, "Executor Cloud");

export const executorCloudApiDocument = (origin: string) =>
  hostedApiDocument(ExecutorCloudApi, origin, cloudSessionCookiePrefix(origin));
