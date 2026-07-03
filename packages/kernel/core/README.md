# @executor-js/codemode-core

Core primitives for "code mode" — the pattern where an LLM writes TypeScript/JavaScript that calls into a pre-registered set of tools, executed in a sandbox. This package provides the shared type surface (`Tool`, `SandboxToolInvoker`, `CodeExecutor`), JSON Schema helpers, and error types used by every runtime that implements the contract.

Most callers depend on this transitively through `@executor-js/execution` and a sandbox runtime like `@executor-js/runtime-quickjs`. Install directly when you're authoring a new runtime.

## Install

```sh
bun add @executor-js/codemode-core
# or
npm install @executor-js/codemode-core
```

## Usage

Implement a runtime that satisfies `CodeExecutor`:

```ts
import type { CodeExecutor, ExecuteResult, SandboxToolInvoker } from "@executor-js/codemode-core";
import { Effect } from "effect";

export const makeMyRuntime = (): CodeExecutor => ({
  execute: (code: string, invoker: SandboxToolInvoker) =>
    Effect.gen(function* () {
      // Spin up your sandbox, expose `invoker` as `tools.<path>(...)`, run
      // the code, collect logs, and return an ExecuteResult.
      void code;
      void invoker;
      const result: ExecuteResult = { result: undefined, logs: [] };
      return result;
    }),
});
```

The runtime is passed a `SandboxToolInvoker` that bridges sandbox-side tool calls back to the executor. The sandbox-visible API is whatever you decide — `@executor-js/runtime-quickjs` exposes a `tools` proxy object; a runtime targeting Cloudflare Workers might use something else.

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/UsefulSoftwareCo/executor).

## License

MIT
