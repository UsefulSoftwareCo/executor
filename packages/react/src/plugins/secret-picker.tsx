import { useState, type ChangeEvent, type FocusEvent } from "react";
import { PlusIcon } from "lucide-react";

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
import { useScopeStack } from "../api/scope-context";

export interface SecretPickerSecret {
  readonly id: string;
  readonly scopeId: string;
  readonly name: string;
  readonly provider?: string;
}

const PROVIDER_LABELS: Record<string, string> = {
  keychain: "Keychain",
  file: "Local",
  memory: "Memory",
  onepassword: "1Password",
};

const providerLabel = (key: string | undefined): string => {
  if (!key) return "Local";
  return PROVIDER_LABELS[key] ?? key;
};

export function SecretPicker(props: {
  readonly value: string | null;
  readonly valueScopeId?: string;
  readonly onSelect: (secretId: string, scopeId: string) => void;
  readonly secrets: readonly SecretPickerSecret[];
  readonly placeholder?: string;
  /** When provided, renders a "+ New secret" row at the top of the dropdown. */
  readonly onCreateNew?: () => void;
}) {
  const {
    value,
    valueScopeId,
    onSelect,
    secrets,
    placeholder = "Search secrets…",
    onCreateNew,
  } = props;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const scopeStack = useScopeStack();
  const scopeLabel = (scopeId: string): string => {
    const index = scopeStack.findIndex((entry) => String(entry.id) === scopeId);
    if (index === 0) return "Personal";
    if (index > 0) return scopeStack[index]?.name || "Organization";
    return "Scoped";
  };

  const selected =
    secrets.find(
      (secret) =>
        secret.id === value && (valueScopeId === undefined || secret.scopeId === valueScopeId),
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
              <CommandEmpty>No secrets found</CommandEmpty>
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
                      <span>New secret</span>
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
                        key={`${secret.scopeId}:${secret.id}`}
                        value={`${secret.name} ${secret.id} ${secret.scopeId}`}
                        onSelect={() => {
                          onSelect(secret.id, secret.scopeId);
                          setOpen(false);
                          setQuery("");
                        }}
                      >
                        <span className="min-w-0 flex-1 truncate">{secret.name}</span>
                        <Badge variant="outline" className="ml-2 shrink-0 text-[10px]">
                          {scopeLabel(secret.scopeId)}
                        </Badge>
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
