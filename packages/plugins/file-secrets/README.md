# @executor-js/plugin-file-secrets

File-backed secret store for the executor. Persists secrets to a single JSON file at an XDG-compliant path so they survive between process restarts — useful for local development, CLIs, and scripts where a system keychain isn't available.

## Install

```sh
bun add @executor-js/sdk @executor-js/plugin-file-secrets
# or
npm install @executor-js/sdk @executor-js/plugin-file-secrets
```

## Usage

```ts
import { createExecutor } from "@executor-js/sdk";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";

const executor = await createExecutor({
  onElicitation: "accept-all",
  plugins: [fileSecretsPlugin()] as const,
});

// Write a secret — persisted to the backing file
await executor.secrets.set({
  id: "api-key",
  name: "My API Key",
  value: "secret123",
  scope: executor.scopes[0]!.id,
});

// Read it back
const value = await executor.secrets.get("api-key");

// Check where it's stored
console.log("Secret file:", executor.fileSecrets.filePath);
```

Secrets written through `executor.secrets.set(...)` become available to every other plugin that resolves them, so you can (for example) store a GitHub token here and have `@executor-js/plugin-openapi` or `@executor-js/plugin-graphql` pick it up via `{ secretId, prefix }` headers.

## Using with Effect

If you're building on `@executor-js/sdk/core` (the raw Effect entry), import this plugin from its `/core` subpath instead — it returns the Effect-shaped plugin with `Effect.Effect<...>`-returning methods rather than promisified wrappers:

```ts
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets/core";
```

## Security note

Secrets are stored unencrypted in a plain JSON file. Use [`@executor-js/plugin-keychain`](https://www.npmjs.com/package/@executor-js/plugin-keychain) for OS-keychain-backed storage, or [`@executor-js/plugin-onepassword`](https://www.npmjs.com/package/@executor-js/plugin-onepassword) for 1Password-backed storage when you need encryption at rest.

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/UsefulSoftwareCo/executor).

## License

MIT
