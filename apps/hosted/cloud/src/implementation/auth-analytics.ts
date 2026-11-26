import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";

const operations = new Set([
  "/organization/create",
  "/organization/update",
  "/organization/update-member-role",
  "/organization/invite-member",
  "/organization/remove-member",
  "/organization/accept-invitation",
  "/organization/cancel-invitation",
  "/api-key/create",
  "/api-key/delete",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/update-user",
  "/change-password",
  "/revoke-session",
  "/revoke-other-sessions",
  "/sign-out",
]);
export interface NativeAuthUsage {
  readonly userId: string;
  readonly operation: string;
  readonly status: number;
}
export const nativeAuthAnalytics = (
  record: (usage: NativeAuthUsage) => Promise<void>,
): BetterAuthPlugin => ({
  id: "executor-product-analytics",
  hooks: {
    after: [
      {
        matcher: (context) =>
          context.request !== undefined &&
          context.path !== undefined &&
          operations.has(context.path),
        handler: createAuthMiddleware(async (context) => {
          const session = await getSessionFromCtx(context).catch(() => null);
          const user = session?.user ?? context.context.newSession?.user;
          if (user === undefined || context.path === undefined) return;
          const returned = context.context.returned;
          await record({
            userId: user.id,
            operation: context.path.slice(1).replaceAll("/", "."),
            status:
              returned instanceof APIError
                ? returned.statusCode
                : returned instanceof Response
                  ? returned.status
                  : 200,
          });
        }),
      },
    ],
  },
});
