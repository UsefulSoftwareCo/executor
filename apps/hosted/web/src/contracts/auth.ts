import { revalidated } from "@executor-js/ui/contracts/refresh";
import { signInCallback } from "./navigation.ts";
import { BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import { clearLastOrganization } from "../implementation/last-organization.ts";
import { LastOrganization } from "@executor-js/hosted-server/browser/contracts";
import { BrowserAtoms } from "./telemetry.ts";
import { traceHeaders } from "@executor-js/telemetry";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { dashboardAuthClientOptions } from "@executor-js/ui/contracts/http";
import { AsyncResult, Atom } from "effect/reactivity";
import { acknowledgedQuery } from "@executor-js/ui/contracts/mutations";

/**
 * Keep library methods private; organization calls below require explicit targets. Server
 * rendering has no page origin, so it addresses the host in-process; see `authRequest`.
 */
const authClient = createAuthClient({
  ...dashboardAuthClientOptions,
  plugins: [organizationClient(), oauthProviderClient()],
});

/** Safe auth diagnostics retain the provider code/status, never its raw message or response. */
export class AuthFailed extends Schema.TaggedError<AuthFailed>()("AuthFailed", {
  code: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  message: Schema.String,
}) {}

/** Shown for an address the server cannot accept, whether the form or the server notices first. */
export const invalidEmailMessage = "Enter a valid email address, such as name@example.com.";

/** Whether an address has a mailbox and a dotted domain, as the server requires. */
export const plausibleEmail = (email: string) => /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/u.test(email);

const authMessage = (code: string | undefined, status: number): string => {
  if (status === 429 || code === "TOO_MANY_ATTEMPTS")
    return "Too many attempts. Wait a minute and try again.";
  if (code === "OTP_EXPIRED") return "This code has expired. Request a new code.";
  if (code === "INVALID_OTP") return "This code is incorrect. Check the code and try again.";
  if (code === "INVALID_EMAIL") return invalidEmailMessage;
  if (code === "INVALID_EMAIL_OR_PASSWORD") return "Email or password is incorrect. Try again.";
  if (code === "SSO_NOT_CONFIGURED")
    return "SSO is not available for this email domain. Check your work email or contact your administrator.";
  if (code === "SSO_DOMAIN_AMBIGUOUS")
    return "More than one SSO connection uses this email domain. Contact your administrator for help signing in.";
  if (status === 401) return "Authentication failed. Start sign-in again.";
  if (status === 403)
    return "Access was denied. Check your invitation or contact an administrator.";
  return "Something went wrong. Check your details and try again.";
};

/**
 * Options for every Better Auth call: trace propagation, and the runtime's fetch so a server
 * render reaches the API in-process with the page request's identity.
 */
export const authCallOptions = Effect.gen(function* () {
  return { headers: yield* traceHeaders, customFetchImpl: yield* FetchHttpClient.Fetch };
});
export type AuthCallOptions = Effect.Success<typeof authCallOptions>;

/** Convert library responses to Effect failures while preserving safe machine-readable fields. */
export const authRequest = <A>(
  run: (
    options: AuthCallOptions,
  ) => Promise<
    { data: A; error: null } | { data: null; error: { code?: string | undefined; status: number } }
  >,
) =>
  authCallOptions
    .pipe(
      Effect.flatMap((options) =>
        Effect.tryPromise({
          try: () => run(options),
          catch: () =>
            new AuthFailed({
              message: "Cannot reach the server. Check your connection and try again.",
            }),
        }),
      ),
    )
    .pipe(
      Effect.flatMap((result) =>
        result.error === null
          ? Effect.succeed(result.data)
          : Effect.fail(
              new AuthFailed({
                ...(result.error.code === undefined ? {} : { code: result.error.code }),
                status: result.error.status,
                message: authMessage(result.error.code, result.error.status),
              }),
            ),
      ),
    );

/** Browser identity deliberately excludes library session preferences and tokens. */
export const HostedSession = BrowserSession;

/** A server-verified session; server-rendered documents send it to the browser with the page. */
const entrySession = Atom.make<Option.Option<BrowserSession>>(Option.none()).pipe(
  Atom.serializable({ key: "hosted:session", schema: Schema.Option(BrowserSession) }),
  Atom.keepAlive,
);

/** Revalidate in the background; only the HTTP endpoint can renew the real session cookie. */
const liveSessionQuery = BrowserAtoms.atom(
  authRequest((options) => authClient.getSession({}, options)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HostedSession)),
    // A confirmed missing session also forgets where that person last worked.
    Effect.tap((session) => Effect.sync(() => session === null && clearLastOrganization())),
    Effect.withSpan("ui.auth.session"),
  ),
).pipe(Atom.keepAlive);
const sessionQuery = Atom.readable(
  (get) => {
    const entry = get(entrySession);
    return Option.isSome(entry)
      ? AsyncResult.success<BrowserSession, AuthFailed | Schema.SchemaError>(entry.value)
      : get(liveSessionQuery);
  },
  (refresh) => {
    refresh(entrySession);
    refresh(liveSessionQuery);
  },
).pipe(revalidated);
/** The server-verified session, revalidated by the browser; APIs enforce authorization. */
export const sessionAtom = acknowledgedQuery(sessionQuery);
/** Server rendering starts from the session it verified for this request. */
export const sessionInitialValues = (verified: BrowserSession) => [
  Atom.initialValue(entrySession, Option.some(verified)),
];

/** Where this person last worked, read by the server for this document. */
export const lastOrganizationAtom = Atom.make<LastOrganization | null>(null).pipe(
  Atom.serializable({ key: "hosted:last-organization", schema: Schema.NullOr(LastOrganization) }),
  Atom.keepAlive,
);

/** Better Auth creates the OAuth state and redirects to the chosen provider. */
export const signInAtom = BrowserAtoms.fn(
  (input: { provider: "google" | "github" | "openai"; redirect: string }) =>
    authRequest((options) =>
      authClient.signIn.social(
        {
          provider: input.provider,
          callbackURL: signInCallback(input.redirect),
          errorCallbackURL: `/login?redirect=${encodeURIComponent(input.redirect)}`,
        },
        input.provider === "openai"
          ? { ...options, headers: { ...options.headers, "x-skip-oauth-proxy": "true" } }
          : options,
      ),
    ).pipe(Effect.withSpan("ui.auth.signIn"), Effect.asVoid),
);

/** Revoke the session, then load the public root without an auth-return URL. */
export const signOutAtom = BrowserAtoms.fn(() =>
  authRequest((options) => authClient.signOut({}, options)).pipe(
    Effect.withSpan("ui.auth.signOut"),
    // The root response selects the public document after the cookie is cleared.
    // Refreshing the private route first would send it back to login with a return URL.
    Effect.tap(() =>
      Effect.sync(() => {
        clearLastOrganization();
        window.location.replace("/");
      }),
    ),
    Effect.asVoid,
  ),
);

/** Personal account operations; every one of them acts on the signed-in user only. */
export const accountOperations = (options: AuthCallOptions) => ({
  rename: (name: string) => authClient.updateUser({ name }, options),
  current: () => authClient.getSession({}, options),
  sessions: () => authClient.listSessions({}, options),
  revokeSession: (token: string) => authClient.revokeSession({ token }, options),
  revokeOtherSessions: () => authClient.revokeOtherSessions({}, options),
  changePassword: (input: { readonly currentPassword: string; readonly newPassword: string }) =>
    authClient.changePassword({ ...input, revokeOtherSessions: false }, options),
});

/** Only explicit organization operations are available to dashboard contracts. */
export const organizationOperations = (options: AuthCallOptions) => ({
  list: () => authClient.organization.list({}, options),
  create: (input: { readonly name: string; readonly slug: string }) =>
    authClient.organization.create({ ...input, keepCurrentActiveOrganization: true }, options),
  members: (organizationId: OrganizationId, offset: number) =>
    authClient.organization.listMembers(
      { query: { organizationId, limit: 100, offset, sortBy: "id", sortDirection: "asc" } },
      options,
    ),
  invitations: (organizationId: OrganizationId) =>
    authClient.organization.listInvitations({ query: { organizationId } }, options),
  invite: (input: {
    readonly organizationId: OrganizationId;
    readonly email: string;
    readonly role: "admin" | "member";
  }) => authClient.organization.inviteMember({ ...input, resend: true }, options),
  revokeInvitation: (invitationId: string) =>
    authClient.organization.cancelInvitation({ invitationId }, options),
  removeMember: (input: {
    readonly organizationId: OrganizationId;
    readonly memberIdOrEmail: string;
  }) => authClient.organization.removeMember(input, options),
  rename: (input: { readonly organizationId: OrganizationId; readonly name: string }) =>
    authClient.organization.update(
      { organizationId: input.organizationId, data: { name: input.name } },
      options,
    ),
  changeSlug: (input: { readonly organizationId: OrganizationId; readonly slug: string }) =>
    authClient.organization.update(
      { organizationId: input.organizationId, data: { slug: input.slug } },
      options,
    ),
  changeLogo: (input: { readonly organizationId: OrganizationId; readonly logo: string | null }) =>
    authClient.organization.update(
      { organizationId: input.organizationId, data: { logo: input.logo } },
      options,
    ),
  updateMemberRole: (input: {
    readonly organizationId: OrganizationId;
    readonly memberId: string;
    readonly role: "admin" | "member";
  }) => authClient.organization.updateMemberRole(input, options),
  // The verified invitation identifies its organization.
  acceptInvitation: (invitationId: string) =>
    authClient.organization.acceptInvitation({ invitationId }, options),
});

/** Consent uses its explicit selected organization, never a shared session field. */
export const mcpAuthorization = (options: AuthCallOptions) => ({
  client: (clientId: string) =>
    authClient.oauth2.publicClient({ query: { client_id: clientId } }, options),
  /** A scoped connection already names its organization, so its consent omits the choice. */
  consent: (input: {
    readonly accept: boolean;
    readonly organization: string | undefined;
    readonly query: string;
  }) =>
    authClient.oauth2.consent(
      { accept: input.accept, oauth_query: input.query },
      {
        ...options,
        headers: {
          ...options.headers,
          ...(input.organization === undefined
            ? {}
            : { "x-executor-organization": input.organization }),
        },
      },
    ),
});

/** Discard the previous identity and destination before a full-page session switch. */
export const clearSessionDisplay = clearLastOrganization;
