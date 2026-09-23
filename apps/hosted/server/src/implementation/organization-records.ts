import type { AuthContext } from "@better-auth/core";
/** Better Auth records an organization owns, removed together once its product data is gone. */
import { Effect, Schema } from "effect";
import { AuthenticationUnavailable } from "../contracts/auth.ts";
import { OrganizationForbidden, type OrganizationId } from "../contracts/organization.ts";

const Organization = Schema.Struct({ logo: Schema.NullOr(Schema.String) });
const Grant = Schema.Struct({ id: Schema.NonEmptyString });

type Adapter = Pick<AuthContext["adapter"], "findOne" | "findMany" | "delete" | "deleteMany">;

/**
 * Better Auth's adapter substitutes its own default limit for an absent one, so
 * a bare findMany silently stops at 100 rows. Page by ascending id until a short
 * page arrives; a keyset stays correct even if rows are inserted mid-sweep.
 */
const grantPage = 200;

const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new AuthenticationUnavailable() });

/**
 * Better Auth's own delete route stays disabled: it cannot remove the product
 * records this organization owns. This deletes the same rows plus the MCP
 * grants bound to the organization as their OAuth resource, which Better Auth
 * has no foreign key for. It returns the saved icon so the caller can release
 * its stored image afterwards.
 *
 * There is no transaction across these statements, so the order decides what a
 * mid-flight failure leaves behind. Grants go first, while the organization is
 * still fully administrable and the caller can simply retry. The organization
 * row goes next, in one statement: from that point no request resolves the
 * organization at all, which is a state nobody has to reach again. Member and
 * invitation rows go last, after Better Auth's own cascade has most likely
 * already removed them; a leftover member row for an organization that no
 * longer exists grants nothing, whereas the previous order could leave a live
 * organization with zero members, which its own owner could never administer
 * or delete.
 */
export const deleteOrganizationRecords = (adapter: Adapter, organization: OrganizationId) =>
  Effect.gen(function* () {
    const existing = yield* call(() =>
      adapter.findOne({
        model: "organization",
        where: [{ field: "id", value: organization }],
        select: ["logo"],
      }),
    );
    if (existing === null) return yield* new OrganizationForbidden();
    const saved = yield* Schema.decodeUnknownEffect(Organization)(existing).pipe(
      Effect.catchTag("SchemaError", () => Effect.fail(new AuthenticationUnavailable())),
    );
    // Grants outlive membership checks only as dead rows; remove their tokens with them.
    let after: string | null = null;
    for (;;) {
      const grants = yield* call(() =>
        adapter.findMany({
          model: "mcpGrant",
          where: [
            { field: "resource", value: organization },
            ...(after === null
              ? []
              : [
                  { field: "id", value: after, operator: "gt" as const, connector: "AND" as const },
                ]),
          ],
          select: ["id"],
          limit: grantPage,
          sortBy: { field: "id", direction: "asc" },
        }),
      ).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Grant))),
        Effect.catchTag("SchemaError", () => Effect.fail(new AuthenticationUnavailable())),
      );
      for (const grant of grants) {
        for (const model of ["oauthAccessToken", "oauthRefreshToken", "oauthConsent"] as const)
          yield* call(() =>
            adapter.deleteMany({
              model,
              where: [{ field: "referenceId", value: grant.id }],
            }),
          );
        yield* call(() =>
          adapter.delete({ model: "mcpGrant", where: [{ field: "id", value: grant.id }] }),
        );
      }
      const last = grants.at(-1);
      if (last === undefined || grants.length < grantPage) break;
      after = last.id;
    }
    // Other sessions keep a stale active-organization preference; every request resolves the URL target.
    yield* call(() =>
      adapter.delete({ model: "organization", where: [{ field: "id", value: organization }] }),
    );
    for (const model of ["member", "invitation"] as const)
      yield* call(() =>
        adapter.deleteMany({
          model,
          where: [{ field: "organizationId", value: organization }],
        }),
      );
    return { logo: saved.logo };
  });
