import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { Option, Schema } from "effect";
import {
  OrganizationDetailsUpdate,
  OrganizationId,
  OrganizationSlug,
} from "../contracts/organization.ts";

const Target = Schema.Struct({
  organizationId: OrganizationId,
  organizationSlug: Schema.optionalKey(Schema.Never),
});
const Update = Schema.Struct({ ...Target.fields, data: OrganizationDetailsUpdate });
const MemberRole = Schema.Struct({
  ...Target.fields,
  memberId: Schema.NonEmptyString,
  role: Schema.Literals(["admin", "member"]),
});
const Creation = Schema.Struct({
  keepCurrentActiveOrganization: Schema.Literal(true),
  slug: OrganizationSlug,
});
const Invitation = Schema.Struct({ invitationId: Schema.NonEmptyString });

/**
 * Constrain the native organization's HTTP surface to Executor's explicit operations.
 * Better Auth 1.7 otherwise falls back to a shared session preference. New library
 * endpoints remain blocked until their target semantics have been reviewed.
 * Server-only library calls are private adapter operations, not HTTP authority.
 */
export const explicitOrganizationAuth = {
  id: "executor-explicit-organization",
  hooks: {
    before: [
      {
        matcher: (context) =>
          context.request !== undefined && context.path?.startsWith("/organization/") === true,
        handler: createAuthMiddleware(async (context) => {
          const require = <A>(schema: Schema.Decoder<A>, input: unknown, strict = false) => {
            if (
              Option.isNone(
                Schema.decodeUnknownOption(schema, {
                  onExcessProperty: strict ? "error" : "ignore",
                })(input),
              )
            ) {
              throw new APIError("BAD_REQUEST", {
                message: "An explicit organization target is required.",
              });
            }
          };
          switch (context.path) {
            case "/organization/list":
              return;
            case "/organization/create":
              return require(Creation, context.body);
            case "/organization/list-members":
            case "/organization/list-invitations":
            case "/organization/get-full-organization":
              return require(Target, context.query);
            case "/organization/update":
              return require(Update, context.body, true);
            case "/organization/update-member-role":
              return require(MemberRole, context.body, true);
            case "/organization/invite-member":
            case "/organization/remove-member":
              return require(Target, context.body);
            case "/organization/accept-invitation":
              return require(Invitation, context.body);
            // The invitation identifies the organization; Better Auth checks its current membership and cancel permission.
            case "/organization/cancel-invitation":
              return require(Invitation, context.body, true);
            default:
              throw new APIError("NOT_FOUND", {
                message: "This organization operation is not available.",
              });
          }
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
