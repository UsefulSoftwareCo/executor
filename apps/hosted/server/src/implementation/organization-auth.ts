import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { Option, Schema } from "effect";
import {
  OrganizationDetailsUpdate,
  OrganizationId,
  OrganizationRole,
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
const InviteMember = Schema.Struct({
  ...Target.fields,
  email: Schema.NonEmptyString,
  resend: Schema.optionalKey(Schema.Boolean),
  role: Schema.Literals(["admin", "member"]),
});
const Membership = Schema.Struct({ role: OrganizationRole });
const StoredInvitation = Schema.Struct({
  role: InviteMember.fields.role,
  status: Schema.String,
  organizationId: Schema.NonEmptyString,
});
const JoinedMember = Schema.Struct({ organizationId: Schema.NonEmptyString });
const JoinedOrganization = Schema.Struct({ name: Schema.String });
const SentInvitation = Schema.Struct({
  id: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
});

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
            case "/organization/leave":
              return require(Target, context.body, true);
            case "/organization/create":
              return require(Creation, context.body);
            case "/organization/list-members":
              return require(Target, context.query);
            case "/organization/list-invitations":
            case "/organization/get-full-organization": {
              const target = Schema.decodeUnknownOption(Target)(context.query);
              if (Option.isNone(target))
                throw new APIError("BAD_REQUEST", {
                  message: "An explicit organization target is required.",
                });
              const session = await getSessionFromCtx(context);
              if (session === null) throw new APIError("UNAUTHORIZED");
              // Invitation IDs are bearer credentials for self-host signup. Native
              // Better Auth reads check membership only, including the composite read.
              const member = Schema.decodeUnknownOption(Membership)(
                await context.context.adapter.findOne({
                  model: "member",
                  where: [
                    { field: "userId", value: session.user.id },
                    { field: "organizationId", value: target.value.organizationId },
                  ],
                  select: ["role"],
                }),
              );
              if (Option.isNone(member) || member.value.role === "member")
                throw new APIError("FORBIDDEN", {
                  message: "Only organization administrators can read invitations.",
                });
              return;
            }
            case "/organization/update":
              return require(Update, context.body, true);
            case "/organization/update-member-role":
              return require(MemberRole, context.body, true);
            case "/organization/invite-member": {
              const invitation = Schema.decodeUnknownOption(InviteMember)(context.body);
              if (Option.isNone(invitation))
                throw new APIError("BAD_REQUEST", {
                  message:
                    "Provide an organization and either the admin or member invitation role.",
                });
              return { context: { body: invitation.value } };
            }
            case "/organization/remove-member":
              return require(Target, context.body);
            case "/organization/accept-invitation": {
              const invitation = Schema.decodeUnknownOption(Invitation)(context.body);
              if (Option.isNone(invitation))
                throw new APIError("BAD_REQUEST", { message: "An invitation is required." });
              const session = await getSessionFromCtx(context);
              if (session === null) throw new APIError("UNAUTHORIZED");
              // Old pending invitations can predate the request role guard. Native
              // acceptance copies their stored role directly into a new membership.
              const row = await context.context.adapter.findOne<Record<string, unknown>>({
                model: "invitation",
                where: [
                  { field: "id", value: invitation.value.invitationId },
                  { field: "email", value: session.user.email.toLowerCase() },
                ],
              });
              const stored = Schema.decodeUnknownOption(StoredInvitation)(row);
              if (Option.isNone(stored))
                throw new APIError("BAD_REQUEST", {
                  message: "This invitation is invalid. Ask an administrator for a new invitation.",
                });
              // Reopening the link after joining repeats an acceptance that already
              // happened. Native acceptance only takes pending invitations, so answer
              // with the recipient's current membership, marked so the page can say so.
              if (stored.value.status === "accepted") {
                const member = await context.context.adapter.findOne<Record<string, unknown>>({
                  model: "member",
                  where: [
                    { field: "userId", value: session.user.id },
                    { field: "organizationId", value: stored.value.organizationId },
                  ],
                });
                const organization = Schema.decodeUnknownOption(JoinedOrganization)(
                  await context.context.adapter.findOne({
                    model: "organization",
                    where: [{ field: "id", value: stored.value.organizationId }],
                    select: ["name"],
                  }),
                );
                if (
                  Option.isSome(Schema.decodeUnknownOption(JoinedMember)(member)) &&
                  Option.isSome(organization)
                )
                  return context.json({
                    invitation: row,
                    member,
                    alreadyMember: { name: organization.value.name },
                  });
              }
              return { context: { body: invitation.value } };
            }
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
    after: [
      {
        matcher: (context) => context.path === "/organization/invite-member",
        // Native resend only reuses an unexpired invitation, so resending an expired one
        // creates a new row. The sent invitation supersedes every other pending one.
        handler: createAuthMiddleware(async (context) => {
          const sent = Schema.decodeUnknownOption(SentInvitation)(context.context.returned);
          if (Option.isNone(sent)) return;
          await context.context.adapter.updateMany({
            model: "invitation",
            where: [
              { field: "organizationId", value: sent.value.organizationId },
              { field: "email", value: sent.value.email.toLowerCase() },
              { field: "status", value: "pending" },
              { field: "id", operator: "ne", value: sent.value.id },
            ],
            update: { status: "canceled" },
          });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
