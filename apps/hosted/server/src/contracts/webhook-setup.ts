import { HttpApiGroup, HttpApiEndpoint } from "effect/http-api";
import {
  CompleteWebhookSetup,
  WebhookErrors,
  WebhookSetupView,
  WebhookSubscription,
  WebhookTarget,
} from "@executor-js/sdk/core";
import { OrganizationReference, OrganizationForbidden } from "./organization.ts";
import { RequireBrowserSession } from "./auth.ts";
const params = { organization: OrganizationReference, ...WebhookTarget.fields };
const path = "/api/organizations/:organization/webhook-setup/:app/:subscription";
export const HostedWebhookSetup = HttpApiGroup.make("webhookSetup")
  .add(
    HttpApiEndpoint.get("read", path, {
      params,
      success: WebhookSetupView,
      error: [...WebhookErrors, OrganizationForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("complete", path, {
      params,
      payload: CompleteWebhookSetup.mapFields(
        ({ app: _app, subscription: _subscription, ...fields }) => fields,
      ),
      success: WebhookSubscription,
      error: [...WebhookErrors, OrganizationForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.delete("remove", path, {
      params,
      success: WebhookSubscription,
      error: [...WebhookErrors, OrganizationForbidden],
    }),
  )
  .add(
    HttpApiEndpoint.post("confirmRemoval", `${path}/confirm-removal`, {
      params,
      success: WebhookSubscription,
      error: [...WebhookErrors, OrganizationForbidden],
    }),
  )
  .middleware(RequireBrowserSession);
