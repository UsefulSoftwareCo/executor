/** Organization-keyed setup bindings use the private cookie routes on the shared hosted client. */
import { Data, Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";
import { AppId, WebhookId } from "@executor-js/sdk";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import { webhookSetupAtoms } from "@executor-js/ui/contracts/webhook-setup";
import { HostedClient } from "./api.ts";
class SetupKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly app: AppId;
  readonly subscription: WebhookId;
}> {}
const family = Atom.family((params: SetupKey) =>
  webhookSetupAtoms(HostedClient.runtime, {
    read: Effect.flatMap(HostedClient, (client) => client.webhookSetup.read({ params })),
    complete: (payload) =>
      Effect.flatMap(HostedClient, (client) => client.webhookSetup.complete({ params, payload })),
    remove: Effect.flatMap(HostedClient, (client) => client.webhookSetup.remove({ params })),
    confirmRemoval: Effect.flatMap(HostedClient, (client) =>
      client.webhookSetup.confirmRemoval({ params }),
    ),
  }),
);
/** An organization is always supplied by the page's URL boundary. */
export const hostedWebhookSetupAtoms = (
  organization: OrganizationReference,
  app: string,
  subscription: string,
) =>
  family(
    new SetupKey({
      organization,
      app: AppId.make(app),
      subscription: WebhookId.make(subscription),
    }),
  );
