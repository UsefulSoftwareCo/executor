import { useState, type ChangeEvent, type FocusEvent } from "react";
import { PlusIcon } from "lucide-react";

import type { Owner } from "@executor-js/sdk/shared";

import { Input } from "../components/input";
import { Badge } from "../components/badge";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "../components/command";
import { Popover, PopoverAnchor, PopoverContent } from "../components/popover";
import { ownerLabel, useOwnerDisplay } from "../api/owner-display";

// ---------------------------------------------------------------------------
// Connection / provider-item picker (v2) — successor to v1's secret picker.
//
// v1 picked a stored secret by (scopeId, secretId); v2 picks a value source —
// either an existing owner-scoped connection or a provider item — keyed by an
// opaque `id` and an `owner`. The export names are kept so the plugin `/react`
// dirs keep importing `SecretPicker` / `SecretPickerSecret`, adapted to v2.
// ---------------------------------------------------------------------------

export interface SecretPickerSecret {
  /** Opaque value id — a connection name or a provider item id. */
  readonly id: string;
  /** Which owner this entry belongs to (org | user). */
  readonly owner: Owner;
  readonly name: string;
  /** Credential provider key (e.g. "default", "1password"). */
  readonly provider?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  default: "Default",
  keychain: "Keychain",
  file: "Local",
  memory: "Memory",
  onepassword: "1Password",
};

const providerLabel = (key: string | undefined): string => {
  if (!key) return "Default";
  return PROVIDER_LABELS[key] ?? key;
};

export function SecretPicker(props: {
  readonly value: string | null;
  readonly valueOwner?: Owner;
  readonly onSelect: (id: string, owner: Owner) => void;
  readonly secrets: readonly SecretPickerSecret[];
  readonly placeholder?: string;
  /** When provided, renders a "+ New" row at the top of the dropdown. */
  readonly onCreateNew?: () => void;
}) {
  const {
    value,
    valueOwner,
    onSelect,
    secrets,
    placeholder = "Search credentials…",
    onCreateNew,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ownerDisplay = useOwnerDisplay();

  const selected =
    secrets.find(
      (secret) => secret.id === value && (valueOwner === undefined || secret.owner === valueOwner),
    ) ??
    secrets.find((secret) => secret.id === value) ??
    null;

  const grouped = new Map<string, SecretPickerSecret[]>();
  for (const secret of secrets) {
    const key = providerLabel(secret.provider);
    const group = grouped.get(key);
    if (group) {
      group.push(secret);
    } else {
      grouped.set(key, [secret]);
    }
  }

  const groups: [string, SecretPickerSecret[]][] = [...grouped.entries()]
    .map(([label, items]): [string, SecretPickerSecret[]] => [
      label,
      [...items].sort((a, b) => a.name.localeCompare(b.name)),
    ])
    .sort(([a], [b]) => a.localeCompare(b));
  const showGroupHeadings = groups.length > 1;

  return (
    <div className="relative w-full">
      <Popover open={open} onOpenChange={setOpen} modal={false}>
        <PopoverAnchor asChild>
          <Input
            value={open ? query : selected ? selected.name : (value ?? "")}
            onChange={(event: ChangeEvent<HTMLInputElement>) => {
              setQuery(event.target.value);
              if (!open) setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={(event: FocusEvent<HTMLInputElement>) => {
              const related = event.relatedTarget as HTMLElement | null;
              if (related?.closest("[data-slot=popover-content]")) return;
              setOpen(false);
            }}
            placeholder={placeholder}
            className="text-sm"
          />
        </PopoverAnchor>
        <PopoverContent
          className="w-(--radix-popover-trigger-width) p-0"
          align="start"
          onOpenAutoFocus={(event: Event) => event.preventDefault()}
          onCloseAutoFocus={(event: Event) => event.preventDefault()}
          onInteractOutside={(event: Event) => {
            const target = event.target as HTMLElement | null;
            if (target?.closest("[data-slot=popover-anchor]")) {
              event.preventDefault();
            }
          }}
        >
          <Command shouldFilter={false}>
            <CommandList>
              <CommandEmpty>No credentials found</CommandEmpty>
              {onCreateNew && (
                <>
                  <CommandGroup>
                    <CommandItem
                      value="__create_new__"
                      onSelect={() => {
                        onCreateNew();
                        setOpen(false);
                        setQuery("");
                      }}
                      className="text-muted-foreground data-[selected=true]:text-foreground"
                    >
                      <PlusIcon aria-hidden className="size-3.5" />
                      <span>New credential</span>
                    </CommandItem>
                  </CommandGroup>
                  {secrets.length > 0 && <CommandSeparator />}
                </>
              )}
              {groups.map(([label, items]) => {
                const lowerQuery = query.toLowerCase();
                const filtered = lowerQuery
                  ? items.filter(
                      (secret) =>
                        secret.name.toLowerCase().includes(lowerQuery) ||
                        secret.id.toLowerCase().includes(lowerQuery),
                    )
                  : items;
                if (filtered.length === 0) return null;
                return (
                  <CommandGroup key={label} heading={showGroupHeadings ? label : undefined}>
                    {filtered.map((secret) => (
                      <CommandItem
                        key={`${secret.owner}:${secret.id}`}
                        value={`${secret.name} ${secret.id} ${secret.owner}`}
                        onSelect={() => {
                          onSelect(secret.id, secret.owner);
                          setOpen(false);
                          setQuery("");
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{secret.name}</span>
                        {ownerDisplay.showOwnerLabels ? (
                          <Badge variant="outline" className="ml-2 shrink-0 text-[10px]">
                            {ownerLabel(secret.owner)}
                          </Badge>
                        ) : null}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                );
              })}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
