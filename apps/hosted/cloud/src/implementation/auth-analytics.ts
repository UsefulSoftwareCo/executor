/** Better Auth owns these endpoints outside the hosted API middleware. */
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { BetterAuthPlugin } from "better-auth";

const operations = new Set([
  "/organization/create",
  "/organization/list",
  "/organization/list-members",
  "/organization/list-invitations",
  "/organization/get-full-organization",
  "/organization/update",
  "/organization/update-member-role",
  "/organization/invite-member",
  "/organization/remove-member",
  "/organization/accept-invitation",
  "/organization/cancel-invitation",
  "/api-key/create",
  "/api-key/list",
  "/api-key/get",
  "/api-key/delete",
  "/passkey/verify-registration",
  "/passkey/delete-passkey",
  "/passkey/list-user-passkeys",
  "/sign-out",
]);
/** Only server-established identity and authored operation names cross this callback. */
export interface NativeAuthUsage {
  readonly userId: string;
  readonly operation: string;
  readonly status: number;
}
/** Record completed authenticated operations without inspecting bodies, return values or credentials. */
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
          // Better Auth endpoint middleware does not retain its session in the after-hook context.
          // Analytics lookup failure must not change an already completed auth operation.
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
