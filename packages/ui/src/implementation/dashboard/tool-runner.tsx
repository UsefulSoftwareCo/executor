import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  AppProviderFailed,
  Json,
  type ApprovalRequestId,
  type Tool,
  type ToolResumeResultReceived,
} from "@executor-js/sdk";
import { ToolCallReference, type BrowserToolRun } from "@executor-js/mcp/browser";
import { Cause, Exit, Match, Option, Schema } from "effect";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useCallback, useState, type ComponentType } from "react";
import type { ToolRunApprovalAtoms } from "../../contracts/browser-approval.ts";
import type { AccountSummary, FailureProps, Query } from "../../contracts/dashboard.ts";
import type { RequirementAccounts } from "../../contracts/app-accounts.ts";
import { BrowserApprovalCard } from "./browser-approval.tsx";
import { Button } from "../components/button.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs.tsx";
import { Textarea } from "../components/textarea.tsx";
import { Code, CopyButton } from "./code.tsx";
import { isSchema, type JsonSchema } from "./json-schema.ts";
import { ProviderErrorNotice } from "./provider-error-notice.tsx";
import {
  isRenderableObjectSchema,
  missingRequiredFields,
  resolveSchema,
  ToolInputForm,
} from "./tool-input-form.tsx";

const isJson = Schema.is(Json);
const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Json));

const skeleton = (schema: unknown, root: JsonSchema, depth = 0): Json => {
  if (!isSchema(schema) || depth > 4) return null;
  const resolved = resolveSchema(schema, root);
  if (isJson(resolved.default)) return resolved.default;
  if (isJson(resolved.const)) return resolved.const;
  if (Array.isArray(resolved.enum) && isJson(resolved.enum[0])) return resolved.enum[0];
  const variants = Array.isArray(resolved.anyOf) ? resolved.anyOf : resolved.oneOf;
  if (Array.isArray(variants) && variants.length > 0 && !isSchema(resolved.properties))
    return skeleton(variants[0], root, depth + 1);
  const type = Array.isArray(resolved.type)
    ? resolved.type.find((candidate) => candidate !== "null")
    : (resolved.type ?? (isSchema(resolved.properties) ? "object" : undefined));
  switch (type) {
    case "object": {
      const properties = isSchema(resolved.properties) ? resolved.properties : {};
      const required = Array.isArray(resolved.required) ? resolved.required : [];
      return Object.fromEntries(
        required
          .filter((name): name is string => typeof name === "string")
          .map((name) => [name, skeleton(properties[name], root, depth + 1)]),
      );
    }
    case "array":
      return [];
    case "string":
      return "";
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    default:
      return null;
  }
};

type Draft =
  | { readonly mode: "form"; readonly value: Json }
  | { readonly mode: "json"; readonly text: string };

const initialDraft = (tool: Tool | undefined): Draft => {
  const schema = tool?.inputSchema;
  const root = isSchema(schema) ? schema : {};
  const seeded = tool === undefined ? {} : skeleton(schema, root);
  const value = isSchema(seeded) ? seeded : {};
  return isRenderableObjectSchema(schema)
    ? { mode: "form", value }
    : { mode: "json", text: JSON.stringify(value, null, 2) };
};

export const runningAs = <A extends AccountSummary>(
  requirements: readonly RequirementAccounts<A>[],
): readonly string[] => {
  const accounts = new Map(
    requirements.flatMap((entry) => entry.using.map((account) => [account.id, account] as const)),
  );
  return [...accounts.values()].map((account) =>
    account.providerName === undefined || account.providerName === account.label
      ? account.label || "Unnamed account"
      : `${account.label || "Unnamed account"} (${account.providerName})`,
  );
};

const answered = (result: ToolResumeResultReceived) =>
  Match.value(result).pipe(
    Match.discriminatorsExhaustive("status")({
      completed: ({ toolError }) =>
        toolError === true
          ? "Approved. The tool ran and reported an error, shown below."
          : "Approved. The tool ran, and its result is below.",
      denied: () => "Declined. Executor will not resume this saved call.",
      cancelled: () => "Cancelled. Executor will not resume this saved call.",
      failed: (failed) =>
        Match.value(failed).pipe(
          Match.when(
            { reason: "context-changed" },
            () =>
              "The app or its accounts changed since this call was saved, so Executor did not resume it. Run it again to review the current call.",
          ),
          Match.when(
            { reason: "execution-failed", context: "unconfirmed" },
            () =>
              "Executor could not read the app or its accounts to confirm they match the call you reviewed, because its storage failed, so it did not resume it. Run it again in a moment to review it.",
          ),
          Match.when(
            { reason: "execution-failed" },
            () =>
              "The tool failed after you approved it. It may have already made changes. Check before running it again.",
          ),
          Match.when(
            { reason: "expired" },
            () => "This request expired, so Executor will not resume this saved call.",
          ),
          Match.exhaustive,
        ),
      "already-consumed": () => "This request was already answered.",
    }),
  );

const Referenced = Schema.Struct({ reference: ToolCallReference });
const referenceOf = (error: unknown) =>
  Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(Referenced)(error), ({ reference }) => reference),
  );

function CallReference({ reference }: { readonly reference: string }) {
  return (
    <section
      aria-label="Call reference"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-3 py-2 text-xs text-muted-foreground"
    >
      <span>This call's reference in the activity log</span>
      <span className="flex min-w-0 items-center gap-1">
        <code className="font-mono text-foreground wrap-anywhere">{reference}</code>
        <CopyButton code={reference} label="Copy call reference" inline text="" />
      </span>
    </section>
  );
}

function ToolRunReview({ atoms }: { readonly atoms: ToolRunApprovalAtoms }) {
  const answer = useAtomValue(atoms.answer);
  const result =
    AsyncResult.isSuccess(answer) && answer.value.status === "answered"
      ? answer.value.result
      : undefined;
  const reference = AsyncResult.isSuccess(answer) ? answer.value.reference : undefined;
  return (
    <>
      <BrowserApprovalCard
        atoms={atoms}
        completion={result === undefined ? undefined : answered(result)}
      />
      {reference !== undefined && <CallReference reference={reference} />}
      {result?.status === "completed" && (
        <section aria-label="Tool result">
          <Code code={JSON.stringify(result.value, null, 2)} copyable copyLabel="Copy result" />
        </section>
      )}
    </>
  );
}

export function ToolRunner<E>({
  tool,
  call,
  approval,
  detail,
  Failure,
  accounts,
}: {
  readonly tool: string;
  readonly call: Atom.AtomResultFn<Json, BrowserToolRun, E>;
  readonly approval: (requestId: ApprovalRequestId) => ToolRunApprovalAtoms;
  readonly detail: Query<Tool | undefined, unknown>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  readonly accounts?: readonly string[] | undefined;
}) {
  const run = useAtomSet(call, { mode: "promiseExit" });
  const schema = useAtomValue(detail);
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState(false);
  const [checked, setChecked] = useState(false);
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [output, setOutput] = useState<string>();
  const [reference, setReference] = useState<string>();
  const [review, setReview] = useState<ApprovalRequestId>();
  const [error, setError] = useState<"json" | "object" | Cause.Cause<E>>();
  const onInvalidChange = useCallback(
    (path: string, broken: boolean) =>
      setInvalid((paths) => {
        if (paths.has(path) === broken) return paths;
        const next = new Set(paths);
        if (broken) next.add(path);
        else next.delete(path);
        return next;
      }),
    [],
  );
  const loading = AsyncResult.isInitial(schema);
  const inputSchema = AsyncResult.isSuccess(schema) ? schema.value?.inputSchema : undefined;
  const renderable = isRenderableObjectSchema(inputSchema);
  const current = draft ?? initialDraft(AsyncResult.isSuccess(schema) ? schema.value : undefined);
  const missing =
    checked && current.mode === "form" ? missingRequiredFields(inputSchema, current.value) : [];
  const blocked = checked && current.mode === "form" && invalid.size > 0;
  const failure =
    error === undefined || typeof error === "string" ? Option.none() : Cause.findErrorOption(error);
  const switchTo = (mode: string) => {
    if (current.mode === "form" && mode === "json") {
      if (invalid.size > 0) return setChecked(true);
      setError(undefined);
      setChecked(false);
      setDraft({ mode: "json", text: JSON.stringify(current.value, null, 2) });
    }
    if (current.mode === "json" && mode === "form") {
      const parsed = decodeJson(current.text);
      if (Exit.isFailure(parsed)) return setError("json");
      if (!isSchema(parsed.value)) return setError("object");
      setError(undefined);
      setDraft({ mode: "form", value: parsed.value });
    }
  };
  const editor = (
    <Textarea
      aria-label="Input"
      className="font-mono text-xs min-h-40"
      value={current.mode === "json" ? current.text : ""}
      onChange={(event) => setDraft({ mode: "json", text: event.target.value })}
      spellCheck={false}
      disabled={pending}
    />
  );
  return (
    <div
      data-product-private
      className="flex flex-col gap-4 mt-6 min-w-0 [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere [&_pre]:text-[11px] [&_pre]:bg-muted [&_pre]:p-[12px] [&_pre]:rounded-[6px]"
    >
      <form
        noValidate
        onSubmit={async (event) => {
          event.preventDefault();
          setError(undefined);
          let input: Json;
          if (current.mode === "form") {
            setChecked(true);
            if (invalid.size > 0 || missingRequiredFields(inputSchema, current.value).length > 0)
              return;
            input = current.value;
          } else {
            const parsed = decodeJson(current.text);
            if (Exit.isFailure(parsed)) {
              setError("json");
              return;
            }
            input = parsed.value;
          }
          setPending(true);
          setOutput(undefined);
          setReview(undefined);
          setReference(undefined);
          const result = await run(input);
          setPending(false);
          if (Exit.isFailure(result)) {
            setError(result.cause);
            setReference(
              Option.getOrUndefined(Option.map(Cause.findErrorOption(result.cause), referenceOf)),
            );
          } else if (result.value.status === "approval-required") setReview(result.value.requestId);
          else {
            setOutput(JSON.stringify(result.value.value, null, 2));
            setReference(result.value.reference);
          }
        }}
      >
        <Tabs value={loading ? "" : current.mode} onValueChange={switchTo} className="gap-2.25">
          <div className="flex min-h-7 items-end justify-between gap-3">
            <h3 className="text-[13px] font-medium">Input</h3>
            {(loading || renderable) && (
              <TabsList aria-label="Input format" className="h-7! shrink-0">
                <TabsTrigger value="form" className="px-2.5 text-xs" disabled={pending || loading}>
                  Form
                </TabsTrigger>
                <TabsTrigger value="json" className="px-2.5 text-xs" disabled={pending || loading}>
                  JSON
                </TabsTrigger>
              </TabsList>
            )}
          </div>
          {accounts !== undefined && accounts.length > 0 && (
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted-foreground wrap-anywhere">
              Running as
              <span className="font-medium text-foreground">{accounts.join(", ")}</span>
            </div>
          )}
          {loading ? (
            <Skeleton role="status" aria-label="Loading input" className="h-40" />
          ) : (
            <>
              <TabsContent value="form">
                {current.mode === "form" && (
                  <ToolInputForm
                    schema={inputSchema}
                    value={current.value}
                    onChange={(value) => setDraft({ mode: "form", value })}
                    missing={missing}
                    disabled={pending}
                    onInvalidChange={onInvalidChange}
                  />
                )}
              </TabsContent>
              <TabsContent value="json">{editor}</TabsContent>
            </>
          )}
        </Tabs>
        <Button className="mt-3" disabled={pending || loading}>
          {pending ? "Running…" : "Run tool"}
        </Button>
      </form>
      {blocked ? (
        <p role="alert" className="text-destructive text-[13px]">
          Fix the {invalid.size === 1 ? "field" : "fields"} marked invalid.
        </p>
      ) : missing.length > 0 ? (
        <p role="alert" className="text-destructive text-[13px]">
          Fill in the required {missing.length === 1 ? "field" : "fields"}.
        </p>
      ) : error === "json" ? (
        <p role="alert" className="text-destructive text-[13px]">
          Enter valid JSON.
        </p>
      ) : error === "object" ? (
        <p role="alert" className="text-destructive text-[13px]">
          Enter a JSON object to use the form.
        </p>
      ) : Option.isSome(failure) && Schema.is(AppProviderFailed)(failure.value) ? (
        <ProviderErrorNotice
          error={failure.value}
          context={`While running tool ${tool}. Check whether it made changes before trying again.`}
        />
      ) : (
        error !== undefined && <Failure cause={error} />
      )}
      {reference !== undefined && <CallReference reference={reference} />}
      {review !== undefined && <ToolRunReview key={review} atoms={approval(review)} />}
      {output !== undefined && (
        <section aria-label="Tool result">
          <Code code={output} copyable copyLabel="Copy result" />
        </section>
      )}
    </div>
  );
}
