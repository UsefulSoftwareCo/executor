/**
 * Same-origin anonymous attribution only. A hosted dashboard never consumes an identity supplied
 * by another subdomain, including an untrusted app. This cookie grants no account access.
 */
export const siteVisitorCookie = (origin: string) =>
  `${new URL(origin).protocol === "https:" ? "__Host-" : ""}executor_visitor`;

/** How long a visit stays attributable to a later sign-up. */
export const siteVisitorDays = 90;

const anonymousId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

/** Parse only a well-formed anonymous ID; anything else is ignored. */
export const readSiteVisitor = (cookies: string, origin: string) => {
  const name = siteVisitorCookie(origin);
  const raw = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  const value = raw?.slice(name.length + 1);
  return value !== undefined && anonymousId.test(value) ? value : undefined;
};
