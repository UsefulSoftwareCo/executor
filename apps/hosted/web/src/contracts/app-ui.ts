import { organizationHttpClient } from "./organization-reference.ts";
/** Host-specific pages opt into the shared private-app browser contract. */
import { HostedAppUiApi, AppSignInId } from "@executor-js/hosted-server/app-ui/contracts";
import type { OrganizationReference } from "@executor-js/hosted-server/organization";
import type { AppId, AppSlug, DeploymentId } from "@executor-js/sdk";
import { Cause, Data, Effect, Match, Option, Schedule, Schema, Stream } from "effect";
import { Atom, AtomHttpApi } from "effect/unstable/reactivity";
import type { HttpApiEndpoint } from "effect/unstable/httpapi";
import type { HttpClientError } from "effect/unstable/http";
import { DashboardRuntime } from "./telemetry.ts";

/** This client is used only by products that mount private app pages. */
export class AppUiClient extends AtomHttpApi.Service<AppUiClient>()("HostedAppUiClient", {
  api: HostedAppUiApi,
  httpClient: organizationHttpClient,
  runtime: DashboardRuntime,
}) {}
class AppUiKey extends Data.Class<{
  readonly organization: OrganizationReference;
  readonly slug: string;
  readonly app: AppId;
  readonly appSlug: AppSlug;
  readonly deployment: DeploymentId;
}> {}
const location = Atom.family((key: AppUiKey) =>
  AppUiClient.runtime
    .atom(
      Stream.fromEffectSchedule(
        Effect.flatMap(AppUiClient, (client) =>
          client.appUi.location({ params: { organization: key.organization, app: key.app } }),
        ),
        Schedule.spaced("3 seconds"),
      ).pipe(Stream.takeUntil((location) => location.status !== "pending")),
    )
    .pipe(Atom.refreshOnWindowFocus),
);
/** A stable, non-secret app link; opening it initiates authentication when needed. */
export const appUiLocationAtom = (key: ConstructorParameters<typeof AppUiKey>[0]) =>
  location(new AppUiKey(key));
/** The dashboard's existing login authorizes a browser-bound attempt. */
export const authorizeAppUiAtom = AppUiClient.mutation("appUi", "authorize");
/** Preserve a validated request ID through the existing login redirect. */
export const appUiSearch = (search: Record<string, unknown>) => ({
  request: Option.getOrUndefined(Schema.decodeUnknownOption(AppSignInId)(search.request)),
});
export { AppSignInId };

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
    UiUnauthorized: () => "This sign-in attempt ended. Open the app URL again.",
    OrganizationForbidden: () => "You do not have access to this team.",
    UiForbidden: () => "You do not have access to this app.",
    UiFailed: (error) =>
      error.reason === "account_required"
        ? "Choose this app’s accounts before opening it."
        : "The app page is unavailable. Check its deployment and the server’s app URL settings.",
    Unauthorized: () => "Your session ended. Sign in again.",
    Forbidden: () => "Open Executor from its configured address.",
    AuthenticationUnavailable: () => "Sign-in is temporarily unavailable.",
    HttpClientError: () => "Could not reach the server. Try again.",
    SchemaError: () => "The server returned an unexpected response.",
  }),
);
/** Display safe copy instead of arbitrary error or credential payloads. */
export const appUiError = (cause: Cause.Cause<AppUiError>) =>
  Option.match(Cause.findErrorOption(cause), {
    onSome: message,
    onNone: () => "The app could not open. Try again.",
  });
