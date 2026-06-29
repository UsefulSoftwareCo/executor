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
// Cloudflare Access, NOT in the app. The shell hides the API-keys footer and
// shows no members page, so those methods are never reached from the UI; they
// return empty (reads) or a clear "managed by Cloudflare Access" error (writes)
// to satisfy the provider shape.
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
    listMembers: () => Effect.succeed({ members: [] }),
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
