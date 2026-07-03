export const consoleBasePath = (orgSlug?: string): string =>
  orgSlug ? `/${encodeURIComponent(orgSlug)}` : "";
