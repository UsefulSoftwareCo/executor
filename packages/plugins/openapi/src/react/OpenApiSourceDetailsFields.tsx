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
import { SourceFavicon } from "@executor-js/react/components/source-favicon";
import {
  SourceIdentityFieldRows,
  type SourceIdentity,
} from "@executor-js/react/plugins/source-identity";

export function OpenApiSourceDetailsFields(props: {
  readonly title: string;
  readonly description?: string;
  readonly identity: SourceIdentity;
  readonly baseUrl: string;
  readonly onBaseUrlChange: (value: string) => void;
  readonly baseUrlOptions?: readonly FreeformComboboxOption[];
  readonly specUrl?: string;
  readonly onSpecUrlChange?: (value: string) => void;
  readonly faviconUrl?: string;
  readonly namespaceReadOnly?: boolean;
  readonly specUrlDisabled?: boolean;
  readonly saveState?: "idle" | "saving" | "saved";
  readonly baseUrlMissingMessage?: string;
  readonly footer?: string;
}) {
  const baseUrlOptions = props.baseUrlOptions ?? [];

  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <CardStackEntry>
          {props.faviconUrl && <SourceFavicon url={props.faviconUrl} size={16} />}
          <CardStackEntryContent>
            <CardStackEntryTitle>{props.title}</CardStackEntryTitle>
            {props.description && (
              <CardStackEntryDescription>{props.description}</CardStackEntryDescription>
            )}
          </CardStackEntryContent>
          {props.saveState && props.saveState !== "idle" && (
            <span className="text-xs text-muted-foreground">
              {props.saveState === "saving" ? "Saving…" : "Saved"}
            </span>
          )}
        </CardStackEntry>
        <SourceIdentityFieldRows
          identity={props.identity}
          namespaceReadOnly={props.namespaceReadOnly}
        />
        <div className="grid grid-cols-1 md:grid-cols-2">
          <CardStackEntryField label="Base URL">
            {baseUrlOptions.length > 0 ? (
              <FreeformCombobox
                value={props.baseUrl}
                onValueChange={props.onBaseUrlChange}
                options={baseUrlOptions}
                placeholder="https://api.example.com"
                className="w-full"
                inputClassName="font-mono text-sm"
              />
            ) : (
              <Input
                value={props.baseUrl}
                onChange={(e) => props.onBaseUrlChange((e.target as HTMLInputElement).value)}
                placeholder="https://api.example.com"
                className="font-mono text-sm"
              />
            )}

            {props.baseUrlMissingMessage && !props.baseUrl && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400">
                {props.baseUrlMissingMessage}
              </p>
            )}
          </CardStackEntryField>
          {props.specUrl !== undefined && props.onSpecUrlChange && (
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
