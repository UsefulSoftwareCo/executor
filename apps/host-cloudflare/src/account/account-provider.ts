import { Effect, Layer } from "effect";

import {
  AccountProvider,
  accountProviderMiddlewareLayer,
  type AccountHeaders,
} from "@executor-js/api/server";
import { AccountError, AccountUnauthorized } from "@executor-js/api";

import { makeAccessVerifier } from "../auth/cloudflare-access";
import type { CloudflareConfig } from "../config";

// ---------------------------------------------------------------------------
// Cloudflare AccountProvider — backs the shared `/account/*` surface the
// multiplayer shell reads. Cloudflare Access is the identity, so `me` just
// reflects the Access principal (the same `makeAccessVerifier` the API gate
// uses), reading the `Cf-Access-Jwt-Assertion` header off the request.
//
// Single-tenant + Access-managed: members, roles, and API keys live in
// Cloudflare Access, not in the app. Writes stay refused. `listMembers` still
// has to return the current Access principal — the console infers admin from
// that list (`isCurrentUser` + role), and an empty list fail-closes every
// workspace-admin action even when `ADMIN_EMAILS` granted `orgRole: "admin"`.
// ---------------------------------------------------------------------------

const NOT_IN_APP = "Managed by Cloudflare Access, not in the app.";

export const cloudflareAccountProvider = (
  config: CloudflareConfig,
): Layer.Layer<AccountProvider> => {
  const { verify } = makeAccessVerifier(config);

  // The provider gets raw headers; rebuild a minimal Request so `verify` can
  // read the Access assertion header (and honor the dev-auth bypass).
  const principalFrom = (headers: AccountHeaders) =>
    verify(new Request("https://internal.local/", { headers: new Headers(headers) }));

  const forbiddenWrite = Effect.fail(new AccountError({ message: NOT_IN_APP }));

  return Layer.succeed(AccountProvider)({
    me: (headers) =>
      principalFrom(headers).pipe(
        Effect.flatMap((principal) =>
          principal
            ? Effect.succeed({
                user: {
                  id: principal.accountId,
                  email: principal.email,
                  name: principal.name,
                  avatarUrl: principal.avatarUrl,
                },
                organization: {
                  id: principal.organizationId,
                  name: principal.organizationName,
                  slug: config.organizationSlug,
                },
              })
            : Effect.fail(new AccountUnauthorized()),
        ),
      ),
    listApiKeys: () => Effect.succeed({ apiKeys: [] }),
    createApiKey: () => forbiddenWrite,
    revokeApiKey: () => forbiddenWrite,
    // Org-owned keys are a WorkOS concept; Access-managed instances have no
    // credential store of their own to mint one from.
    listOrgApiKeys: () => Effect.succeed({ apiKeys: [] }),
    createOrgApiKey: () => forbiddenWrite,
    revokeOrgApiKey: () => forbiddenWrite,
    listMembers: (headers) =>
      principalFrom(headers).pipe(
        Effect.flatMap((principal) =>
          principal
            ? Effect.succeed({
                members: [
                  {
                    id: principal.accountId,
                    userId: principal.accountId,
                    email: principal.email.length > 0 ? principal.email : null,
                    name: principal.name,
                    avatarUrl: principal.avatarUrl,
                    role: principal.orgRole === "admin" ? "admin" : "member",
                    status: "active",
                    lastActiveAt: null,
                    isCurrentUser: true,
                  },
                ],
              })
            : Effect.fail(new AccountUnauthorized()),
        ),
      ),
    listRoles: () => Effect.succeed({ roles: [] }),
    inviteMember: () => forbiddenWrite,
    removeMember: () => forbiddenWrite,
    updateMemberRole: () => forbiddenWrite,
    updateOrgName: () => forbiddenWrite,
  });
};

/** The per-request `AccountProvider` middleware (mounted under `/api`). */
export const cloudflareAccountMiddleware = (config: CloudflareConfig) =>
  accountProviderMiddlewareLayer(cloudflareAccountProvider(config));
