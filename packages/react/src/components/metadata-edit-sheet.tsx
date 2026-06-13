import { Suspense, useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import { useAtomSet } from "@effect/atom-react";
import * as Exit from "effect/Exit";
import { type Connection, type IntegrationSlug } from "@executor-js/sdk/shared";
import type { EditSheetApplyResult, EditSheetSectionProps } from "@executor-js/sdk/client";
import { toast } from "sonner";

import { updateConnection, updateIntegration } from "../api/atoms";
import { connectionWriteKeys, integrationWriteKeys } from "../api/reactivity-keys";
import { trackEvent } from "../api/analytics";
import { messageFromExit } from "../api/error-reporting";
import { Button } from "./button";
import { Input } from "./input";
import { Label } from "./label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "./sheet";
import { Textarea } from "./textarea";

// ---------------------------------------------------------------------------
// Metadata edit sheets — the user-curated, AGENT-VISIBLE metadata for an
// integration and for a connection. The point of the sheet (vs. an inline
// input) is the preview: it shows the exact inventory line an agent reads, so
// editing the description is editing what the model sees.
// ---------------------------------------------------------------------------

/** The connection's callable prefix under `tools.` — the line item agents see
 *  in the execute tool's "Available connection prefixes" inventory. */
const connectionPrefix = (connection: Connection): string => {
  const address = String(connection.address);
  return address.startsWith("tools.") ? address.slice("tools.".length) : address;
};

function AgentPreview(props: { readonly label: string; readonly line: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {props.label}
      </p>
      <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-foreground">
        {props.line}
      </pre>
    </div>
  );
}

export function ConnectionEditSheet(props: {
  readonly connection: Connection | null;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { connection } = props;
  const doUpdate = useAtomSet(updateConnection, { mode: "promiseExit" });
  const [description, setDescription] = useState("");
  const [identityLabel, setIdentityLabel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDescription(connection?.description ?? "");
    setIdentityLabel(connection?.identityLabel ?? "");
  }, [connection]);

  const handleSave = async () => {
    if (!connection) return;
    setSaving(true);
    const exit = await doUpdate({
      params: {
        owner: connection.owner,
        integration: connection.integration,
        name: connection.name,
      },
      payload: {
        description: description.trim().length > 0 ? description.trim() : null,
        identityLabel: identityLabel.trim().length > 0 ? identityLabel.trim() : null,
      },
      reactivityKeys: connectionWriteKeys,
    });
    setSaving(false);
    if (Exit.isFailure(exit)) {
      toast.error(messageFromExit(exit, "Failed to update connection"));
      return;
    }
    props.onOpenChange(false);
  };

  const previewDescription = description.trim().split("\n", 1)[0];
  const prefix = connection ? connectionPrefix(connection) : "";

  return (
    <Sheet open={connection !== null} onOpenChange={props.onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Edit connection</SheetTitle>
          <SheetDescription>
            The description is agent-visible: it rides this connection's prefix in the tool
            inventory, so it is the place to say what this credential reaches and how to use it.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4">
          <div className="space-y-1.5">
            <Label htmlFor="connection-description">Description</Label>
            <Textarea
              id="connection-description"
              value={description}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setDescription(e.target.value)
              }
              placeholder="e.g. Production CRM — reads only; use the sandbox connection for writes."
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="connection-label">Account label</Label>
            <Input
              id="connection-label"
              value={identityLabel}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setIdentityLabel(e.target.value)
              }
              placeholder="Which account this credential belongs to"
              disabled={saving}
            />
            <p className="text-xs text-muted-foreground">
              Display-only; shown in the accounts list instead of the connection name.
            </p>
          </div>

          {connection ? (
            <AgentPreview
              label="What agents see"
              line={
                previewDescription ? `- \`${prefix}\` — ${previewDescription}` : `- \`${prefix}\``
              }
            />
          ) : null}
        </div>

        <SheetFooter>
          <Button onClick={() => void handleSave()} disabled={saving || !connection}>
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function IntegrationEditSheet(props: {
  readonly slug: IntegrationSlug;
  readonly open: boolean;
  /** The integration's display name. */
  readonly name: string;
  /** The integration's agent-visible description. */
  readonly description: string;
  /** Plugin-owned configuration (e.g. OpenAPI spec update) rendered below the
   *  shared fields — the same surface the plugin's add flow configures. The
   *  section STAGES its change and reports an apply thunk via
   *  `onPendingChange`; the sheet's one Save runs it after the metadata
   *  update. */
  readonly pluginSection?: ComponentType<EditSheetSectionProps>;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const doUpdate = useAtomSet(updateIntegration, { mode: "promiseExit" });
  const [nameDraft, setNameDraft] = useState(props.name);
  const [descriptionDraft, setDescriptionDraft] = useState(props.description);
  const [saving, setSaving] = useState(false);
  // The plugin section's staged change — a thunk that applies it and resolves
  // to a summary line. Held in a ref: it changes per keystroke in the section
  // and is only read at Save.
  const pendingPluginApply = useRef<(() => Promise<EditSheetApplyResult>) | null>(null);
  const handlePendingChange = useCallback((apply: (() => Promise<EditSheetApplyResult>) | null) => {
    pendingPluginApply.current = apply;
  }, []);

  useEffect(() => {
    if (props.open) {
      setNameDraft(props.name);
      setDescriptionDraft(props.description);
    }
  }, [props.open, props.name, props.description]);

  const handleSave = async () => {
    const nextName = nameDraft.trim();
    if (nextName.length === 0) return;
    setSaving(true);
    const exit = await doUpdate({
      params: { slug: props.slug },
      payload: { name: nextName, description: descriptionDraft.trim() },
      reactivityKeys: integrationWriteKeys,
    });
    trackEvent("integration_renamed", {
      integration_slug: String(props.slug),
      success: Exit.isSuccess(exit),
    });
    if (Exit.isFailure(exit)) {
      setSaving(false);
      toast.error(messageFromExit(exit, "Failed to update integration"));
      return;
    }
    // Then the plugin section's staged change (e.g. the spec update). On
    // failure the section shows its own error inline — keep the sheet open.
    const apply = pendingPluginApply.current;
    if (apply) {
      const result = await apply();
      if (!result.ok) {
        setSaving(false);
        return;
      }
      if (result.summary) toast.success(result.summary);
    }
    setSaving(false);
    props.onOpenChange(false);
  };

  const slug = String(props.slug);
  const preview = descriptionDraft.trim().split("\n", 1)[0];

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right">
        <SheetHeader>
          <SheetTitle>Edit integration</SheetTitle>
          <SheetDescription>
            The name is what people see; the description is agent-visible context — agents read it
            when browsing sources and as fallback context on connections without one of their own.
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-5 overflow-y-auto px-4">
          <div className="space-y-1.5">
            <Label htmlFor="integration-name">Name</Label>
            <Input
              id="integration-name"
              value={nameDraft}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setNameDraft(e.target.value)}
              placeholder="e.g. GitHub"
              disabled={saving}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="integration-description">Description</Label>
            <Textarea
              id="integration-description"
              value={descriptionDraft}
              onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
                setDescriptionDraft(e.target.value)
              }
              onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleSave();
              }}
              placeholder="What this API is and when to reach for it"
              disabled={saving}
            />
          </div>

          <AgentPreview
            label="What agents see"
            line={
              preview && preview.toLowerCase() !== slug.toLowerCase()
                ? `{ id: "${slug}", description: "${preview}", ... }`
                : `{ id: "${slug}", ... }`
            }
          />

          {props.pluginSection ? (
            <Suspense fallback={null}>
              <props.pluginSection sourceId={slug} onPendingChange={handlePendingChange} />
            </Suspense>
          ) : null}
        </div>

        <SheetFooter>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || nameDraft.trim().length === 0}
          >
            {saving ? "Saving..." : "Save"}
          </Button>
          <Button variant="outline" onClick={() => props.onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
