import { describe, expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { testAccess } from "@executor-js/product-access/testing";

import type { ExecutorAccess } from "./access";
import { createExecutor } from "./executor";
import { IntegrationSlug, Subject } from "./ids";
import { definePlugin } from "./plugin";
import { makeTestConfig } from "./testing";

// ---------------------------------------------------------------------------
// `ExecutorAccess.settingsWrite` is the product's decision, and core enforces
// it VERBATIM at every user-intent settings sink — including catalog
// replacement from a SUBJECT-LESS executor. A host that hands a subject-less
// binding a denying `settingsWrite` has stated its rule; core must not keep a
// residual rule of its own ("subject-less replacement of an existing row is
// always boot convergence") that overrides the supplied denial. Products that
// WANT boot convergence say so through their access implementation
// (`workspaceServiceAccess`), which these tests also pin.
//
// The fixtures build executors over ONE test database: a workspace-service
// seeder that registers the catalog row, then differently-postured executors
// that attempt to replace it through the same plugin-extension path.
// ---------------------------------------------------------------------------

const SLUG = IntegrationSlug.make("settings-authority");
const SEEDED_DESCRIPTION = "seeded by the workspace service";
const REPLACED_DESCRIPTION = "replaced despite a denied settings decision";

const catalogPlugin = definePlugin(() => ({
  id: "settings-authority-demo" as const,
  storage: () => ({}),
  extension: (ctx) => ({
    register: (description: string) =>
      ctx.core.integrations.register({ slug: SLUG, description, config: {} }),
  }),
}))();

/** The workspace-service posture with the product's settings decision
 *  replaced by an unconditional denial — the host's explicit word. */
const denyingServiceAccess = (): ExecutorAccess => ({
  ...testAccess.org(),
  settingsWrite: () => Effect.succeed("denied" as const),
});

const setup = () =>
  Effect.gen(function* () {
    const config = makeTestConfig({
      subject: null,
      access: testAccess.org(),
      plugins: [catalogPlugin] as const,
    });
    const seeder = yield* createExecutor(config);
    yield* Effect.addFinalizer(() =>
      seeder
        .close()
        .pipe(
          Effect.ignore,
          Effect.andThen(Effect.promise(() => config.testDb.close()).pipe(Effect.ignore)),
        ),
    );
    yield* seeder["settings-authority-demo"].register(SEEDED_DESCRIPTION);
    return { config, seeder };
  });

describe("settingsWrite authority over catalog replacement", () => {
  it.effect("a supplied denial refuses replacement from a subject-less executor", () =>
    Effect.gen(function* () {
      const { config, seeder } = yield* setup();
      const denied = yield* createExecutor({ ...config, access: denyingServiceAccess() });
      yield* Effect.addFinalizer(() => denied.close().pipe(Effect.ignore));

      const outcome = yield* Effect.result(
        denied["settings-authority-demo"].register(REPLACED_DESCRIPTION),
      );
      // The product said "denied"; core must enforce it even with no bound
      // subject — there is no core-owned boot-convergence exemption.
      expect(Result.isFailure(outcome)).toBe(true);
      expect(outcome).toMatchObject({ failure: { _tag: "OrgWriteDeniedError" } });

      const after = yield* seeder.integrations.get(SLUG);
      expect(after?.description).toBe(SEEDED_DESCRIPTION);
    }).pipe(Effect.scoped),
  );

  it.effect("boot convergence stays available when the product allows it", () =>
    Effect.gen(function* () {
      const { seeder } = yield* setup();
      // The same subject-less posture with the product's own (allowing)
      // decision converges the existing row — the rule lives in the product,
      // not in core.
      yield* seeder["settings-authority-demo"].register("converged at boot");
      const after = yield* seeder.integrations.get(SLUG);
      expect(after?.description).toBe("converged at boot");
    }).pipe(Effect.scoped),
  );

  it.effect("baseline: a bound member's denial already refuses replacement", () =>
    Effect.gen(function* () {
      const { config, seeder } = yield* setup();
      const member = yield* createExecutor({
        ...config,
        subject: Subject.make("member-1"),
        access: testAccess.member("denied"),
      });
      yield* Effect.addFinalizer(() => member.close().pipe(Effect.ignore));

      const outcome = yield* Effect.result(
        member["settings-authority-demo"].register(REPLACED_DESCRIPTION),
      );
      expect(Result.isFailure(outcome)).toBe(true);
      expect(outcome).toMatchObject({ failure: { _tag: "OrgWriteDeniedError" } });

      const after = yield* seeder.integrations.get(SLUG);
      expect(after?.description).toBe(SEEDED_DESCRIPTION);
    }).pipe(Effect.scoped),
  );
});
