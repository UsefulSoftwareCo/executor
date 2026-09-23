import type { AuthContext } from "@better-auth/core";
import { Effect, Schema } from "effect";
import { AuthenticationUnavailable } from "../contracts/auth.ts";
import {
  OrganizationForbidden,
  OrganizationId,
  type OrganizationReference,
} from "../contracts/organization.ts";

/** Resolve ID or slug before authorization. Ambiguous references never select either tenant. */
export const resolveOrganizationReference = (
  adapter: Pick<AuthContext["adapter"], "findMany">,
  reference: OrganizationReference,
) =>
  Effect.tryPromise({
    try: () =>
      adapter.findMany({
        model: "organization",
        where: [
          { field: "id", value: reference, connector: "OR" },
          { field: "slug", value: reference, connector: "OR" },
        ],
        select: ["id"],
        limit: 2,
      }),
    catch: () => new AuthenticationUnavailable(),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ id: OrganizationId })))),
    Effect.catchTag("SchemaError", () => Effect.fail(new AuthenticationUnavailable())),
    Effect.flatMap((matches) =>
      matches.length === 1 && matches[0] !== undefined
        ? Effect.succeed(matches[0].id)
        : Effect.fail(new OrganizationForbidden()),
    ),
  );
