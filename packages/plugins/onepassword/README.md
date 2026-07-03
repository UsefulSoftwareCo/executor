# @executor-js/plugin-onepassword

[1Password](https://1password.com) integration for the executor. Provides a secret source that resolves values from a 1Password vault, backed by either the desktop app (connect.sock) or a service account token.

## Install

```sh
bun add @executor-js/sdk @executor-js/plugin-onepassword
# or
npm install @executor-js/sdk @executor-js/plugin-onepassword
```

## Usage

```ts
import { createExecutor } from "@executor-js/sdk";
import { onepasswordPlugin } from "@executor-js/plugin-onepassword";

const executor = await createExecutor({
  onElicitation: "accept-all",
  plugins: [onepasswordPlugin()] as const,
});

// Point the plugin at your account
await executor.onepassword.configure({
  auth: { kind: "desktop-app", accountName: "my-account" },
  vaultId: "my-vault-id",
  name: "Personal",
});

// Inspect connection / list vaults
const status = await executor.onepassword.status();
const vaults = await executor.onepassword.listVaults({
  kind: "desktop-app",
  accountName: "my-account",
});
```

For CI and headless environments, use a service-account token instead of the desktop app. Store the token through the executor's secret store first, then reference it by id:

```ts
import { createExecutor } from "@executor-js/sdk";
import { onepasswordPlugin } from "@executor-js/plugin-onepassword";
import { fileSecretsPlugin } from "@executor-js/plugin-file-secrets";

const executor = await createExecutor({
  onElicitation: "accept-all",
  plugins: [fileSecretsPlugin(), onepasswordPlugin()] as const,
});

await executor.secrets.set({
  id: "op-token",
  name: "1Password service account",
  value: process.env.OP_SERVICE_ACCOUNT_TOKEN!,
  scope: executor.scopes[0]!.id,
});

await executor.onepassword.configure({
  auth: { kind: "service-account", tokenSecretId: "op-token" },
  vaultId: "my-vault-id",
  name: "CI",
});
```

## Using with Effect

If you're building on `@executor-js/sdk/core` (the raw Effect entry), import this plugin from its `/core` subpath instead — it returns the Effect-shaped plugin with `Effect.Effect<...>`-returning methods rather than promisified wrappers:

```ts
import { onepasswordPlugin } from "@executor-js/plugin-onepassword/core";
```

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/UsefulSoftwareCo/executor).

## License

MIT
