# @executor-js/sdk

A TypeScript SDK for building executors that wire together tool sources, secrets, and policies across MCP, OpenAPI, GraphQL, and custom plugins.

The default surface is `Promise`-based — plugins are built on [Effect](https://effect.website/) under the hood, but consumers never have to touch it.

## Install

```sh
bun add @executor-js/sdk
# or
npm install @executor-js/sdk
```

## Quick start

```ts
import { createExecutor } from "@executor-js/sdk";

const executor = await createExecutor({
  // Required: how to respond when a tool requests user input mid-call.
  // `"accept-all"` auto-approves every prompt — fine for tests/automation.
  // For an interactive host, pass a handler `(ctx) => Promise<ElicitationResponse>`.
  onElicitation: "accept-all",
});

const tools = await executor.tools.list();
console.log(`scope=${executor.scopes[0]!.id} tools=${tools.length}`);

await executor.close();
```

`createExecutor` returns an executor backed by an in-memory store and a default scope (`default-scope`). Without plugins it has no tools or secret providers — the surface is still there, it just enumerates empty. Add plugins to contribute tools, secret providers, and per-plugin extension methods.

To invoke a tool once one is registered:

```ts
import { createExecutor } from "@executor-js/sdk";

const executor = await createExecutor({ onElicitation: "accept-all" });

const tools = await executor.tools.list();
const target = tools[0];
if (target) {
  const result = await executor.tools.invoke(target.id, {
    /* args matching target.inputSchema */
  });
  console.log(result);
}

await executor.close();
```

Pass an `options` object only if you need to override the executor-level handler for a single call (rare — typically used by hosts that bridge per-client elicitation channels):

```ts
await executor.tools.invoke(target.id, args, {
  onElicitation: customHandler,
});
```

## Two import paths

The SDK ships two surfaces from the same package:

- `@executor-js/sdk` — the **Promise** surface for end users. Returns plain `Promise`s, no Effect required. This is what the quick start above uses.
- `@executor-js/sdk/core` — the **Effect** surface for plugin authors. Exposes `definePlugin`, the typed error classes, schema helpers, and the Effect-shaped `Executor`. Every `@executor-js/plugin-*` package mirrors the same split.

End users only ever need the root import. Plugin authors reach for `/core` because writing a plugin means returning Effect-shaped callbacks for storage, tool invocation, and secret providers.

## Authoring a plugin

A plugin is a factory that returns a spec object. The factory accepts plugin-author options and returns `{ id, storage, extension?, secretProviders?, ... }`. The shape of `extension` becomes `executor[plugin.id]` in the resulting executor — and on the Promise side every Effect-returning method is automatically promisified.

```ts
import { Effect } from "effect";
import { definePlugin, type SecretProvider } from "@executor-js/sdk/core";
import { createExecutor } from "@executor-js/sdk";

interface MemorySecretsConfig {
  readonly initial?: Readonly<Record<string, string>>;
}

// definePlugin takes a factory and returns a configured-plugin function
// that the consumer calls with options.
export const memorySecretsPlugin = definePlugin((options?: MemorySecretsConfig) => {
  const map = new Map<string, string>(Object.entries(options?.initial ?? {}));
  const provider: SecretProvider = {
    key: "memory",
    writable: true,
    get: (id: string) => Effect.sync(() => map.get(id) ?? null),
    has: (id: string) => Effect.sync(() => map.has(id)),
    set: (id: string, value: string) => Effect.sync(() => void map.set(id, value)),
    delete: (id: string) => Effect.sync(() => map.delete(id)),
    list: () => Effect.sync(() => Array.from(map.keys()).map((k) => ({ id: k, name: k }))),
  };

  return {
    id: "memorySecrets" as const,
    storage: () => ({}),
    extension: () => ({
      label: "in-memory secrets",
    }),
    secretProviders: () => [provider],
  };
});

// End users compose the executor exactly the same way as above —
// the plugin's extension is reachable as `executor.memorySecrets`.
const executor = await createExecutor({
  plugins: [memorySecretsPlugin({ initial: { greeting: "hello" } })] as const,
  onElicitation: "accept-all",
});

console.log(executor.memorySecrets.label); // "in-memory secrets"

await executor.secrets.set({
  id: "api-token",
  name: "API Token",
  value: "sk_live_xxx",
  scope: executor.scopes[0]!.id,
});

console.log(await executor.secrets.get("api-token")); // "sk_live_xxx"

await executor.close();
```

The same pattern is what every shipped `@executor-js/plugin-*` package does internally. See [`packages/plugins/file-secrets`](https://github.com/RhysSullivan/executor/tree/main/packages/plugins/file-secrets) for a production example that backs `secretProviders` with an XDG-located JSON file.

## Plugins

These plugin packages are published from the monorepo:

- [`@executor-js/plugin-mcp`](https://www.npmjs.com/package/@executor-js/plugin-mcp) — Model Context Protocol sources (stdio + remote)
- [`@executor-js/plugin-openapi`](https://www.npmjs.com/package/@executor-js/plugin-openapi) — OpenAPI specs and Google Discovery documents as tools
- [`@executor-js/plugin-graphql`](https://www.npmjs.com/package/@executor-js/plugin-graphql) — GraphQL endpoints as tools
- [`@executor-js/plugin-file-secrets`](https://www.npmjs.com/package/@executor-js/plugin-file-secrets) — file-backed secret store
- [`@executor-js/plugin-keychain`](https://www.npmjs.com/package/@executor-js/plugin-keychain) — OS keychain secret store
- [`@executor-js/plugin-onepassword`](https://www.npmjs.com/package/@executor-js/plugin-onepassword) — 1Password secret source

Each plugin exposes the same dual `.` / `./core` entry split as the SDK itself: end users import from the root, plugin authors who need to compose internals import from `/core`.

## Secrets

Secrets are scoped per executor and shared across every plugin that contributes a provider. A writable provider must be registered (via a plugin) before `set` will succeed.

```ts
import { createExecutor } from "@executor-js/sdk";

declare const executor: Awaited<ReturnType<typeof createExecutor>>;

await executor.secrets.set({
  id: "github-token",
  name: "GitHub Token",
  value: "ghp_...",
  scope: executor.scopes[0]!.id, // which scope owns the secret
});

const value = await executor.secrets.get("github-token");
const refs = await executor.secrets.list();
```

Plugins that need a token — HTTP-backed sources, OAuth flows, etc. — accept a secret id at the source-config layer and resolve through the executor, so token strings never live in your config files.

## Status

Pre-`1.0`. APIs may still change between beta releases. See the [executor monorepo](https://github.com/RhysSullivan/executor) for the current development branch and roadmap.

## License

MIT
