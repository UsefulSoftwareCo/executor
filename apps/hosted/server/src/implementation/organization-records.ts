import type { AuthContext } from "@better-auth/core";
import { Effect, Schema } from "effect";
import { AuthenticationUnavailable } from "../contracts/auth.ts";
import { OrganizationForbidden, type OrganizationId } from "../contracts/organization.ts";

const Organization = Schema.Struct({ logo: Schema.NullOr(Schema.String) });
const Grant = Schema.Struct({ id: Schema.NonEmptyString });

type Adapter = Pick<AuthContext["adapter"], "findOne" | "findMany" | "delete" | "deleteMany">;

const grantPage = 200;

const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: () => new AuthenticationUnavailable() });

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
