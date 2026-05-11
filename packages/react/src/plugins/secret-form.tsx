import {
  createContext,
  use,
  useId,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";

import { setSecret } from "../api/atoms";
import { secretWriteKeys } from "../api/reactivity-keys";
import { SecretId, type ScopeId } from "@executor-js/sdk";
import { Button, type buttonVariants } from "../components/button";
import { Field, FieldError, FieldLabel } from "../components/field";
import { Input } from "../components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";
import type { VariantProps } from "class-variance-authority";

import { secretValueInputType } from "./secret-input";
import { getUniqueSecretId, isSecretIdTaken } from "./secret-id";

// ---------------------------------------------------------------------------
// Context
//
// One generic interface — `state`, `actions`, `meta` — that both the modal
// and inline create flows share. Surfaces compose the `SecretForm.*` parts
// they want; provider owns state, derived values, and submit lifecycle.
// ---------------------------------------------------------------------------

type SubmitStatus =
  | { readonly kind: "idle" }
  | { readonly kind: "submitting" }
  | { readonly kind: "error"; readonly message: string };

interface SecretFormState {
  readonly name: string;
  readonly value: string;
  readonly idOverride: string | null;
  readonly provider: string;
  readonly revealed: boolean;
  readonly status: SubmitStatus;
}

interface SecretFormActions {
  readonly setName: (v: string) => void;
  readonly setValue: (v: string) => void;
  readonly setIdOverride: (v: string) => void;
  readonly setProvider: (v: string) => void;
  readonly toggleReveal: () => void;
  readonly submit: () => Promise<void>;
}

interface SecretFormMeta {
  readonly id: string;
  readonly duplicateError: string | null;
  readonly canSubmit: boolean;
}

interface SecretFormContextValue {
  readonly state: SecretFormState;
  readonly actions: SecretFormActions;
  readonly meta: SecretFormMeta;
}

const SecretFormContext = createContext<SecretFormContextValue | null>(null);

function useSecretForm(): SecretFormContextValue {
  const ctx = use(SecretFormContext);
  if (!ctx) {
    // oxlint-disable-next-line executor/no-try-catch-or-throw, executor/no-error-constructor -- boundary: React context invariant surfaces programmer misuse during render
    throw new Error("SecretForm parts must be rendered inside <SecretForm.Provider>");
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

interface SecretFormProviderProps {
  readonly existingSecretIds: readonly string[];
  readonly suggestedName?: string;
  readonly fallbackId?: string;
  readonly initialProvider?: string;
  readonly scopeId: ScopeId;
  readonly onCreated: (secretId: string) => void;
  readonly children: ReactNode;
}

function SecretFormProvider(props: SecretFormProviderProps) {
  const {
    existingSecretIds,
    suggestedName = "",
    fallbackId = "secret",
    initialProvider = "auto",
    scopeId,
    onCreated,
    children,
  } = props;

  const doSet = useAtomSet(setSecret, { mode: "promiseExit" });

  const [state, setState] = useState<SecretFormState>(() => ({
    name: suggestedName,
    value: "",
    idOverride: null,
    provider: initialProvider,
    revealed: false,
    status: { kind: "idle" },
  }));

  const baseName = state.name || suggestedName;
  const autoId = useMemo(
    () => getUniqueSecretId(baseName, existingSecretIds, fallbackId),
    [baseName, existingSecretIds, fallbackId],
  );
  const id = state.idOverride ?? autoId;
  const duplicateError =
    state.idOverride !== null && isSecretIdTaken(state.idOverride, existingSecretIds)
      ? "Secret ID already exists"
      : null;

  const displayName = state.name.trim() || suggestedName.trim();
  const canSubmit =
    id.trim() !== "" &&
    state.value.trim() !== "" &&
    duplicateError === null &&
    state.status.kind !== "submitting";

  const submit = async () => {
    if (!canSubmit) return;
    setState((s) => ({ ...s, status: { kind: "submitting" } }));
    const exit = await doSet({
      params: { scopeId },
      payload: {
        id: SecretId.make(id.trim()),
        name: displayName || id.trim(),
        value: state.value.trim(),
        provider: state.provider === "auto" ? undefined : state.provider,
      },
      reactivityKeys: secretWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setState((s) => ({
        ...s,
        status: {
          kind: "error",
          message: "Failed to save secret",
        },
      }));
      return;
    }
    onCreated(id.trim());
  };

  const value: SecretFormContextValue = {
    state,
    actions: {
      setName: (v) => setState((s) => ({ ...s, name: v })),
      setValue: (v) => setState((s) => ({ ...s, value: v })),
      setIdOverride: (v) => setState((s) => ({ ...s, idOverride: v })),
      setProvider: (v) => setState((s) => ({ ...s, provider: v })),
      toggleReveal: () => setState((s) => ({ ...s, revealed: !s.revealed })),
      submit,
    },
    meta: { id, duplicateError, canSubmit },
  };

  return <SecretFormContext value={value}>{children}</SecretFormContext>;
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

function NameField(props: { label?: string; placeholder?: string }) {
  const { state, actions } = useSecretForm();
  const inputId = useId();
  return (
    <Field>
      <FieldLabel htmlFor={inputId}>{props.label ?? "Name"}</FieldLabel>
      <Input
        id={inputId}
        value={state.name}
        onChange={(e) => actions.setName((e.target as HTMLInputElement).value)}
        placeholder={props.placeholder ?? "GitHub PAT"}
      />
    </Field>
  );
}

function IdField(props: { placeholder?: string }) {
  const { actions, meta } = useSecretForm();
  const inputId = useId();
  return (
    <Field>
      <FieldLabel htmlFor={inputId}>ID</FieldLabel>
      <Input
        id={inputId}
        value={meta.id}
        onChange={(e) => actions.setIdOverride((e.target as HTMLInputElement).value)}
        placeholder={props.placeholder ?? "github-token"}
        className="font-mono"
      />
      {meta.duplicateError && <FieldError>{meta.duplicateError}</FieldError>}
    </Field>
  );
}

function ValueField(props: { revealable?: boolean; placeholder?: string; autoFocus?: boolean }) {
  const { state, actions } = useSecretForm();
  const inputId = useId();
  const revealable = props.revealable ?? false;
  const revealed = revealable && state.revealed;
  const errored = state.status.kind === "error";

  return (
    <Field>
      <FieldLabel htmlFor={inputId}>Value</FieldLabel>
      <div className="relative" data-ph-block>
        <Input
          id={inputId}
          type={secretValueInputType({ revealable, revealed })}
          value={state.value}
          onChange={(e) => actions.setValue((e.target as HTMLInputElement).value)}
          placeholder={props.placeholder ?? "ghp_xxxxxxxxxxxxxxxxxxxx"}
          autoFocus={props.autoFocus}
          autoComplete="new-password"
          className={revealable ? "pr-9 font-mono" : "font-mono"}
          style={
            revealable && !revealed ? ({ WebkitTextSecurity: "disc" } as CSSProperties) : undefined
          }
          data-ph-block
        />
        {revealable && (
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            className="absolute right-1 top-1/2 size-7 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            onClick={actions.toggleReveal}
            aria-label={state.revealed ? "Hide secret value" : "Reveal secret value"}
          >
            <SecretVisibilityIcon revealed={state.revealed} />
          </Button>
        )}
      </div>
      {errored && (
        <FieldError>{state.status.kind === "error" ? state.status.message : ""}</FieldError>
      )}
    </Field>
  );
}

function ProviderField(props: { options: readonly { label: string; value: string }[] }) {
  const { state, actions } = useSecretForm();
  const inputId = useId();
  if (props.options.length <= 1) return null;
  return (
    <Field>
      <FieldLabel htmlFor={inputId}>Storage</FieldLabel>
      <Select value={state.provider} onValueChange={actions.setProvider}>
        <SelectTrigger id={inputId} className="h-9 text-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

function ErrorBanner() {
  const { state } = useSecretForm();
  if (state.status.kind !== "error") return null;
  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
      <p className="text-sm text-destructive">{state.status.message}</p>
    </div>
  );
}

type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

function SubmitButton(props: ButtonProps & { children?: ReactNode }) {
  const { state, meta, actions } = useSecretForm();
  const { children, disabled, onClick, ...rest } = props;
  const submitting = state.status.kind === "submitting";
  return (
    <Button
      {...rest}
      onClick={(e) => {
        onClick?.(e);
        if (!e.defaultPrevented) void actions.submit();
      }}
      disabled={disabled || !meta.canSubmit}
    >
      {submitting ? "Saving…" : children}
    </Button>
  );
}

// ---------------------------------------------------------------------------
// Reveal-eye icon (used by ValueField when `revealable`)
// ---------------------------------------------------------------------------

function SecretVisibilityIcon(props: { revealed: boolean }) {
  return props.revealed ? (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 2l12 12" />
      <path d="M6.5 6.5a2 2 0 0 0 3 3" />
      <path d="M3.5 5.5C2.3 6.7 1.5 8 1.5 8s2.5 4.5 6.5 4.5c1 0 1.9-.3 2.7-.7" />
      <path d="M10.7 10.7c2-1.4 3.3-3.2 3.8-3.7 0 0-2.5-5-6.5-5-.7 0-1.4.1-2 .4" />
    </svg>
  ) : (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.5 8s2.5-4.5 6.5-4.5S14.5 8 14.5 8s-2.5 4.5-6.5 4.5S1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Compound export
// ---------------------------------------------------------------------------

export const SecretForm = {
  Provider: SecretFormProvider,
  NameField,
  IdField,
  ValueField,
  ProviderField,
  ErrorBanner,
  SubmitButton,
};

export type { SecretFormProviderProps };
