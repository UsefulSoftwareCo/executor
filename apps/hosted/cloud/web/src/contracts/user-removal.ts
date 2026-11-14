/** Deleting your own user is a cloud capability; self-host operators manage their users. */
import { hydrated } from "@executor-js/ui/contracts/http";
import { revalidated } from "@executor-js/ui/contracts/refresh";
import { Cause, Effect, Match, Option, type Schema } from "effect";
import type { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import type { HttpClientError } from "effect/http";
import { ExecutorCloudApi } from "../../../src/contracts/api.ts";
import { CloudClient } from "./billing.ts";

type Removal = HttpApiGroup.Endpoints<(typeof ExecutorCloudApi.groups)["userRemoval"]>;
/** The precise failures this one destructive request can produce. */
export type UserRemovalError =
  | HttpApiEndpoint.Errors<Removal>
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

const fallback = "Your account could not be deleted. Try again.";
const message = Match.type<UserRemovalError>().pipe(
  Match.tags({
    // Each of these already names what to do next, without exposing anything private.
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
/** Safe copy for the delete dialog; defects never render their raw cause. */
export const userRemovalError = (cause: Cause.Cause<UserRemovalError>) =>
  Option.match(Cause.findErrorOption(cause), { onSome: message, onNone: () => fallback });

/** What deleting the user does to each organization, read when the settings page opens. */
export const userRemovalPreviewAtom = CloudClient.query(
  "userRemoval",
  "preview",
  hydrated({}),
).pipe(revalidated);

/** The user's sessions end with it, so the caller leaves the dashboard after it succeeds. */
export const deleteUserAtom = CloudClient.runtime.fn<void>()(() =>
  Effect.flatMap(CloudClient, (client) => client.userRemoval.remove()),
);
