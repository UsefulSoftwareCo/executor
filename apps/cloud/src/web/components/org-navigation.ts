import { isValidOrgSlug } from "@executor-js/api";

export type OrganizationNavigationLocation = {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
};

export const organizationNavigationHref = (
  targetSlug: string,
  location: OrganizationNavigationLocation,
) => {
  const segments = location.pathname.split("/");
  const currentSlug = segments[1];
  let pathname: string;

  if (currentSlug && isValidOrgSlug(currentSlug)) {
    segments[1] = targetSlug;
    pathname = segments.join("/");
  } else if (location.pathname === "/") {
    pathname = `/${targetSlug}`;
  } else {
    pathname = `/${targetSlug}${location.pathname.startsWith("/") ? "" : "/"}${location.pathname}`;
  }

  return `${pathname}${location.search}${location.hash}`;
};
