# @executor-js/host-eve

Expose Executor's tool catalog to a [Vercel **eve**](https://vercel.com/eve) agent.

eve agents discover one typed tool per file under `agent/tools/*.ts`. Executor's
catalog is large by design (discover-by-intent, not one tool per API), so rather
than generating hundreds of tool files, this host mirrors the Executor MCP host:
it surfaces Executor's **codemode** surface as two tools the model drives directly.

- **`execute`** runs TypeScript against Executor's sandboxed tools runtime
  (`tools.search(...)`, `tools.describe.tool(...)`, `tools.github.issues.list(...)`).
- **`resume`** answers an auth / approval / form pause raised mid-execution, using
  the `executionId` the paused `execute` result returned.

This package never imports `eve` at runtime. The factory returns plain objects
shaped to satisfy eve's `defineTool`, so eve stays a peer of your agent project,
not a dependency of this host.

## Usage

Build the engine once and share it across both tools (a paused execution lives in
that engine instance's memory, so `execute` and `resume` must come from the same
engine).

```ts
// agent/executor.ts
import { createExecutionEngine } from "@executor-js/execution/promise";
import { createExecutorEveTools } from "@executor-js/host-eve";

// `executor` (an Executor client) and `codeExecutor` (a sandbox runtime, e.g.
// the QuickJS code executor) are wired the same way the CLI / local app do it.
import { executor, codeExecutor } from "./runtime.ts";

const engine = createExecutionEngine({ executor, codeExecutor });

// Top-level await: the `execute` description (workflow + configured namespaces)
// is read from the engine once and baked in before eve compiles the manifest.
export const executorTools = await createExecutorEveTools({ engine });
```

```ts
// agent/tools/execute.ts
import { defineTool } from "eve/tools";
import { executorTools } from "../executor.ts";

export default defineTool(executorTools.execute);
```

```ts
// agent/tools/resume.ts
import { defineTool } from "eve/tools";
import { executorTools } from "../executor.ts";

export default defineTool(executorTools.resume);
```

The model now writes Executor codemode in `execute`, and when a call needs OAuth
or an approval it gets back an `executionId` and calls `resume`.

## Config

`createExecutorEveTools(config)` accepts either:

- `{ engine }`: a pre-built `@executor-js/execution/promise` engine (recommended;
  lets you share one engine and its trace context), or
- `{ executor, codeExecutor }`: the pieces, and the factory builds the engine.

Plus optional:

- `description`: override the `execute` tool description. When omitted, the
  dynamic description is read from `engine.getDescription()` and baked in.
- `onDefect(error, correlationId)`: called when a tool body throws an unexpected
  defect. Defaults to `console.error`. The model only ever sees an opaque
  `Internal tool error [id]`; the cause is logged out-of-band so it can't leak
  internal context through the tool result.

## Return shape

Every tool resolves to an `ExecutorToolEnvelope`:

```ts
{
  status: string;
  text: string;
  data: Record<string, unknown>;
}
```

`text` is the model-facing render; `data` is the full structured payload kept for
eve Agent Runs and `outputSchema` consumers. `toModelOutput` projects the
envelope down to `{ type: "text", value: text }` so the model reads only `text`.

## Approval

Executor's own pause/resume **is** the human-in-the-loop mechanism: a sensitive
call pauses mid-execution and `resume` continues it. If you also want a pre-call
gate on the whole `execute` tool, add eve's native approval in your tool file:

```ts
import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { executorTools } from "../executor.ts";

export default defineTool({ ...executorTools.execute, needsApproval: always() });
```
