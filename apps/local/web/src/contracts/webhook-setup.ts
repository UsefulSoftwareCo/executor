/** Private session-authenticated client; generated secrets remain redacted in query state. */
import { LocalWebhookSetupApi } from "@executor-js/local-server/webhook-setup";
import type { AppId, WebhookId } from "@executor-js/sdk";
import { Data, Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { Atom, AtomHttpApi } from "effect/unstable/reactivity";
import { webhookSetupAtoms } from "@executor-js/ui/contracts/webhook-setup";
import { DashboardRuntime } from "./telemetry.ts";
/** The browser supplies its existing pairing cookie; no agent token is accepted. */
export class WebhookSetupClient extends AtomHttpApi.Service<WebhookSetupClient>()(
  "WebhookSetupClient",
  { api: LocalWebhookSetupApi, httpClient: FetchHttpClient.layer, runtime: DashboardRuntime },
) {}
class SetupKey extends Data.Class<{ readonly app: AppId; readonly subscription: WebhookId }> {}
const family = Atom.family((params: SetupKey) =>
  webhookSetupAtoms(WebhookSetupClient.runtime, {
    read: Effect.flatMap(WebhookSetupClient, (client) => client.webhookSetup.read({ params })),
    complete: (payload) =>
      Effect.flatMap(WebhookSetupClient, (client) =>
        client.webhookSetup.complete({ params, payload }),
      ),
    remove: Effect.flatMap(WebhookSetupClient, (client) => client.webhookSetup.remove({ params })),
    confirmRemoval: Effect.flatMap(WebhookSetupClient, (client) =>
      client.webhookSetup.confirmRemoval({ params }),
    ),
  }),
);
/** Stable resource keys keep independent setup pages from superseding one another. */
export const localWebhookSetupAtoms = (app: AppId, subscription: WebhookId) =>
  family(new SetupKey({ app, subscription }));
