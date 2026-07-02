import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import * as Exit from "effect/Exit";

import { integrationWriteKeys } from "@executor-js/react/api/reactivity-keys";
import { messageFromExit } from "@executor-js/react/api/error-reporting";
import { FormErrorAlert } from "@executor-js/react/lib/integration-add";
import { IntegrationSlug } from "@executor-js/sdk/shared";
import type { EditSheetApplyResult, EditSheetSectionProps } from "@executor-js/sdk/client";
import { Checkbox } from "@executor-js/react/components/checkbox";
import { Label } from "@executor-js/react/components/label";
import { Textarea } from "@executor-js/react/components/textarea";

import { openApiConfigAtom, updateOpenApiSpec } from "./atoms";

// ---------------------------------------------------------------------------
// Update spec — the openapi plugin's section of the integration Edit sheet.
// The user STAGES a spec update here (check re-fetch, or paste new content);
// nothing runs until the sheet's Save. The staged apply re-resolves the spec
// and rebuilds the tool catalog in place — connections, credentials, policies,
// and the curated description all survive.
// ---------------------------------------------------------------------------

type UpdateOutcome = {
  readonly toolCount: number;
  readonly addedTools: readonly string[];
  readonly removedTools: readonly string[];
};

const outcomeSummary = (outcome: UpdateOutcome): string => {
  const added = outcome.addedTools.length;
  const removed = outcome.removedTools.length;
  if (added === 0 && removed === 0) {
    return `Spec updated — ${outcome.toolCount} tools, no changes to the tool list.`;
  }
  const parts = [
    ...(added > 0 ? [`+${added} tool${added !== 1 ? "s" : ""}`] : []),
    ...(removed > 0 ? [`−${removed} tool${removed !== 1 ? "s" : ""}`] : []),
  ];
  return `Spec updated — ${parts.join(", ")} (${outcome.toolCount} total).`;
};

export default function UpdateSpecSection(props: EditSheetSectionProps) {
  const slug = IntegrationSlug.make(props.sourceId);
  const configResult = useAtomValue(openApiConfigAtom(slug));
  const doUpdate = useAtomSet(updateOpenApiSpec, { mode: "promiseExit" });
  const [refetchStaged, setRefetchStaged] = useState(false);
  const [pasted, setPasted] = useState("");
  const [error, setError] = useState<string | null>(null);

  const config =
    AsyncResult.isSuccess(configResult) && configResult.value ? configResult.value : null;

  const sourceUrl = config?.sourceUrl;

  // The staged apply, rebuilt whenever the staged inputs change. Reported to
  // the sheet through a ref-stable callback so Save can run it.
  const applyStaged = useCallback(async (): Promise<EditSheetApplyResult> => {
    const spec = pasted.trim().length > 0 ? { kind: "blob" as const, value: pasted } : undefined;
    if (!spec && !refetchStaged) return { ok: true, summary: null };
    setError(null);
    const exit = await doUpdate({
      params: { slug },
      payload: spec ? { spec } : {},
      reactivityKeys: integrationWriteKeys,
    });
    if (Exit.isFailure(exit)) {
      setError(messageFromExit(exit, "Failed to update spec"));
      return { ok: false };
    }
    setRefetchStaged(false);
    setPasted("");
    return { ok: true, summary: outcomeSummary(exit.value) };
  }, [doUpdate, pasted, refetchStaged, slug]);

  const onPendingChangeRef = useRef(props.onPendingChange);
  onPendingChangeRef.current = props.onPendingChange;
  const hasStagedChange = refetchStaged || pasted.trim().length > 0;
  useEffect(() => {
    onPendingChangeRef.current?.(hasStagedChange ? applyStaged : null);
    // Clear the staged apply if this section unmounts mid-edit.
    return () => onPendingChangeRef.current?.(null);
  }, [hasStagedChange, applyStaged]);

  if (!config) return null;

  return (
    <div className="space-y-3 border-t border-border/60 pt-5">
      <div className="space-y-1">
        <p className="text-sm font-medium text-foreground">Update spec</p>
        <p className="text-xs text-muted-foreground">
          Rebuild this integration's tools from the latest spec when you save. Connections,
          credentials, and policies are kept.
        </p>
      </div>

      {sourceUrl ? (
        <div className="space-y-2">
          <Label className="flex items-start gap-2 text-sm font-normal">
            <Checkbox
              checked={refetchStaged}
              onCheckedChange={(checked: boolean | "indeterminate") =>
                setRefetchStaged(checked === true)
              }
            />
            <span className="space-y-0.5">
              <span className="block">Re-fetch the spec on save</span>
              <span className="block break-all font-mono text-xs text-muted-foreground">
                {sourceUrl}
              </span>
            </span>
          </Label>
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="update-spec-content" className="text-xs text-muted-foreground">
            Updated spec content
          </Label>
          <Textarea
            id="update-spec-content"
            value={pasted}
            onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setPasted(e.target.value)}
            placeholder="Paste the updated OpenAPI JSON/YAML — applied when you save. This spec was added inline, so there is no URL to re-fetch."
            rows={4}
            maxRows={10}
            className="font-mono text-xs"
          />
        </div>
      )}

      {error && <FormErrorAlert message={error} />}
    </div>
  );
}
