/**
 * The site's anonymous PostHog identity, shared with sign-up on the browser origin so a new account
 * can be linked to the visit that led to it. No visitor cookie grants authentication or
 * authorization.
 */
export const siteVisitorCookie = "executor_visitor";

/** How long a visit stays attributable to a later sign-up. */
export const siteVisitorDays = 90;

const anonymousId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Parse only a well-formed anonymous ID; anything else is ignored. */
export const readSiteVisitor = (cookies: string) => {
  const raw = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${siteVisitorCookie}=`));
  const value = raw?.slice(siteVisitorCookie.length + 1);
  return value !== undefined && anonymousId.test(value) ? value : undefined;
};
