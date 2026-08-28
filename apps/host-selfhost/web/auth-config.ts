// Pre-login read of which social sign-in providers the operator configured, so
// the login page knows which provider buttons to render. Same boundary as
// setup-status: a plain same-origin fetch that runs before the atom registry
// exists. Fails soft to "no providers" — the email/password form is always
// available, so a hiccup here degrades to the baseline login, never a lockout.

export const fetchSocialProviders = async (): Promise<readonly string[]> => {
  const response = await fetch("/api/auth-config", { credentials: "same-origin" }).then(
    (r) => r,
    () => null,
  );
  if (!response?.ok) return [];
  const data = (await response.json().then(
    (d) => d,
    () => ({}),
  )) as { socialProviders?: unknown };
  return Array.isArray(data.socialProviders)
    ? data.socialProviders.filter((p): p is string => typeof p === "string")
    : [];
};
