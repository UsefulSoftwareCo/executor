export const activeOrganizationMemberships = <Membership extends { readonly status: string }>(
  memberships: ReadonlyArray<Membership>,
) => memberships.filter((membership) => membership.status === "active");
