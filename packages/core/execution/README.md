# @executor-js/execution

Sandboxed JavaScript execution for an executor. Hands a `tools.<namespace>.<name>(...)` proxy into a code sandbox so an agent (or any caller) can run generated TypeScript/JavaScript that invokes the executor's registered tools.

Supports pause/resume for elicitation-driven flows: tools that need user input (OAuth, form fill, approval) suspend the sandbox, surface a `PausedExecution`, and resume on a `ResumeResponse`.

## Install

```sh
bun add @executor-js/sdk @executor-js/execution @executor-js/runtime-quickjs
# or
npm install @executor-js/sdk @executor-js/execution @executor-js/runtime-quickjs
```

`@executor-js/runtime-quickjs` is the sandbox runtime. It's not a dependency of `@executor-js/execution` — you bring your own so consumers with a different runtime don't ship ~13 MB of WASM they never use.

## Usage

```ts
import { createExecutor } from "@executor-js/sdk";
import { createExecutionEngine } from "@executor-js/execution";
import { makeQuickJsExecutor } from "@executor-js/runtime-quickjs";

const executor = await createExecutor({
  onElicitation: "accept-all",
});

const engine = createExecutionEngine({
  executor,
  codeExecutor: makeQuickJsExecutor({
    timeoutMs: 2_000,
    memoryLimitBytes: 32 * 1024 * 1024,
  }),
});

const result = await engine.execute(
  `
    const pets = await tools.petstore.findPetsByStatus({ status: "available" });
    return pets.length;
  `,
  {
    onElicitation: async (ctx) => {
      // A tool asked for user input mid-execution. Your UI decides what to do.
      console.log("tool needs input:", ctx.request);
      return { action: "decline" };
    },
  },
);

console.log(result);
// { result: 12, logs: [...] }
```

## Custom tool discovery

`tools.search(...)` uses Executor's built-in lexical tool discovery by default. Hosts can provide their own implementation, such as an indexed or semantic search provider, without replacing the sandbox runtime:

```ts
import { createExecutionEngine, type ToolDiscoveryProvider } from "@executor-js/execution";

const toolDiscoveryProvider: ToolDiscoveryProvider = {
  searchTools: ({ query, namespace, limit, offset }) =>
    mySearchIndex.searchTools({ query, namespace, limit, offset }),
};

const engine = createExecutionEngine({
  executor,
  codeExecutor: makeQuickJsExecutor(),
  toolDiscoveryProvider,
});
```

## Pause/resume for elicitation

When the host doesn't support inline elicitation, use `executeWithPause` to intercept the first request as a pause point:

```ts
import type { ExecutionEngine } from "@executor-js/execution";

declare const engine: ExecutionEngine;
declare const code: string;

const started = await engine.executeWithPause(code);

if (started.status === "paused") {
  const { id, elicitationContext } = started.execution;
  // Render the elicitation request in your UI. Later:
  const resumed = await engine.resume(id, {
    action: "accept",
    content: { name: "Ada" },
  });
}
```

## Workflow description for LLMs

```ts
import type { ExecutionEngine } from "@executor-js/execution";

declare const engine: ExecutionEngine;

const description = await engine.getDescription();
// Returns the short `execute` tool description: a one-line intro, a pointer to
// the `execute` skill, and the live connection-prefix inventory. Feed this to
// an LLM as the execute tool's description.
```

The full "use tools.search(), then tools.describe.tool(), then call ..." workflow
prose lives in the `execute` skill rather than the always-loaded description, so a
model that never runs code does not pay for it. MCP hosts expose it through the
`skills` tool; to read it directly:

```ts
import { EXECUTE_SKILL } from "@executor-js/execution";

const howTo = EXECUTE_SKILL.body;
```

## Using with Effect

If you're building on `@executor-js/sdk/core` (the raw Effect entry), import from the `/core` subpath. The returned engine is Effect-native: `execute`, `executeWithPause`, and `resume` all become `Effect.Effect<...>`, and `onElicitation` is an `ElicitationHandler` returning `Effect.Effect<ElicitationResponse>`.

```ts
import { createExecutionEngine } from "@executor-js/execution/core";
```

## Status

Pre-`1.0`. APIs may still change between beta releases. Part of the [executor monorepo](https://github.com/RhysSullivan/executor).

## License

MIT
