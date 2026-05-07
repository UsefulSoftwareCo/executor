import { useState } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { authWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { Input } from "@executor-js/react/components/input";
import { Label } from "@executor-js/react/components/label";

import { createOrganization } from "../auth";

type CreatedOrganization = { id: string; handle: string; name: string };

export function useCreateOrganizationForm(options: {
  defaultName?: string;
  onSuccess: (org: CreatedOrganization) => void;
  onFailure?: () => void;
}) {
  const doCreate = useAtomSet(createOrganization, { mode: "promiseExit" });
  const [name, setName] = useState(options.defaultName ?? "");
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const reset = (nextName = options.defaultName ?? "") => {
    setName(nextName);
    setError(null);
    setCreating(false);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Organization name is required.");
      return;
    }
    setCreating(true);
    setError(null);
    const exit = await doCreate({ payload: { name: trimmed }, reactivityKeys: authWriteKeys });
    setCreating(false);
    if (Exit.isSuccess(exit)) {
      options.onSuccess(exit.value);
    } else {
      setError("Failed to create organization.");
      options.onFailure?.();
    }
  };

  return {
    name,
    setName,
    error,
    setError,
    creating,
    submit,
    reset,
    canSubmit: name.trim().length > 0,
  };
}

export function CreateOrganizationFields(props: {
  name: string;
  onNameChange: (name: string) => void;
  error: string | null;
  onSubmit: () => void;
}) {
  return (
    <div className="grid gap-4 py-3">
      <div className="grid gap-1.5">
        <Label
          htmlFor="organization-name"
          className="text-sm font-medium uppercase tracking-wider text-muted-foreground"
        >
          Organization name
        </Label>
        <Input
          id="organization-name"
          value={props.name}
          placeholder="Northwind Labs"
          autoFocus
          onChange={(event) => props.onNameChange((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") props.onSubmit();
          }}
          className="h-9 text-sm"
        />
      </div>

      {props.error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
          <p className="text-sm text-destructive">{props.error}</p>
        </div>
      )}
    </div>
  );
}
