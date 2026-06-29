import { useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue, useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { toast } from "sonner";
import {
  ToolAddress,
  type Connection,
  type ConnectionName,
  type IntegrationSlug,
} from "@executor-js/sdk/shared";

import { executeCode, toolSchemaAtom } from "../api/atoms";
import { trackEvent } from "../api/analytics";
import { Badge } from "./badge";
import { Button } from "./button";
import { Label } from "./label";
import { Textarea } from "./textarea";
import { CodeBlock } from "./code-block";
import { CardStack, CardStackHeader, CardStackContent } from "./card-stack";
import { NativeSelect, NativeSelectOption } from "./native-select";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "./tabs";
import {
  JsonSchemaForm,
  isRenderableObjectSchema,
  missingRequiredFields,
} from "./json-schema-form";
import { cn } from "../lib/utils";

// ---------------------------------------------------------------------------
// ToolRunPanel — invoke a single tool against a chosen connection (account) to
// verify the credentials actually work and see the result/error.
//
// Backend: `POST /executions` runs codemode source. We generate a one-liner
// that invokes the exact per-connection tool through the sandbox `tools` proxy:
//
//   return await tools["<int>.<owner>.<conn>.<tool>"](<args>);
//
// The `<owner>` segment is the SELECTED CONNECTION's own owner — never an
// ambient value — because the connection list merges both owners (the global
// owner toggle is retired). The tool name segment may itself contain dots (e.g.
// `aliases.deleteAlias`), so the address is built by string-joining the segments
// and passed to the proxy via bracket access — never split on dots.
// ---------------------------------------------------------------------------

/** Build the proxy address (no `tools.` prefix) for a tool against a specific
 *  connection, using the CONNECTION's own owner. Pure — unit-testable. */
export const toolProxyAddress = (input: {
  readonly integration: IntegrationSlug;
  readonly connection: Connection;
  readonly toolName: string;
}): string =>
  `${input.integration}.${input.connection.owner}.${input.connection.name}.${input.toolName}`;

type RunResult =
  | {
      readonly kind: "completed";
      readonly text: string;
      readonly structured: unknown;
      readonly isError: boolean;
    }
  | { readonly kind: "paused"; readonly text: string };

/** Detect the `{ ok: false }` invocation-failure envelope — a failed-credential
 *  signal even when the HTTP execution itself "completed" without isError. */
const isFailedEnvelope = (structured: unknown): boolean =>
  typeof structured === "object" &&
  structured !== null &&
  "ok" in structured &&
  (structured as { ok: unknown }).ok === false;

/** Decode the args Textarea as JSON. Effect Schema is used at the JSON boundary
 *  (the codebase forbids raw `JSON.parse`); a malformed string yields `None`,
 *  which we surface as an inline validation error. */
const decodeArgsJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString);

const prettyJson = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

export function ToolRunPanel(props: {
  /** Integration slug — the `<integration>` address segment. */
  readonly integration: IntegrationSlug;
  /** Bare tool name — the `<tool>` address segment (may contain dots). */
  readonly toolName: string;
  /** This integration's connections (accounts) across BOTH owners. Each is
   *  addressed under its OWN owner — there is no ambient owner. */
  readonly connections: readonly Connection[];
  /** Pre-select this connection (the account the selected tool belongs to in the
   *  grouped Tools tab). Falls back to the first connection when null/unmatched. */
  readonly initialConnectionName?: ConnectionName | string | null;
}) {
  const { integration, toolName, connections, initialConnectionName } = props;

  const [selectedConnection, setSelectedConnection] = useState<ConnectionName | null>(
    (initialConnectionName as ConnectionName | null) ?? connections[0]?.name ?? null,
  );
  const [argsJson, setArgsJson] = useState("{}");
  const [argsError, setArgsError] = useState<string | null>(null);
  const [argsMode, setArgsMode] = useState<"form" | "json">("json");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);

  const doExecute = useAtomSet(executeCode, { mode: "promiseExit" });

  // Reset the picker + result when the connection set or the tool changes, so a
  // result never lingers against a stale tool/account. Prefer the tool's own
  // account (`initialConnectionName`) when it is present in the list.
  useEffect(() => {
    setSelectedConnection((current) => {
      if (
        initialConnectionName &&
        connections.some((c: Connection) => c.name === initialConnectionName)
      ) {
        return initialConnectionName as ConnectionName;
      }
      if (current && connections.some((c: Connection) => c.name === current)) return current;
      return connections[0]?.name ?? null;
    });
  }, [connections, initialConnectionName]);

  useEffect(() => {
    setResult(null);
    setArgsError(null);
  }, [toolName]);

  // The full `Connection` for the selected name — carries its OWN owner, which
  // is the `<owner>` address segment (never an ambient owner).
  const selectedConnectionObj = useMemo<Connection | null>(
    () => connections.find((c: Connection) => c.name === selectedConnection) ?? null,
    [connections, selectedConnection],
  );

  // Build the per-connection address `tools.<int>.<owner>.<conn>.<tool>` and the
  // proxy form (the same string minus the `tools.` root), using the SELECTED
  // CONNECTION's own owner.
  const addressNoPrefix = useMemo(
    () =>
      selectedConnectionObj
        ? toolProxyAddress({ integration, connection: selectedConnectionObj, toolName })
        : null,
    [integration, selectedConnectionObj, toolName],
  );

  const fullAddress = addressNoPrefix ? ToolAddress.make(`tools.${addressNoPrefix}`) : null;

  // The tool's schema view drives both the args-shape hint (TypeScript) and the
  // dynamic form (raw input JSON Schema + shared $defs).
  const schemaResult = useAtomValue(toolSchemaAtom(fullAddress ?? ToolAddress.make("")));
  const schemaView = AsyncResult.isSuccess(schemaResult) ? schemaResult.value : null;
  const inputSchema = schemaView?.inputSchema ?? null;
  const schemaDefinitions = schemaView?.schemaDefinitions;
  const schemaAvailable = isRenderableObjectSchema(inputSchema, schemaDefinitions);

  // The form is a controlled view over the single `argsJson` string. Decode it
  // (same Option-returning decode the run path uses); only a plain JSON object
  // can drive the form.
  const parsedArgs = useMemo<Record<string, unknown> | null>(() => {
    const decoded = decodeArgsJson(argsJson);
    if (Option.isNone(decoded)) return null;
    const v = decoded.value;
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  }, [argsJson]);

  // Required-arg gate: Run is only available once every `required` top-level
  // field has a value. With no renderable schema we can't know what's required,
  // so we don't block.
  const requiredMissing = useMemo<readonly string[]>(
    () =>
      schemaAvailable
        ? missingRequiredFields(inputSchema, schemaDefinitions, parsedArgs ?? {})
        : [],
    [schemaAvailable, inputSchema, schemaDefinitions, parsedArgs],
  );

  // Default to the form the first time a renderable schema arrives with a JSON
  // object in the args. A ref guard makes this fire exactly once, so a later
  // manual tab choice is respected even as `parsedArgs` keeps changing.
  const autoSelectedFormRef = useRef(false);
  useEffect(() => {
    if (autoSelectedFormRef.current) return;
    if (schemaAvailable && parsedArgs !== null) {
      autoSelectedFormRef.current = true;
      setArgsMode("form");
    }
  }, [schemaAvailable, parsedArgs]);

  // Form edits stringify straight back into the same `argsJson` state — no
  // second copy of state, so the JSON tab always shows the live form value.
  const handleFormChange = (next: Record<string, unknown>): void => {
    setArgsJson(JSON.stringify(next, null, 2));
    setArgsError(null);
  };

  const handleRun = async () => {
    if (!addressNoPrefix) return;

    const decoded = decodeArgsJson(argsJson);
    if (Option.isNone(decoded)) {
      setArgsError("Invalid JSON — enter a valid JSON object of arguments.");
      return;
    }
    const parsed = decoded.value;
    setArgsError(null);
    setRunning(true);
    setResult(null);

    // Read-only invoke: pass the validated args through as JSON. Empty
    // `reactivityKeys` — invoking a tool doesn't mutate `tools.list`.
    // `autoApprove` because the operator clicked Run: that IS the approval, so
    // an approval-gated tool should run here instead of dead-ending on a pause.
    const code = `return await tools[${JSON.stringify(addressNoPrefix)}](${JSON.stringify(parsed)});`;
    const exit = await doExecute({ payload: { code, autoApprove: true }, reactivityKeys: [] });
    setRunning(false);

    if (Exit.isFailure(exit)) {
      trackEvent("tool_run_submitted", {
        integration_slug: integration,
        tool_name: toolName,
        args_mode: argsMode,
        result: "failed",
      });
      toast.error("Failed to run tool");
      return;
    }

    const value = exit.value;
    if (value.status === "paused") {
      trackEvent("tool_run_submitted", {
        integration_slug: integration,
        tool_name: toolName,
        args_mode: argsMode,
        result: "paused",
      });
      setResult({ kind: "paused", text: value.text });
      return;
    }
    trackEvent("tool_run_submitted", {
      integration_slug: integration,
      tool_name: toolName,
      args_mode: argsMode,
      result: "completed",
      ...(value.isError ? { is_error: true } : {}),
    });
    setResult({
      kind: "completed",
      text: value.text,
      structured: value.structured,
      isError: value.isError,
    });
  };

  if (connections.length === 0) {
    return <p className="text-sm text-muted-foreground">Add a connection to test tools.</p>;
  }

  return (
    <div className="space-y-4">
      <CardStack>
        <CardStackContent className="space-y-4 px-4 py-4">
          {/* Connection picker — which account to run against. */}
          <div className="space-y-1.5">
            <Label htmlFor="tool-run-connection">Connection</Label>
            <NativeSelect
              id="tool-run-connection"
              className="w-full"
              value={selectedConnection ?? ""}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                setSelectedConnection(e.target.value as ConnectionName)
              }
              disabled={running}
            >
              {connections.map((connection: Connection) => (
                <NativeSelectOption key={connection.name} value={connection.name}>
                  {connection.identityLabel || connection.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
            <p className="text-xs text-muted-foreground">
              Pick the account whose credentials you want to verify.
            </p>
          </div>

          {/* Arguments editor — dynamic form built from the input JSON Schema,
              with a Raw JSON escape hatch. Both views share the `argsJson`
              string as the single source of truth. */}
          <div className="space-y-1.5">
            <Tabs
              value={argsMode}
              onValueChange={(v: string) => setArgsMode(v === "form" ? "form" : "json")}
            >
              <TabsList variant="line" className="w-full justify-start border-b">
                <TabsTrigger value="form" disabled={!schemaAvailable || parsedArgs === null}>
                  Form
                </TabsTrigger>
                <TabsTrigger value="json">Raw JSON</TabsTrigger>
              </TabsList>

              <TabsContent value="form" className="space-y-3 pt-3">
                {schemaAvailable && parsedArgs !== null ? (
                  <JsonSchemaForm
                    schema={inputSchema}
                    definitions={schemaDefinitions}
                    value={parsedArgs}
                    onChange={handleFormChange}
                    disabled={running}
                  />
                ) : (
                  <p className="text-xs text-muted-foreground">
                    No schema available — use Raw JSON to enter arguments.
                  </p>
                )}
              </TabsContent>

              <TabsContent value="json" className="space-y-1.5 pt-3">
                <Textarea
                  id="tool-run-args"
                  className="font-mono text-xs"
                  rows={5}
                  spellCheck={false}
                  value={argsJson}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                    setArgsJson(e.target.value)
                  }
                  disabled={running}
                  aria-invalid={argsError != null}
                />
                {argsError && <p className="text-xs text-destructive">{argsError}</p>}
              </TabsContent>
            </Tabs>
          </div>

          <div className="flex items-center justify-between gap-3">
            {requiredMissing.length > 0 ? (
              <p className="text-xs text-muted-foreground">
                Fill required:{" "}
                <span className="font-mono text-foreground/80">{requiredMissing.join(", ")}</span>
              </p>
            ) : (
              <span aria-hidden />
            )}
            <Button
              size="sm"
              onClick={() => void handleRun()}
              disabled={running || requiredMissing.length > 0}
            >
              {running ? "Running..." : "Run"}
            </Button>
          </div>
        </CardStackContent>
      </CardStack>

      {result && <ToolRunResult result={result} />}
    </div>
  );
}

function ToolRunResult(props: { readonly result: RunResult }) {
  const { result } = props;

  if (result.kind === "paused") {
    return (
      <CardStack>
        <CardStackHeader>Result</CardStackHeader>
        <CardStackContent>
          <p className="px-4 py-3 text-sm text-muted-foreground">
            This tool requires approval (a policy gates it) — adjust the policy to run it directly.
          </p>
        </CardStackContent>
      </CardStack>
    );
  }

  const failed = result.isError || isFailedEnvelope(result.structured);
  const hasStructured = result.structured !== undefined;

  return (
    <CardStack className={cn(failed ? "border-destructive/40" : undefined)}>
      <CardStackHeader>
        <div className="flex items-center gap-2">
          <span>Result</span>
          <Badge variant={failed ? "destructive" : "secondary"}>
            {failed ? "Error" : "Success"}
          </Badge>
        </div>
      </CardStackHeader>
      <CardStackContent className="space-y-3 px-4 py-4">
        {failed && (
          <p className="text-xs text-destructive">
            The tool returned an error — the credentials may be invalid or lack access.
          </p>
        )}
        {hasStructured ? (
          <CodeBlock
            code={prettyJson(result.structured)}
            lang="json"
            title="Structured"
            className={cn(failed ? "border-destructive/40" : undefined)}
          />
        ) : null}
        {result.text && result.text.length > 0 && (
          <div className="space-y-1">
            <p className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Text
            </p>
            <pre className="max-h-48 overflow-auto rounded-md border border-border bg-card/60 p-3 font-mono text-xs whitespace-pre-wrap break-words text-foreground/80">
              {result.text}
            </pre>
          </div>
        )}
      </CardStackContent>
    </CardStack>
  );
}
