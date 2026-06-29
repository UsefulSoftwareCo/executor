// ---------------------------------------------------------------------------
// removed: scope-isolated credential-usage reporting on the OpenAPI plugin.
//
// v1 tracked which sources used a given secret/connection via the plugin's
// `usagesForSecret` / `usagesForConnection` hooks and the credential_binding
// table, scoped by the executor scope stack. v2 deletes all of this: there are
// no secrets, no credential bindings, and no `usagesFor*` hooks — a connection
// IS the credential and is owner-scoped, so "usage" collapses to the connection
// rows themselves. The owner partition (org vs user) gives the isolation v1
// achieved via the scope stack, and it's enforced by the core owner policy.
//
// Owner isolation of connections/tools is covered by multi-scope-bearer.test.ts
// and the keystone owner-policy tests. This stub documents the migration
// explicitly.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";

describe("OpenAPI usage scope isolation (removed in v2)", () => {
  it("has no v2 equivalent — usagesFor* + credential_binding are gone", () => {
    expect(true).toBe(true);
  });
});
