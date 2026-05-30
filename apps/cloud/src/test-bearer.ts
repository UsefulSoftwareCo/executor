// Shared test bearer format between the test worker (runs inside workerd /
// Miniflare) and node-pool tests (which import it directly). Kept in its own
// zero-dependency module so node tests can pull it without dragging in the
// worker entry, which imports `cloudflare:workers`.

import type { VerifiedToken } from "./mcp/jwt";

export const TEST_BEARER_PREFIX = "test-accept::";
export const NO_ORG_SENTINEL = "none";

export const makeTestBearer = (accountId: string, organizationId: string | null): string =>
  `${TEST_BEARER_PREFIX}${accountId}::${organizationId ?? NO_ORG_SENTINEL}`;

export const parseTestBearer = (token: string): VerifiedToken | null => {
  if (!token.startsWith(TEST_BEARER_PREFIX)) return null;
  const [accountId, organizationId] = token.slice(TEST_BEARER_PREFIX.length).split("::", 2);
  if (!accountId || !organizationId) return null;
  return {
    accountId,
    organizationId: organizationId === NO_ORG_SENTINEL ? null : organizationId,
  };
};
