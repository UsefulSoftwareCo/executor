/**
 * Provider-issued self-host delegation keys use a reserved Better Auth prefix.
 * This lets every session-producing boundary reject a delegated bearer before
 * Better Auth can turn it into the key owner's unrestricted session. Ordinary
 * Better Auth API keys keep their existing format and behavior.
 */
export const SELF_HOST_DELEGATED_KEY_PREFIX = "exec_";

export const selfHostCredentialToken = (
  headers: Headers | Record<string, string>,
): string | null => {
  const apiKey = headers instanceof Headers ? headers.get("x-api-key") : headers["x-api-key"];
  if (apiKey?.trim()) return apiKey.trim();
  const authorization =
    headers instanceof Headers ? headers.get("authorization") : headers.authorization;
  if (authorization?.toLowerCase().startsWith("bearer ")) {
    const token = authorization.slice(7).trim();
    if (token.length > 0) return token;
  }
  return null;
};

export const isSelfHostDelegatedKey = (headers: Headers | Record<string, string>): boolean =>
  selfHostCredentialToken(headers)?.startsWith(SELF_HOST_DELEGATED_KEY_PREFIX) === true;
