# @executor-js/runtime-quickjs

[QuickJS](https://github.com/justjake/quickjs-emscripten) sandbox runtime for `@executor-js/execution`. Runs untrusted TypeScript/JavaScript in a WASM-backed interpreter with configurable timeout, memory limit, and stack size — safe enough to execute LLM-generated code that calls your registered tools.

## Install

```sh
bun add @executor-js/execution @executor-js/runtime-quickjs
# or
npm install @executor-js/execution @executor-js/runtime-quickjs
```

## Usage

Pass a `makeQuickJsExecutor()` as the `codeExecutor` when building the execution engine:

```ts
import { createExecutor } from "@executor-js/sdk";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

const executor = await createExecutor({ onElicitation: "accept-all" });

const engine = createExecutionEngine({
  executor,
  codeExecutor: makeQuickJsExecutor({
    timeoutMs: 2_000,
    memoryLimitBytes: 32 * 1024 * 1024,
    maxStackSizeBytes: 1 * 1024 * 1024,
  }),
});
```

### Options

| Option              | Default    | Description                       |
| ------------------- | ---------- | --------------------------------- |
| `timeoutMs`         | `300_000`  | Max wall-clock time per execution |
| `memoryLimitBytes`  | `64 * 1MB` | Max memory the VM can allocate    |
| `maxStackSizeBytes` | `1 * 1MB`  | Max call-stack depth              |

### Swapping the QuickJS build

```ts
import { setQuickJSModule } from "@executor-js/runtime-quickjs";
import { newQuickJSWASMModule } from "quickjs-emscripten";

setQuickJSModule(await newQuickJSWASMModule());
```

Use this when you want a different WASM variant (e.g. debug builds, QuickJS-NG) than the default bundled one. `newQuickJSWASMModule()` defaults to the release-sync variant; pass a different `@jitl/quickjs-*` variant to swap it.

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/RhysSullivan/executor).

## License

MIT
