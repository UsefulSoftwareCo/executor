export const siteVisitorCookie = (origin: string) =>
  `${new URL(origin).protocol === "https:" ? "__Host-" : ""}executor_visitor`;

export const siteVisitorDays = 90;

const anonymousId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const readSiteVisitor = (cookies: string, origin: string) => {
  const name = siteVisitorCookie(origin);
  const raw = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  const value = raw?.slice(name.length + 1);
  return value !== undefined && anonymousId.test(value) ? value : undefined;
};
