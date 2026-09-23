import { cloudSessionCookiePrefix } from "./browser.ts";
import { HostedAppUi } from "@executor-js/hosted-server/app-ui/contracts";
import { HostedApi, hostedApiDocument } from "@executor-js/hosted-server/contracts";
import { HostedOrganizationRemoval } from "@executor-js/hosted-server";
import { billingGroup } from "./billing.ts";
import { onboardingGroup } from "./onboarding.ts";
import { feedbackGroup } from "./feedback.ts";
import { OpenApi } from "effect/unstable/httpapi";

/** Complete Executor Cloud API. Compose every Cloud product endpoint here. */
export const ExecutorCloudApi = HostedApi.add(HostedAppUi, billingGroup)
  .add(onboardingGroup)
  .add(feedbackGroup)
  .add(HostedOrganizationRemoval)
  .annotate(OpenApi.Title, "Executor Cloud");

/** The exact product contract used by the router, published spec and generated Executor app. */
export const executorCloudApiDocument = (origin: string) =>
  hostedApiDocument(ExecutorCloudApi, origin, cloudSessionCookiePrefix(origin));
