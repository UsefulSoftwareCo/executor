import type { AuthContext } from "@better-auth/core";
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
  inviterId: Schema.NonEmptyString,
});
const ChangedMember = Schema.Struct({
  userId: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
  role: OrganizationRole,
});
const RemovedMember = Schema.Struct({ member: ChangedMember });

export const invitingRoles = ["owner", "admin"] as const;
const mayInvite = (role: typeof OrganizationRole.Type) =>
  (invitingRoles as ReadonlyArray<string>).includes(role);

export const inviterMayInvite = async (
  adapter: Pick<AuthContext["adapter"], "findOne">,
  invitation: { readonly organizationId: string; readonly inviterId: string },
) => {
  const inviter = Schema.decodeUnknownOption(Membership)(
    await adapter.findOne({
      model: "member",
      where: [
        { field: "userId", value: invitation.inviterId },
        { field: "organizationId", value: invitation.organizationId },
      ],
      select: ["role"],
    }),
  );
  return Option.isSome(inviter) && mayInvite(inviter.value.role);
};
const JoinedMember = Schema.Struct({ organizationId: Schema.NonEmptyString });
const JoinedOrganization = Schema.Struct({ name: Schema.String });
const SentInvitation = Schema.Struct({
  id: Schema.NonEmptyString,
  email: Schema.NonEmptyString,
  organizationId: Schema.NonEmptyString,
  inviterId: Schema.NonEmptyString,
});

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
              if (!(await inviterMayInvite(context.context.adapter, stored.value)))
                throw new APIError("BAD_REQUEST", {
                  message:
                    "The person who sent this invitation can no longer invite members. Ask an administrator for a new invitation.",
                });
              return { context: { body: invitation.value } };
            }
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
          const session = await getSessionFromCtx(context);
          if (session === null || sent.value.inviterId === session.user.id) return;
          const resent = await context.context.adapter.update<Record<string, unknown>>({
            model: "invitation",
            where: [
              { field: "id", value: sent.value.id },
              { field: "status", value: "pending" },
            ],
            update: { inviterId: session.user.id },
          });
          if (resent !== null) return context.json(resent);
        }),
      },
      {
        matcher: (context) =>
          context.path === "/organization/remove-member" ||
          context.path === "/organization/update-member-role",
        handler: createAuthMiddleware(async (context) => {
          const returned = context.context.returned;
          const removed = context.path === "/organization/remove-member";
          const member = removed
            ? Option.map(Schema.decodeUnknownOption(RemovedMember)(returned), (r) => r.member)
            : Schema.decodeUnknownOption(ChangedMember)(returned);
          if (Option.isNone(member) || (!removed && mayInvite(member.value.role))) return;
          await context.context.adapter.updateMany({
            model: "invitation",
            where: [
              { field: "organizationId", value: member.value.organizationId },
              { field: "inviterId", value: member.value.userId },
              { field: "status", value: "pending" },
            ],
            update: { status: "canceled" },
          });
        }),
      },
    ],
  },
} satisfies BetterAuthPlugin;
