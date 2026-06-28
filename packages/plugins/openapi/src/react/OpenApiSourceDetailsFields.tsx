import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryField,
  CardStackEntryTitle,
} from "@executor-js/react/components/card-stack";
import {
  FreeformCombobox,
  type FreeformComboboxOption,
} from "@executor-js/react/components/combobox";
import { Input } from "@executor-js/react/components/input";
import { Textarea } from "@executor-js/react/components/textarea";
import { IntegrationFavicon } from "@executor-js/react/components/integration-favicon";
import {
  IntegrationIdentityFieldRows,
  type IntegrationIdentity,
} from "@executor-js/react/plugins/integration-identity";

/** The spec input is shown as a one-line "Spec URL" field only when it IS a
 *  URL; pasted document content gets a multi-line editor instead. */
const isUrlInput = (value: string): boolean => URL.canParse(value.trim());

export function OpenApiSourceDetailsFields(props: {
  readonly title: string;
  readonly subtitle?: string;
  readonly identity: IntegrationIdentity;
  /** The integration's agent-visible description (prefilled from the spec). */
  readonly description?: string;
  readonly onDescriptionChange?: (value: string) => void;
  readonly baseUrl: string;
  readonly onBaseUrlChange: (value: string) => void;
  readonly baseUrlOptions?: readonly FreeformComboboxOption[];
  readonly baseUrlLabel?: string;
  readonly baseUrlPlaceholder?: string;
  readonly baseUrlHint?: string;
  readonly specUrl?: string;
  readonly onSpecUrlChange?: (value: string) => void;
  readonly faviconIcon?: string | null;
  readonly faviconUrl?: string;
  readonly namespaceReadOnly?: boolean;
  readonly specUrlDisabled?: boolean;
  readonly saveState?: "idle" | "saving" | "saved";
  readonly baseUrlMissingMessage?: string;
  readonly footer?: string;
}) {
  const specIsUrl = props.specUrl !== undefined && isUrlInput(props.specUrl);

  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <CardStackEntry>
          {(props.faviconIcon || props.faviconUrl) && (
            <IntegrationFavicon icon={props.faviconIcon} url={props.faviconUrl} size={16} />
          )}
          <CardStackEntryContent>
            <CardStackEntryTitle>{props.title}</CardStackEntryTitle>
            {props.subtitle && (
              <CardStackEntryDescription>{props.subtitle}</CardStackEntryDescription>
            )}
          </CardStackEntryContent>
          {props.saveState && props.saveState !== "idle" && (
            <span className="text-xs text-muted-foreground">
              {props.saveState === "saving" ? "Saving…" : "Saved"}
            </span>
          )}
        </CardStackEntry>
        <IntegrationIdentityFieldRows
          identity={props.identity}
          namespaceReadOnly={props.namespaceReadOnly}
        />
        {props.onDescriptionChange && (
          <CardStackEntryField label="Description">
            <Textarea
              value={props.description ?? ""}
              onChange={(e) => props.onDescriptionChange?.((e.target as HTMLTextAreaElement).value)}
              placeholder="What this API is and when to reach for it"
              rows={2}
              maxRows={6}
              className="text-sm"
            />
          </CardStackEntryField>
        )}
        <div className="grid grid-cols-1 md:grid-cols-2">
          <CardStackEntryField label={props.baseUrlLabel ?? "Base URL"}>
            {props.baseUrlOptions && props.baseUrlOptions.length > 0 ? (
              <FreeformCombobox
                value={props.baseUrl}
                onValueChange={props.onBaseUrlChange}
                options={props.baseUrlOptions}
                placeholder={props.baseUrlPlaceholder ?? "https://api.example.com"}
                className="w-full"
                inputClassName="font-mono text-sm"
              />
            ) : (
              <Input
                value={props.baseUrl}
                onChange={(e) => props.onBaseUrlChange((e.target as HTMLInputElement).value)}
                placeholder={props.baseUrlPlaceholder ?? "https://api.example.com"}
                className="font-mono text-sm"
              />
            )}

            {props.baseUrlMissingMessage && !props.baseUrl && (
              <p className="text-[11px] text-muted-foreground">{props.baseUrlMissingMessage}</p>
            )}
            {props.baseUrlHint && (
              <p className="text-[11px] text-muted-foreground">{props.baseUrlHint}</p>
            )}
          </CardStackEntryField>
          {specIsUrl && props.onSpecUrlChange && (
            <CardStackEntryField label="Spec URL">
              <Input
                value={props.specUrl}
                onChange={(e) => props.onSpecUrlChange?.((e.target as HTMLInputElement).value)}
                placeholder="https://api.example.com/openapi.json"
                className="font-mono text-sm"
                disabled={props.specUrlDisabled}
              />
            </CardStackEntryField>
          )}
        </div>
        {props.specUrl !== undefined && !specIsUrl && props.onSpecUrlChange && (
          <CardStackEntryField label="Spec">
            <Textarea
              value={props.specUrl}
              onChange={(e) => props.onSpecUrlChange?.((e.target as HTMLTextAreaElement).value)}
              placeholder="Pasted OpenAPI JSON/YAML"
              rows={4}
              maxRows={12}
              className="font-mono text-xs"
              disabled={props.specUrlDisabled}
            />
          </CardStackEntryField>
        )}
        {props.footer && (
          <CardStackEntry>
            <CardStackEntryContent>
              <CardStackEntryTitle>{props.footer}</CardStackEntryTitle>
            </CardStackEntryContent>
          </CardStackEntry>
        )}
      </CardStackContent>
    </CardStack>
  );
}
