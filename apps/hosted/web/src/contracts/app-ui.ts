import { revalidated } from "@executor-js/ui/contracts/refresh";
import { browserOnly } from "@executor-js/ui/contracts/http";
import { organizationHttpClient } from "./organization-reference.ts";
/** Host-specific pages opt into the shared private-app browser contract. */
import {
  HostedAppUiApi,
  AppSignInFailure,
  AppSignInId,
} from "@executor-js/hosted-server/app-ui/contracts";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { AppId, AppSlug, DeploymentId } from "@executor-js/sdk";
import { Cause, Data, Effect, Match, Option, Schedule, Schema, Stream } from "effect";
import { Atom, AtomHttpApi } from "effect/reactivity";
import type { HttpApiEndpoint } from "effect/http-api";
import type { HttpClientError } from "effect/http";
import { DashboardRuntime } from "./telemetry.ts";
import { batchReads } from "@executor-js/dashboard-start/batch-browser";
import {
  observeBuild,
  outdatedPageMessage,
  pageOutdated,
} from "@executor-js/dashboard-start/build-change";

const batched = batchReads(HostedAppUiApi);

/**
 * This client is used only by products that mount private app pages. Its reads batch with the
 * page's others.
 */
export class AppUiClient extends AtomHttpApi.Service<AppUiClient>()("HostedAppUiClient", {
  api: HostedAppUiApi,
  httpClient: organizationHttpClient,
  runtime: DashboardRuntime,
  transformClient: (client) => batched(observeBuild(client)),
}) {}
class AppUiKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly slug: string;
  readonly app: AppId;
  readonly appSlug: AppSlug;
  readonly deployment: DeploymentId;
}> {}
const location = Atom.family((key: AppUiKey) =>
  // The open-app control polls deployment status; it loads after hydration.
  browserOnly(
    AppUiClient.runtime.atom(
      Stream.fromEffectSchedule(
        Effect.flatMap(AppUiClient, (client) =>
          client.appUi.location({ params: { organization: key.organization, app: key.app } }),
        ),
        Schedule.spaced("3 seconds"),
      ).pipe(Stream.takeUntil((location) => location.status !== "pending")),
    ),
  ).pipe(revalidated),
);
/** A stable, non-secret app link; opening it initiates authentication when needed. */
export const appUiLocationAtom = (key: ConstructorParameters<typeof AppUiKey>[0]) =>
  location(new AppUiKey(key));
/** The server resolves attempts; the page only sees a request on client navigation, or a failure. */
export const appUiSearch = (search: Record<string, unknown>) => ({
  request: Option.getOrUndefined(Schema.decodeUnknownOption(AppSignInId)(search.request)),
  failure: Option.getOrUndefined(Schema.decodeUnknownOption(AppSignInFailure)(search.failure)),
});
/** Why the server stopped an attempt, in the same words as other app errors. */
export const appSignInFailureMessage = (failure: AppSignInFailure) =>
  Match.value(failure).pipe(
    Match.when("ended", () => "This sign-in attempt ended. Open the app URL again."),
    Match.when("forbidden", () => "You do not have access to this app."),
    Match.when(
      "unavailable",
      () => "The app page is unavailable. Check its deployment and the server’s app URL settings.",
    ),
    Match.exhaustive,
  );
export { AppSignInFailure, AppSignInId };

/** Expected app authentication failures stay typed through the atom and view. */
export type AppUiError =
  | HttpApiEndpoint.Errors<
      (typeof HostedAppUiApi.groups.appUi.endpoints)[keyof typeof HostedAppUiApi.groups.appUi.endpoints]
    >
  | HttpClientError.HttpClientError
  | Schema.SchemaError
  | Cause.NoSuchElementError;
const message = Match.type<AppUiError>().pipe(
  Match.tagsExhaustive({
    NoSuchElementError: () => "App domain status is unavailable. Try again.",
    AppUiAddressInvalid: (error) =>
      Match.value(error.reason).pipe(
        Match.when(
          "too_long",
          () => "Shorten the team slug. The app domain is too long for this host.",
        ),
        Match.when(
          "invalid_slug",
          () => "Choose a different app name. Its generated address is not a valid hostname.",
        ),
        Match.exhaustive,
      ),
    OrganizationForbidden: () => "You do not have access to this app.",
    AppNotFound: () => "This app no longer exists.",
    AppNotDeployed: () => "Deploy this app before opening its page.",
    DeploymentNotFound: () => "This app’s deployment is no longer available. Reload the app.",
    StorageError: () => "Executor could not read this app. Try again.",
    AppUiUnavailable: () =>
      "The app page is unavailable. Check its deployment and the server’s app URL settings.",
    Unauthorized: () => "Your session ended. Sign in again.",
    Forbidden: () => "Open Executor from its configured address.",
    AuthenticationUnavailable: () => "Sign-in is temporarily unavailable.",
    HttpClientError: () =>
      pageOutdated() ? outdatedPageMessage : "Could not reach the server. Try again.",
    SchemaError: () =>
      pageOutdated() ? outdatedPageMessage : "The server returned an unexpected response.",
  }),
);
/** Display safe copy instead of arbitrary error or credential payloads. */
export const appUiError = (cause: Cause.Cause<AppUiError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: message,
    onNone: () => "The app could not open. Try again.",
  });
