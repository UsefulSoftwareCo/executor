import { Data, Effect, Layer } from "effect";
import type { Organization, OrganizationMembership, OrganizationRole } from "@workos-inc/node";

import { WorkOSAuth, type WorkOSCollectedList } from "./workos";

export type WorkOSTestState = {
  readonly memberships: readonly OrganizationMembership[];
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

const collected = <A>(data: readonly A[]): WorkOSCollectedList<A> => ({
  object: "list",
  data: [...data],
  listMetadata: {
    before: null,
    after: null,
  },
});

const makeWorkOSTestService = (state: WorkOSTestState): WorkOSAuth["Service"] => {
  const nextOrgId = "org_created";
  const service: Partial<WorkOSAuth["Service"]> = {
    listUserMemberships: () => Effect.succeed(collected(state.memberships)),
    createOrganization: (name) =>
      Effect.sync(() => {
        const org = makeWorkOSTestOrganization(nextOrgId, name);
        state.createdOrganizations.push({ id: org.id, name: org.name });
        return org;
      }),
    createMembership: (organizationId, userId, roleSlug) =>
      Effect.sync(() => {
        state.createdMemberships.push({ organizationId, userId, roleSlug });
        return makeWorkOSTestMembership(organizationId, "active");
      }),
    refreshSession: (_sealedSession, organizationId) => Effect.succeed(`session_${organizationId}`),
    authenticateSealedSession: (sealedSession) =>
      Effect.succeed({
        userId: "user_1",
        email: "test@example.com",
        firstName: "Test",
        lastName: "User",
        avatarUrl: null,
        organizationId: sealedSession.replace("session_", ""),
        sessionId: "session_id",
        refreshedSession: undefined,
      }),
  };

  return new Proxy(service as WorkOSAuth["Service"], {
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
  Layer.succeed(WorkOSAuth)(makeWorkOSTestService(state));
