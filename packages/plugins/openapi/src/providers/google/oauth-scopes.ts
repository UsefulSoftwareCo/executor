const googleUserConsentBlockedScopes = new Set([
  "https://www.googleapis.com/auth/chat.bot",
  "https://www.googleapis.com/auth/chat.import",
  "https://www.googleapis.com/auth/keep",
  "https://www.googleapis.com/auth/keep.readonly",
]);

const googleUserConsentBlockedScopePrefixes = ["https://www.googleapis.com/auth/chat.app."];

const googleBroadScopeGroups: readonly {
  readonly broad: string;
  readonly prefixes: readonly string[];
}[] = [
  {
    broad: "https://mail.google.com/",
    prefixes: ["https://www.googleapis.com/auth/gmail."],
  },
  {
    broad: "https://www.googleapis.com/auth/calendar",
    prefixes: ["https://www.googleapis.com/auth/calendar."],
  },
  {
    broad: "https://www.googleapis.com/auth/drive",
    prefixes: ["https://www.googleapis.com/auth/drive."],
  },
];

const normalizeGoogleIdentityScope = (scope: string): string =>
  scope === "https://www.googleapis.com/auth/userinfo.email"
    ? "email"
    : scope === "https://www.googleapis.com/auth/userinfo.profile"
      ? "profile"
      : scope;

const orderedUniqueScopes = (scopes: Iterable<string>): string[] => {
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const trimmed = scope.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
};

export const isGoogleUserConsentOAuthScope = (scope: string): boolean =>
  !googleUserConsentBlockedScopes.has(scope) &&
  !googleUserConsentBlockedScopePrefixes.some((prefix) => scope.startsWith(prefix));

export const filterGoogleUserConsentOAuthScopes = (scopes: Iterable<string>): string[] =>
  orderedUniqueScopes(scopes).filter(isGoogleUserConsentOAuthScope);

export const compactGoogleOAuthScopes = (scopes: Iterable<string>): string[] => {
  const ordered = filterGoogleUserConsentOAuthScopes([...scopes].map(normalizeGoogleIdentityScope));
  const present = new Set(ordered);
  return ordered.filter(
    (scope) =>
      !googleBroadScopeGroups.some(
        (group) =>
          scope !== group.broad &&
          present.has(group.broad) &&
          group.prefixes.some((prefix) => scope.startsWith(prefix)),
      ),
  );
};
