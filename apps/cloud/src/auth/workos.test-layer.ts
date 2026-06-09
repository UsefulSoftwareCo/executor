import { Data, Effect, Layer } from "effect";
import type { Organization, OrganizationMembership, OrganizationRole } from "@workos-inc/node";

import { WorkOSClient, type WorkOSCollectedList } from "./workos";

export type WorkOSTestState = {
  readonly memberships: readonly OrganizationMembership[];
  // When set, a successful create adds a unique org id + an active membership,
  // so a running server's free-org limit trips live across requests. Off by
  // default — existing tests keep the fixed `org_created` id and static list.
  readonly growMembershipsOnCreate?: boolean;
  // When set, the user is resolved from the `wos-session` cookie value and
  // memberships are keyed per user — so each test/browser picks its own user id
  // and is isolated on a shared instance (no reset needed), matching the
  // in-process per-org harness. Implies grow-on-create.
  readonly multiUser?: boolean;
  readonly createdOrganizations: Array<{ readonly id: string; readonly name: string }>;
  readonly createdMemberships: Array<{
    readonly organizationId: string;
    readonly userId: string;
    readonly roleSlug: string | undefined;
  }>;
};

export class UnstubbedWorkOSMethod extends Data.TaggedError("UnstubbedWorkOSMethod")<{
  readonly method: string;
}> {}

export const makeWorkOSTestState = (overrides: Partial<WorkOSTestState> = {}): WorkOSTestState => ({
  memberships: [],
  createdOrganizations: [],
  createdMemberships: [],
  ...overrides,
});

export const WorkOSTestRole: OrganizationRole = {
  object: "role",
  id: "role_admin",
  name: "Admin",
  slug: "admin",
  description: null,
  permissions: [],
  resourceTypeSlug: "organization",
  type: "OrganizationRole",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

export const makeWorkOSTestOrganization = (id: string, name = id): Organization => ({
  object: "organization",
  id,
  name,
  allowProfilesOutsideOrganization: false,
  domains: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  externalId: null,
  metadata: {},
});

export const makeWorkOSTestMembership = (
  organizationId: string,
  status: OrganizationMembership["status"],
) =>
  ({
    object: "organization_membership",
    id: `membership_${organizationId}`,
    organizationId,
    organizationName: organizationId,
    status,
    userId: "user_1",
    role: WorkOSTestRole,
    directoryManaged: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    customAttributes: {},
  }) satisfies OrganizationMembership;

const decode = (value: string): string => {
  // oxlint-disable-next-line executor/no-try-catch-or-throw -- boundary: tolerate non-URL-encoded cookie values from direct API callers
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const collected = <A>(data: readonly A[]): WorkOSCollectedList<A> => ({
  object: "list",
  data: [...data],
  listMetadata: {
    before: null,
    after: null,
  },
});

const makeWorkOSTestService = (state: WorkOSTestState): WorkOSClient["Service"] => {
  const nextOrgId = "org_created";
  let orgCounter = 0;
  // Per-user membership buckets (multi-user mode). Closure-scoped, so they live
  // for the layer's lifetime (= the running server) and isolate users from each
  // other without a reset.
  const byUser = new Map<string, OrganizationMembership[]>();
  const memsFor = (userId: string) => {
    let m = byUser.get(userId);
    if (!m) byUser.set(userId, (m = []));
    return m;
  };
  const grows = state.multiUser || state.growMembershipsOnCreate;
  const service: Partial<WorkOSClient["Service"]> = {
    listUserMemberships: (userId: string) =>
      Effect.succeed(collected(state.multiUser ? memsFor(userId) : state.memberships)),
    createOrganization: (name) =>
      Effect.sync(() => {
        const id = grows ? `${nextOrgId}_${++orgCounter}` : nextOrgId;
        const org = makeWorkOSTestOrganization(id, name);
        state.createdOrganizations.push({ id: org.id, name: org.name });
        return org;
      }),
    createMembership: (organizationId, userId, roleSlug) =>
      Effect.sync(() => {
        state.createdMemberships.push({ organizationId, userId, roleSlug });
        const membership = makeWorkOSTestMembership(organizationId, "active");
        if (state.multiUser) memsFor(userId).push(membership);
        else if (state.growMembershipsOnCreate) {
          (state.memberships as OrganizationMembership[]).push(membership);
        }
        return membership;
      }),
    getOrganization: (organizationId: string) =>
      Effect.succeed(makeWorkOSTestOrganization(organizationId)),
    // The create-org page polls pending invitations; no invitation flows in
    // the stub world, so the list is always empty.
    listInvitationsByEmail: (_email: string) => Effect.succeed(collected([])),
    getUserOrgMembership: (organizationId: string, _userId: string) =>
      Effect.succeed(makeWorkOSTestMembership(organizationId, "active")),
    // Multi-user refresh carries the user id forward + the switched-to org, so the
    // create-org handler's `verified.organizationId === org.id` check passes and
    // the user stays consistent across the refresh. The incoming sealed session
    // may be URL-encoded (set-cookie round-trip through a real browser) and may
    // already carry an `|org:` suffix from a previous switch — normalize both.
    refreshSession: (sealedSession, organizationId) =>
      Effect.succeed(
        state.multiUser
          ? `${userOf(sealedSession)}|org:${organizationId}`
          : `session_${organizationId}`,
      ),
    authenticateSealedSession: (sealedSession) => Effect.sync(() => sessionOf(sealedSession)),
    // The protected-API identity path (`resolveSessionPrincipal`) authenticates
    // from the Request; mirror the real client's cookie-parse + delegate.
    authenticateRequest: (request: Request) =>
      Effect.sync(() => {
        const match = /(?:^|;\s*)wos-session=([^;]+)/.exec(request.headers.get("cookie") ?? "");
        return match ? sessionOf(decodeURIComponent(match[1]!)) : null;
      }),
  };

  function userOf(sealedSession: string): string {
    return decode(sealedSession).split("|org:")[0] || "user_1";
  }

  function sessionOf(sealedSession: string) {
    if (state.multiUser) {
      // Cookie is `<userId>` (initial) or `<userId>|org:<orgId>` (after refresh);
      // a browser round-trip URL-encodes it. The LAST org segment is current.
      const parts = decode(sealedSession).split("|org:");
      const userPart = parts[0];
      const orgPart = parts.length > 1 ? parts[parts.length - 1] : undefined;
      return {
        userId: userPart || "user_1",
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
        avatarUrl: null,
        organizationId: orgPart ?? "",
        sessionId: "session_id",
        refreshedSession: undefined,
      };
    }
    return {
      userId: "user_1",
      email: "test@example.com",
      firstName: "Test",
      lastName: "User",
      avatarUrl: null,
      organizationId: sealedSession.replace("session_", ""),
      sessionId: "session_id",
      refreshedSession: undefined,
    };
  }

  return new Proxy(service as WorkOSClient["Service"], {
    get: (target, prop) => {
      if (prop in target) return target[prop as keyof typeof target];
      return () =>
        Effect.fail(
          new UnstubbedWorkOSMethod({
            method: typeof prop === "string" ? prop : (prop.description ?? "symbol"),
          }),
        );
    },
  });
};

export const WorkOSTestLayer = (state: WorkOSTestState) =>
  Layer.succeed(WorkOSClient)(makeWorkOSTestService(state));
