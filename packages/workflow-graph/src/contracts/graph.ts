/**
 * A workflow drawn from its source. The tree mirrors the code: a block is a list of nodes that run
 * top to bottom, and decisions, loops, parallel groups and try blocks hold their own blocks. Edges
 * are implied by that structure, so nobody writes or stores a graph by hand.
 */

/** Text from the code. A template keeps its static parts and shows `…` for each dynamic one. */
export interface Label {
  readonly text: string;
  readonly dynamic: boolean;
}

/** Something a node names that has its own place in the dashboard. */
export type Reference =
  | { readonly kind: "tool"; readonly path: string }
  | { readonly kind: "workflow"; readonly name: string }
  | { readonly kind: "account"; readonly slot: string; readonly scope: "user" | "app" | undefined }
  | { readonly kind: "host"; readonly host: string };

/** What starts a workflow, read from the code that calls `workflows.start`. */
export type Starter =
  | { readonly kind: "tool"; readonly path: string }
  | { readonly kind: "schedule"; readonly name: string; readonly tool: string }
  | { readonly kind: "webhook"; readonly name: string }
  | {
      readonly kind: "workflow";
      readonly name: string;
      readonly step: string;
      readonly tool: string;
    };

export type StepKind = "do" | "query" | "mutation" | "sleep" | "sleepUntil";

/** One durable step: a `ctx.step` call. `detail` holds its options as written. */
export interface StepNode {
  readonly type: "step";
  readonly id: string;
  /** The file and line the node was written at; a helper's steps keep their own file. */
  readonly file: string;
  readonly line: number;
  readonly kind: StepKind;
  readonly label: Label;
  readonly detail: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly uses: ReadonlyArray<Reference>;
  /** The line span of the call, for the code excerpt. */
  readonly end: number;
}

export interface Arm {
  readonly label: string;
  readonly body: ReadonlyArray<WorkflowNode>;
}

/** `if`, `switch`, `?:` and `&&`/`||` around steps; one arm per option in code order. */
export interface BranchNode {
  readonly type: "branch";
  readonly id: string;
  /** The file and line the node was written at; a helper's steps keep their own file. */
  readonly file: string;
  readonly line: number;
  readonly label: Label;
  readonly arms: ReadonlyArray<Arm>;
}

/** A loop statement, or `Promise.all(items.map(…))`, around steps. */
export interface LoopNode {
  readonly type: "loop";
  readonly id: string;
  /** The file and line the node was written at; a helper's steps keep their own file. */
  readonly file: string;
  readonly line: number;
  readonly label: Label;
  readonly detail: string | undefined;
  readonly body: ReadonlyArray<WorkflowNode>;
}

/** `Promise.all([...])` with steps in more than one entry. */
export interface ParallelNode {
  readonly type: "parallel";
  readonly id: string;
  /** The file and line the node was written at; a helper's steps keep their own file. */
  readonly file: string;
  readonly line: number;
  readonly branches: ReadonlyArray<ReadonlyArray<WorkflowNode>>;
}

/**
 * `try` around steps: `failure` is the `catch`, which runs when something in `body` throws, and
 * `cleanup` the `finally`, which runs after either, however they leave.
 */
export interface TryNode {
  readonly type: "try";
  readonly id: string;
  /** The file and line the node was written at; a helper's steps keep their own file. */
  readonly file: string;
  readonly line: number;
  readonly body: ReadonlyArray<WorkflowNode>;
  readonly failure: ReadonlyArray<WorkflowNode>;
  readonly cleanup: ReadonlyArray<WorkflowNode>;
  /** Whether a `catch` takes failures; an empty one swallows them. */
  readonly catches: boolean;
}

/**
 * Where a path stops: a `return` (`done`), an uncaught `throw` (`fails`), inside a loop a
 * `continue` (`next`) or `break` (`exit`), or a helper's or callback's own `return` where the rest
 * of its code can't be drawn around it (`return`).
 */
export interface EndNode {
  readonly type: "end";
  readonly id: string;
  /** The file and line the node was written at; a helper's steps keep their own file. */
  readonly file: string;
  readonly line: number;
  readonly outcome: "done" | "fails" | "next" | "exit" | "return";
}

export type WorkflowNode = StepNode | BranchNode | LoopNode | ParallelNode | TryNode | EndNode;

export interface WorkflowGraph {
  readonly name: string;
  readonly file: string;
  readonly line: number;
  /** Top-level input fields when the input schema is an `object({...})` written in place. */
  readonly input: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<WorkflowNode>;
  readonly startedBy: ReadonlyArray<Starter>;
  /** Only part of the workflow is drawn: it was too large to read in full, or a helper calls itself. */
  readonly partial: boolean;
}

/** Every workflow an app's source declares, by name. */
export interface AppGraph {
  readonly workflows: ReadonlyArray<WorkflowGraph>;
}
