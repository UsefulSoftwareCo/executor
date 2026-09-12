export type OrgRoleMetadata =
  | {
      readonly orgRoleModel: "organization";
      readonly orgRole?: "admin" | "member";
    }
  | {
      readonly orgRoleModel: "none";
      readonly orgRole?: never;
    };

/** Project a role source into the serializable discriminated union. */
export const sessionOrgRoleMetadata = (source: {
  readonly orgRoleModel: "organization" | "none";
  readonly orgRole?: "admin" | "member";
}): OrgRoleMetadata =>
  source.orgRoleModel === "none"
    ? { orgRoleModel: "none" }
    : {
        orgRoleModel: "organization",
        ...(source.orgRole === undefined ? {} : { orgRole: source.orgRole }),
      };
