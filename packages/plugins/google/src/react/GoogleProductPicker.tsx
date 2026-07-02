import { useMemo, useState } from "react";
import { ChevronDownIcon, PlusIcon, TriangleAlert, XIcon } from "lucide-react";

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
  googleOAuthConsentScopesForPreset,
  googleOpenApiPresets,
  type GoogleOpenApiOAuthAudience,
  type GoogleOpenApiPreset,
} from "../sdk/presets";
import { googleOAuthConsentBatches } from "../sdk/oauth-batches";
import { isGoogleDiscoveryUrl } from "../sdk/discovery";

// ---------------------------------------------------------------------------
// GoogleProductPicker - the "customize your Google connection" surface.
//
// A checkable card grid over `googleOpenApiPresets`, grouped/annotated by
// `oauthAudience`. The user picks which Google APIs to bundle into the single
// `google` integration; the parent turns the selected discovery URLs into a
// `{ kind: "googleDiscoveryBundle", urls }` add. A "View scopes" panel previews
// the unioned OAuth consent (via `googleOAuthConsentBatches`) BEFORE connecting,
// and a custom-URL escape hatch lets advanced users paste any Google Discovery
// document the preset list doesn't cover.
// ---------------------------------------------------------------------------

// Audience groups, ordered from least- to most-privileged. The warning tiers
// (`workspace-admin`, `unsupported-user`) carry a caution chip so the user sees
// the consent risk before selecting.
const AUDIENCE_ORDER: readonly GoogleOpenApiOAuthAudience[] = [
  "standard-user",
  "advanced-user",
  "workspace-admin",
  "unsupported-user",
];

const AUDIENCE_LABEL: Readonly<Record<GoogleOpenApiOAuthAudience, string>> = {
  "standard-user": "Core Google services",
  "advanced-user": "Advanced services",
  "workspace-admin": "Workspace admin",
  "unsupported-user": "Limited user consent",
};

const AUDIENCE_DESCRIPTION: Readonly<Record<GoogleOpenApiOAuthAudience, string>> = {
  "standard-user": "Connect with a normal Google account - one consent screen.",
  "advanced-user": "Broader scopes that may need an unverified-app warning to be accepted.",
  "workspace-admin": "Requires a Google Workspace admin account; not available on personal Gmail.",
  "unsupported-user": "Google does not grant these scopes through standard user OAuth consent.",
};

const audienceNeedsWarning = (audience: GoogleOpenApiOAuthAudience): boolean =>
  audience === "workspace-admin" || audience === "unsupported-user";

type GoogleProductPickerProps = {
  readonly selectedPresetIds: ReadonlySet<string>;
  readonly onToggle: (presetId: string, checked: boolean) => void;
  readonly customUrls: readonly string[];
  readonly onAddCustomUrl: (url: string) => void;
  readonly onRemoveCustomUrl: (url: string) => void;
};

const AudienceWarningChip = ({ audience }: { audience: GoogleOpenApiOAuthAudience }) =>
  audience === "workspace-admin" ? (
    <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">
      <TriangleAlert className="size-3" />
      Admin only
    </Badge>
  ) : audience === "unsupported-user" ? (
    <Badge variant="outline" className="shrink-0 border-destructive/40 text-destructive">
      <TriangleAlert className="size-3" />
      Limited consent
    </Badge>
  ) : null;

// A Google API row - borderless and single-line, leaning on hover/selected
// fills instead of per-item card chrome (lightest separation that still reads).
// Name + truncated summary share one baseline for a dense, scannable two-column
// list; the audience warning chip trails on the right.
const ProductRow = ({
  preset,
  checked,
  onToggle,
}: {
  readonly preset: GoogleOpenApiPreset;
  readonly checked: boolean;
  readonly onToggle: (checked: boolean) => void;
}) => (
  <FieldLabel
    className={cn(
      // `w-full` overrides FieldLabel's base `w-fit` (which would size the row to
      // its content and overflow the column); `min-w-0` then lets the cell shrink
      // to its track so the name/summary truncates instead of spilling over.
      "flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 transition-colors",
      checked ? "bg-primary/5" : "hover:bg-muted/40",
    )}
  >
    <Checkbox checked={checked} onCheckedChange={(next) => onToggle(next === true)} />
    <div className="shrink-0">
      <IntegrationFavicon icon={preset.icon} url={preset.url} size={16} />
    </div>
    {/* One truncating line - the name + summary clip to the cell with an
        ellipsis instead of overflowing into the neighbouring column. */}
    <div className="min-w-0 flex-1 truncate text-sm">
      <span className="font-medium text-foreground">{preset.name}</span>{" "}
      <span className="text-[11px] text-muted-foreground">{preset.summary}</span>
    </div>
    <AudienceWarningChip audience={preset.oauthAudience} />
  </FieldLabel>
);

const CustomUrlEscapeHatch = ({
  customUrls,
  onAddCustomUrl,
  onRemoveCustomUrl,
}: {
  readonly customUrls: readonly string[];
  readonly onAddCustomUrl: (url: string) => void;
  readonly onRemoveCustomUrl: (url: string) => void;
}) => {
  const [draft, setDraft] = useState("");
  const trimmed = draft.trim();
  const isValid = isGoogleDiscoveryUrl(trimmed);
  const isDuplicate = customUrls.includes(trimmed);

  const commit = () => {
    if (!isValid || isDuplicate) return;
    onAddCustomUrl(trimmed);
    setDraft("");
  };

  return (
    <div className="space-y-2">
      <FieldLabel className="text-[11px] font-medium text-muted-foreground">
        Add a custom Google Discovery URL
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
          placeholder="https://www.googleapis.com/discovery/v1/apis/<service>/<version>/rest"
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
        <p className="text-[11px] text-destructive">
          Enter a Google Discovery document URL (a *.googleapis.com discovery/$discovery endpoint).
        </p>
      ) : null}
      {customUrls.length > 0 ? (
        <ul className="space-y-1">
          {customUrls.map((url: string) => (
            <li
              key={url}
              className="flex items-center justify-between gap-2 rounded-md border border-border bg-muted/20 px-2.5 py-1.5"
            >
              <span className="truncate font-mono text-[11px] text-foreground">{url}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 shrink-0"
                onClick={() => onRemoveCustomUrl(url)}
                aria-label={`Remove ${url}`}
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

export function GoogleProductPicker({
  selectedPresetIds,
  onToggle,
  customUrls,
  onAddCustomUrl,
  onRemoveCustomUrl,
}: GoogleProductPickerProps) {
  const [scopesOpen, setScopesOpen] = useState(false);

  const groups = useMemo(
    () =>
      AUDIENCE_ORDER.flatMap((audience: GoogleOpenApiOAuthAudience) => {
        const presets = googleOpenApiPresets.filter(
          (preset: GoogleOpenApiPreset) => preset.oauthAudience === audience,
        );
        return presets.length > 0 ? [{ audience, presets }] : [];
      }),
    [],
  );

  // The "View scopes" preview unions the selected presets' representative
  // consent scopes through `googleOAuthConsentBatches`, mirroring the unioned
  // scopes the bundle converter ultimately stores on the integration.
  const consentBatches = useMemo(
    () =>
      googleOAuthConsentBatches(
        googleOpenApiPresets
          .filter((preset: GoogleOpenApiPreset) => selectedPresetIds.has(preset.id))
          .map((preset: GoogleOpenApiPreset) => ({
            id: preset.id,
            name: preset.name,
            oauthAudience: preset.oauthAudience,
            scopes: googleOAuthConsentScopesForPreset(preset.id),
          })),
      ),
    [selectedPresetIds],
  );

  const selectedCount = selectedPresetIds.size + customUrls.length;

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <FieldLabel>Customize your Google connection</FieldLabel>
        <p className="text-[11px] text-muted-foreground">
          Pick the Google APIs to bundle into one connection. They share a single OAuth consent and
          appear as merged tools under one Google integration.
        </p>
      </div>

      {groups.map(
        ({
          audience,
          presets,
        }: {
          readonly audience: GoogleOpenApiOAuthAudience;
          readonly presets: readonly GoogleOpenApiPreset[];
        }) => (
          <div key={audience} className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
                {AUDIENCE_LABEL[audience]}
              </span>
              {audienceNeedsWarning(audience) ? <AudienceWarningChip audience={audience} /> : null}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="ml-auto h-auto px-1.5 py-0.5 text-[11px] font-normal text-muted-foreground hover:bg-transparent hover:text-foreground"
                onClick={() => {
                  const allSelected = presets.every((preset: GoogleOpenApiPreset) =>
                    selectedPresetIds.has(preset.id),
                  );
                  presets.forEach((preset: GoogleOpenApiPreset) =>
                    onToggle(preset.id, !allSelected),
                  );
                }}
              >
                {presets.every((preset: GoogleOpenApiPreset) => selectedPresetIds.has(preset.id))
                  ? "Clear"
                  : "Select all"}
              </Button>
            </div>
            <p className="text-[11px] text-muted-foreground">{AUDIENCE_DESCRIPTION[audience]}</p>
            <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {presets.map((preset: GoogleOpenApiPreset) => (
                <ProductRow
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

      <CustomUrlEscapeHatch
        customUrls={customUrls}
        onAddCustomUrl={onAddCustomUrl}
        onRemoveCustomUrl={onRemoveCustomUrl}
      />

      <div className="space-y-1.5 rounded-lg border border-border bg-muted/10 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold tracking-wide text-foreground uppercase">
            Authentication
          </span>
          <Badge variant="secondary">OAuth</Badge>
        </div>
        <p className="text-[11px] text-muted-foreground">
          The selected Google APIs share one OAuth consent. Review the scopes below, then connect a
          Google account from the integration page after adding.
        </p>
      </div>

      <Collapsible open={scopesOpen} onOpenChange={setScopesOpen}>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline" size="sm" disabled={consentBatches.length === 0}>
            <ChevronDownIcon
              className={cn("size-3.5 transition-transform", scopesOpen ? "rotate-180" : "")}
            />
            View scopes
            {selectedCount > 0 ? (
              <Badge variant="secondary" className="ml-1">
                {selectedCount}
              </Badge>
            ) : null}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">
          {consentBatches.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">
              Select at least one Google API to preview the OAuth consent.
            </p>
          ) : (
            <div className="space-y-3">
              {consentBatches.map((batch) => (
                <div key={batch.id} className="space-y-1.5">
                  <span className="text-[11px] font-semibold text-foreground">{batch.label}</span>
                  <ul className="space-y-1">
                    {batch.apiScopes.map((scope: string) => (
                      <li
                        key={scope}
                        className="rounded-md border border-border bg-muted/20 px-2.5 py-1 font-mono text-[11px] break-all text-muted-foreground"
                      >
                        {scope}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

export default GoogleProductPicker;
