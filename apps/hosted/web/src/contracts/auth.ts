import { revalidated } from "@executor-js/ui/contracts/refresh";
import { signInCallback } from "./navigation.ts";
import { BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import { clearLastOrganization } from "../implementation/last-organization.ts";
import { LastOrganization } from "@executor-js/hosted-server/browser/contracts";
import { BrowserAtoms } from "./telemetry.ts";
import { traceHeaders } from "@executor-js/telemetry";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { grantSettingsHeader, type GrantSettings } from "@executor-js/mcp-auth/grants";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient } from "effect/http";
import { dashboardAuthClientOptions } from "@executor-js/ui/contracts/http";
import { AsyncResult, Atom } from "effect/reactivity";
import { acknowledgedQuery } from "@executor-js/ui/contracts/mutations";

const authClient = createAuthClient({
  ...dashboardAuthClientOptions,
  plugins: [organizationClient(), oauthProviderClient()],
});

export class AuthFailed extends Schema.TaggedError<AuthFailed>()("AuthFailed", {
  code: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  message: Schema.String,
}) {}

export const invalidEmailMessage = "Enter a valid email address, such as name@example.com.";

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

export const authCallOptions = Effect.gen(function* () {
  return { headers: yield* traceHeaders, customFetchImpl: yield* FetchHttpClient.Fetch };
});
export type AuthCallOptions = Effect.Success<typeof authCallOptions>;

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

export const HostedSession = BrowserSession;

const entrySession = Atom.make<Option.Option<BrowserSession>>(Option.none()).pipe(
  Atom.serializable({ key: "hosted:session", schema: Schema.Option(BrowserSession) }),
  Atom.keepAlive,
);

const liveSessionQuery = BrowserAtoms.atom(
  authRequest((options) => authClient.getSession({}, options)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HostedSession)),
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
export const sessionAtom = acknowledgedQuery(sessionQuery);
export const sessionInitialValues = (verified: BrowserSession) => [
  Atom.initialValue(entrySession, Option.some(verified)),
];

export const lastOrganizationAtom = Atom.make<LastOrganization | null>(null).pipe(
  Atom.serializable({ key: "hosted:last-organization", schema: Schema.NullOr(LastOrganization) }),
  Atom.keepAlive,
);

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

export const signOutAtom = BrowserAtoms.fn(() =>
  authRequest((options) => authClient.signOut({}, options)).pipe(
    Effect.withSpan("ui.auth.signOut"),
    Effect.tap(() =>
      Effect.sync(() => {
        clearLastOrganization();
        window.location.replace("/");
      }),
    ),
    Effect.asVoid,
  ),
);

export const accountOperations = (options: AuthCallOptions) => ({
  rename: (name: string) => authClient.updateUser({ name }, options),
  current: () => authClient.getSession({}, options),
  sessions: () => authClient.listSessions({}, options),
  revokeSession: (token: string) => authClient.revokeSession({ token }, options),
  revokeOtherSessions: () => authClient.revokeOtherSessions({}, options),
  changePassword: (input: { readonly currentPassword: string; readonly newPassword: string }) =>
    authClient.changePassword({ ...input, revokeOtherSessions: false }, options),
});

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
  acceptInvitation: (invitationId: string) =>
    authClient.organization.acceptInvitation({ invitationId }, options),
});

const decisionHeaders = (
  options: AuthCallOptions,
  input: {
    readonly accept: boolean;
    readonly organization: string | undefined;
    readonly settings: GrantSettings | undefined;
  },
) => ({
  ...options.headers,
  ...(!input.accept || input.organization === undefined
    ? {}
    : { "x-executor-organization": input.organization }),
  ...(!input.accept || input.settings === undefined
    ? {}
    : { [grantSettingsHeader]: JSON.stringify(input.settings) }),
});

export const mcpAuthorization = (options: AuthCallOptions) => ({
  client: (clientId: string) =>
    authClient.oauth2.publicClient({ query: { client_id: clientId } }, options),
  consent: (input: {
    readonly accept: boolean;
    readonly organization: string | undefined;
    readonly settings: GrantSettings | undefined;
    readonly query: string;
  }) =>
    authClient.oauth2.consent(
      { accept: input.accept, oauth_query: input.query },
      { ...options, headers: decisionHeaders(options, input) },
    ),
  deviceRequest: (userCode: string) =>
    authClient.$fetch<unknown>("/device/request", {
      ...options,
      method: "GET",
      query: { user_code: userCode },
    }),
  decideDevice: (input: {
    readonly userCode: string;
    readonly accept: boolean;
    readonly organization: string | undefined;
    readonly settings: GrantSettings | undefined;
  }) =>
    authClient.$fetch<unknown>("/device/decide", {
      ...options,
      method: "POST",
      body: { user_code: input.userCode, accept: input.accept },
      headers: decisionHeaders(options, input),
    }),
});

export const clearSessionDisplay = clearLastOrganization;
