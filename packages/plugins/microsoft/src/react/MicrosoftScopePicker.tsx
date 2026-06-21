import { useMemo, useState } from "react";
import { ChevronDownIcon, PlusIcon, XIcon } from "lucide-react";

import { cn } from "@executor-js/react/lib/utils";
import { Badge } from "@executor-js/react/components/badge";
import { Button } from "@executor-js/react/components/button";
import { Checkbox } from "@executor-js/react/components/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@executor-js/react/components/collapsible";
import { FieldLabel } from "@executor-js/react/components/field";
import { Input } from "@executor-js/react/components/input";
import { IntegrationFavicon } from "@executor-js/react/components/integration-favicon";

import {
  microsoftGraphScopePresets,
  microsoftGraphScopesForPresetIds,
  type MicrosoftGraphScopeAudience,
  type MicrosoftGraphScopePreset,
} from "../sdk/presets";

type MicrosoftScopePickerProps = {
  readonly selectedPresetIds: ReadonlySet<string>;
  readonly onToggle: (presetId: string, checked: boolean) => void;
  readonly customScopes: readonly string[];
  readonly onAddCustomScope: (scope: string) => void;
  readonly onRemoveCustomScope: (scope: string) => void;
};

const AUDIENCE_ORDER: readonly MicrosoftGraphScopeAudience[] = [
  "productivity",
  "files-content",
  "collaboration",
  "directory-identity",
  "admin-security",
  "platform-business",
];

const AUDIENCE_LABEL: Readonly<Record<MicrosoftGraphScopeAudience, string>> = {
  productivity: "Productivity",
  "files-content": "Files and content",
  collaboration: "Collaboration",
  "directory-identity": "Directory and identity",
  "admin-security": "Admin and security",
  "platform-business": "Platform and business",
};

const AUDIENCE_DESCRIPTION: Readonly<Record<MicrosoftGraphScopeAudience, string>> = {
  productivity: "User-facing Microsoft 365 operations for the connected account.",
  "files-content": "Drive, SharePoint, OneNote, workbook, and content APIs.",
  collaboration: "Teams, chats, online meetings, calls, and teamwork APIs.",
  "directory-identity": "Tenant directory, app, identity, policy, and governance APIs.",
  "admin-security": "Admin, audit, security, compliance, device, and education APIs.",
  "platform-business": "Search, connectors, extensions, print, places, and business services.",
};

const ScopeRow = ({
  preset,
  checked,
  onToggle,
}: {
  readonly preset: MicrosoftGraphScopePreset;
  readonly checked: boolean;
  readonly onToggle: (checked: boolean) => void;
}) => (
  <FieldLabel
    className={cn(
      "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors",
      checked ? "bg-primary/5" : "hover:bg-muted/40",
    )}
  >
    <Checkbox checked={checked} onCheckedChange={(next) => onToggle(next === true)} />
    <div className="shrink-0">
      <IntegrationFavicon icon={preset.icon} size={16} />
    </div>
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-sm font-medium text-foreground">{preset.name}</span>
      </div>
      <p className="truncate text-[11px] text-muted-foreground">{preset.summary}</p>
    </div>
  </FieldLabel>
);

const CustomScopeInput = ({
  customScopes,
  onAddCustomScope,
  onRemoveCustomScope,
}: {
  readonly customScopes: readonly string[];
  readonly onAddCustomScope: (scope: string) => void;
  readonly onRemoveCustomScope: (scope: string) => void;
}) => {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const isValid = trimmed.length > 0 && !/\s/.test(trimmed);
  const isDuplicate = customScopes.includes(trimmed);

  const commit = () => {
    if (!isValid || isDuplicate) return;
    onAddCustomScope(trimmed);
    setDraft("");
  };

  return (
    <div className="space-y-2">
      <FieldLabel className="text-[11px] font-medium text-muted-foreground">
        Add custom Graph scope
      </FieldLabel>
      <div className="flex items-center gap-2">
        <Input
          value={draft}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
          onKeyDown={(event: React.KeyboardEvent<HTMLInputElement>) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            }
          }}
          placeholder="Sites.Read.All"
          className="font-mono text-[11px]"
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!isValid || isDuplicate}
          onClick={commit}
        >
          <PlusIcon className="size-3.5" />
          Add
        </Button>
      </div>
      {trimmed.length > 0 && !isValid ? (
        <p className="text-[11px] text-destructive">Scopes cannot contain whitespace.</p>
      ) : null}
      {customScopes.length > 0 ? (
        <ul className="space-y-1">
          {customScopes.map((scope: string) => (
            <li
              key={scope}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-1.5"
            >
              <span className="truncate font-mono text-[11px] text-foreground">{scope}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                onClick={() => onRemoveCustomScope(scope)}
                aria-label={`Remove ${scope}`}
              >
                <XIcon className="size-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

export function MicrosoftScopePicker({
  selectedPresetIds,
  onToggle,
  customScopes,
  onAddCustomScope,
  onRemoveCustomScope,
}: MicrosoftScopePickerProps) {
  const [scopesOpen, setScopesOpen] = useState(false);

  const groups = useMemo(
    () =>
      AUDIENCE_ORDER.flatMap((audience: MicrosoftGraphScopeAudience) => {
        const presets = microsoftGraphScopePresets.filter(
          (preset: MicrosoftGraphScopePreset) => preset.audience === audience,
        );
        return presets.length > 0 ? [{ audience, presets }] : [];
      }),
    [],
  );

  const scopes = useMemo(
    () => microsoftGraphScopesForPresetIds([...selectedPresetIds], customScopes),
    [selectedPresetIds, customScopes],
  );

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <FieldLabel>Customize Microsoft Graph</FieldLabel>
        <p className="text-[11px] text-muted-foreground">
          Pick the operation groups to expose as tools. They share one Microsoft OAuth consent and
          one account connection.
        </p>
      </div>

      {groups.map(
        ({
          audience,
          presets,
        }: {
          readonly audience: MicrosoftGraphScopeAudience;
          readonly presets: readonly MicrosoftGraphScopePreset[];
        }) => (
          <div key={audience} className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
                {AUDIENCE_LABEL[audience]}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-auto px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
                onClick={() => {
                  const allSelected = presets.every((preset: MicrosoftGraphScopePreset) =>
                    selectedPresetIds.has(preset.id),
                  );
                  presets.forEach((preset: MicrosoftGraphScopePreset) =>
                    onToggle(preset.id, !allSelected),
                  );
                }}
              >
                {presets.every((preset: MicrosoftGraphScopePreset) =>
                  selectedPresetIds.has(preset.id),
                )
                  ? "Clear"
                  : "Select all"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{AUDIENCE_DESCRIPTION[audience]}</p>
            <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {presets.map((preset: MicrosoftGraphScopePreset) => (
                <ScopeRow
                  key={preset.id}
                  preset={preset}
                  checked={selectedPresetIds.has(preset.id)}
                  onToggle={(checked: boolean) => onToggle(preset.id, checked)}
                />
              ))}
            </div>
          </div>
        ),
      )}

      <CustomScopeInput
        customScopes={customScopes}
        onAddCustomScope={onAddCustomScope}
        onRemoveCustomScope={onRemoveCustomScope}
      />

      <Collapsible open={scopesOpen} onOpenChange={setScopesOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={scopes.length === 0}>
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", scopesOpen ? "rotate-180" : "")}
            />
            View scopes
            {scopes.length > 0 ? (
              <Badge variant="secondary" className="ml-1">
                {scopes.length}
              </Badge>
            ) : null}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          <ul className="space-y-1">
            {scopes.map((scope: string) => (
              <li
                key={scope}
                className="rounded-md border border-border bg-muted/20 px-2.5 py-1 font-mono text-[11px] break-all text-muted-foreground"
              >
                {scope}
              </li>
            ))}
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export default MicrosoftScopePicker;
