/** One naming and mutation lifecycle for copied apps and generated catalog apps. */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Exit } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import type { App } from "@executor-js/sdk";
import type { MutationProps } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";

/** Prevent duplicate submits and late navigation when the form has been left. */
export function AppCreateForm<Input, E, A extends App = App>({
  mutation,
  Failure,
  initialName,
  input,
  onCreated,
  onCancel,
  label,
  children,
  beforeName,
}: MutationProps<Input, A, E> & {
  readonly initialName: string;
  readonly input: (name: string) => Input;
  readonly onCreated: (app: A) => void | Promise<void>;
  readonly onCancel?: (() => void) | undefined;
  readonly label: string;
  readonly children?: ((pending: boolean) => ReactNode) | undefined;
  readonly beforeName?: ReactNode;
}) {
  const result = useAtomValue(mutation);
  const create = useAtomSet(mutation, { mode: "promiseExit" });
  const [name, setName] = useState(initialName);
  const active = useRef(true);
  const submitting = useRef(false);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  return (
    <form
      className="max-w-145 space-y-5"
      onSubmit={async (event) => {
        event.preventDefault();
        if (submitting.current || !name.trim()) return;
        submitting.current = true;
        setPending(true);
        try {
          const exit = await create(input(name.trim()));
          if (active.current && Exit.isSuccess(exit)) await onCreated(exit.value);
        } finally {
          submitting.current = false;
          if (active.current) setPending(false);
        }
      }}
    >
      {beforeName}
      <label className="flex flex-col gap-2 text-[13px] font-medium">
        App name
        <Input
          required
          maxLength={120}
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={pending}
        />
      </label>
      {children?.(pending)}
      {AsyncResult.isFailure(result) && <Failure cause={result.cause} />}
      <div className="flex items-center gap-3">
        <Button type="submit" disabled={pending || !name.trim()}>
          {pending ? "Creating app…" : label}
        </Button>
        {onCancel && (
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}
