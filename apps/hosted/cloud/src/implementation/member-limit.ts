import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { Option, Schema } from "effect";
import type { CloudBillingHooks } from "./auth-options.ts";

const Target = Schema.Struct({ organizationId: Schema.NonEmptyString });
const Administrator = Schema.Struct({ role: Schema.Literals(["owner", "admin"]) });

export const cloudMemberLimit = (billing: CloudBillingHooks) =>
  ({
    id: "executor-cloud-member-limit",
    hooks: {
      before: [
        {
          matcher: (context) => context.path === "/organization/invite-member",
          handler: createAuthMiddleware(async (context) => {
            const target = Schema.decodeUnknownOption(Target)(context.body);
            if (Option.isNone(target)) return;
            const session = await getSessionFromCtx(context);
            if (session === null) return;
            const caller = Schema.decodeUnknownOption(Administrator)(
              await context.context.adapter.findOne({
                model: "member",
                where: [
                  { field: "userId", value: session.user.id },
                  { field: "organizationId", value: target.value.organizationId },
                ],
                select: ["role"],
              }),
            );
            if (Option.isNone(caller)) return;
            const members = await context.context.adapter.count({
              model: "member",
              where: [{ field: "organizationId", value: target.value.organizationId }],
            });
            if (members >= (await billing.memberLimit(target.value.organizationId)))
              throw new APIError("FORBIDDEN", {
                code: "ORGANIZATION_MEMBERSHIP_LIMIT_REACHED",
                message: "Organization membership limit reached",
              });
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
