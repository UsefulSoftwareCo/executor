// ---------------------------------------------------------------------------
// A credential provider that stops answering must fail the resolution, not hang it.
//
// A provider is frequently REMOTE — an HTTP secret store, or under sealed custody a
// vault that may live in another enclave — so "stopped answering" is one of its
// ordinary failure modes. Unbounded, a store that goes away does not fail a tool
// invocation, it hangs it, and nothing in the resulting silence names the provider.
//
// Executor already bounds its other remote calls this way (OAuth discovery, the MCP
// plugin's probes); credential resolution was the one that did not.
//
// Time is virtual here: the bound is deliberately generous, and a test that waited
// it out in real time would be a thirty-second test. TestClock is advanced past it
// instead — which is also why this uses `it.effect` rather than `it.live`.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { createExecutor } from "./executor";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./test-config";

const STORE = ProviderKey.make("remote-store");
const INTEG = IntegrationSlug.make("acme");
const CONN = ConnectionName.make("main");

const providerWith = (get: CredentialProvider["get"]): CredentialProvider => ({
  key: STORE,
  writable: true,
  get,
  set: () => Effect.void,
});

const plugin = (provider: CredentialProvider) =>
  definePlugin(() => ({
    id: "acme" as const,
    credentialProviders: [provider],
    storage: () => ({}),
    extension: (ctx) => ({
      seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Acme", config: {} }),
      read: () => ctx.connections.resolveValue({ owner: "org", integration: INTEG, name: CONN }),
    }),
  }))();

const executorWithConnection = (provider: CredentialProvider) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor(
      makeTestConfig({ plugins: [plugin(provider)] as const }),
    );
    yield* executor.acme.seed();
    yield* executor.connections.create({
      owner: "org",
      name: CONN,
      integration: INTEG,
      template: AuthTemplateSlug.make("api_key"),
      from: { provider: STORE, id: ProviderItemId.make("item-1") },
    });
    return executor;
  });

describe("a credential provider that stops answering", () => {
  it.effect("fails the resolution instead of hanging it", () =>
    Effect.gen(function* () {
      const executor = yield* executorWithConnection(providerWith(() => Effect.never));

      const fiber = yield* Effect.forkChild(Effect.exit(executor.acme.read()));
      yield* TestClock.adjust(Duration.minutes(5));
      const exit = yield* Fiber.join(fiber);

      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("names the provider and the operation, not just a failure", () =>
    Effect.gen(function* () {
      // A bare timeout would leave an operator looking at whatever the caller was
      // doing rather than at the store that stopped answering.
      const executor = yield* executorWithConnection(providerWith(() => Effect.never));

      const fiber = yield* Effect.forkChild(Effect.exit(executor.acme.read()));
      yield* TestClock.adjust(Duration.minutes(5));
      const exit = yield* Fiber.join(fiber);

      expect(String(exit)).toContain("remote-store");
      expect(String(exit)).toContain("did not answer");
      // The operation, too — without this the test passes its own name by accident:
      // the operation could drop out of the message entirely and nothing would notice.
      expect(String(exit)).toContain("get");
    }),
  );

  it.effect("an object-literal provider stores a pasted value — the control", () =>
    Effect.gen(function* () {
      // The control for the class case below: identical in every respect except that the
      // provider is an object literal. Without it, a red class test could mean anything.
      const items = new Map<string, string>();
      const lit: CredentialProvider = {
        key: STORE,
        writable: true,
        get: (id) => Effect.sync(() => items.get(String(id)) ?? null),
        set: (id, value) => Effect.sync(() => void items.set(String(id), value)),
      };
      const executor = yield* createExecutor(makeTestConfig({ plugins: [plugin(lit)] as const }));
      yield* executor.acme.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: AuthTemplateSlug.make("api_key"),
        value: "tok",
      });
      expect(yield* executor.acme.read()).toBe("tok");
    }),
  );

  it.effect("wraps a CLASS-based provider without breaking its methods", () =>
    Effect.gen(function* () {
      // The wrapper must not change HOW a provider's own methods are called. `get` was
      // invoked with its receiver (`provider.get(id)`) but the optional methods were
      // destructured and called bare, which silently drops `this`. Every in-tree provider
      // is an object literal and cannot notice; a provider written as a class — exactly
      // what "wrap any provider" invites — throws TypeError on the first optional call.
      class ClassProvider {
        readonly key = STORE;
        readonly writable = true;
        private readonly items = new Map<string, string>();
        get(id: ProviderItemId) {
          return Effect.sync(() => this.items.get(String(id)) ?? null);
        }
        set(id: ProviderItemId, value: string) {
          // `this` is the whole point: bare invocation makes this line throw.
          return Effect.sync(() => void this.items.set(String(id), value));
        }
      }

      const executor = yield* createExecutor(
        makeTestConfig({ plugins: [plugin(new ClassProvider() as CredentialProvider)] as const }),
      );
      yield* executor.acme.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: AuthTemplateSlug.make("api_key"),
        value: "tok",
      });

      expect(yield* executor.acme.read()).toBe("tok");
    }),
  );

  it.effect("keeps a capability the provider defines on its PROTOTYPE", () =>
    Effect.gen(function* () {
      // The wrapper must not change the provider's SHAPE either. A spread copies only own
      // ENUMERABLE properties, so anything on a class's prototype — every method, and any
      // accessor like the `writable` below — is dropped silently. Nothing raises; the wrapper
      // simply appears not to have it, and the caller takes a path the provider meant to own.
      // Here that means `defaultWritableProvider` no longer sees a writable store, so creating
      // a connection from a pasted value fails with no provider at all.
      class PrototypeProvider {
        readonly key = STORE;
        private readonly items = new Map<string, string>();
        // On the PROTOTYPE, not the instance — this is the property a spread loses.
        get writable() {
          return true;
        }
        get(id: ProviderItemId) {
          return Effect.sync(() => this.items.get(String(id)) ?? null);
        }
        set(id: ProviderItemId, value: string) {
          return Effect.sync(() => void this.items.set(String(id), value));
        }
      }

      const executor = yield* createExecutor(
        makeTestConfig({
          plugins: [plugin(new PrototypeProvider() as CredentialProvider)] as const,
        }),
      );
      yield* executor.acme.seed();
      yield* executor.connections.create({
        owner: "org",
        name: CONN,
        integration: INTEG,
        template: AuthTemplateSlug.make("api_key"),
        value: "tok",
      });

      expect(yield* executor.acme.read()).toBe("tok");
    }),
  );

  it.effect("still resolves normally when the provider answers", () =>
    Effect.gen(function* () {
      // The control. A bound that refused everything would satisfy both assertions
      // above while breaking every working deployment.
      const executor = yield* executorWithConnection(providerWith(() => Effect.succeed("tok")));

      expect(yield* executor.acme.read()).toBe("tok");
    }),
  );
});
