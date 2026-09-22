/** Workflow actions share the read-only browser and keep independent mutation state. */
import { Json, type HostedWorkflow, type WorkflowRun } from "@executor-js/sdk";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult, type Atom } from "effect/unstable/reactivity";
import { Exit, Schema } from "effect";
import { useState, type ComponentType } from "react";
import type { FailureProps } from "../../contracts/dashboard.ts";
import { Code } from "./code.tsx";
import { Button } from "../components/button.tsx";
import { Textarea } from "../components/textarea.tsx";
type Start<E> = Atom.AtomResultFn<
  { readonly workflow: string; readonly input: Json; readonly key: string },
  WorkflowRun,
  E
>;
export function WorkflowStart<E>({
  definition,
  start,
  editable,
  Failure,
  onStarted,
}: {
  readonly definition: HostedWorkflow;
  readonly start: Start<E>;
  readonly editable: boolean;
  readonly Failure: ComponentType<FailureProps<E>>;
  readonly onStarted: () => void;
}) {
  const [input, setInput] = useState("{}");
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [invalid, setInvalid] = useState(false);
  const [result, setResult] = useState<Exit.Exit<WorkflowRun, E>>();
  const [pending, setPending] = useState(false);
  const submit = useAtomSet(start, { mode: "promiseExit" });
  return (
    <div className="mt-3 space-y-3">
      <details>
        <summary className="cursor-pointer text-xs text-muted-foreground">Input schema</summary>
        <Code code={JSON.stringify(definition.inputSchema, null, 2)} />
      </details>
      {editable && (
        <form
          className="max-w-xl space-y-3"
          onSubmit={async (event) => {
            event.preventDefault();
            const value = Schema.decodeUnknownExit(Schema.fromJsonString(Json))(input);
            setInvalid(Exit.isFailure(value));
            if (Exit.isFailure(value)) return;
            setPending(true);
            const result = await submit({ workflow: definition.name, input: value.value, key });
            setPending(false);
            setResult(result);
            if (Exit.isSuccess(result)) {
              setKey(crypto.randomUUID());
              onStarted();
            }
          }}
        >
          <label className="block space-y-2 text-xs">
            Input
            <Textarea
              aria-label={`${definition.name} input`}
              className="min-h-24 font-mono text-xs"
              value={input}
              disabled={pending}
              onChange={(event) => {
                setInput(event.target.value);
                setKey(crypto.randomUUID());
              }}
              spellCheck={false}
            />
          </label>
          {invalid && (
            <p role="alert" className="text-sm text-destructive">
              Enter valid JSON.
            </p>
          )}
          {result && Exit.isFailure(result) && <Failure cause={result.cause} />}
          <Button size="sm" variant="outline" disabled={pending}>
            {pending ? "Starting…" : "Start workflow"}
          </Button>
          {result && Exit.isSuccess(result) && (
            <p role="status" className="text-xs text-muted-foreground">
              Workflow started.
            </p>
          )}
        </form>
      )}
    </div>
  );
}
export function WorkflowTerminate<E>({
  run,
  terminate,
  editable,
  Failure,
}: {
  readonly run: WorkflowRun;
  readonly terminate: Atom.AtomResultFn<void, WorkflowRun, E>;
  readonly editable: boolean;
  readonly Failure: ComponentType<FailureProps<E>>;
}) {
  const stop = useAtomSet(terminate),
    result = useAtomValue(terminate);
  const terminal =
    run.status === "complete" || run.status === "errored" || run.status === "terminated";
  return (
    <>
      {!terminal && editable && (
        <Button
          size="sm"
          variant="outline"
          disabled={AsyncResult.isWaiting(result)}
          onClick={() => stop()}
        >
          Terminate run
        </Button>
      )}
      {AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
    </>
  );
}
