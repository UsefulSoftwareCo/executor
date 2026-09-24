import { signInCallback } from "./navigation.ts";
import { BrowserSession } from "@executor-js/hosted-server/browser/contracts";
import {
  clearSessionHint,
  readSessionHint,
  writeSessionHint,
} from "../implementation/session-hint.ts";
import { BrowserAtoms } from "./telemetry.ts";
import { traceHeaders } from "@executor-js/telemetry";
import type { OrganizationId } from "@executor-js/hosted-server/organization";
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { createAuthClient } from "better-auth/client";
import { organizationClient } from "better-auth/client/plugins";
import { Effect, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { acknowledgedQuery } from "@executor-js/ui/contracts/mutations";

/** Keep library methods private; organization calls below require explicit targets. */
const authClient = createAuthClient({ plugins: [organizationClient(), oauthProviderClient()] });

/** Safe auth diagnostics retain the provider code/status, never its raw message or response. */
export class AuthFailed extends Schema.TaggedError<AuthFailed>()("AuthFailed", {
  code: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  message: Schema.String,
}) {}

const authMessage = (code: string | undefined, status: number): string => {
  if (status === 429 || code === "TOO_MANY_ATTEMPTS")
    return "Too many attempts. Wait a minute and try again.";
  if (code === "OTP_EXPIRED") return "This sign-in code has expired. Request a new code.";
  if (code === "INVALID_OTP")
    return "This sign-in code is incorrect. Check the code and try again.";
  if (code === "INVALID_EMAIL_OR_PASSWORD") return "Email or password is incorrect. Try again.";
  if (code === "SSO_NOT_CONFIGURED")
    return "SSO is not available for this email domain. Check your work email or contact your administrator.";
  if (code === "SSO_DOMAIN_AMBIGUOUS")
    return "More than one SSO connection uses this email domain. Contact your administrator for help signing in.";
  if (status === 401) return "Authentication failed. Start sign-in again.";
  if (status === 403)
    return "Access was denied. Check your invitation or contact an administrator.";
  return "Unable to complete sign-in. Check your details and try again.";
};

/** Convert library responses to Effect failures while preserving safe machine-readable fields. */
export const authRequest = <A>(
  run: (options: {
    headers: Readonly<Record<string, string>>;
  }) => Promise<
    { data: A; error: null } | { data: null; error: { code?: string | undefined; status: number } }
  >,
) =>
  Effect.flatMap(traceHeaders, (headers) =>
    Effect.tryPromise({
      try: () => run({ headers }),
      catch: () =>
        new AuthFailed({
          message: "Cannot reach the server. Check your connection and try again.",
        }),
    }),
  ).pipe(
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

const entrySession = Atom.make<Option.Option<BrowserSession>>(Option.none()).pipe(Atom.keepAlive);

const initialSessionHint = Atom.make<Option.Option<typeof HostedSession.Type>>(Option.none()).pipe(
  Atom.keepAlive,
);
/** Revalidate in the background; only the HTTP endpoint can renew the real session cookie. */
const liveSessionQuery = BrowserAtoms.atom(
  authRequest((options) => authClient.getSession({}, options)).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(HostedSession)),
    Effect.tap((session) => Effect.sync(() => writeSessionHint(session))),
    Effect.withSpan("ui.auth.session"),
  ),
).pipe(Atom.keepAlive);
const sessionQuery = Atom.readable(
  (get) => {
    const entry = get(entrySession);
    if (Option.isSome(entry))
      return AsyncResult.success<BrowserSession, AuthFailed | Schema.SchemaError>(entry.value);
    const live = get(liveSessionQuery);
    const hint = get(initialSessionHint);
    return AsyncResult.isInitial(live) && Option.isSome(hint)
      ? AsyncResult.waiting(
          AsyncResult.success<typeof HostedSession.Type, AuthFailed | Schema.SchemaError>(
            hint.value,
          ),
        )
      : live;
  },
  (refresh) => {
    refresh(entrySession);
    refresh(liveSessionQuery);
  },
).pipe(Atom.refreshOnWindowFocus);
/** Optimistic display identity; live results replace the hint and APIs enforce authorization. */
export const sessionAtom = acknowledgedQuery(sessionQuery);
/** Seed a server-verified entry response, or use the display hint while ordinary pages revalidate. */
export const sessionInitialValues = (verified?: BrowserSession) =>
  verified === undefined
    ? [Atom.initialValue(initialSessionHint, readSessionHint())]
    : [Atom.initialValue(entrySession, Option.some(verified))];

/** Better Auth creates the OAuth state and redirects to the chosen provider. */
export const signInAtom = BrowserAtoms.fn(
  (input: { provider: "google" | "github"; redirect: string }) =>
    authRequest((options) =>
      authClient.signIn.social(
        {
          provider: input.provider,
          callbackURL: signInCallback(input.redirect),
          errorCallbackURL: `/login?redirect=${encodeURIComponent(input.redirect)}`,
        },
        options,
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
        clearSessionHint();
        window.location.replace("/");
      }),
    ),
    Effect.asVoid,
  ),
);

/** Only explicit organization operations are available to dashboard contracts. */
export const organizationOperations = (options: { headers: Readonly<Record<string, string>> }) => ({
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
export const mcpAuthorization = (options: { headers: Readonly<Record<string, string>> }) => ({
  client: (clientId: string) =>
    authClient.oauth2.publicClient({ query: { client_id: clientId } }, options),
  consent: (input: {
    readonly accept: boolean;
    readonly organization: string;
    readonly query: string;
  }) =>
    authClient.oauth2.consent(
      { accept: input.accept, oauth_query: input.query },
      {
        headers: {
          ...options.headers,
          "x-executor-organization": input.organization,
        },
      },
    ),
});

/** Discard the previous identity and destination before a full-page session switch. */
export const clearSessionDisplay = clearSessionHint;
