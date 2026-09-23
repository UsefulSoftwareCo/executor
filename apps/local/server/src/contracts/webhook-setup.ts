/** Local setup separates the agent's link operation from cookie-only secret exchange. */
import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiMiddleware,
  OpenApi,
} from "effect/unstable/httpapi";
import {
  CompleteWebhookSetup,
  HttpUrl,
  WebhookErrors,
  WebhookSetupView,
  WebhookSubscription,
  WebhookTarget,
} from "@executor-js/sdk/core";
import { AuthForbidden, AuthStorageError, PairingUnauthorized } from "./auth.ts";
import { DashboardUnauthorized } from "./dashboard.ts";
/** Browser cookies alone authorize secret reads; API keys can issue only setup links. */
export class WebhookSetupAccess extends HttpApiMiddleware.Service<WebhookSetupAccess>()(
  "local/WebhookSetupAccess",
  { error: [AuthForbidden, AuthStorageError, DashboardUnauthorized] },
) {}
/** The product owns these routes. They are outside ExecutorApi and its generated management surface. */
export const LocalWebhookSetupApi = HttpApi.make("local-webhook-setup")
  .add(
    HttpApiGroup.make("webhookLinks").add(
      HttpApiEndpoint.get("link", "/webhook-setup/api/:app/:subscription/link", {
        params: WebhookTarget.fields,
        success: Schema.Struct({ url: HttpUrl }),
        error: [...WebhookErrors, AuthForbidden, PairingUnauthorized],
      }).annotate(
        OpenApi.Description,
        "Get the secure browser setup link for a manual webhook. Show this link to the user; never ask them to paste secrets into chat.",
      ),
    ),
  )
  .add(
    HttpApiGroup.make("webhookSetup")
      .add(
        HttpApiEndpoint.get("read", "/webhook-setup/api/:app/:subscription", {
          params: WebhookTarget.fields,
          success: WebhookSetupView,
          error: WebhookErrors,
        }),
      )
      .add(
        HttpApiEndpoint.post("complete", "/webhook-setup/api/:app/:subscription", {
          params: WebhookTarget.fields,
          payload: CompleteWebhookSetup.mapFields(
            ({ app: _app, subscription: _subscription, ...fields }) => fields,
          ),
          success: WebhookSubscription,
          error: WebhookErrors,
        }),
      )
      .add(
        HttpApiEndpoint.delete("remove", "/webhook-setup/api/:app/:subscription", {
          params: WebhookTarget.fields,
          success: WebhookSubscription,
          error: WebhookErrors,
        }),
      )
      .add(
        HttpApiEndpoint.post(
          "confirmRemoval",
          "/webhook-setup/api/:app/:subscription/confirm-removal",
          { params: WebhookTarget.fields, success: WebhookSubscription, error: WebhookErrors },
        ),
      )
      .middleware(WebhookSetupAccess),
  );
