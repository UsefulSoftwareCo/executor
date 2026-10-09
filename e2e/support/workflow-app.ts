/** Shared authored workflow fixture and public wire projections for real product HTTP tests. */
import { Schema } from "effect";
import { withApps } from "./apps-release.ts";

/** Each fixture tool's kind, as the app declares it. Calls must name it. */
export const workflowToolKinds = {
  isolation: "query",
  rows: "query",
  save: "mutation",
  release: "mutation",
  released: "query",
  denied: "mutation",
  approval: "mutation",
  interactive: "query",
  timeoutWrite: "mutation",
  launch: "mutation",
  history: "query",
} as const;

export const workflowFiles = (version: string) => [
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: withApps({ "brotli-wasm": "3.0.1" }) }),
  },
  {
    path: "context.ts",
    content: `import wasm from "brotli-wasm/pkg.web/brotli_wasm_bg.wasm";
if (!(wasm instanceof WebAssembly.Module) || !WebAssembly.Module.exports(wasm).some((entry) => entry.name === "compress")) {
  throw new Error("Retained WASM module was not available in this app context");
}
import { defineProvider, secrets, object, string,
  type QueryContext, type MutationContext, type WorkflowContext,
  router,
} from "apps";
const service = defineProvider({ name: "Workflow fixture", auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
export const requirements = { accounts: { service } };
export type QueryCtx = QueryContext<typeof requirements>;
export type MutationCtx = MutationContext<typeof requirements>;
export type WorkflowCtx = WorkflowContext<typeof requirements>;
`,
  },
  {
    path: "operations.ts",
    content: `import { query, mutation, object, string } from "apps";
import type { QueryCtx, MutationCtx } from "./context.ts";
import { readFileSync } from "node:fs";
const hostEnvironmentAtImport = typeof process !== "undefined" && process.env.EXECUTOR_ENCRYPTION_KEY !== undefined;
export const isolation = query({ input: object({}) }, async () => {
  let hostFileAccess = false;
  try { readFileSync("/etc/passwd", "utf8"); hostFileAccess = true; } catch {}
  return { hostEnvironmentAtImport, hostEnvironmentAtCall: typeof process !== "undefined" && process.env.EXECUTOR_ENCRYPTION_KEY !== undefined, hostFileAccess };
});
const insertEvent = "INSERT INTO events (id, label, source) VALUES (?, ?, ?) RETURNING id, label, source";
export const rows = query({ input: object({}) }, async (ctx: QueryCtx) =>
  ctx.sql.exec("SELECT id, label, source FROM events ORDER BY seq").toArray());
export const save = mutation({ input: object({ label: string() }) }, async (ctx: MutationCtx, input) => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const row = ctx.sql.transaction((tx) =>
    tx.exec(insertEvent, crypto.randomUUID(), input.label, ctx.accounts.service.fields.token).one());
  await new Promise((resolve) => setTimeout(resolve, 10));
  return row;
});
export const release = mutation({ input: object({ label: string() }) }, async (ctx: MutationCtx, input) => {
  ctx.sql.exec("INSERT INTO checkpoints (label) VALUES (?)", input.label);
  return null;
});
export const released = query({ input: object({ label: string() }) }, async (ctx: QueryCtx, input) =>
  ctx.sql.exec("SELECT 1 FROM checkpoints WHERE label = ?", input.label).toArray().length > 0);
export const denied = mutation({ input: object({}), approval: () => "denied" }, async () => "unreachable");
export const approval = mutation({ input: object({}), approval: () => "user-approval" }, async () => "unreachable");
export const interactive = query({ input: object({}) }, async (ctx) => {
  await ctx.elicit({ mode: "form", message: "Synthetic input", requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } });
  return "unreachable";
});
// The step times out while waiting; its call has ended by the time the write runs, so it never lands.
export const timeoutWrite = mutation({ input: object({}) }, async (ctx: MutationCtx) => {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  ctx.sql.transaction((tx) => tx.exec(insertEvent, crypto.randomUUID(), "timeout:rollback", "synthetic"));
  return null;
});
export const explode = mutation({ input: object({}) }, async (ctx: MutationCtx) =>
  ctx.sql.transaction((tx) => {
    tx.exec(insertEvent, crypto.randomUUID(), "explode:rollback", "synthetic");
    throw new TypeError("Synthetic mutation failure");
  }));
export const launch = mutation({ input: object({ key: string() }) }, async (ctx: MutationCtx, input) =>
  ctx.workflows.start({ workflow: "quick", input: {}, key: input.key }));
export const history = query({ input: object({}) }, async (ctx: QueryCtx) => ctx.workflows.list({ limit: 1 }));
`,
  },
  {
    path: "workflows.ts",
    content: `import { workflow, object, string, NonRetryableError } from "apps";
import { rows, save, released, denied, approval, interactive, timeoutWrite, explode } from "./operations.ts";
import type { WorkflowCtx } from "./context.ts";
export const process = workflow({ input: object({ label: string() }) }, async (ctx: WorkflowCtx, input) => {
  if ("sql" in ctx || "accounts" in ctx || "elicit" in ctx) throw new NonRetryableError("Invalid body context");
  let attempts = 0;
  let key;
  const first = await ctx.step.do("credential", { retries: { limit: 1, delay: 10 } }, async (step) => {
    if ("sql" in step || "elicit" in step) throw new NonRetryableError("Invalid step context");
    if (key !== undefined && key !== step.idempotencyKey) throw new NonRetryableError("Unstable key");
    key = step.idempotencyKey;
    if (++attempts === 1) throw new Error("Synthetic retry");
    return { source: step.accounts.service.fields.token, attempts, key };
  });
  await ctx.step.runMutation("save", save, { label: input.label + ":before" });
  while (!(await ctx.step.runQuery("released", released, { label: input.label }))) {
    await ctx.step.sleep("hold", "100 milliseconds");
  }
  const after = await ctx.step.do("credential", async (step) => step.accounts.service.fields.token);
  await Promise.all(["left", "right"].map((name) => ctx.step.runMutation("save", save, { label: input.label + ":" + name })));
  const stored = await ctx.step.runQuery("read", rows, {});
  const deadline = await ctx.step.do("deadline", async () => Date.now() + 200);
  await ctx.step.sleepUntil("finish", deadline);
  return { version: "${version}", first, after, count: stored.length };
});
export const quick = workflow({ input: object({}) }, async () => "${version}");
export const slow = workflow({ input: object({}) }, async (ctx: WorkflowCtx) => {
  await ctx.step.runMutation("before", save, { label: "cancel:before" });
  await ctx.step.sleep("hold", "1 minute");
  await ctx.step.runMutation("after", save, { label: "cancel:after" });
  return null;
});
export const deniedRun = workflow({ input: object({}) }, async (ctx: WorkflowCtx) => ctx.step.runMutation("denied", denied, {}));
export const approvalRun = workflow({ input: object({}) }, async (ctx: WorkflowCtx) => ctx.step.runMutation("approval", approval, {}));
export const interactiveRun = workflow({ input: object({}) }, async (ctx: WorkflowCtx) => ctx.step.runQuery("interactive", interactive, {}, { retries: { limit: 0, delay: 0 } }));
export const timeoutRun = workflow({ input: object({}) }, async (ctx: WorkflowCtx) => ctx.step.runMutation("timeout", timeoutWrite, {}, { timeout: 100, retries: { limit: 0, delay: 0 } }));
export const leak = workflow({ input: object({}) }, async (ctx: WorkflowCtx) =>
  ctx.step.do("leak", { retries: { limit: 0, delay: 0 } }, async (step) => {
    throw new NonRetryableError("Rejected token " + step.accounts.service.fields.token);
  }));
export const explodeRun = workflow({ input: object({}) }, async (ctx: WorkflowCtx) =>
  ctx.step.runMutation("explode", explode, {}, { retries: { limit: 0, delay: 0 } }));
export const fatal = workflow({ input: object({}) }, async (ctx: WorkflowCtx) => {
  let calls = 0;
  return ctx.step.do("fatal", { retries: { limit: 2, delay: 10 } }, async () => {
    if (++calls > 1) return "incorrectly retried";
    throw new NonRetryableError("Synthetic private exception");
  });
});
`,
  },
  {
    path: "index.ts",
    content: `import { defineApp, router } from "apps";
import { requirements } from "./context.ts";
import { rows, save, release, released, denied, approval, interactive, timeoutWrite, explode, launch, history, isolation } from "./operations.ts";
import * as workflows from "./workflows.ts";
export default defineApp(requirements, {
  tools: router({
    rows, released, interactive, history, isolation,
    save, release, denied, approval, timeoutWrite, explode, launch,
  }), workflows
});`,
  },
  {
    path: "migrations/0001_workflow.sql",
    content: `CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, label TEXT NOT NULL, source TEXT NOT NULL);
CREATE TABLE checkpoints (label TEXT NOT NULL);
`,
  },
];
export const WorkflowApp = Schema.Struct({ id: Schema.String, activeDeployment: Schema.String });
export const WorkflowRun = Schema.Struct({
  id: Schema.String,
  deployment: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
  failure: Schema.optionalKey(
    Schema.Struct({
      step: Schema.optionalKey(Schema.String),
      errorName: Schema.optionalKey(Schema.String),
      message: Schema.optionalKey(Schema.String),
    }),
  ),
});
export const WorkflowRows = Schema.Array(
  Schema.Struct({ label: Schema.String, source: Schema.String }),
);
