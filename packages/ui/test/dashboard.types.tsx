/** Compile-only checks: shared views must not widen an operation's errors to fit its renderer. */
import type { Atom } from "effect/unstable/reactivity";
import { Schema, type Exit } from "effect";
import type { App, Provider, OAuthClientSetup } from "@executor-js/sdk";
import { UserFacingError } from "@executor-js/utils/user-facing-error";
import type { ImportedApp } from "@executor-js/catalog/contracts";
import type { AccountSubmission, OAuthSubmission } from "../src/contracts/credentials.ts";
import type { FailureProps, InstallApp, Query } from "../src/contracts/dashboard.ts";
import { QueryView } from "../src/implementation/dashboard/context.tsx";
import { CatalogInstall } from "../src/implementation/dashboard/catalog.tsx";
import { AccountForm } from "../src/implementation/dashboard/account-form.tsx";
import { OAuthFields, OAuthSetup } from "../src/implementation/dashboard/oauth-fields.tsx";

class Denied extends Schema.TaggedError<Denied>()("Denied", {}) {}
class SessionEnded extends Schema.TaggedError<SessionEnded>()("SessionEnded", {}) {}
const SetupUnavailable = UserFacingError.define({
  tag: "SetupUnavailable",
  status: 503,
  title: "Setup unavailable",
  description: "Setup could not complete.",
  recovery: { action: "Try again.", instructions: "Check the setup service." },
});
function checkSetupErrors(
  complete: Query<OAuthClientSetup, typeof SetupUnavailable.Type>,
  missingPresentation: Query<OAuthClientSetup, Denied | typeof SetupUnavailable.Type>,
) {
  OAuthSetup({ query: complete, children: () => null });
  // @ts-expect-error Every expected setup error must own its presentation.
  OAuthSetup({ query: missingPresentation, children: () => null });
}
type Errors = Denied | SessionEnded;
const Failure = (_props: FailureProps<Errors>) => null;
const IncompleteFailure = (_props: FailureProps<Denied>) => null;

function checkQueries(query: Query<string, Errors>) {
  QueryView({ query, Failure, children: (value) => value.toUpperCase() });
  // @ts-expect-error The renderer omits SessionEnded; E must come from the query.
  QueryView({ query, Failure: IncompleteFailure, children: (value) => value });
}

function checkMutations(
  mutation: Atom.AtomResultFn<InstallApp, ImportedApp, Errors>,
  entry: Parameters<typeof CatalogInstall>[0]["entry"],
) {
  CatalogInstall({
    mutation,
    Failure,
    entry,
    onBack: () => {},
    onInstalled: (app) => {
      app.id;
    },
  });
  CatalogInstall({
    mutation,
    // @ts-expect-error Mutation failure rendering must handle both error cases.
    Failure: IncompleteFailure,
    entry,
    onBack: () => {},
    onInstalled: () => {},
  });
}

function checkForms(
  provider: Provider,
  submit: (input: AccountSubmission) => Promise<Exit.Exit<App, Errors>>,
  start: (input: OAuthSubmission) => Promise<Exit.Exit<string, Errors>>,
) {
  AccountForm({
    provider,
    submit,
    Failure,
    submitLabel: "Connect",
    onSaved: (app) => {
      app.id;
    },
    oauth: () => null,
  });
  AccountForm({
    provider,
    submit,
    // @ts-expect-error Callback-based forms must preserve the submission's error type too.
    Failure: IncompleteFailure,
    submitLabel: "Connect",
    onSaved: () => {},
    oauth: () => null,
  });
  OAuthFields({
    providerName: "Example",
    setup: "unresolved",
    redirectUri: "https://example.com/callback",
    start,
    Failure,
    requiresClient: () => false,
    onAuthorized: (value) => {
      value.toUpperCase();
    },
  });
  OAuthFields({
    providerName: "Example",
    setup: "unresolved",
    redirectUri: "https://example.com/callback",
    start,
    // @ts-expect-error OAuth start failures cannot be narrowed by the renderer.
    Failure: IncompleteFailure,
    requiresClient: () => false,
    onAuthorized: () => {},
  });
}
