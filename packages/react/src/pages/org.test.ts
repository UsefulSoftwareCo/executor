import { describe, expect, it } from "@effect/vitest";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Cause from "effect/Cause";

import { canManageOrganizationRole, resolveOrgPageAccess, resolveOrgPageAccessResult } from "./org";

describe("canManageOrganizationRole", () => {
  it("allows the roles accepted by the account providers", () => {
    expect(canManageOrganizationRole("admin")).toBe(true);
    expect(canManageOrganizationRole("owner")).toBe(true);
  });

  it("hides management controls from non-administrative roles", () => {
    expect(canManageOrganizationRole("member")).toBe(false);
    expect(canManageOrganizationRole("viewer")).toBe(false);
    expect(canManageOrganizationRole(null)).toBe(false);
  });
});

describe("resolveOrgPageAccessResult", () => {
  it("maps the request lifecycle without treating loading or failure as read-only", () => {
    const failure = AsyncResult.failure(Cause.fail("offline"));

    expect(resolveOrgPageAccessResult(AsyncResult.initial())).toEqual({
      status: "loading",
      canManageOrganization: false,
    });
    expect(resolveOrgPageAccessResult(failure)).toEqual({
      status: "failed",
      canManageOrganization: false,
    });
    expect(resolveOrgPageAccessResult(AsyncResult.waiting(failure))).toEqual({
      status: "loading",
      canManageOrganization: false,
    });
  });

  it("uses the current member role only after the request succeeds", () => {
    expect(
      resolveOrgPageAccessResult(
        AsyncResult.success({
          members: [
            { isCurrentUser: false, role: "admin" },
            { isCurrentUser: true, role: "member" },
          ],
        }),
      ),
    ).toEqual({ status: "denied", canManageOrganization: false });
  });
});

describe("resolveOrgPageAccess", () => {
  it("keeps permission loading distinct from a denied role", () => {
    expect(resolveOrgPageAccess({ status: "loading" })).toEqual({
      status: "loading",
      canManageOrganization: false,
    });
    expect(resolveOrgPageAccess({ status: "resolved", role: "member" })).toEqual({
      status: "denied",
      canManageOrganization: false,
    });
  });

  it("allows administrators only after their role resolves", () => {
    expect(resolveOrgPageAccess({ status: "resolved", role: "admin" })).toEqual({
      status: "allowed",
      canManageOrganization: true,
    });
    expect(resolveOrgPageAccess({ status: "resolved", role: "owner" })).toEqual({
      status: "allowed",
      canManageOrganization: true,
    });
  });

  it("keeps request failure and a missing current membership explicit", () => {
    expect(resolveOrgPageAccess({ status: "failed" })).toEqual({
      status: "failed",
      canManageOrganization: false,
    });
    expect(resolveOrgPageAccess({ status: "resolved", role: null })).toEqual({
      status: "failed",
      canManageOrganization: false,
    });
  });
});
