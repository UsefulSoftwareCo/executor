// ---------------------------------------------------------------------------
// Explicit product-access postures for tests. These are the PRODUCTION rules
// from ./index, packaged so a test states its posture at the call site —
// `makeTestConfig` (from `@executor-js/sdk/testing`) has no default posture.
//
// `@executor-js/sdk`'s OWN tests import this entry too — resolved through
// the workspace ROOT devDependency on `@executor-js/product-access`, not
// through the sdk package itself, which declares no dependency on this
// package. That keeps the package graph acyclic (turbo rejects even
// dev-dependency cycles) while every test states a real product posture.
// ---------------------------------------------------------------------------

import { Effect } from "effect";

import type { ExecutorAccess, OrgWriteAccess } from "@executor-js/sdk/core";

import {
  memberAccess,
  platformObserverAccess,
  requestBoundMemberAccess,
  workspaceServiceAccess,
} from "./index";

/** Explicit product postures for test bindings. */
export const testAccess = {
  /** A bound member with a static workspace-settings decision. */
  member: (workspaceWrites: OrgWriteAccess = "allowed"): ExecutorAccess =>
    memberAccess(workspaceWrites),
  /** A bound member on a session-lifetime stack: the decision is read from
   *  the fiber-local `CurrentOrgWriteAccess` at every guarded sink. */
  requestBound: (): ExecutorAccess => requestBoundMemberAccess(),
  /** A subject-less workspace-service binding (org partition only), with an
   *  optional denied workspace-settings decision for boot-convergence
   *  scenarios. */
  org: (workspaceWrites: OrgWriteAccess = "allowed"): ExecutorAccess => {
    const base = workspaceServiceAccess();
    if (workspaceWrites === "allowed") return base;
    return {
      ...base,
      settingsWrite: (target) =>
        Effect.succeed(target.kind === "owner" && target.owner === "user" ? "allowed" : "denied"),
    };
  },
  /** The platform observer posture; `subject: false` is the production
   *  subject-less shape, the default keeps a bound subject's partitions for
   *  tests that combine a member binding with the platform capabilities. */
  platform: (options?: { readonly subject?: boolean }): ExecutorAccess =>
    options?.subject === false
      ? platformObserverAccess()
      : {
          ...platformObserverAccess(),
          owners: ["user", "org"],
        },
} as const;
