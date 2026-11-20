import type * as t from "@babel/types";
import type { AppGraph, Starter, WorkflowGraph, WorkflowNode } from "../contracts/graph.ts";
import {
  CODE,
  NOT_SERVER,
  calleeName,
  declareIn,
  isFunction,
  keyName,
  memberName,
  objectEntries,
  patternNames,
  property,
  reachable,
  readModule,
  resolve,
  stringProperty,
  unwrap,
  type At,
  type Binding,
  type Budget,
  type FunctionNode,
  type Module,
  type SourceFile,
} from "./source.ts";
import { Walker, type Block, type Context, type Tools } from "./walker.ts";

/**
 * Reads an app's source the way its author wrote it: the `defineApp` definition names the
 * workflows, tools, schedules and webhooks, and each workflow's handler is walked statement by
 * statement. `ctx.step.*` calls become steps and the control flow around them becomes decisions,
 * loops, parallel groups and try blocks. Plain code between steps is not drawn.
 *
 * Nothing is evaluated. A name or target computed at runtime keeps its static text and `…`, and
 * draws no reference.
 */

/** Units of work one derivation may spend: plenty for real apps, quick to run out on hostile source. */
const WORK_BUDGET = 200_000;
/**
 * Parsing is the one step the work budget can't interrupt, so how much source is parsed is capped
 * instead. Workflow code is small; a file past the cap, usually generated, is skipped.
 */
const MAX_FILE_LENGTH = 512 * 1024;
const MAX_TOTAL_LENGTH = 2 * 1024 * 1024;
const MAX_FILES = 2_000;

export function deriveAppGraph(files: ReadonlyArray<SourceFile>): AppGraph {
  const budget: Budget = { left: WORK_BUDGET, exhausted: false, skipped: new Set() };
  const modules = new Map<string, Module>();
  let parsed = 0;
  for (const file of files) {
    const content = file.content;
    if (
      content === undefined ||
      !CODE.test(file.path) ||
      NOT_SERVER.test(file.path) ||
      file.path.endsWith(".d.ts")
    )
      continue;
    if (
      content.length > MAX_FILE_LENGTH ||
      parsed + content.length > MAX_TOTAL_LENGTH ||
      modules.size >= MAX_FILES
    ) {
      budget.skipped.add(file.path);
      continue;
    }
    parsed += content.length;
    const module = readModule({ path: file.path, content }, budget);
    if (module) modules.set(module.path, module);
  }
  const app = findDefinition(modules);
  if (!app) return { workflows: [] };
  const tools = readTools(app, modules);
  const startsByTool = new Map<string, Set<string>>();
  for (const [path, handler] of tools.handlers)
    startsByTool.set(path, startedIn(handler, modules, budget));

  const starters = new Map<string, Starter[]>();
  const addStarter = (workflow: string, starter: Starter) =>
    starters.set(workflow, [...(starters.get(workflow) ?? []), starter]);
  for (const [path, started] of startsByTool)
    for (const name of started) addStarter(name, { kind: "tool", path });
  for (const [name, entry] of objectEntries(property(app, "schedules", modules), modules)) {
    const tool = scheduledTool(entry, tools, modules);
    if (tool === undefined) continue;
    for (const workflow of startsByTool.get(tool) ?? [])
      addStarter(workflow, { kind: "schedule", name, tool });
  }
  for (const [name, entry] of objectEntries(property(app, "webhooks", modules), modules)) {
    const handle = property(entry, "handle", modules);
    if (handle)
      for (const workflow of startedIn(handle, modules, budget))
        addStarter(workflow, { kind: "webhook", name });
  }

  const workflows: WorkflowGraph[] = [];
  for (const [name, entry] of objectEntries(property(app, "workflows", modules), modules)) {
    const graph = readWorkflow(name, entry, { modules, tools, startsByTool, budget });
    if (graph) workflows.push(graph);
  }
  // Workflows that start each other through a tool are known once every workflow is read.
  for (const graph of workflows)
    walkNodes(graph.nodes, (node) => {
      if (node.type !== "step") return;
      for (const use of node.uses)
        if (use.kind === "workflow") {
          const tool = node.uses.find((other) => other.kind === "tool");
          addStarter(use.name, {
            kind: "workflow",
            name: graph.name,
            step: node.label.text,
            tool: tool?.kind === "tool" ? tool.path : "",
          });
        }
    });
  // A spent budget may have cut any reading short, so no graph can claim to be complete.
  return {
    workflows: workflows.map((graph) => ({
      ...graph,
      startedBy: starters.get(graph.name) ?? [],
      partial: graph.partial || budget.exhausted,
    })),
  };
}

function walkNodes(nodes: ReadonlyArray<WorkflowNode>, visit: (node: WorkflowNode) => void) {
  for (const node of nodes) {
    visit(node);
    switch (node.type) {
      case "branch":
        for (const arm of node.arms) walkNodes(arm.body, visit);
        break;
      case "loop":
        walkNodes(node.body, visit);
        break;
      case "parallel":
        for (const branch of node.branches) walkNodes(branch, visit);
        break;
      case "try":
        walkNodes(node.body, visit);
        walkNodes(node.failure, visit);
        walkNodes(node.cleanup, visit);
        break;
    }
  }
}

function findDefinition(modules: Map<string, Module>): At | undefined {
  const entries = [...modules.values()].sort(
    (a, b) => Number(b.path === "index.ts") - Number(a.path === "index.ts"),
  );
  for (const module of entries) {
    if (!module.defaultExport) continue;
    const call = resolve({ module, node: module.defaultExport }, modules);
    if (call.node.type !== "CallExpression" || calleeName(call.node) !== "defineApp") continue;
    const definition = call.node.arguments.at(-1);
    if (!definition) continue;
    const object = returned(resolve({ ...call, node: definition }, modules), modules);
    if (object?.node.type === "ObjectExpression") return object;
  }
  return undefined;
}

/**
 * A definition written as a function (`defineApp(requirements, async (ctx) => ({ … }))`) returns
 * its object; the function's own `const`s stay in scope, so a workflow declared inside it resolves.
 */
function returned(at: At, modules: Map<string, Module>): At | undefined {
  if (at.node.type === "ObjectExpression") return at;
  if (!isFunction(at.node)) return undefined;
  const env = new Map<string, Binding>(at.env ?? []);
  for (const param of at.node.params) for (const name of patternNames(param)) env.set(name, null);
  const body = at.node.body;
  if (body.type !== "BlockStatement")
    return resolve({ module: at.module, node: body, env }, modules);
  for (const statement of body.body) {
    declareIn(env, statement, env);
    if (statement.type === "ReturnStatement" && statement.argument)
      return resolve({ module: at.module, node: statement.argument, env }, modules);
  }
  return undefined;
}

const SCHEDULE_HELPERS = new Set(["userInterval", "userCron", "appInterval", "appCron"]);

/** The tool a schedule runs: `userCron(timing, operation, input)` and friends, or `{ tool: "path" }`. */
function scheduledTool(entry: At, tools: Tools, modules: Map<string, Module>): string | undefined {
  const name = calleeName(entry.node);
  if (entry.node.type === "CallExpression" && name !== undefined && SCHEDULE_HELPERS.has(name)) {
    const operation = entry.node.arguments[1];
    return operation && tools.byNode.get(resolve({ ...entry, node: operation }, modules).node);
  }
  return stringProperty(entry, "tool", modules);
}

function readTools(app: At, modules: Map<string, Module>): Tools {
  const tools: Tools = { byNode: new Map(), handlers: new Map() };
  const visit = (at: At | undefined, prefix: string, depth: number) => {
    if (!at || depth > 10) return;
    const node = at.node;
    const name = calleeName(node);
    if (node.type === "CallExpression" && name === "router") {
      const routes = node.arguments[0];
      if (routes) visit(resolve({ ...at, node: routes }, modules), prefix, depth + 1);
      return;
    }
    if (node.type === "ObjectExpression") {
      for (const [key, entry] of objectEntries(at, modules))
        visit(entry, prefix ? `${prefix}.${key}` : key, depth + 1);
      return;
    }
    if (node.type === "CallExpression" && prefix) {
      tools.byNode.set(node, prefix);
      const handler = node.arguments.at(-1);
      if (handler) tools.handlers.set(prefix, resolve({ ...at, node: handler }, modules));
    }
  };
  visit(property(app, "tools", modules), "", 0);
  return tools;
}

/**
 * Workflow names a handler starts with a literal `workflows.start({ workflow: "…" })`, in code that
 * runs when the handler does. A name a spread could replace starts nothing that can be known.
 */
function startedIn(at: At, modules: Map<string, Module>, budget: Budget): Set<string> {
  const names = new Set<string>();
  const fn = at.node;
  if (!isFunction(fn)) return names;
  // The handler's own parameters and declarations shadow outer names.
  const env = new Map<string, Binding>(at.env ?? []);
  for (const param of fn.params) for (const name of patternNames(param)) env.set(name, null);
  if (fn.body.type === "BlockStatement")
    for (const statement of fn.body.body) declareIn(env, statement, env);
  const first = fn.params[0];
  const context = first?.type === "Identifier" ? first.name : undefined;
  let workflows: string | undefined;
  if (first?.type === "ObjectPattern")
    for (const entry of first.properties)
      if (
        entry.type === "ObjectProperty" &&
        !entry.computed &&
        keyName(entry.key) === "workflows" &&
        entry.value.type === "Identifier"
      )
        workflows = entry.value.name;
  // Only the handler's own context starts a workflow; another object's `workflows.start` doesn't.
  const isWorkflows = (node: t.Node) => {
    const current = unwrap(node);
    if (current.type === "Identifier") return current.name === workflows;
    if (current.type !== "MemberExpression" || memberName(current) !== "workflows") return false;
    const owner = unwrap(current.object);
    return owner.type === "Identifier" && owner.name === context;
  };
  // A callback whose own parameter takes the context's or `workflows`' name is about another object.
  const keeps = (inner: FunctionNode) =>
    !inner.params.some((param) =>
      patternNames(param).some((name) => name === context || name === workflows),
    );
  reachable(
    fn.body,
    budget,
    (node) => {
      if (node.type !== "CallExpression") return;
      const callee = unwrap(node.callee);
      if (callee.type !== "MemberExpression" || memberName(callee) !== "start") return;
      if (!isWorkflows(callee.object)) return;
      const options = node.arguments[0];
      const name =
        options && stringProperty({ module: at.module, node: options, env }, "workflow", modules);
      if (name !== undefined) names.add(name);
    },
    keeps,
  );
  return names;
}

/** A workflow's graph, or none when its handler can't be read or the source trips the walk. */
function readWorkflow(name: string, at: At, context: Context): WorkflowGraph | undefined {
  if (at.node.type !== "CallExpression" || calleeName(at.node) !== "workflow") return undefined;
  const handler = at.node.arguments.at(-1);
  const options = at.node.arguments.length > 1 ? at.node.arguments[0] : undefined;
  if (!handler) return undefined;
  const fn = resolve({ ...at, node: handler }, context.modules);
  if (!isFunction(fn.node)) return undefined;
  const walker = new Walker(context);
  let block: Block;
  try {
    block = walker.body(fn.node, walker.enter(fn.module, fn.node, [], "workflow", [], fn.env));
  } catch {
    // App source is untrusted; a shape the walk can't take, such as very deep nesting, draws nothing.
    return undefined;
  }
  // The run finishes after the last step unless every path already ended.
  const nodes: WorkflowNode[] = block.ends
    ? block.nodes
    : [
        ...block.nodes,
        {
          type: "end",
          id: "end",
          file: fn.module.path,
          line: fn.node.loc?.end.line ?? 1,
          outcome: "done",
        },
      ];
  return {
    name,
    file: at.module.path,
    line: at.node.loc?.start.line ?? 1,
    input: inputFields(
      options && resolve({ ...at, node: options }, context.modules),
      context.modules,
    ),
    nodes,
    startedBy: [],
    partial: walker.partial,
  };
}

function inputFields(options: At | undefined, modules: Map<string, Module>): string[] {
  const input = property(options, "input", modules);
  if (!input || input.node.type !== "CallExpression" || calleeName(input.node) !== "object")
    return [];
  const shape = input.node.arguments[0];
  if (!shape) return [];
  return objectEntries(resolve({ ...input, node: shape }, modules), modules).map(([key]) => key);
}
