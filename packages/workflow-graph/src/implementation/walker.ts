import type * as t from "@babel/types";
import type { Arm, EndNode, Label, WorkflowNode } from "../contracts/graph.ts";
import {
  children,
  declareIn,
  forgetWritten,
  isFunction,
  keyName,
  line,
  memberName,
  patternNames,
  resolve,
  rootName,
  spend,
  unwrap,
  type At,
  type Binding,
  type Budget,
  type Environment,
  type FunctionNode,
  type Module,
} from "./source.ts";
import { describeStep, sourceText, stepKind } from "./steps.ts";

export interface Tools {
  /** Tool path by the operation's defining expression, to name `runQuery(…, op)` targets. */
  readonly byNode: Map<t.Node, string>;
  readonly handlers: Map<string, At>;
}

export interface Context {
  readonly modules: Map<string, Module>;
  readonly tools: Tools;
  readonly startsByTool: Map<string, Set<string>>;
  readonly budget: Budget;
}

/**
 * Where the walk is. `env` holds the bindings in scope, and `contexts` and `steps` the names that
 * hold `ctx` and `ctx.step`; each block gets its own copies, so a block's names end with it, and a
 * name declared or assigned again loses its role.
 */
interface Scope {
  readonly module: Module;
  readonly env: Map<string, Binding>;
  readonly contexts: Set<string>;
  readonly steps: Set<string>;
  /** What a `return` leaves: the run, a callback such as one item's pass, or an inlined helper. */
  readonly exit: "workflow" | "callback" | "helper";
  /** A `throw` here lands in a `catch`. */
  readonly catches: boolean;
  /** What an unlabelled `break` leaves. */
  readonly breaks: "loop" | "switch" | undefined;
  readonly inLoop: boolean;
  /**
   * A `return` from a helper or callback here can be folded: the rest of the block is drawn in the
   * branch that goes on. Inside a loop, `switch` or `try` it can't, and draws a "Returns" marker.
   */
  readonly foldsReturn: boolean;
  /** A `continue` here goes on to a `for` loop's update steps, drawn after the body. */
  readonly continuesToUpdate: boolean;
  readonly helpers: ReadonlyArray<t.Node>;
}

/**
 * A block's nodes and how paths leave it. `ends` means no path reaches what follows. The others say
 * which ways out were used: a `return` from a helper or callback, a `break` out of a `switch` and a
 * `throw` a `catch` takes all leave without a node of their own, and `continue` or a loop's `break`
 * leave through a "Next" or "Exit loop" marker.
 */
export interface Block {
  readonly nodes: WorkflowNode[];
  readonly ends: boolean;
  readonly returns: boolean;
  readonly breaks: boolean;
  readonly caught: boolean;
  readonly jumps: boolean;
  /** Some path left with a `continue` that goes on to the loop's update. */
  readonly skips: boolean;
}

const EMPTY: Block = {
  nodes: [],
  ends: false,
  returns: false,
  breaks: false,
  caught: false,
  jumps: false,
  skips: false,
};

/** Past this many nodes the walk stops adding to the workflow and marks its graph partial. */
const MAX_NODES = 600;

export class Walker {
  private count = 0;
  /** Receiver names the code writes to; from then on they are not trusted as `ctx` or `ctx.step`. */
  private readonly tainted = new Set<string>();
  /** Set when the graph shows only part of the workflow: the budget or node limit ran out, or a helper calls itself. */
  partial = false;

  constructor(private readonly context: Context) {}

  private id() {
    this.count += 1;
    return `n${this.count}`;
  }

  /** Whether the walk may go on; once it may not, the graph is partial. */
  private working(): boolean {
    if (this.count < MAX_NODES && spend(this.context.budget)) return true;
    this.partial = true;
    return false;
  }

  /**
   * A function's scope. `roles` names the parameters that receive `ctx` or `ctx.step`; for the
   * workflow handler that is its first. Every other parameter shadows outer names with an unknown.
   */
  enter(
    module: Module,
    fn: FunctionNode,
    roles: ReadonlyArray<"ctx" | "step" | undefined>,
    exit: Scope["exit"],
    helpers: ReadonlyArray<t.Node>,
    outer?: Environment,
  ): Scope {
    const scope: Scope = {
      module,
      env: new Map<string, Binding>(outer ?? []),
      contexts: new Set(),
      steps: new Set(),
      exit,
      catches: false,
      breaks: undefined,
      inLoop: false,
      foldsReturn: true,
      continuesToUpdate: false,
      helpers,
    };
    fn.params.forEach((param, index) => {
      this.bind(scope, patternNames(param));
      const role = exit === "workflow" ? (index === 0 ? "ctx" : undefined) : roles[index];
      if (param.type === "Identifier" && role)
        (role === "ctx" ? scope.contexts : scope.steps).add(param.name);
      if (param.type === "ObjectPattern" && role === "ctx") this.stepsFrom(param, scope);
    });
    return scope;
  }

  /** Declares names with unknown values; they shadow outer bindings and any receiver role. */
  private bind(scope: Scope, names: ReadonlyArray<string>) {
    for (const name of names) {
      scope.env.set(name, null);
      scope.contexts.delete(name);
      scope.steps.delete(name);
    }
  }

  body(fn: FunctionNode, scope: Scope): Block {
    if (fn.body.type === "BlockStatement") return this.statements(fn.body.body, scope);
    return this.flow(this.expression(fn.body, scope));
  }

  private child(scope: Scope, changes: Partial<Scope> = {}): Scope {
    return {
      ...scope,
      env: new Map<string, Binding>(scope.env),
      contexts: new Set(scope.contexts),
      steps: new Set(scope.steps),
      ...changes,
    };
  }

  /** A run of statements in their own block scope; it stops at the first one no path gets past. */
  statements(list: ReadonlyArray<t.Statement>, outer: Scope): Block {
    const scope = this.child(outer);
    for (const statement of list) {
      if (statement.type === "FunctionDeclaration" && statement.id) {
        this.bind(scope, [statement.id.name]);
        scope.env.set(statement.id.name, { node: statement, env: scope.env });
      }
      // A block's `let`, `const` and class names shadow outer ones from the block's start, before
      // their declaration runs; reading them there throws, so they resolve to nothing.
      if (statement.type === "ClassDeclaration" && statement.id)
        this.bind(scope, [statement.id.name]);
      if (statement.type === "VariableDeclaration" && statement.kind !== "var")
        for (const declarator of statement.declarations)
          this.bind(scope, patternNames(declarator.id));
    }
    return this.sequence(list, scope);
  }

  /** The statements of `list` from `from` on; passing the start keeps folding from copying the rest. */
  private sequence(list: ReadonlyArray<t.Statement>, scope: Scope, from = 0): Block {
    const nodes: WorkflowNode[] = [];
    let flags = EMPTY;
    for (let index = from; index < list.length; index++) {
      const statement = list[index];
      if (!statement || !this.working()) break;
      // A branch that leaves without a node, such as a helper's early `return`, takes only the
      // other branch on to the rest of the block, so the rest is drawn inside that branch.
      const block =
        statement.type === "IfStatement"
          ? this.ifStatement(statement, scope, { list, from: index + 1 })
          : this.statement(statement, scope);
      nodes.push(...block.nodes);
      flags = merge(flags, block);
      if (block.ends || ("folded" in block && block.folded))
        return { ...flags, nodes, ends: block.ends };
    }
    return { ...flags, nodes, ends: false };
  }

  /** Nodes from an expression: a path through them stops when every way through ends. */
  private flow(nodes: WorkflowNode[]): Block {
    return { ...EMPTY, nodes, ends: terminal(nodes) };
  }

  statement(node: t.Statement, scope: Scope): Block {
    if (!this.working()) return EMPTY;
    switch (node.type) {
      case "ExpressionStatement":
        return this.flow(this.expression(node.expression, scope));
      case "VariableDeclaration": {
        const nodes = this.inOrder(
          node.declarations.flatMap((declarator) => (declarator.init ? [declarator.init] : [])),
          scope,
        );
        for (const declarator of node.declarations) this.alias(declarator, scope);
        declareIn(scope.env, node, scope.env);
        return this.flow(nodes);
      }
      case "FunctionDeclaration":
        return EMPTY;
      case "ReturnStatement": {
        const nodes = node.argument ? this.expression(node.argument, scope) : [];
        if (scope.exit === "workflow") nodes.push(this.end(node, scope, "done"));
        else if (!scope.foldsReturn) nodes.push(this.end(node, scope, "return"));
        return {
          ...EMPTY,
          nodes,
          ends: true,
          returns: scope.exit !== "workflow" && scope.foldsReturn,
        };
      }
      case "ThrowStatement": {
        const nodes = node.argument ? this.expression(node.argument, scope) : [];
        if (!scope.catches) nodes.push(this.end(node, scope, "fails"));
        return { ...EMPTY, nodes, ends: true, caught: scope.catches };
      }
      case "BreakStatement":
        if (scope.breaks === "switch" && !node.label) return { ...EMPTY, ends: true, breaks: true };
        return { ...EMPTY, nodes: [this.end(node, scope, "exit")], ends: true, jumps: true };
      case "ContinueStatement":
        if (scope.continuesToUpdate && !node.label) return { ...EMPTY, ends: true, skips: true };
        return {
          ...EMPTY,
          nodes: scope.inLoop ? [this.end(node, scope, "next")] : [],
          ends: true,
          jumps: true,
        };
      case "BlockStatement":
        return this.statements(node.body, scope);
      case "LabeledStatement":
        return this.statement(node.body, scope);
      case "IfStatement":
        return this.ifStatement(node, scope, undefined);
      case "SwitchStatement":
        return this.switchStatement(node, scope);
      case "ForOfStatement":
      case "ForInStatement":
        return this.eachLoop(node, scope);
      case "ForStatement":
        return this.forLoop(node, scope);
      case "WhileStatement":
      case "DoWhileStatement":
        return this.whileLoop(node, scope);
      case "TryStatement":
        return this.tryStatement(node, scope);
      default:
        return EMPTY;
    }
  }

  private end(node: t.Node, scope: Scope, outcome: EndNode["outcome"]): EndNode {
    return { type: "end", id: this.id(), file: scope.module.path, line: line(node), outcome };
  }

  /** `const step = ctx.step` and `const { step } = ctx` add receivers; any other value removes them. */
  private alias(declarator: t.VariableDeclarator, scope: Scope) {
    const init = declarator.init && unwrap(declarator.init);
    const step = !!init && declarator.id.type === "Identifier" && this.isStepReceiver(init, scope);
    const context = !!init && declarator.id.type === "Identifier" && this.isContext(init, scope);
    const destructured =
      !!init && declarator.id.type === "ObjectPattern" && this.isContext(init, scope);
    this.bind(scope, patternNames(declarator.id));
    if (declarator.id.type === "Identifier" && step) scope.steps.add(declarator.id.name);
    if (declarator.id.type === "Identifier" && context) scope.contexts.add(declarator.id.name);
    if (declarator.id.type === "ObjectPattern" && destructured)
      this.stepsFrom(declarator.id, scope);
  }

  private stepsFrom(pattern: t.ObjectPattern, scope: Scope) {
    for (const entry of pattern.properties)
      if (
        entry.type === "ObjectProperty" &&
        !entry.computed &&
        keyName(entry.key) === "step" &&
        entry.value.type === "Identifier"
      )
        scope.steps.add(entry.value.name);
  }

  /** `rest` is what follows in the block; it is drawn inside the branch that goes on to it. */
  private ifStatement(
    node: t.IfStatement,
    scope: Scope,
    rest: { readonly list: ReadonlyArray<t.Statement>; readonly from: number } | undefined,
  ): Block & { readonly folded?: boolean } {
    const test = this.expression(node.test, scope);
    const yes = this.statement(node.consequent, this.child(scope));
    const no = node.alternate ? this.statement(node.alternate, this.child(scope)) : EMPTY;
    const leavesQuietly = (arm: Block) =>
      arm.ends && !terminal(arm.nodes) && (arm.returns || arm.breaks || arm.skips) && !arm.caught;
    const fold =
      rest !== undefined &&
      rest.from < rest.list.length &&
      ((leavesQuietly(yes) && !no.ends) || (leavesQuietly(no) && !yes.ends));
    if (fold && rest) {
      const after = this.sequence(rest.list, scope, rest.from);
      const yesBody = yes.ends ? yes.nodes : [...yes.nodes, ...after.nodes];
      const noBody = no.ends ? no.nodes : [...no.nodes, ...after.nodes];
      return {
        ...merge(merge(yes, no), after),
        nodes: [
          ...test,
          this.branch(node, scope, this.label(node.test, scope), [
            { label: "Yes", body: yesBody },
            { label: "No", body: noBody },
          ]),
        ],
        ends: after.ends,
        folded: true,
      };
    }
    const flags = merge(yes, no);
    const ends = yes.ends && no.ends;
    if (yes.nodes.length === 0 && no.nodes.length === 0) return { ...flags, nodes: test, ends };
    return {
      ...flags,
      nodes: [
        ...test,
        this.branch(node, scope, this.label(node.test, scope), [
          { label: "Yes", body: yes.nodes },
          { label: "No", body: no.nodes },
        ]),
      ],
      ends,
    };
  }

  /** Each option runs its case and falls through the following ones until a `break` or an end. */
  private switchStatement(node: t.SwitchStatement, scope: Scope): Block {
    const test = this.expression(node.discriminant, scope);
    const arms: Arm[] = [];
    const blocks: Block[] = [];
    let names: string[] = [];
    let hasDefault = false;
    node.cases.forEach((entry, index) => {
      names.push(entry.test ? this.text(entry.test, scope) : "default");
      if (!entry.test) hasDefault = true;
      if (entry.consequent.length === 0 && index < node.cases.length - 1) return;
      const path: t.Statement[] = [];
      collect: for (const later of node.cases.slice(index))
        for (const statement of later.consequent) {
          if (statement.type === "BreakStatement" && !statement.label) break collect;
          path.push(statement);
        }
      const block = this.statements(
        path,
        this.child(scope, { breaks: "switch", foldsReturn: false }),
      );
      arms.push({ label: names.join(", "), body: block.nodes });
      blocks.push(block);
      names = [];
    });
    if (!hasDefault) {
      arms.push({ label: "default", body: [] });
      blocks.push(EMPTY);
    }
    // A `break` inside an option leaves the switch, so what follows it is still reached.
    const stops = blocks.every((block) => block.ends && !block.breaks);
    const flags = { ...blocks.reduce(merge, EMPTY), breaks: false };
    if (arms.every((arm) => arm.body.length === 0)) return { ...flags, nodes: test, ends: stops };
    return {
      ...flags,
      nodes: [...test, this.branch(node, scope, this.label(node.discriminant, scope), arms)],
      ends: stops,
    };
  }

  private loopScope(scope: Scope): Scope {
    return this.child(scope, {
      breaks: "loop",
      inLoop: true,
      foldsReturn: false,
      continuesToUpdate: false,
    });
  }

  private eachLoop(node: t.ForOfStatement | t.ForInStatement, scope: Scope): Block {
    const before = this.expression(node.right, scope);
    const inner = this.loopScope(scope);
    const left =
      node.left.type === "VariableDeclaration" ? node.left.declarations[0]?.id : node.left;
    if (left) this.bind(inner, patternNames(left));
    const body = this.statement(node.body, inner);
    const name = left ? this.text(left, scope) : "item";
    return this.loop(
      node,
      scope,
      before,
      body,
      body.nodes,
      `Each ${name}`,
      `of ${this.text(node.right, scope)}`,
      false,
    );
  }

  private forLoop(node: t.ForStatement, scope: Scope): Block {
    const inner = this.loopScope(scope);
    const init = !node.init
      ? []
      : node.init.type === "VariableDeclaration"
        ? this.statement(node.init, inner).nodes
        : this.expression(node.init, inner);
    const test = node.test ? this.expression(node.test, inner) : [];
    // A `continue` goes on to the update, so when the update has steps it flows into them.
    const updateSteps = node.update ? this.expression(node.update, inner) : [];
    const body = this.statement(node.body, { ...inner, continuesToUpdate: updateSteps.length > 0 });
    const update = !body.ends || body.skips ? updateSteps : [];
    return this.loop(
      node,
      scope,
      init,
      body,
      [...test, ...body.nodes, ...update],
      "Repeat",
      node.test ? `while ${this.text(node.test, scope)}` : undefined,
      false,
    );
  }

  private whileLoop(node: t.WhileStatement | t.DoWhileStatement, scope: Scope): Block {
    const inner = this.loopScope(scope);
    const test = this.expression(node.test, inner);
    const body = this.statement(node.body, inner);
    const once = node.type === "DoWhileStatement";
    // A `do … while` checks its condition only after a pass that reaches the end of its body.
    const pass = once ? [...body.nodes, ...(body.ends ? [] : test)] : [...test, ...body.nodes];
    return this.loop(
      node,
      scope,
      [],
      body,
      pass,
      "Repeat",
      `while ${this.text(node.test, scope)}`,
      once,
    );
  }

  /**
   * A loop may run no passes, so what follows it is reached, unless it is a `do … while` whose one
   * certain pass always returns or throws.
   */
  private loop(
    node: t.Node,
    scope: Scope,
    before: WorkflowNode[],
    body: Block,
    pass: WorkflowNode[],
    label: string,
    detail: string | undefined,
    once: boolean,
  ): Block {
    const flags = { ...body, jumps: false, breaks: false, skips: false };
    const ends = once && body.ends && !body.jumps;
    if (pass.length === 0) return { ...flags, nodes: before, ends };
    return {
      ...flags,
      nodes: [
        ...before,
        {
          type: "loop",
          id: this.id(),
          file: scope.module.path,
          line: line(node),
          label: { text: label, dynamic: false },
          detail,
          body: pass,
        },
      ],
      ends,
    };
  }

  /**
   * `finally` is drawn inside the try box as the part that always runs, after the body and the
   * failure branch, whichever way they leave.
   */
  private tryStatement(node: t.TryStatement, scope: Scope): Block {
    const handler = node.handler;
    const body = this.statements(
      node.block.body,
      this.child(scope, { catches: scope.catches || !!handler, foldsReturn: false }),
    );
    let failure = EMPTY;
    if (handler) {
      const inner = this.child(scope, { foldsReturn: false });
      if (handler.param) this.bind(inner, patternNames(handler.param));
      failure = this.statements(handler.body.body, inner);
    }
    const cleanup = node.finalizer
      ? this.statements(node.finalizer.body, this.child(scope, { foldsReturn: false }))
      : EMPTY;
    const ends = cleanup.ends || (body.ends && (!handler || failure.ends));
    const flags = merge(
      merge({ ...body, caught: handler ? false : body.caught }, failure),
      cleanup,
    );
    if (!handler && cleanup.nodes.length === 0) return { ...flags, nodes: body.nodes, ends };
    if (body.nodes.length === 0 && failure.nodes.length === 0 && cleanup.nodes.length === 0)
      return { ...flags, nodes: [], ends };
    return {
      ...flags,
      nodes: [
        {
          type: "try",
          id: this.id(),
          file: scope.module.path,
          line: line(node),
          body: body.nodes,
          failure: failure.nodes,
          cleanup: cleanup.nodes,
          catches: !!handler,
        },
      ],
      ends,
    };
  }

  private branch(node: t.Node, scope: Scope, label: Label, arms: Arm[]): WorkflowNode {
    return {
      type: "branch",
      id: this.id(),
      file: scope.module.path,
      line: line(node),
      label,
      arms,
    };
  }

  /** Steps inside an expression, in evaluation order. Functions are not entered unless called. */
  expression(node: t.Node, scope: Scope): WorkflowNode[] {
    if (!this.working()) return [];
    const current = unwrap(node);
    if (current.type === "AwaitExpression") return this.expression(current.argument, scope);
    if (current.type === "AssignmentExpression" || current.type === "UpdateExpression") {
      const target = current.type === "AssignmentExpression" ? current.left : current.argument;
      const nodes = this.inOrder(children(current), scope);
      // A written name is no longer what it was declared as, and no longer a receiver, on any
      // path after the write, including one that writes only conditionally or to a property.
      forgetWritten(scope.env, current);
      const root = rootName(target);
      if (root !== undefined && (scope.contexts.has(root) || scope.steps.has(root)))
        this.tainted.add(root);
      if (unwrap(target).type === "Identifier") this.bind(scope, patternNames(unwrap(target)));
      return nodes;
    }
    if (current.type === "CallExpression") {
      const step = this.step(current, scope);
      if (step) return step;
      const all = this.promiseAll(current, scope);
      if (all) return all;
      const inlined = this.helper(current, scope);
      if (inlined) return inlined;
    }
    if (current.type === "ConditionalExpression") {
      const test = this.expression(current.test, scope);
      const yes = this.expression(current.consequent, scope);
      const no = this.expression(current.alternate, scope);
      if (yes.length === 0 && no.length === 0) return test;
      return [
        ...test,
        this.branch(current, scope, this.label(current.test, scope), [
          { label: "Yes", body: yes },
          { label: "No", body: no },
        ]),
      ];
    }
    if (current.type === "LogicalExpression") {
      const left = this.expression(current.left, scope);
      const right = this.expression(current.right, scope);
      if (right.length === 0) return left;
      const runsWhenTrue = current.operator === "&&";
      return [
        ...left,
        this.branch(current, scope, this.label(current.left, scope), [
          { label: "Yes", body: runsWhenTrue ? right : [] },
          { label: "No", body: runsWhenTrue ? [] : right },
        ]),
      ];
    }
    if (isFunction(current) || current.type === "ClassExpression") return [];
    return this.inOrder(children(current), scope);
  }

  /** Expressions evaluated one after another; nothing after one that always throws is reached. */
  private inOrder(list: ReadonlyArray<t.Node>, scope: Scope): WorkflowNode[] {
    const nodes: WorkflowNode[] = [];
    for (const node of list) {
      nodes.push(...this.expression(node, scope));
      if (terminal(nodes)) break;
    }
    return nodes;
  }

  private isContext(node: t.Node, scope: Scope): boolean {
    const current = unwrap(node);
    return (
      current.type === "Identifier" &&
      scope.contexts.has(current.name) &&
      !this.tainted.has(current.name)
    );
  }

  private isStepReceiver(node: t.Node, scope: Scope): boolean {
    const current = unwrap(node);
    if (current.type === "Identifier")
      return scope.steps.has(current.name) && !this.tainted.has(current.name);
    if (current.type !== "MemberExpression" || memberName(current) !== "step") return false;
    return this.isContext(current.object, scope);
  }

  private step(call: t.CallExpression, scope: Scope): WorkflowNode[] | undefined {
    const callee = unwrap(call.callee);
    if (callee.type !== "MemberExpression") return undefined;
    const kind = stepKind(callee);
    if (!kind || !this.isStepReceiver(callee.object, scope)) return undefined;
    const before = this.inOrder(
      call.arguments.slice(1).filter((arg) => !isFunction(arg)),
      scope,
    );
    // An argument that always throws means the step itself is never reached.
    if (terminal(before)) return before;
    const described = describeStep(
      call,
      kind,
      { module: scope.module, env: scope.env },
      this.context,
    );
    return [...before, { type: "step", id: this.id(), ...described }];
  }

  /** `Promise.all([a, b])` runs side by side; `Promise.all(items.map(fn))` runs `fn` per item. */
  private promiseAll(call: t.CallExpression, scope: Scope): WorkflowNode[] | undefined {
    const callee = unwrap(call.callee);
    if (callee.type !== "MemberExpression") return undefined;
    const owner = unwrap(callee.object);
    const method = memberName(callee);
    if (owner.type !== "Identifier" || owner.name !== "Promise" || scope.env.has("Promise"))
      return undefined;
    if (method !== "all" && method !== "allSettled" && method !== "race" && method !== "any")
      return undefined;
    const arg = call.arguments[0] && unwrap(call.arguments[0]);
    if (!arg) return [];
    if (arg.type === "ArrayExpression") {
      const branches = arg.elements
        .flatMap((element) => (element ? [this.expression(element, scope)] : []))
        .filter((branch) => branch.length > 0);
      if (branches.length <= 1) return branches[0] ?? [];
      return [
        { type: "parallel", id: this.id(), file: scope.module.path, line: line(call), branches },
      ];
    }
    if (arg.type !== "CallExpression") return undefined;
    const mapCallee = unwrap(arg.callee);
    const fn = arg.arguments[0] && unwrap(arg.arguments[0]);
    if (
      mapCallee.type !== "MemberExpression" ||
      memberName(mapCallee) !== "map" ||
      !fn ||
      !isFunction(fn)
    )
      return undefined;
    const items = this.expression(mapCallee.object, scope);
    const inner = this.enter(scope.module, fn, [], "callback", scope.helpers, scope.env);
    // The callback keeps the receivers in scope, except names its own parameters shadow.
    const shadowed = new Set(fn.params.flatMap(patternNames));
    for (const name of scope.contexts) if (!shadowed.has(name)) inner.contexts.add(name);
    for (const name of scope.steps) if (!shadowed.has(name)) inner.steps.add(name);
    // `allSettled` collects a pass's failure instead of failing the run.
    const catches = scope.catches || method === "allSettled";
    const body = this.body(fn, { ...inner, catches }).nodes;
    if (body.length === 0) return items;
    const param = fn.params[0];
    return [
      ...items,
      {
        type: "loop",
        id: this.id(),
        file: scope.module.path,
        line: line(call),
        label: { text: `Each ${param ? this.text(param, scope) : "item"}`, dynamic: false },
        detail: `of ${this.text(mapCallee.object, scope)}, at the same time`,
        body,
      },
    ];
  }

  /** A call to a function in the app's own code that receives `ctx` or `ctx.step` is drawn inline. */
  private helper(call: t.CallExpression, scope: Scope): WorkflowNode[] | undefined {
    const roles = call.arguments.map((arg) =>
      this.isContext(arg, scope)
        ? ("ctx" as const)
        : this.isStepReceiver(arg, scope)
          ? ("step" as const)
          : undefined,
    );
    if (!roles.some(Boolean)) return undefined;
    const target = resolve(
      { module: scope.module, node: call.callee, env: scope.env },
      this.context.modules,
    );
    if (!isFunction(target.node)) {
      // `ctx` goes into code that can't be read, so steps it takes there aren't drawn.
      this.partial = true;
      return undefined;
    }
    if (scope.helpers.includes(target.node)) {
      // A helper that calls itself is drawn once; its repeats are left out.
      this.partial = true;
      return undefined;
    }
    const before = call.arguments.flatMap((arg) =>
      isFunction(arg) ? [] : this.expression(arg, scope),
    );
    const inner = this.enter(
      target.module,
      target.node,
      roles,
      "helper",
      [...scope.helpers, target.node],
      target.env,
    );
    // A helper's own `return` ends only the helper; its uncaught `throw` still ends the run.
    return [...before, ...this.body(target.node, { ...inner, catches: scope.catches }).nodes];
  }

  /** A condition as written. */
  private label(node: t.Node, scope: Scope): Label {
    return { text: sourceText(scope.module, node), dynamic: false };
  }

  private text(node: t.Node, scope: Scope): string {
    return sourceText(scope.module, node);
  }
}

function merge(a: Block, b: Block): Block {
  return {
    nodes: a.nodes,
    ends: a.ends,
    returns: a.returns || b.returns,
    breaks: a.breaks || b.breaks,
    caught: a.caught || b.caught,
    jumps: a.jumps || b.jumps,
    skips: a.skips || b.skips,
  };
}

/** Whether no path through these nodes reaches what follows them. */
export function terminal(nodes: ReadonlyArray<WorkflowNode>): boolean {
  const last = nodes.at(-1);
  if (!last) return false;
  switch (last.type) {
    case "end":
      return true;
    case "branch":
      return last.arms.every((arm) => arm.body.length > 0 && terminal(arm.body));
    case "try":
      return (
        terminal(last.cleanup) || (terminal(last.body) && (!last.catches || terminal(last.failure)))
      );
    default:
      return false;
  }
}
