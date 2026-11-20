import type * as t from "@babel/types";
import type { Label, Reference, StepKind, StepNode } from "../contracts/graph.ts";
import {
  children,
  isFunction,
  line,
  memberName,
  keyName,
  patternNames,
  property,
  reachable,
  resolve,
  spend,
  unwrap,
  type At,
  type Budget,
  type Environment,
  type FunctionNode,
  type Module,
} from "./source.ts";
import type { Context } from "./walker.ts";

/** What one `ctx.step` call says: its kind, name, options as written and what its code reaches. */

const STEP_METHODS: ReadonlyMap<string, StepKind> = new Map([
  ["do", "do"],
  ["runQuery", "query"],
  ["runMutation", "mutation"],
  ["sleep", "sleep"],
  ["sleepUntil", "sleepUntil"],
]);
const MAX_LABEL = 60;

export function stepKind(callee: t.MemberExpression): StepKind | undefined {
  const method = memberName(callee);
  return method === undefined ? undefined : STEP_METHODS.get(method);
}

export function describeStep(
  call: t.CallExpression,
  kind: StepKind,
  where: { readonly module: Module; readonly env: Environment },
  context: Context,
): Omit<StepNode, "type" | "id"> {
  const { module, env } = where;
  const [name, second, third] = call.arguments;
  const uses: Reference[] = [];
  const detail: Array<{ name: string; value: string }> = [];
  if (kind === "do") {
    const options = third && second && !isFunction(unwrap(second)) ? second : undefined;
    if (options) detail.push(...stepOptions({ module, node: options, env }, context));
    const fn = call.arguments.at(-1);
    if (fn) {
      const target = resolve({ module, node: fn, env }, context.modules);
      // A `fetch` the app declares itself, at any level above the step, is not the network.
      const ownFetch =
        env.has("fetch") ||
        target.env?.has("fetch") === true ||
        target.module.locals.has("fetch") ||
        target.module.imports.has("fetch");
      if (isFunction(target.node)) uses.push(...usesIn(target.node, context.budget, !ownFetch));
    }
  }
  if (kind === "query" || kind === "mutation") {
    if (second) {
      const op = resolve({ module, node: second, env }, context.modules);
      const path = context.tools.byNode.get(op.node);
      if (path !== undefined) {
        uses.push({ kind: "tool", path });
        for (const workflow of context.startsByTool.get(path) ?? [])
          uses.push({ kind: "workflow", name: workflow });
      }
    }
    const options = call.arguments[3];
    if (options) detail.push(...stepOptions({ module, node: options, env }, context));
  }
  if (kind === "sleep" && second)
    detail.push({ name: "Duration", value: sourceValue(module, second) });
  if (kind === "sleepUntil" && second)
    detail.push({ name: "Until", value: sourceValue(module, second) });
  return {
    file: module.path,
    line: line(call),
    end: call.loc?.end.line ?? line(call),
    kind,
    label: name ? stepName(module, name) : { text: kind, dynamic: true },
    detail,
    uses: dedupe(uses),
  };
}

/** `timeout` and `retries` as written, read the way any property is: only when nothing overrides them. */
function stepOptions(at: At, context: Context): Array<{ name: string; value: string }> {
  const options = resolve(at, context.modules);
  const out: Array<{ name: string; value: string }> = [];
  const timeout = property(options, "timeout", context.modules);
  if (timeout) out.push({ name: "Timeout", value: sourceValue(timeout.module, timeout.node) });
  const retries = property(options, "retries", context.modules);
  if (retries?.node.type === "ObjectExpression") {
    const field = (name: string) => {
      const value = property(retries, name, context.modules);
      return value ? sourceValue(value.module, value.node) : undefined;
    };
    const limit = field("limit");
    const delay = field("delay");
    const backoff = field("backoff");
    out.push({
      name: "Retries",
      value: [limit, delay && `after ${delay}`, backoff].filter(Boolean).join(", "),
    });
  }
  return out;
}

/** A step's name: literal text, a template's static parts, or the expression that computes it. */
function stepName(module: Module, node: t.Node): Label {
  const current = unwrap(node);
  if (current.type === "StringLiteral") return { text: current.value, dynamic: false };
  if (current.type === "TemplateLiteral") {
    const text = current.quasis
      .map(
        (quasi, index) =>
          (quasi.value.cooked ?? quasi.value.raw) + (index < current.expressions.length ? "…" : ""),
      )
      .join("");
    return { text, dynamic: current.expressions.length > 0 };
  }
  return { text: sourceText(module, current), dynamic: true };
}

function sourceValue(module: Module, node: t.Node): string {
  const current = unwrap(node);
  return current.type === "StringLiteral" ? current.value : sourceText(module, current);
}

/** The code of `node` on one line, shortened to fit a card. */
export function sourceText(module: Module, node: t.Node): string {
  const source =
    node.start != null && node.end != null ? module.source.slice(node.start, node.end) : "";
  const flat = source.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_LABEL ? `${flat.slice(0, MAX_LABEL - 1)}…` : flat;
}

/**
 * Accounts and hosts a step's own code reaches through its step context: `step.user.accounts.x`
 * (or a destructured `user`, `app` or `accounts`), and `fetch` of a URL whose host is written out.
 * Code that never runs is skipped. A callback that declares its own `step`, accounts holder or
 * `fetch` anywhere inside reports nothing through that name, rather than guess which one is meant.
 */
function usesIn(fn: FunctionNode, budget: Budget, networkFetch: boolean): Reference[] {
  const uses: Reference[] = [];
  const param = fn.params[0];
  const redeclared = declaredInside(fn, budget);
  const step = param?.type === "Identifier" && !redeclared.has(param.name) ? param.name : undefined;
  // Destructured names that hold an accounts object, by the scope they belong to.
  const holders = new Map<string, "user" | "app" | undefined>();
  const accounts = new Map<string, "user" | "app" | undefined>();
  if (param?.type === "ObjectPattern")
    for (const entry of param.properties) {
      if (entry.type !== "ObjectProperty" || entry.computed || entry.value.type !== "Identifier")
        continue;
      if (redeclared.has(entry.value.name)) continue;
      const key = keyName(entry.key);
      if (key === "user" || key === "app") holders.set(entry.value.name, key);
      if (key === "accounts") accounts.set(entry.value.name, undefined);
    }
  const globalFetch = networkFetch && !redeclared.has("fetch");
  const isStep = (node: t.Node) => {
    const current = unwrap(node);
    return step !== undefined && current.type === "Identifier" && current.name === step;
  };
  /** The scope of an expression that is the step's accounts object, or `false` when it isn't one. */
  const accountsOf = (node: t.Node): "user" | "app" | undefined | false => {
    const current = unwrap(node);
    if (current.type === "Identifier")
      return accounts.has(current.name) ? accounts.get(current.name) : false;
    if (current.type !== "MemberExpression" || memberName(current) !== "accounts") return false;
    const owner = unwrap(current.object);
    if (isStep(owner)) return undefined;
    if (owner.type === "Identifier" && holders.has(owner.name)) return holders.get(owner.name);
    if (owner.type === "MemberExpression" && isStep(owner.object)) {
      const scope = memberName(owner);
      if (scope === "user" || scope === "app") return scope;
    }
    return false;
  };
  reachable(fn.body, budget, (node) => {
    if (node.type === "MemberExpression") {
      const slot = memberName(node);
      const scope = slot === undefined ? false : accountsOf(node.object);
      if (slot !== undefined && scope !== false) uses.push({ kind: "account", slot, scope });
    }
    if (node.type === "CallExpression") {
      const callee = unwrap(node.callee);
      const isFetch =
        (callee.type === "Identifier" && callee.name === "fetch" && globalFetch) ||
        (callee.type === "MemberExpression" &&
          memberName(callee) === "fetch" &&
          isStep(callee.object));
      const host =
        isFetch && node.arguments[0] ? writtenHost(unwrap(node.arguments[0])) : undefined;
      if (host) uses.push({ kind: "host", host });
    }
  });
  return uses;
}

/** Every name a function's body declares or reassigns, at any depth, including nested parameters. */
function declaredInside(fn: FunctionNode, budget: Budget): Set<string> {
  const names = new Set<string>();
  const visit = (node: t.Node) => {
    if (!spend(budget)) return;
    if (node.type === "VariableDeclarator")
      for (const name of patternNames(node.id)) names.add(name);
    if ((node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") && node.id)
      names.add(node.id.name);
    if (node !== fn && isFunction(node))
      for (const param of node.params) for (const name of patternNames(param)) names.add(name);
    if (node.type === "CatchClause" && node.param)
      for (const name of patternNames(node.param)) names.add(name);
    // A name written to inside is no longer what it was handed in as.
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier")
      names.add(node.left.name);
    for (const child of children(node)) visit(child);
  };
  visit(fn.body);
  return names;
}

/**
 * The host of a URL only when the code writes all of its authority, read with the same URL parser
 * that runs the request. A dynamic part before the authority closes could still change the host.
 */
function writtenHost(node: t.Node): string | undefined {
  const prefix = staticPrefix(node);
  if (!prefix || !/^https?:\/\//iu.test(prefix.text)) return undefined;
  let text = prefix.text;
  if (!prefix.complete) {
    const start = text.indexOf("//") + 2;
    const end = text.slice(start).search(/[/?#\\]/u);
    if (end < 0) return undefined;
    text = text.slice(0, start + end + 1);
  }
  if (!URL.canParse(text)) return undefined;
  return new URL(text).hostname.toLowerCase() || undefined;
}

/** The text a string expression starts with, and whether that is the whole string. */
function staticPrefix(
  node: t.Node,
): { readonly text: string; readonly complete: boolean } | undefined {
  if (node.type === "StringLiteral") return { text: node.value, complete: true };
  if (node.type === "TemplateLiteral") {
    const first = node.quasis[0]?.value.cooked;
    return first === undefined || first === null
      ? undefined
      : { text: first, complete: node.expressions.length === 0 };
  }
  if (node.type === "BinaryExpression" && node.operator === "+") {
    const left = staticPrefix(unwrap(node.left));
    return left && { text: left.text, complete: false };
  }
  return undefined;
}

function dedupe(uses: Reference[]): Reference[] {
  const seen = new Set<string>();
  return uses.filter((use) => {
    const key = JSON.stringify(use);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
