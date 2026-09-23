/** A shared review page for tool consent and standard MCP form input. */
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  BrowserApprovalFailed,
  type BrowserApprovalAtoms,
} from "../../contracts/browser-approval.ts";
import type { PendingInteraction, ElicitationResponse } from "@executor-js/mcp/browser";
import { Cause, Exit, Match } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useState, type ReactNode } from "react";
import { Button } from "../components/button.tsx";
import { Input } from "../components/input.tsx";
import { Spinner } from "../components/spinner.tsx";

type Field = PendingInteraction["elicitation"]["requestedSchema"]["properties"][string];
type Value = string | readonly string[] | undefined;
const defaults = (request: PendingInteraction) =>
  Object.fromEntries(
    Object.entries(request.elicitation.requestedSchema.properties).map(
      ([key, field]): [string, Value] => [
        key,
        field.default === undefined
          ? undefined
          : field.type === "array"
            ? field.default
            : String(field.default),
      ],
    ),
  );
const failureMessage = (cause: Cause.Cause<BrowserApprovalFailed>) => {
  const error = Cause.squash(cause);
  return error instanceof BrowserApprovalFailed
    ? Match.value(error.reason).pipe(
        Match.when("unauthorized", () => "Sign in again to review this request."),
        Match.when("forbidden", () => "Your account cannot review this request."),
        Match.when("invalid-answer", () => "Check the form fields and try again."),
        Match.when("unavailable", () => "This request is no longer available."),
        Match.when("network", () => "Cannot reach Executor. Try again."),
        Match.exhaustive,
      )
    : "Cannot load this request. Try again.";
};

/** Authentication is provided by the product; the server independently checks every read and answer. */
export function BrowserApprovalPage({ atoms }: { readonly atoms: BrowserApprovalAtoms }) {
  return (
    <main className="mx-auto flex min-h-svh w-full max-w-2xl flex-col px-5 py-12 sm:py-20">
      <div className="mb-8 flex items-center gap-2 text-lg font-semibold">
        <img src="/favicon.png" alt="" className="size-7" />
        executor
      </div>
      <BrowserApprovalCard atoms={atoms} />
    </main>
  );
}
/** Reuse the same form inside a product page; completion copy belongs to the delivery surface. */
export function BrowserApprovalCard({
  atoms,
  completion,
}: {
  readonly atoms: BrowserApprovalAtoms;
  readonly completion?: ReactNode;
}) {
  const view = useAtomValue(atoms.view);
  const refresh = useAtomRefresh(atoms.view);
  const expires =
    AsyncResult.isSuccess(view) && view.value.status === "pending"
      ? view.value.request.expiresAt
      : undefined;
  useEffect(() => {
    if (expires === undefined) return;
    const timer = setTimeout(refresh, Math.max(0, expires - Date.now()) + 100);
    return () => clearTimeout(timer);
  }, [expires, refresh]);
  return (
    <section className="rounded-xl border bg-card p-6 shadow-sm sm:p-8">
      {AsyncResult.isFailure(view) ? (
        <>
          <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35]">
            Cannot open this request
          </h1>
          <p role="alert" className="my-4 text-sm text-muted-foreground">
            {failureMessage(view.cause)}
          </p>
          <Button variant="outline" onClick={refresh}>
            Try again
          </Button>
        </>
      ) : !AsyncResult.isSuccess(view) ? (
        <Spinner />
      ) : view.value.status === "pending" ? (
        <ApprovalForm
          key={view.value.request.requestId}
          request={view.value.request}
          appName={view.value.appName}
          atoms={atoms}
          completion={completion}
        />
      ) : (
        <ApprovalResult status={view.value.status} completion={completion} />
      )}
    </section>
  );
}
function ApprovalResult({
  status,
  completion,
}: {
  readonly status: "answered" | "unavailable";
  readonly completion?: ReactNode;
}) {
  return (
    <>
      <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35]">
        {status === "answered" ? "Response saved" : "Request no longer available"}
      </h1>
      <p className="mt-3 text-sm text-muted-foreground">
        {status === "answered"
          ? (completion ?? "You can return to your agent.")
          : "This request has expired, was handled, or is no longer running."}
      </p>
    </>
  );
}
function ApprovalForm({
  request,
  appName,
  atoms,
  completion,
}: {
  readonly completion?: ReactNode;
  readonly request: PendingInteraction;
  readonly appName: string | undefined;
  readonly atoms: BrowserApprovalAtoms;
}) {
  const [values, setValues] = useState(() => defaults(request));
  const [persist, setPersist] = useState("");
  const [saved, setSaved] = useState<"answered" | "unavailable">();
  const [error, setError] = useState<string>();
  const submit = useAtomSet(atoms.answer, { mode: "promiseExit" });
  const sending = useAtomValue(atoms.answer).waiting;
  const schema: Extract<
    PendingInteraction,
    { status: "input-required" }
  >["elicitation"]["requestedSchema"] = request.elicitation.requestedSchema;
  const offered = request.elicitation._meta?.persist;
  const scopes = Array.isArray(offered)
    ? offered.filter((value): value is string => typeof value === "string")
    : [];
  const decide = async (action: ElicitationResponse["action"]) => {
    setError(undefined);
    const content = new Map<string, string | number | boolean | readonly string[]>();
    if (action === "accept")
      for (const [name, field] of Object.entries(schema.properties)) {
        const value = values[name];
        if (value === undefined) {
          if (schema.required?.includes(name)) {
            if (field.type === "string" && !("enum" in field) && !("oneOf" in field))
              content.set(name, "");
            else if (field.type === "array") content.set(name, []);
          }
          continue;
        }
        if (field.type === "array") {
          if (typeof value !== "string") content.set(name, value);
        } else if (typeof value === "string") {
          if (field.type === "boolean") {
            if (value !== "") content.set(name, value === "true");
          } else if (field.type === "number" || field.type === "integer") {
            if (value !== "" && Number.isFinite(Number(value))) content.set(name, Number(value));
          } else content.set(name, value);
        }
      }
    const response: ElicitationResponse =
      action === "accept"
        ? {
            action,
            content: Object.fromEntries(content),
            ...(persist === "" ? {} : { _meta: { persist } }),
          }
        : { action };
    const result = await submit(response);
    if (Exit.isSuccess(result)) setSaved(result.value.status);
    else setError(failureMessage(result.cause));
  };
  if (saved !== undefined) return <ApprovalResult status={saved} completion={completion} />;
  const tool = request.status === "approval-required" ? request.invocation.tool : request.tool.tool;
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void decide("accept");
      }}
      className="space-y-6"
    >
      <header>
        <p className="mb-2 text-sm text-muted-foreground">
          {appName === undefined ? tool : `${appName} · ${tool}`}
        </p>
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35]">
          {request.status === "approval-required" ? "Review tool request" : "Input requested"}
        </h1>
      </header>
      <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-4 font-sans text-sm">
        {request.elicitation.message}
      </pre>
      {Object.entries(schema.properties).map(([name, field]) => (
        <label key={name} className="block space-y-2 text-sm font-medium">
          <span>
            {field.title ?? name}
            {schema.required?.includes(name) ? " *" : ""}
          </span>
          <FormField
            name={name}
            field={field}
            value={values[name]}
            required={schema.required?.includes(name) === true}
            disabled={sending}
            change={(value) => setValues({ ...values, [name]: value })}
          />
          {field.description && (
            <span className="block text-xs font-normal text-muted-foreground">
              {field.description}
            </span>
          )}
        </label>
      ))}
      {request.elicitation._meta !== undefined &&
        Object.keys(request.elicitation._meta).length > 0 && (
          <details className="text-sm" open>
            <summary className="cursor-pointer font-medium">Approval terms and details</summary>
            <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-muted p-3 text-xs">
              {JSON.stringify(request.elicitation._meta, null, 2)}
            </pre>
          </details>
        )}
      {scopes.length > 0 && (
        <label className="block space-y-2 text-sm font-medium">
          <span>Remember this approval</span>
          <select
            className="h-10 w-full rounded-md border bg-background px-3 font-normal"
            value={persist}
            disabled={sending}
            onChange={(event) => setPersist(event.target.value)}
          >
            <option value="">Just this once</option>
            {scopes.map((scope) => (
              <option key={scope} value={scope}>
                {scope === "session" ? "For this session" : scope === "always" ? "Always" : scope}
              </option>
            ))}
          </select>
        </label>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2 border-t pt-5">
        <Button type="submit" disabled={sending} loading={sending}>
          {request.status === "approval-required" ? "Approve" : "Submit"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={sending}
          onClick={() => void decide("decline")}
        >
          Decline
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={sending}
          onClick={() => void decide("cancel")}
        >
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Expires at {new Date(request.expiresAt).toLocaleTimeString()}.
      </p>
    </form>
  );
}
function FormField({
  name,
  field,
  value,
  required,
  disabled,
  change,
}: {
  name: string;
  field: Field;
  value: Value;
  required: boolean;
  disabled: boolean;
  change: (value: Value) => void;
}) {
  const selectClass = "min-h-10 w-full rounded-md border bg-background px-3 py-2 font-normal";
  return Match.value(field).pipe(
    Match.when({ type: "array" }, (field) => {
      const choices =
        "enum" in field.items
          ? field.items.enum.map((value) => ({ value, label: value }))
          : field.items.anyOf.map((option) => ({ value: option.const, label: option.title }));
      return (
        <select
          aria-label={field.title ?? name}
          className={selectClass}
          multiple
          value={value === undefined || typeof value === "string" ? [] : [...value]}
          disabled={disabled}
          required={required && (field.minItems ?? 0) > 0}
          onChange={(event) =>
            change(Array.from(event.target.selectedOptions, (option) => option.value))
          }
        >
          {choices.map(({ value, label }) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      );
    }),
    Match.when({ type: "boolean" }, () => (
      <select
        aria-label={field.title ?? name}
        className={selectClass}
        value={typeof value === "string" ? value : ""}
        disabled={disabled}
        required={required}
        onChange={(event) => change(event.target.value === "" ? undefined : event.target.value)}
      >
        <option value="">Choose a value</option>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    )),
    Match.whenOr({ type: "number" }, { type: "integer" }, (field) => (
      <Input
        aria-label={field.title ?? name}
        type="number"
        value={typeof value === "string" ? value : ""}
        min={field.minimum}
        max={field.maximum}
        step={field.type === "integer" ? 1 : "any"}
        required={required}
        disabled={disabled}
        onChange={(event) => change(event.target.value === "" ? undefined : event.target.value)}
      />
    )),
    Match.when({ type: "string" }, (field) => {
      const choices =
        "enum" in field
          ? field.enum.map((value, index) => ({
              value,
              label: "enumNames" in field ? (field.enumNames?.[index] ?? value) : value,
            }))
          : "oneOf" in field
            ? field.oneOf.map((option) => ({ value: option.const, label: option.title }))
            : undefined;
      if (choices !== undefined)
        return (
          <select
            aria-label={field.title ?? name}
            className={selectClass}
            value={
              value === undefined
                ? ""
                : String(choices.findIndex((option) => option.value === value))
            }
            disabled={disabled}
            required={required}
            onChange={(event) =>
              change(
                event.target.value === "" ? undefined : choices[Number(event.target.value)]?.value,
              )
            }
          >
            <option value="">Choose a value</option>
            {choices.map(({ label }, index) => (
              <option key={index} value={String(index)}>
                {label}
              </option>
            ))}
          </select>
        );
      const format = "format" in field ? field.format : undefined;
      return (
        <Input
          aria-label={field.title ?? name}
          type={
            format === "email"
              ? "email"
              : format === "uri"
                ? "url"
                : format === "date"
                  ? "date"
                  : "text"
          }
          value={typeof value === "string" ? value : ""}
          minLength={"minLength" in field ? field.minLength : undefined}
          maxLength={"maxLength" in field ? field.maxLength : undefined}
          required={
            required &&
            (format !== undefined || ("minLength" in field && (field.minLength ?? 0) > 0))
          }
          disabled={disabled}
          onChange={(event) => change(event.target.value === "" ? undefined : event.target.value)}
        />
      );
    }),
    Match.exhaustive,
  );
}
