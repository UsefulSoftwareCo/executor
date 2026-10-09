import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  AppProviderFailed,
  Json,
  type AccountId,
  type SelectedAccounts,
  type Tool,
} from "@executor-js/sdk";
import { Cause, Exit, Option, Schema } from "effect";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useCallback, useState, type ComponentType } from "react";
import type { FailureProps, Query } from "../../contracts/dashboard.ts";
import { Button } from "../components/button.tsx";
import { Skeleton } from "../components/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/tabs.tsx";
import { Textarea } from "../components/textarea.tsx";
import { Code } from "./code.tsx";
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

/** A starting value for each required input; optional fields stay out of the draft. */
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

/** One draft, shown either as fields or as the JSON text it serializes to. */
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

/** Who a call acts as: the page's selected profile and the accounts it binds. */
export interface ToolRunContext {
  readonly profile: string;
  readonly accounts: readonly string[];
}

/** Name the selected profile's accounts for the runner's read-only context line. */
export function toolRunContext(
  profile: string,
  selection: SelectedAccounts,
  accounts: readonly {
    readonly id: AccountId;
    readonly label: string;
    readonly providerName?: string | undefined;
  }[],
): ToolRunContext {
  const selected = new Set(
    Object.values(selection).flatMap((ids) => (Array.isArray(ids) ? ids : [ids])),
  );
  return {
    profile,
    accounts: accounts
      .filter((account) => selected.has(account.id))
      .map((account) =>
        account.providerName === undefined || account.providerName === account.label
          ? account.label
          : `${account.label} (${account.providerName})`,
      ),
  };
}

/**
 * Run one tool with a form or JSON draft. The product binds the call to its exact app, profile
 * revision and deployment, and renders its own failures; provider failures keep the shared account
 * recovery.
 */
export function ToolRunner<E>({
  tool,
  call,
  detail,
  Failure,
  context,
}: {
  readonly tool: string;
  readonly call: Atom.AtomResultFn<Json, Json, E>;
  /** The selected tool's schemas seed the draft with its required inputs. */
  readonly detail: Query<Tool | undefined, unknown>;
  readonly Failure: ComponentType<FailureProps<NoInfer<E>>>;
  /** The profile the page selected; calls always run with its bindings. */
  readonly context?: ToolRunContext | undefined;
}) {
  const run = useAtomSet(call, { mode: "promiseExit" });
  const schema = useAtomValue(detail);
  const [draft, setDraft] = useState<Draft>();
  const [pending, setPending] = useState(false);
  // Set by a blocked run or tab switch; the form then marks its missing and invalid fields.
  const [checked, setChecked] = useState(false);
  // Form fields whose text does not parse, so the draft still holds their last good value.
  const [invalid, setInvalid] = useState<ReadonlySet<string>>(new Set());
  const [output, setOutput] = useState<string>();
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
  // A failed schema read still leaves JSON, so only the first read holds the editor.
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
      // The draft would drop the text of a field that does not parse.
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
          const result = await run(input);
          setPending(false);
          if (Exit.isFailure(result)) setError(result.cause);
          else setOutput(JSON.stringify(result.value, null, 2));
        }}
      >
        {/* No tab is selected until the schema decides between the form and JSON. */}
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
          {context !== undefined && (
            <p className="text-xs text-muted-foreground wrap-anywhere">
              Running as <span className="font-medium text-foreground">{context.profile}</span>
              {context.accounts.length > 0 && ` · ${context.accounts.join(", ")}`}
            </p>
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
      {output !== undefined && (
        <section aria-label="Tool result">
          <Code code={output} copyable copyLabel="Copy result" />
        </section>
      )}
    </div>
  );
}
