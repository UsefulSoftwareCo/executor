// ---------------------------------------------------------------------------
// When a connection produced no tools, say so.
//
// Discovery can come back empty for reasons that have nothing to do with the
// tool being asked for — most commonly a credential the upstream rejects, which
// is how this was found: a provider returning a value with a stray newline
// broke discovery, the catalog came back empty, and invoking a tool reported
// that the TOOL did not exist. Someone reading that goes looking for a renamed
// or removed tool, which is the one thing that is not wrong.
//
// The address genuinely does not resolve, so `ToolNotFoundError` is the right
// error. What was missing is that it said nothing about the connection behind
// it having no tools at all — the fact that separates "you typed the wrong tool
// name" from "this connection produced nothing".
// ---------------------------------------------------------------------------

import { describe, expect, it } from "@effect/vitest";
import { Effect, Predicate } from "effect";

import { createExecutor } from "./executor";
import {
  AuthTemplateSlug,
  ConnectionName,
  IntegrationSlug,
  ProviderItemId,
  ProviderKey,
  ToolAddress,
  ToolName,
} from "./ids";
import { definePlugin } from "./plugin";
import type { CredentialProvider } from "./provider";
import { makeTestConfig } from "./test-config";

const STORE = ProviderKey.make("memory");
const INTEG = IntegrationSlug.make("demo");
const TEMPLATE = AuthTemplateSlug.make("apiKey");
const CONN = ConnectionName.make("main");

const provider: CredentialProvider = {
  key: STORE,
  writable: true,
  get: () => Effect.succeed("token"),
  set: () => Effect.void,
};

/** `tools` is what discovery produced: empty stands in for a connection whose
 *  upstream rejected the credential, which yields no catalog. */
const pluginWith = (tools: readonly { readonly name: ToolName; readonly description: string }[]) =>
  definePlugin(() => ({
    id: "demo" as const,
    credentialProviders: [provider],
    storage: () => ({}),
    resolveTools: () => Effect.succeed({ tools: [...tools] }),
    invokeTool: ({ toolRow }) => Effect.succeed({ ran: toolRow.name }),
    extension: (ctx) => ({
      seed: () => ctx.core.integrations.register({ slug: INTEG, description: "Demo", config: {} }),
    }),
  }))();

const EMPTY = pluginWith([]);
const POPULATED = pluginWith([
  { name: ToolName.make("inspect"), description: "inspect" },
  { name: ToolName.make("deploy"), description: "deploy" },
]);

const failInvoking = (plugin: ReturnType<typeof pluginWith>, tool: string) =>
  Effect.gen(function* () {
    const executor = yield* createExecutor({ ...makeTestConfig({ plugins: [plugin] as const }) });
    yield* executor.demo.seed();
    yield* executor.connections.create({
      owner: "org",
      name: CONN,
      integration: INTEG,
      template: TEMPLATE,
      from: { provider: STORE, id: ProviderItemId.make("item-1") },
    });

    // `Effect.flip` rather than unwrapping an Exit: the failure becomes the value, already
    // typed, so nothing here inspects a `_tag`, throws, or stringifies an unknown. If the
    // invocation unexpectedly SUCCEEDS, the flip fails the test on its own.
    return yield* Effect.flip(
      executor.execute(ToolAddress.make(`tools.${INTEG}.org.${CONN}.${tool}`), {}),
    );
  });

describe("invoking a tool on a connection that produced no tools", () => {
  it.effect("says the connection produced no tools", () =>
    Effect.gen(function* () {
      const error = yield* failInvoking(EMPTY, "whoami");

      // Naming only the tool sends the reader after a tool that was never the
      // problem. The error has to carry the connection's empty catalog. Asserting
      // on the typed `reason` field rather than the rendered message pins the thing
      // this change actually adds.
      expect(Predicate.isTagged(error, "ToolNotFoundError")).toBe(true);
      if (!Predicate.isTagged(error, "ToolNotFoundError")) return;
      expect(error.reason ?? "").toMatch(/no tools/i);
    }),
  );

  it.effect("still reports a plain unknown tool when the catalog is populated", () =>
    Effect.gen(function* () {
      // The control, and the reason the first assertion means something: a
      // message that always mentioned an empty catalog would satisfy it while
      // being wrong for every ordinary typo.
      const error = yield* failInvoking(POPULATED, "nosuchtool");

      expect(Predicate.isTagged(error, "ToolNotFoundError")).toBe(true);
      if (!Predicate.isTagged(error, "ToolNotFoundError")) return;
      expect(error.reason).toBeUndefined();
    }),
  );
});
