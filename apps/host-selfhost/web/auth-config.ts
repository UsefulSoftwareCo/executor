// Pre-login read of which SSO providers the operator configured, so the login
// page knows which provider buttons to render. Same boundary as setup-status: a
// plain same-origin fetch that runs before the atom registry exists. Fails soft
// to "no providers" — the email/password form is always available, so a hiccup
// here degrades to the baseline login, never a lockout.

export interface SsoProvider {
  readonly id: string;
  readonly name: string;
}

const isSsoProvider = (value: unknown): value is SsoProvider =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as { id?: unknown }).id === "string" &&
  typeof (value as { name?: unknown }).name === "string";

export const fetchSsoProviders = async (): Promise<readonly SsoProvider[]> => {
  const response = await fetch("/api/auth-config", { credentials: "same-origin" }).then(
    (r) => r,
    () => null,
  );
  if (!response?.ok) return [];
  const data = (await response.json().then(
    (d) => d,
    () => ({}),
  )) as { ssoProviders?: unknown };
  return Array.isArray(data.ssoProviders) ? data.ssoProviders.filter(isSsoProvider) : [];
};
