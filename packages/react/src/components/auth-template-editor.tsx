import { type Placement } from "../lib/auth-placements";
import { Button } from "./button";
import { FilterTabs } from "./filter-tabs";
import { Input } from "./input";
import { Label } from "./label";
import { PlacementEditor } from "./placement-editor";

// ---------------------------------------------------------------------------
// Auth-template editor — the single "How does this API authenticate?" editor.
//
// Add-time only: this declares an integration's auth TEMPLATE (where the
// credential goes / which OAuth endpoints), never a secret and never a network
// call. Plugin-agnostic — each plugin owns the mapping from this generic value
// to its own stored wire template (mirroring the `Placement` model and the
// per-plugin `auth-method-config` converters). One editor, three plugins.
//
// Tabs:
//  - `none`   — open / no credential.
//  - `apikey` — one secret sent at one or more PLACEMENTS (header / query),
//               edited through the shared `PlacementEditor`. When `presets`
//               are supplied (OpenAPI spec-detected methods) a pill row offers
//               editable defaults: clicking a pill pre-fills the value.
//  - `oauth`  — provider authorize/token URLs + scopes. No client id/secret —
//               that lives on the OAuth client, registered at connect time.
// ---------------------------------------------------------------------------

export type AuthTemplateEditorKind = "none" | "apikey" | "oauth";

export type AuthTemplateEditorValue =
  | { readonly kind: "none" }
  | { readonly kind: "apikey"; readonly placements: readonly Placement[] }
  | {
      readonly kind: "oauth";
      readonly authorizationUrl: string;
      readonly tokenUrl: string;
      readonly resource?: string | null;
      readonly scopes: readonly string[];
      readonly supportsClientIdMetadataDocument?: boolean;
    };

export interface AuthTemplateEditorPreset {
  /** Pill text, e.g. "Bearer token", "OAuth2". */
  readonly label: string;
  /** Clicking the pill applies this value (an editable default). */
  readonly value: AuthTemplateEditorValue;
}

const DEFAULT_ALLOWED: readonly AuthTemplateEditorKind[] = ["none", "apikey", "oauth"];

const TAB_LABELS: Readonly<Record<AuthTemplateEditorKind, string>> = {
  none: "None",
  apikey: "API key",
  oauth: "OAuth",
};

/** A fresh, empty header placement for the apiKey tab's first row. */
export const emptyApiKeyValue = (): AuthTemplateEditorValue => ({
  kind: "apikey",
  placements: [{ carrier: "header", name: "Authorization", prefix: "" }],
});

export const emptyOAuthValue = (): AuthTemplateEditorValue => ({
  kind: "oauth",
  authorizationUrl: "",
  tokenUrl: "",
  scopes: [],
});

/** The empty default value for a given tab kind. Switching tabs replaces the
 *  value with this so the editor below always has the right shape to edit. */
export const emptyValueForKind = (kind: AuthTemplateEditorKind): AuthTemplateEditorValue => {
  if (kind === "none") return { kind: "none" };
  if (kind === "apikey") return emptyApiKeyValue();
  return emptyOAuthValue();
};

/** Parse a comma-separated scope string into a trimmed, non-empty list. */
export const parseScopes = (raw: string): readonly string[] =>
  raw
    .split(",")
    .map((scope: string) => scope.trim())
    .filter((scope: string) => scope.length > 0);

export interface AuthTemplateEditorProps {
  readonly value: AuthTemplateEditorValue;
  readonly onChange: (value: AuthTemplateEditorValue) => void;
  /** Restrict which tabs render. Default `["none","apikey","oauth"]`. MCP
   *  OAuth-only servers pass `["oauth"]`; GraphQL passes `["none","apikey"]`. */
  readonly allowedKinds?: readonly AuthTemplateEditorKind[];
  /** Spec-detected presets (OpenAPI) → editable-default pills on the apiKey/OAuth
   *  tabs. Clicking a pill applies its value as an editable default. */
  readonly presets?: readonly AuthTemplateEditorPreset[];
  /** Some integrations, notably MCP, discover OAuth metadata from the server at
   *  connection time. In that case the add form should declare OAuth without
   *  editable provider URLs or scopes. */
  readonly oauthMetadata?: "editable" | "discovered";
}

export function AuthTemplateEditor(props: AuthTemplateEditorProps) {
  const {
    value,
    onChange,
    allowedKinds = DEFAULT_ALLOWED,
    presets,
    oauthMetadata = "editable",
  } = props;

  const tabs = allowedKinds.map((kind: AuthTemplateEditorKind) => ({
    value: kind,
    label: TAB_LABELS[kind],
  }));

  // Switching tab replaces the value with an empty default of that kind (so the
  // editor below has the right shape to edit). Re-selecting the current tab is a
  // no-op (it would otherwise clobber the user's in-progress edits).
  const handleTab = (next: AuthTemplateEditorKind): void => {
    if (next === value.kind) return;
    onChange(emptyValueForKind(next));
  };

  // Presets that match the active tab's kind — rendered as editable-default pills.
  const tabPresets = (presets ?? []).filter(
    (preset: AuthTemplateEditorPreset) => preset.value.kind === value.kind,
  );

  return (
    <div className="space-y-3">
      {tabs.length > 1 && (
        <FilterTabs<AuthTemplateEditorKind> tabs={tabs} value={value.kind} onChange={handleTab} />
      )}

      {value.kind === "none" && (
        <p className="text-xs text-muted-foreground">
          No credential — this integration is open and tools are callable without an account.
        </p>
      )}

      {value.kind === "apikey" && (
        <div className="space-y-2.5">
          {tabPresets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tabPresets.map((preset: AuthTemplateEditorPreset, index: number) => (
                <Button
                  key={`${preset.label}-${index}`}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={() => onChange(preset.value)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          )}
          <PlacementEditor
            placements={value.placements}
            onChange={(placements: Placement[]) => onChange({ kind: "apikey", placements })}
          />
        </div>
      )}

      {value.kind === "oauth" && (
        <div className="space-y-3">
          {tabPresets.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {tabPresets.map((preset: AuthTemplateEditorPreset, index: number) => (
                <Button
                  key={`${preset.label}-${index}`}
                  type="button"
                  variant="outline"
                  size="sm"
                  className="rounded-full"
                  onClick={() => onChange(preset.value)}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
          )}
          {oauthMetadata === "discovered" ? (
            <p className="rounded-lg border border-border/60 bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
              OAuth metadata is discovered from this server when you connect an account.
            </p>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="auth-authorization-url" className="text-xs text-muted-foreground">
                  Authorization URL
                </Label>
                <Input
                  id="auth-authorization-url"
                  placeholder="https://provider.example.com/oauth/authorize"
                  value={value.authorizationUrl}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    onChange({ ...value, authorizationUrl: e.target.value })
                  }
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="auth-token-url" className="text-xs text-muted-foreground">
                  Token URL
                </Label>
                <Input
                  id="auth-token-url"
                  placeholder="https://provider.example.com/oauth/token"
                  value={value.tokenUrl}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    onChange({ ...value, tokenUrl: e.target.value })
                  }
                  className="font-mono text-sm"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="auth-scopes" className="text-xs text-muted-foreground">
                  Scopes
                  <span className="font-normal text-muted-foreground/70">comma-separated</span>
                </Label>
                <Input
                  id="auth-scopes"
                  placeholder="read, write"
                  value={value.scopes.join(", ")}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    onChange({ ...value, scopes: parseScopes(e.target.value) })
                  }
                  className="font-mono text-sm"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
