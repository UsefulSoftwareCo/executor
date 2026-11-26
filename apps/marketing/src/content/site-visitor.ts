export const siteVisitorCookie = "executor_visitor";

export const siteVisitorDays = 90;

const anonymousId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export const readSiteVisitor = (cookies: string) => {
  const raw = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${siteVisitorCookie}=`));
  const value = raw?.slice(siteVisitorCookie.length + 1);
  return value !== undefined && anonymousId.test(value) ? value : undefined;
};
