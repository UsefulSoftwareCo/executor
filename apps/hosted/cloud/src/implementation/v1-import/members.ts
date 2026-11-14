/**
 * Who a v1 organization's v2 organization is for (`notes/v1-import.md`, decisions 8, 13 and 17),
 * and which plan v1 bills it on, decided from WorkOS and Autumn alone.
 */
import type { V1Membership, V1User } from "./source.ts";

/**
 * A v1 member the import moves, with the v2 role they get. It names the member by id only: plans
 * are kept as Workflow step results, so a step that needs their email or name reads it again
 * (`memberProfile`).
 */
export interface PlannedMember {
  /** Their WorkOS user id, which v1 rows name as `subject`. */
  readonly user: string;
  /** Their WorkOS membership id, a ULID: the oldest sorts first. */
  readonly membership: string;
  readonly role: "owner" | "admin" | "member";
}

/** A v1 member the import does not move, and why. */
export interface SkippedMember {
  readonly user: string;
  /** Their email is unverified (decision 17), or their membership is not active. */
  readonly reason: "unverified_email" | "pending" | "inactive";
}

export type MemberPlan =
  | {
      readonly ok: true;
      /** The owner first, then the others oldest first. */
      readonly members: readonly [PlannedMember, ...PlannedMember[]];
      readonly skipped: readonly SkippedMember[];
    }
  | { readonly ok: false; readonly reason: string; readonly skipped: readonly SkippedMember[] };

/** A member's v2 email and display name, as their v1 WorkOS user gives them. */
export const memberProfile = (user: V1User) => ({
  email: user.email.toLowerCase(),
  name:
    [user.first_name, user.last_name]
      .filter((part): part is string => typeof part === "string" && part.trim() !== "")
      .join(" ") || user.email,
});

/**
 * The members an import moves and their roles. Only active memberships move; pending and inactive
 * ones are listed as skipped. A WorkOS user whose email is not verified is not imported (decision
 * 17). The owner is the oldest membership of an active admin, or, with no active admin, the oldest
 * active member; every other admin stays an admin (decision 8).
 */
export const planMembers = (
  memberships: readonly V1Membership[],
  users: ReadonlyMap<string, V1User>,
): MemberPlan => {
  const ordered = [...memberships].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const skipped: SkippedMember[] = [];
  const verified = ordered.flatMap((membership) => {
    if (membership.status !== "active") {
      skipped.push({ user: membership.user, reason: membership.status });
      return [];
    }
    const user = users.get(membership.user);
    if (user === undefined || !user.email_verified) {
      skipped.push({ user: membership.user, reason: "unverified_email" });
      return [];
    }
    return [membership];
  });
  const owner = verified.find((membership) => membership.role === "admin") ?? verified[0];
  if (owner === undefined)
    return { ok: false, reason: "No active member has a verified email.", skipped };
  const planned = (membership: V1Membership, role: PlannedMember["role"]): PlannedMember => ({
    user: membership.user,
    membership: membership.id,
    role,
  });
  return {
    ok: true,
    members: [
      planned(owner, "owner"),
      ...verified
        .filter((membership) => membership !== owner)
        .map((membership) => planned(membership, membership.role)),
    ],
    skipped,
  };
};

/** v1's billing for an organization, from the plans Autumn bills it on. */
export type V1Billing =
  | { readonly kind: "free" }
  /**
   * Enterprise orgs move by hand (decision 15): only when the operator lists one to copy into an
   * existing v2 organization, carrying nothing over (decision 34).
   */
  | { readonly kind: "enterprise"; readonly plans: readonly string[] }
  /**
   * v1's grandfathered Hobby and Professional plans, which no Stripe subscription bills. The
   * organization moves to v2's Free plan, as a free one does, with nothing to carry over.
   */
  | { readonly kind: "grandfathered"; readonly plans: readonly string[] }
  | { readonly kind: "paid"; readonly plans: readonly string[] };

const enterprisePlan = (plan: string) => plan === "enterprise" || plan.startsWith("enterprise-");

/** v1's plans that cost nothing. Every other plan, including ones added later, is paid. */
export const freePlans: ReadonlyArray<string> = ["free", "free-pay-as-you-go"];

/** v1 plans that move to v2's Free plan (decision 30). */
export const grandfatheredPlans: ReadonlyArray<string> = ["hobby", "professional"];

export const v1Billing = (plans: readonly string[]): V1Billing => {
  if (plans.some(enterprisePlan)) return { kind: "enterprise", plans };
  const paid = plans.filter((plan) => !freePlans.includes(plan));
  if (paid.length === 0) return { kind: "free" };
  return paid.every((plan) => grandfatheredPlans.includes(plan))
    ? { kind: "grandfathered", plans: paid }
    : { kind: "paid", plans: paid };
};
