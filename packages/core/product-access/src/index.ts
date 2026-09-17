// ---------------------------------------------------------------------------
// @executor-js/product-access — the PRODUCT's personal/organization access
// rules, stated once and selected explicitly by every composition root.
//
// The SDK owns none of these. `createExecutor` requires an `ExecutorAccess`
// and enforces its decisions at core's sinks — storage row visibility and
// write partitions (`owners`), the user-intent settings gate
// (`settingsWrite`), view capabilities (`capabilities`), and effective
// tool-policy evaluation (`toolPolicy`) — while the storage owner policy
// keeps clamping everything to the binding's tenant/subject partition.
// This package is where "what may this principal touch" is decided:
//   - the role rule (admins configure the workspace, members use it),
//   - the personal-stays-open settings rule (a denied member still manages
//     Personal-scope resources),
//   - the request-bound session posture (MCP sessions re-decide per request
//     and re-stamp on approval resume),
//   - the single-user posture (local daemon / CLI / examples),
//   - the subject-less workspace-service and platform-observer postures,
//   - how authored policy rows and toolkit capability rules resolve
//     (`./policy`).
// Non-HTTP hosts consume it without pulling `@executor-js/api`.
//
// Imports come from the PUBLISHED sdk entries: `@executor-js/sdk/core` (the
// Effect SDK; the sdk ROOT export is the Promise façade) and the
// browser-safe `@executor-js/sdk/shared` inside `./policy`.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import {
  currentOrgWriteAccess,
  type AccessDecision,
  type ExecutorAccess,
  type OrgWriteAccess,
  type Owner,
  type SettingsWriteTarget,
} from "@executor-js/sdk/core";

import { standardToolPolicy } from "./policy";

export {
  effectivePolicyFromSorted,
  resolveEffectivePolicy,
  resolveProviderPolicyFromRules,
  resolveToolPolicy,
  standardToolPolicy,
  type ToolPolicyRuleLike,
} from "./policy";

/** The role shape the org-write rule reads — structural, so both the API's
 *  `Principal` and host-mcp's schema'd copy satisfy it without translation. */
export interface OrgRoleInput {
  /** `"organization"` when the deployment has an org role model, `"none"`
   *  when it does not (self-host single-org, local). */
  readonly orgRoleModel: "organization" | "none";
  /** The acting member's role under an `"organization"` model. Missing at a
   *  legacy boundary fails closed (treated as a plain member). */
  readonly orgRole?: "admin" | "member" | undefined;
}

/**
 * THE product rule for workspace-settings writes: a deployment without a
 * role model trusts its user; under a role model only admins configure the
 * workspace, and an absent role fails closed. Previously duplicated by the
 * HTTP execution-stack middleware and the MCP serving seams — this is now
 * the single home.
 */
export const orgWriteAccessForRole = (input: OrgRoleInput): OrgWriteAccess =>
  input.orgRoleModel === "none" || input.orgRole === "admin" ? "allowed" : "denied";

/** A bound member's partitions, personal shadowing shared. */
const MEMBER_OWNERS: readonly Owner[] = ["user", "org"];
/** A subject-less binding's single partition. */
const ORG_OWNERS: readonly Owner[] = ["org"];

/**
 * The settings rule every current product shares: Personal-scope targets
 * are always the member's own to configure; workspace-level targets (org
 * rows and tenant-shared surfaces) follow the workspace decision, evaluated
 * LIVE at each sink so a request-bound decision is re-read after pauses.
 */
const personalOpenSettingsWrite =
  (workspace: Effect.Effect<AccessDecision>) =>
  (target: SettingsWriteTarget): Effect.Effect<AccessDecision> =>
    target.kind === "owner" && target.owner === "user"
      ? Effect.succeed("allowed" as const)
      : workspace;

const memberCapabilities = { adminReads: false, storageWrites: "allowed" } as const;

const memberPosture = (workspace: Effect.Effect<AccessDecision>): ExecutorAccess => ({
  owners: MEMBER_OWNERS,
  settingsWrite: personalOpenSettingsWrite(workspace),
  capabilities: memberCapabilities,
  toolPolicy: standardToolPolicy(MEMBER_OWNERS),
});

/**
 * A bound member whose workspace-settings decision was made from the freshly
 * authenticated request and holds for its lifetime — the HTTP API plane,
 * where every request re-authenticates and builds a new stack.
 */
export const memberAccess = (workspaceWrites: OrgWriteAccess): ExecutorAccess =>
  memberPosture(Effect.succeed(workspaceWrites));

/** {@link memberAccess} with the decision derived by {@link orgWriteAccessForRole}. */
export const memberAccessForRole = (input: OrgRoleInput): ExecutorAccess =>
  memberAccess(orgWriteAccessForRole(input));

/**
 * A bound member on a session-lifetime stack (MCP sessions): the executor
 * outlives any one request, so the workspace-settings decision is read from
 * the fiber-local `CurrentOrgWriteAccess` at EVERY guarded sink. The session
 * host stamps that reference from each freshly authenticated request, the
 * engine re-stamps it from the resuming principal on approval resume, and a
 * missing binding fails closed (denied) — a positive authorization is never
 * cached for the session lifetime.
 */
export const requestBoundMemberAccess = (): ExecutorAccess => memberPosture(currentOrgWriteAccess);

/**
 * The single-user products (local daemon, CLI, desktop, examples): one human
 * owns the whole deployment, there is no role model, and the bound subject
 * may configure everything.
 */
export const singleUserAccess = (): ExecutorAccess => memberPosture(Effect.succeed("allowed"));

/**
 * A subject-less workspace-service binding — boot/system executors that
 * converge the tenant's shared state (catalog registration, seeding) with no
 * acting member. Sees and writes only the org partition; workspace writes
 * are the whole point.
 */
export const workspaceServiceAccess = (): ExecutorAccess => ({
  owners: ORG_OWNERS,
  settingsWrite: personalOpenSettingsWrite(Effect.succeed("allowed")),
  capabilities: memberCapabilities,
  toolPolicy: standardToolPolicy(ORG_OWNERS),
});

/**
 * The platform observer an org-level credential gets (the `/admin/*` plane):
 * subject-less, the WHOLE executor read-only at the storage boundary
 * (`storageWrites: "denied"`), and only the `admin` surface reading
 * tenant-wide (`adminReads: true`).
 *
 * `settingsWrite` stays `"allowed"` ON PURPOSE: the platform posture's
 * enforcement point is the storage owner policy, which refuses every
 * mutation regardless of the surface gate. Deciding `"denied"` here would
 * merely swap the failure the (already unreachable-over-HTTP) mutation
 * surfaces raise from the storage denial to `OrgWriteDeniedError`; the
 * observer's read-only-ness never depends on it.
 */
export const platformObserverAccess = (): ExecutorAccess => ({
  owners: ORG_OWNERS,
  settingsWrite: personalOpenSettingsWrite(Effect.succeed("allowed")),
  capabilities: { adminReads: true, storageWrites: "denied" },
  toolPolicy: standardToolPolicy(ORG_OWNERS),
});
