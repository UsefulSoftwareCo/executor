/** Shared authored workflow fixture and public wire projections for real product HTTP tests. */
import { Schema } from "effect";

export const workflowFiles = (version: string) => [
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { "brotli-wasm": "3.0.1" } }),
  },
  {
    path: "context.ts",
    content: `import wasm from "brotli-wasm/pkg.web/brotli_wasm_bg.wasm";
if (!(wasm instanceof WebAssembly.Module) || !WebAssembly.Module.exports(wasm).some((entry) => entry.name === "compress")) {
  throw new Error("Retained WASM module was not available in this app context");
}
import { defineDatabase, defineProvider, secrets, table, object, string,
  type QueryContext, type MutationContext, type WorkflowContext } from "apps";
const service = defineProvider({ name: "Workflow fixture", auth: {
  key: secrets({ label: "Key", fields: object({ token: string() }) })
} });
export const requirements = { accounts: { service }, database: defineDatabase({
  events: table({ label: string(), source: string() }),
  checkpoints: table({ label: string() })
}) };
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
export const rows = query({ input: object({}) }, async (ctx: QueryCtx) =>
  ctx.db.events.withIndex("by_creation").collect());
export const save = mutation({ input: object({ label: string() }) }, async (ctx: MutationCtx, input) => {
  await new Promise((resolve) => setTimeout(resolve, 10));
  const row = await ctx.db.events.insert({ ...input, source: ctx.accounts.service.fields.token });
  await new Promise((resolve) => setTimeout(resolve, 10));
  return row;
});
export const release = mutation({ input: object({ label: string() }) }, async (ctx: MutationCtx, input) => {
  await ctx.db.checkpoints.insert(input);
  return null;
});
export const released = query({ input: object({ label: string() }) }, async (ctx: QueryCtx, input) =>
  (await ctx.db.checkpoints.withIndex("by_creation").collect()).some(row => row.label === input.label));
export const denied = mutation({ input: object({}), approval: () => "denied" }, async () => "unreachable");
export const approval = mutation({ input: object({}), approval: () => "user-approval" }, async () => "unreachable");
export const interactive = query({ input: object({}) }, async (ctx) => {
  await ctx.elicit({ mode: "form", message: "Synthetic input", requestedSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } });
  return "unreachable";
});
export const timeoutWrite = mutation({ input: object({}) }, async (ctx: MutationCtx) => {
  await ctx.db.events.insert({ label: "timeout:rollback", source: "synthetic" });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  return null;
});
export const launch = mutation({ input: object({ key: string() }) }, async (ctx: MutationCtx, input) =>
  ctx.workflows.start({ workflow: "quick", input: {}, key: input.key }));
export const history = query({ input: object({}) }, async (ctx: QueryCtx) => ctx.workflows.list({ limit: 1 }));
`,
  },
  {
    path: "workflows.ts",
    content: `import { workflow, object, string, NonRetryableError } from "apps";
import { rows, save, released, denied, approval, interactive, timeoutWrite } from "./operations.ts";
import type { WorkflowCtx } from "./context.ts";
export const process = workflow({ input: object({ label: string() }) }, async (ctx: WorkflowCtx, input) => {
  if ("db" in ctx || "accounts" in ctx || "elicit" in ctx) throw new NonRetryableError("Invalid body context");
  let attempts = 0;
  let key;
  const first = await ctx.step.do("credential", { retries: { limit: 1, delay: 10 } }, async (step) => {
    if ("db" in step || "elicit" in step) throw new NonRetryableError("Invalid step context");
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
    content: `import { defineApp } from "apps";
import { requirements } from "./context.ts";
import { rows, save, release, released, denied, approval, interactive, timeoutWrite, launch, history, isolation } from "./operations.ts";
import * as workflows from "./workflows.ts";
export default defineApp(requirements, {
  queries: { rows, released, interactive, history, isolation }, mutations: { save, release, denied, approval, timeoutWrite, launch }, workflows
});`,
  },
];
export const WorkflowApp = Schema.Struct({ id: Schema.String, activeDeployment: Schema.String });
export const WorkflowRun = Schema.Struct({
  id: Schema.String,
  deployment: Schema.String,
  status: Schema.String,
  output: Schema.optionalKey(Schema.Json),
  error: Schema.optionalKey(Schema.String),
});
export const WorkflowRows = Schema.Array(
  Schema.Struct({ label: Schema.String, source: Schema.String }),
);
