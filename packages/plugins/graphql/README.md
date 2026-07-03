# @executor-js/plugin-graphql

Introspect a GraphQL endpoint and expose its queries and mutations as invokable tools on an executor.

## Install

```sh
bun add @executor-js/sdk @executor-js/plugin-graphql
# or
npm install @executor-js/sdk @executor-js/plugin-graphql
```

## Usage

```ts
import { createExecutor } from "@executor-js/sdk";
import { graphqlPlugin } from "@executor-js/plugin-graphql";

const executor = await createExecutor({
  onElicitation: "accept-all",
  plugins: [graphqlPlugin()] as const,
});

// Public endpoint — no auth
await executor.graphql.addSource({
  scope: executor.scopes[0]!.id,
  endpoint: "https://graphql.anilist.co",
  namespace: "anilist",
});

const tools = await executor.tools.list();
const result = await executor.tools.invoke("anilist.Media", {
  search: "Frieren",
});
```

## Secret-backed auth

```ts
import { createExecutor } from "@executor-js/sdk";
import { graphqlPlugin } from "@executor-js/plugin-graphql";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";

const executor = await createExecutor({
  onElicitation: "accept-all",
  plugins: [fileSecretsPlugin(), graphqlPlugin()] as const,
});

const scope = executor.scopes[0]!.id;

await executor.secrets.set({
  id: "github-token",
  name: "GitHub Token",
  value: "ghp_...",
  scope,
});

await executor.graphql.addSource({
  scope,
  endpoint: "https://api.github.com/graphql",
  namespace: "github",
  headers: {
    Authorization: { secretId: "github-token", prefix: "Bearer " },
  },
});
```

## Using with Effect

If you're building on `@executor-js/sdk/core` (the raw Effect entry), import this plugin from its `/core` subpath instead — it returns the Effect-shaped plugin with `Effect.Effect<...>`-returning methods rather than promisified wrappers:

```ts
import { graphqlPlugin } from "@executor-js/plugin-graphql/core";
```

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/UsefulSoftwareCo/executor).

## License

MIT
