export interface Label {
  readonly text: string;
  readonly dynamic: boolean;
}

export type Reference =
  | { readonly kind: "tool"; readonly path: string }
  | { readonly kind: "workflow"; readonly name: string }
  | { readonly kind: "account"; readonly slot: string; readonly scope: "user" | "app" | undefined }
  | { readonly kind: "host"; readonly host: string };

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

export interface StepNode {
  readonly type: "step";
  readonly id: string;

  readonly file: string;
  readonly line: number;
  readonly kind: StepKind;
  readonly label: Label;
  readonly detail: ReadonlyArray<{ readonly name: string; readonly value: string }>;
  readonly uses: ReadonlyArray<Reference>;

  readonly end: number;
}

export interface Arm {
  readonly label: string;
  readonly body: ReadonlyArray<WorkflowNode>;
}

export interface BranchNode {
  readonly type: "branch";
  readonly id: string;

  readonly file: string;
  readonly line: number;
  readonly label: Label;
  readonly arms: ReadonlyArray<Arm>;
}

export interface LoopNode {
  readonly type: "loop";
  readonly id: string;

  readonly file: string;
  readonly line: number;
  readonly label: Label;
  readonly detail: string | undefined;
  readonly body: ReadonlyArray<WorkflowNode>;
}

export interface ParallelNode {
  readonly type: "parallel";
  readonly id: string;

  readonly file: string;
  readonly line: number;
  readonly branches: ReadonlyArray<ReadonlyArray<WorkflowNode>>;
}

export interface TryNode {
  readonly type: "try";
  readonly id: string;

  readonly file: string;
  readonly line: number;
  readonly body: ReadonlyArray<WorkflowNode>;
  readonly failure: ReadonlyArray<WorkflowNode>;
  readonly cleanup: ReadonlyArray<WorkflowNode>;

  readonly catches: boolean;
}

export interface EndNode {
  readonly type: "end";
  readonly id: string;

  readonly file: string;
  readonly line: number;
  readonly outcome: "done" | "fails" | "next" | "exit" | "return";
}

export type WorkflowNode = StepNode | BranchNode | LoopNode | ParallelNode | TryNode | EndNode;

export interface WorkflowGraph {
  readonly name: string;
  readonly file: string;
  readonly line: number;

  readonly input: ReadonlyArray<string>;
  readonly nodes: ReadonlyArray<WorkflowNode>;
  readonly startedBy: ReadonlyArray<Starter>;

  readonly partial: boolean;
}

export interface AppGraph {
  readonly workflows: ReadonlyArray<WorkflowGraph>;
}
