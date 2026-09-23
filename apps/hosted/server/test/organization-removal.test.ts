/** The durable removal steps, driven by a recording step runner instead of an engine. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Effect, Layer } from "effect";
import { StorageError } from "@executor-js/sdk/core";
import { removeOrganizationDurably } from "../src/implementation/organization-removal.ts";
import {
  OrganizationBilling,
  OrganizationRemovalFailed,
  OrganizationRemovals,
  type OrganizationRemovalRecord,
  type OrganizationRemovalStepRunner,
} from "../src/contracts/organization-removal.ts";
import {
  OrganizationForbidden,
  OrganizationIcons,
  OrganizationId,
} from "../src/contracts/organization.ts";
import { Authentication } from "../src/contracts/auth.ts";
import { HostedExecutor } from "../src/contracts/executor.ts";

const organization = OrganizationId.make("org_synthetic");
const iconKey = "0f1e2d3c";
const logo = `/api/organizations/${organization}/icons/${iconKey}`;

/** Record every step, and turn any failure into the named failure the engine would report. */
const recorder = () => {
  const steps: Array<string> = [];
  const run: OrganizationRemovalStepRunner = (name, _retries, work) => {
    steps.push(name);
    return work.pipe(
      Effect.catchCause(() =>
        Effect.fail(new OrganizationRemovalFailed({ organization, step: name })),
      ),
    );
  };
  return { steps, run };
};

/** A world in which every removal step's work has already been done by an earlier attempt. */
const settled = (overrides?: {
  readonly ownerRemove?: Effect.Effect<unknown, unknown>;
  readonly logo?: string | null;
}) => {
  const calls: Array<string> = [];
  const record: { current: OrganizationRemovalRecord } = {
    current: {
      organization,
      instance: organization,
      status: "running",
      logo: overrides?.logo ?? null,
    },
  };
  const executor = {
    // The purge already ran, so this owner has no apps and no webhooks left.
    apps: { list: () => Effect.succeed([]) },
    accounts: { list: () => Effect.succeed([]) },
    webhooks: { list: () => Effect.succeed([]), remove: () => Effect.void },
    owners: {
      remove: () =>
        Effect.sync(() => calls.push("owners.remove")).pipe(
          Effect.andThen(overrides?.ownerRemove ?? Effect.succeed({ apps: 0, accounts: 0 })),
        ),
      check: () => Effect.succeed({ owner: `organization:${organization}` }),
    },
  };
  const services = Layer.mergeAll(
    Layer.succeed(HostedExecutor, Effect.succeed(executor as never)),
    Layer.succeed(OrganizationIcons, {
      upload: () => Effect.die("unused"),
      read: () => Effect.die("unused"),
      remove: (_organization: OrganizationId, key: string) =>
        Effect.sync(() => calls.push(`icons.remove:${key}`)),
    } as never),
    Layer.succeed(Authentication, {
      // The organization row is already gone; an earlier attempt deleted it.
      removeOrganization: () =>
        Effect.sync(() => calls.push("auth.removeOrganization")).pipe(
          Effect.andThen(Effect.fail(new OrganizationForbidden())),
        ),
    } as never),
    Layer.succeed(OrganizationRemovals, {
      read: () => Effect.succeed(record.current),
      begin: () => Effect.succeed(record.current),
      recordLogo: (_organization, value: string | null) =>
        Effect.sync(() => {
          record.current = { ...record.current, logo: value };
        }),
      finish: () =>
        Effect.sync(() => {
          calls.push("removals.finish");
          record.current = { ...record.current, status: "done" };
        }),
    }),
    Layer.succeed(OrganizationBilling, {
      // Autumn reports an expired subscription as already cancelled.
      cancel: () => Effect.sync(() => calls.push("billing.cancel")),
    }),
  );
  return { calls, record, services };
};

const ordered = [
  "unregister-webhooks",
  "purge-owner-store",
  "delete-auth-records",
  "resweep-owner-store",
  "cancel-billing",
  "release-icon",
  "finish",
];

test("every step completes when its work has already been done", async () => {
  const world = settled();
  const { steps, run } = recorder();
  await Effect.runPromise(
    removeOrganizationDurably(organization, run).pipe(Effect.provide(world.services)),
  );

  assert.deepEqual(steps, ordered);
  // A missing organization row is an earlier attempt's success, not a refusal.
  assert.ok(world.calls.includes("auth.removeOrganization"));
  assert.ok(world.calls.includes("removals.finish"));
  assert.equal(world.record.current.status, "done");
});

test("running the whole removal twice changes nothing the second time", async () => {
  const world = settled();
  const { run } = recorder();
  const removal = removeOrganizationDurably(organization, run).pipe(Effect.provide(world.services));
  await Effect.runPromise(removal);
  const afterFirst = [...world.calls];
  await Effect.runPromise(removal);

  assert.deepEqual(world.calls, [...afterFirst, ...afterFirst]);
  assert.equal(world.record.current.status, "done");
});

test("the icon step releases the icon recorded when the organization row was deleted", async () => {
  const world = settled({ logo });
  const { run } = recorder();
  await Effect.runPromise(
    removeOrganizationDurably(organization, run).pipe(Effect.provide(world.services)),
  );

  assert.ok(
    world.calls.includes(`icons.remove:${iconKey}`),
    `Expected the saved icon to be released, got ${world.calls.join(", ")}`,
  );
});

test("an external logo is not treated as a stored icon", async () => {
  const world = settled({ logo: "https://images.example.test/logo.png" });
  const { run } = recorder();
  await Effect.runPromise(
    removeOrganizationDurably(organization, run).pipe(Effect.provide(world.services)),
  );

  assert.ok(!world.calls.some((call) => call.startsWith("icons.remove")));
});

test("a step that keeps failing reports its organization and its step name", async () => {
  const world = settled({ ownerRemove: Effect.fail(new StorageError()) });
  const { steps, run } = recorder();
  const failure = await Effect.runPromise(
    Effect.flip(removeOrganizationDurably(organization, run).pipe(Effect.provide(world.services))),
  );

  assert.equal(failure._tag, "OrganizationRemovalFailed");
  assert.equal(failure.organization, organization);
  assert.equal(failure.step, "purge-owner-store");
  // The run stops there; no later step runs against a store that is unreachable.
  assert.deepEqual(steps, ["unregister-webhooks", "purge-owner-store"]);
  assert.ok(!world.calls.includes("removals.finish"));
});
