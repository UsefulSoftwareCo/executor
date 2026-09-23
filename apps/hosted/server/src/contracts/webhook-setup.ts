/** Cookie-only setup is documented in OpenAPI; bearer accounts cannot satisfy its session requirement. */
import { HttpApiGroup, HttpApiEndpoint } from "effect/unstable/httpapi";
import {
  CompleteWebhookSetup,
  WebhookErrors,
  WebhookSetupView,
  WebhookSubscription,
  WebhookTarget,
} from "@executor-js/sdk/core";
import { OrganizationReference, OrganizationForbidden } from "./organization.ts";
import { RequireUser } from "./auth.ts";
const params = { organization: OrganizationReference, ...WebhookTarget.fields };
const path = "/api/organizations/:organization/webhook-setup/:app/:subscription";
/** Current browser identity, organization membership, and admin role are checked before accessing secrets. */
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
  .middleware(RequireUser);
