// ---------------------------------------------------------------------------
// WorkOS AuthKit — Effect-native sealed session management
// ---------------------------------------------------------------------------

import { env } from "cloudflare:workers";
import { Context, Data, Effect, Layer, Option, Schema } from "effect";
import { GeneratePortalLinkIntent, WorkOS } from "@workos-inc/node/worker";
import { WorkOSError, tryPromiseService, withServiceLogging } from "./errors";

const COOKIE_NAME = "wos-session";
const INVALID_COOKIE_PASSWORD_MESSAGE = "WORKOS_COOKIE_PASSWORD must be at least 32 characters";

type RawWorkOS = WorkOS & {
  readonly get: (
    path: string,
    options?: { readonly query?: Record<string, unknown> },
  ) => Promise<{
    readonly data: unknown;
  }>;
  readonly post: (
    path: string,
    entity: unknown,
    options?: { readonly idempotencyKey?: string },
  ) => Promise<{ readonly data: unknown }>;
};

type WorkOSListMetadata = {
  readonly before?: string | null;
  readonly after?: string | null;
};

type WorkOSAutoPaginatable<Resource> = {
  readonly object: "list";
  readonly data: Resource[];
  readonly listMetadata: WorkOSListMetadata;
  readonly autoPagination: () => Promise<Resource[]>;
};

export type WorkOSCollectedList<Resource> = {
  readonly object: "list";
  readonly data: Resource[];
  readonly listMetadata: {
    readonly before: string | null;
    readonly after: string | null;
  };
};

const RawWorkOSListMetadata = Schema.Struct({
  before: Schema.optional(Schema.NullOr(Schema.String)),
  after: Schema.optional(Schema.NullOr(Schema.String)),
});

const RawWorkOSListResponse = Schema.Struct({
  data: Schema.Array(Schema.Unknown),
  listMetadata: Schema.optional(RawWorkOSListMetadata),
  list_metadata: Schema.optional(RawWorkOSListMetadata),
});

const decodeRawWorkOSListResponse = Schema.decodeUnknownOption(RawWorkOSListResponse);

const completedListMetadata = {
  before: null,
  after: null,
} as const;

const nextCursorFromRawList = (response: typeof RawWorkOSListResponse.Type): string | null =>
  response.listMetadata?.after ?? response.list_metadata?.after ?? null;

export const collectWorkOSList = async <Resource>(
  response: WorkOSAutoPaginatable<Resource>,
): Promise<WorkOSCollectedList<Resource>> => {
  const data = response.listMetadata.after ? await response.autoPagination() : response.data;
  return {
    object: "list",
    data,
    listMetadata: completedListMetadata,
  };
};

export const collectRawWorkOSList = async (
  loadPage: (after?: string) => Promise<unknown>,
): Promise<WorkOSCollectedList<unknown>> => {
  const first = Option.getOrNull(decodeRawWorkOSListResponse(await loadPage()));
  if (!first) {
    return {
      object: "list",
      data: [],
      listMetadata: completedListMetadata,
    };
  }

  const data = [...first.data];
  let after = nextCursorFromRawList(first);

  while (after) {
    const next = Option.getOrNull(decodeRawWorkOSListResponse(await loadPage(after)));
    if (!next) break;
    data.push(...next.data);
    after = nextCursorFromRawList(next);
  }

  return {
    object: "list",
    data,
    listMetadata: completedListMetadata,
  };
};

class WorkOSConfigurationError extends Data.TaggedError("WorkOSConfigurationError")<{
  readonly message: string;
}> {}

/**
 * Optional base-URL override for the WorkOS API (`WORKOS_API_URL`) — points
 * the REAL SDK at a WorkOS emulator in tests/dev. Unset in production, where
 * the SDK uses api.workos.com. Sealed-session crypto, JWKS verification, and
 * every endpoint follow this host, so the whole auth stack runs against the
 * emulator with zero code substitution.
 */
export const workosApiUrlOptions = (
  url: string | undefined,
): { apiHostname?: string; port?: number; https?: boolean } => {
  if (!url) return {};
  const parsed = new URL(url);
  return {
    apiHostname: parsed.hostname,
    ...(parsed.port ? { port: Number(parsed.port) } : {}),
    https: parsed.protocol === "https:",
  };
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const apiKey = env.WORKOS_API_KEY;
  const clientId = env.WORKOS_CLIENT_ID;
  const cookiePassword = env.WORKOS_COOKIE_PASSWORD;

  if (!cookiePassword || cookiePassword.length < 32) {
    return yield* new WorkOSConfigurationError({
      message: INVALID_COOKIE_PASSWORD_MESSAGE,
    });
  }

  const workos = new WorkOS({ apiKey, clientId, ...workosApiUrlOptions(env.WORKOS_API_URL) });

  const use = <A>(fn: (wos: WorkOS) => Promise<A>) =>
    withServiceLogging(
      "workos",
      () => new WorkOSError(),
      tryPromiseService(() => fn(workos)),
    );

  const authenticateSealedSession = (sessionData: string) =>
    Effect.gen(function* () {
      if (!sessionData) return null;

      const session = workos.userManagement.loadSealedSession({
        sessionData,
        cookiePassword,
      });

      const result = yield* use(() => session.authenticate());

      if (result.authenticated) {
        return {
          userId: result.user.id,
          email: result.user.email,
          firstName: result.user.firstName,
          lastName: result.user.lastName,
          avatarUrl: result.user.profilePictureUrl,
          organizationId: result.organizationId,
          sessionId: result.sessionId,
          refreshedSession: undefined as string | undefined,
        };
      }

      if (result.reason === "no_session_cookie_provided") return null;

      // Try refreshing
      const refreshed = yield* use(() => session.refresh()).pipe(
        Effect.orElseSucceed(() => ({ authenticated: false as const })),
      );

      if (!refreshed.authenticated || !("sealedSession" in refreshed) || !refreshed.sealedSession)
        return null;

      return {
        userId: refreshed.user.id,
        email: refreshed.user.email,
        firstName: refreshed.user.firstName,
        lastName: refreshed.user.lastName,
        avatarUrl: refreshed.user.profilePictureUrl,
        organizationId: refreshed.organizationId,
        sessionId: refreshed.sessionId,
        refreshedSession: refreshed.sealedSession,
      };
    });

  return {
    getAuthorizationUrl: (redirectUri: string, state?: string) =>
      workos.userManagement.getAuthorizationUrl({
        provider: "authkit",
        redirectUri,
        clientId,
        ...(state ? { state } : {}),
      }),

    authenticateWithCode: (code: string) =>
      use((wos) =>
        wos.userManagement.authenticateWithCode({
          code,
          clientId,
          session: { sealSession: true, cookiePassword },
        }),
      ),

    /** Create a new organization in WorkOS. */
    createOrganization: (name: string) =>
      use((wos) => wos.organizations.createOrganization({ name })),

    /** Add a user to an organization. */
    createMembership: (organizationId: string, userId: string, roleSlug?: string) =>
      use((wos) =>
        wos.userManagement.createOrganizationMembership({
          organizationId,
          userId,
          ...(roleSlug ? { roleSlug } : {}),
        }),
      ),

    /** List organization memberships for a user. */
    listUserMemberships: (userId: string) =>
      use(async (wos) =>
        collectWorkOSList(
          await wos.userManagement.listOrganizationMemberships({
            userId,
            statuses: ["active", "pending"],
          }),
        ),
      ),

    /**
     * Refresh a sealed session, optionally switching to a new organization.
     * Returns the new sealed session string or null if refresh failed.
     */
    refreshSession: (sessionData: string, organizationId?: string) =>
      Effect.gen(function* () {
        const session = workos.userManagement.loadSealedSession({
          sessionData,
          cookiePassword,
        });
        const refreshed = yield* use(() =>
          session.refresh(organizationId ? { organizationId } : undefined),
        );
        if (!refreshed.authenticated || !("sealedSession" in refreshed)) return null;
        return refreshed.sealedSession ?? null;
      }),

    /**
     * Authenticate a sealed session string. Returns the user info plus
     * any refreshed session that needs to be set on the response.
     * Returns null if the session is missing or invalid.
     */
    authenticateSealedSession,

    /** Authenticate from a Request — convenience wrapper around `authenticateSealedSession`. */
    authenticateRequest: (request: Request) =>
      Effect.gen(function* () {
        const sessionData = parseCookie(request.headers.get("cookie"), COOKIE_NAME);
        if (!sessionData) return null;
        return yield* authenticateSealedSession(sessionData);
      }),

    /**
     * Validate an AuthKit API key. The SDK version installed here exposes
     * organization-owned key types, while WorkOS's API also returns user-owned
     * keys. Keep this boundary unknown and decode the precise app shape in
     * auth/api-keys.ts.
     */
    validateApiKey: (value: string) =>
      use((wos) => wos.apiKeys.validateApiKey({ value }) as Promise<unknown>),

    listUserApiKeys: (userId: string, organizationId: string) =>
      use(async (wos) => {
        const raw = wos as RawWorkOS;
        return collectRawWorkOSList(async (after) => {
          const response = await raw.get(`/user_management/users/${userId}/api_keys`, {
            query: {
              organization_id: organizationId,
              limit: 100,
              ...(after ? { after } : {}),
            },
          });
          return response.data;
        });
      }),

    createUserApiKey: (params: { userId: string; organizationId: string; name: string }) =>
      use(async (wos) => {
        const raw = wos as RawWorkOS;
        const response = await raw.post(`/user_management/users/${params.userId}/api_keys`, {
          name: params.name,
          organization_id: params.organizationId,
        });
        return response.data;
      }),

    deleteApiKey: (id: string) => use((wos) => wos.apiKeys.deleteApiKey(id)),

    /** List organization memberships with user details. */
    listOrgMembers: (organizationId: string) =>
      use(async (wos) =>
        collectWorkOSList(
          await wos.userManagement.listOrganizationMemberships({
            organizationId,
            statuses: ["active", "pending"],
          }),
        ),
      ),

    /** Get a user's membership in an organization. */
    getUserOrgMembership: (organizationId: string, userId: string) =>
      use(async (wos) => {
        const response = await wos.userManagement.listOrganizationMemberships({
          organizationId,
          userId,
          statuses: ["active", "pending"],
        });
        return response.data[0] ?? null;
      }),

    /** Get a user by ID. */
    getUser: (userId: string) => use((wos) => wos.userManagement.getUser(userId)),

    /** Send an organization invitation. */
    sendInvitation: (params: { email: string; organizationId: string; roleSlug?: string }) =>
      use((wos) =>
        wos.userManagement.sendInvitation({
          email: params.email,
          organizationId: params.organizationId,
          roleSlug: params.roleSlug,
        }),
      ),

    /**
     * Pending invitations for an organization (i.e. not yet accepted, revoked,
     * or expired). The SDK's `state` filter doesn't reliably narrow at the
     * API level, so we filter after.
     */
    listPendingInvitations: (organizationId: string) =>
      use(async (wos) =>
        collectWorkOSList(
          await wos.userManagement.listInvitations({
            organizationId,
          }),
        ),
      ).pipe(
        Effect.map((response) => ({
          ...response,
          data: response.data.filter((i) => i.state === "pending"),
        })),
      ),

    /** List invitations for an email address (across all orgs). */
    listInvitationsByEmail: (email: string) =>
      use(async (wos) =>
        collectWorkOSList(
          await wos.userManagement.listInvitations({
            email,
          }),
        ),
      ),

    /** Accept an invitation; returns the (now accepted) invitation. */
    acceptInvitation: (invitationId: string) =>
      use((wos) => wos.userManagement.acceptInvitation(invitationId)),

    /** Remove an organization membership. */
    deleteOrgMembership: (membershipId: string) =>
      use((wos) => wos.userManagement.deleteOrganizationMembership(membershipId)),

    /** Get the role for a membership. */
    getOrgMembership: (membershipId: string) =>
      use((wos) => wos.userManagement.getOrganizationMembership(membershipId)),

    /** Update a membership's role. */
    updateOrgMembershipRole: (membershipId: string, roleSlug: string) =>
      use((wos) => wos.userManagement.updateOrganizationMembership(membershipId, { roleSlug })),

    /** List available roles for an organization. */
    listOrgRoles: (organizationId: string) =>
      use((wos) => wos.organizations.listOrganizationRoles({ organizationId })),

    /** Get an organization (includes domains). */
    getOrganization: (organizationId: string) =>
      use((wos) => wos.organizations.getOrganization(organizationId)),

    /** Update an organization. */
    updateOrganization: (organizationId: string, name: string) =>
      use((wos) => wos.organizations.updateOrganization({ organization: organizationId, name })),

    /** Generate an Admin Portal link for domain verification. */
    generateDomainVerificationPortalLink: (organizationId: string, returnUrl: string) =>
      use((wos) =>
        wos.portal.generateLink({
          organization: organizationId,
          intent: GeneratePortalLinkIntent.DomainVerification,
          returnUrl,
        }),
      ),

    /** Get a domain by ID. */
    getOrganizationDomain: (domainId: string) =>
      use((wos) => wos.organizationDomains.get(domainId)),

    /** Delete a domain claim. */
    deleteOrganizationDomain: (domainId: string) =>
      use((wos) => wos.organizationDomains.delete(domainId)),
  };
});

export type WorkOSClientService = Effect.Success<typeof make>;

export class WorkOSClient extends Context.Service<WorkOSClient, WorkOSClientService>()(
  "@executor-js/cloud/WorkOSClient",
) {
  static Default = Layer.effect(this)(make).pipe(
    Layer.withSpan("WorkOSClient", { attributes: { module: "WorkOSClient" } }),
  );
}

// The boot-scoped WorkOS client root — the one neutral service the stateless
// HTTP path AND the MCP session Durable Object both build on (each merges it
// with its own DB + telemetry layers). Named here, beside the client it aliases,
// so a focused backend consumer (the DO, the miniflare test worker) imports just
// this root rather than the whole `api/layers.ts` HTTP assembly. It names NO
// billing service, so the DO — which never bills — does not transitively require
// one. (This used to live in a standalone `api/core-shared-services.ts` purely to
// keep `@tanstack/react-start` out of the DO bundle; that coupling is gone now
// that `handlers.ts` no longer imports react-start, so the alias moved home.)
export const CoreSharedServices = WorkOSClient.Default;

const parseCookie = (cookieHeader: string | null, name: string): string | null => {
  if (!cookieHeader) return null;
  const match = cookieHeader
    .split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.slice(name.length + 1) || null;
};
