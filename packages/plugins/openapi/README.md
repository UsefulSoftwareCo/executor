# @executor-js/plugin-openapi

Load [OpenAPI](https://www.openapis.org/) specifications into an executor. Every operation in the spec becomes an invokable tool with a JSON-Schema input, automatic request building, and optional secret-backed auth.

## Install

```sh
bun add @executor-js/sdk @executor-js/plugin-openapi
# or
npm install @executor-js/sdk @executor-js/plugin-openapi
```

## Usage

```ts
import { createExecutor } from "@executor-js/sdk";
import { openApiPlugin } from "@executor-js/plugin-openapi";

const executor = await createExecutor({
  onElicitation: "accept-all",
  plugins: [openApiPlugin()] as const,
});

// Load a spec by URL (JSON or YAML, remote or file://)
await executor.openapi.addSpec({
  scope: executor.scopes[0]!.id,
  spec: "https://petstore3.swagger.io/api/v3/openapi.json",
  namespace: "petstore",
});

// List and invoke tools like any other plugin
const tools = await executor.tools.list();
const result = await executor.tools.invoke("petstore.listPets", {});
```

## Secret-backed auth headers

Wire API keys or bearer tokens through the executor's secret store — never hard-code them in source configs:

```ts
import { createExecutor } from "@executor-js/sdk";
import { openApiPlugin } from "@executor-js/plugin-openapi";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";

const executor = await createExecutor({
  onElicitation: "accept-all",
  plugins: [fileSecretsPlugin(), openApiPlugin()] as const,
});

const scope = executor.scopes[0]!.id;

await executor.secrets.set({
  id: "stripe-key",
  name: "Stripe Key",
  value: "sk_live_...",
  scope,
});

await executor.openapi.addSpec({
  scope,
  spec: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
  namespace: "stripe",
  headers: {
    Authorization: { secretId: "stripe-key", prefix: "Bearer " },
  },
});
```

## Using with Effect

If you're building on `@executor-js/sdk/core` (the raw Effect entry), import this plugin from its `/core` subpath instead — it returns the Effect-shaped plugin with `Effect.Effect<...>`-returning methods rather than promisified wrappers:

```ts
import { openApiPlugin } from "@executor-js/plugin-openapi/core";
```

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/UsefulSoftwareCo/executor).

## License

MIT
