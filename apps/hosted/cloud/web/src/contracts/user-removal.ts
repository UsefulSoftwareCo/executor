import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { Cause, Effect, Match, Option, type Schema } from "effect";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import type { HttpClientError } from "effect/http";
import { ExecutorCloudApi } from "../../../src/contracts/api.ts";
import { CloudClient } from "./billing.ts";

type Removal = HttpApiGroup.Endpoints<(typeof ExecutorCloudApi.groups)["userRemoval"]>;
export type UserRemovalError =
  | HttpApiEndpoint.Errors<Removal>
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

const fallback = "Your account could not be deleted. Try again.";
const message = Match.type<UserRemovalError>().pipe(
  Match.tags({
    UserRemovalBlocked: (error) => error.message,
    AccountLinkedToApp: () =>
      "One of your accounts is linked to an app for everyone. Unlink it from the app, then delete your account.",
    AccountWebhooksActive: () =>
      "A webhook subscription still uses one of your accounts. Remove it, then delete your account.",
    AppWorkflowsActive: () =>
      "A workflow is still running in an organization you are deleting. Wait for it to finish, then try again.",
    AccountWorkflowsActive: () =>
      "A running workflow is still using one of your accounts. Wait for it to finish, then try again.",
    OrganizationRemovalUnavailable: () => "Deletion is unavailable right now. Try again shortly.",
    AuthenticationUnavailable: () => "Sign-in is unavailable. Try again shortly.",
    Unauthorized: () => "Your session has ended. Sign in again, then delete your account.",
    HttpClientError: () => "Could not reach the server. Check your connection and try again.",
  }),
  Match.orElse(() => fallback),
);
export const userRemovalError = (cause: Cause.Cause<UserRemovalError>) =>
  Option.match(Cause.findErrorOption(cause), { onSome: message, onNone: () => fallback });

export const userRemovalPreviewAtom = CloudClient.query(
  "userRemoval",
  "preview",
  hydrated({}),
).pipe(revalidated);

export const deleteUserAtom = CloudClient.runtime.fn<void>()(() =>
  Effect.flatMap(CloudClient, (client) => client.userRemoval.remove()),
);
