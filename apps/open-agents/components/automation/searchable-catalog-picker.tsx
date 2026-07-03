"use client";

import { Check, ChevronDown } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type SearchableCatalogOption = {
  id: string;
  label: string;
  description?: string;
  group?: string;
  badge?: string;
  keywords?: string[];
};

type CommonProps = {
  options: SearchableCatalogOption[];
  placeholder: string;
  searchPlaceholder?: string;
  emptyLabel?: string;
  disabled?: boolean;
  className?: string;
  maxSelectedLabels?: number;
};

type SinglePickerProps = CommonProps & {
  multiple?: false;
  value: string;
  onValueChange: (value: string) => void;
};

type MultiPickerProps = CommonProps & {
  multiple: true;
  value: string[];
  onValueChange: (value: string[]) => void;
};

export type SearchableCatalogPickerProps = SinglePickerProps | MultiPickerProps;

function groupOptions(options: SearchableCatalogOption[]) {
  const groups = new Map<string, SearchableCatalogOption[]>();
  for (const option of options) {
    const group = option.group ?? "Options";
    groups.set(group, [...(groups.get(group) ?? []), option]);
  }
  return Array.from(groups.entries());
}

function SelectedValue({
  options,
  placeholder,
  maxSelectedLabels,
}: {
  options: SearchableCatalogOption[];
  placeholder: string;
  maxSelectedLabels: number;
}) {
  if (options.length === 0) {
    return <span className="truncate text-muted-foreground">{placeholder}</span>;
  }

  const visible = options.slice(0, maxSelectedLabels);
  const remaining = options.length - visible.length;
  return (
    <span className="flex min-w-0 flex-wrap gap-1">
      {visible.map((option) => (
        <span
          key={option.id}
          className="max-w-[11rem] truncate rounded border bg-muted/40 px-1.5 py-0.5 text-xs font-medium"
        >
          {option.label}
        </span>
      ))}
      {remaining > 0 ? (
        <span className="rounded border bg-muted/40 px-1.5 py-0.5 text-xs font-medium">
          +{remaining}
        </span>
      ) : null}
    </span>
  );
}

export function SearchableCatalogPicker(props: SearchableCatalogPickerProps) {
  const {
    options,
    placeholder,
    searchPlaceholder = "Filter options",
    emptyLabel = "No options found.",
    disabled = false,
    className,
    maxSelectedLabels = 3,
  } = props;
  const [open, setOpen] = useState(false);
  const selectedOptions = useMemo(() => {
    const values = new Set(
      props.multiple ? props.value : props.value ? [props.value] : [],
    );
    return options.filter((option) => values.has(option.id));
  }, [options, props.multiple, props.value]);
  const groupedOptions = useMemo(() => groupOptions(options), [options]);

  const toggleValue = (id: string) => {
    if (props.multiple) {
      const exists = props.value.includes(id);
      props.onValueChange(
        exists
          ? props.value.filter((value) => value !== id)
          : [...props.value, id],
      );
      return;
    }
    props.onValueChange(id);
    setOpen(false);
  };

  const isSelected = (id: string) =>
    props.multiple ? props.value.includes(id) : props.value === id;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-expanded={open}
          className={cn(
            "h-auto min-h-9 w-full justify-between gap-3 whitespace-normal px-3 py-2 text-left",
            className,
          )}
        >
          <SelectedValue
            options={selectedOptions}
            placeholder={placeholder}
            maxSelectedLabels={maxSelectedLabels}
          />
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[--radix-popover-trigger-width] max-w-[calc(100vw-1rem)] p-0"
      >
        <Command>
          <CommandInput placeholder={searchPlaceholder} />
          <CommandList className="max-h-72">
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            {groupedOptions.map(([group, groupItems]) => (
              <CommandGroup key={group} heading={group}>
                {groupItems.map((option) => {
                  const active = isSelected(option.id);
                  return (
                    <CommandItem
                      key={option.id}
                      value={option.id}
                      keywords={[
                        option.label,
                        option.description ?? "",
                        option.badge ?? "",
                        ...(option.keywords ?? []),
                      ]}
                      onSelect={() => toggleValue(option.id)}
                      className="w-full min-w-0 items-start gap-2 py-2"
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border",
                          active
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border",
                        )}
                      >
                        {active ? <Check className="h-3 w-3" /> : null}
                      </span>
                      <span className="min-w-0 flex-1 overflow-hidden">
                        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                          <span className="min-w-0 break-words text-sm font-medium leading-5">
                            {option.label}
                          </span>
                          {option.badge ? (
                            <span className="shrink-0 rounded border px-1 py-0.5 text-[10px] uppercase leading-none tracking-normal text-muted-foreground">
                              {option.badge}
                            </span>
                          ) : null}
                        </span>
                        {option.description ? (
                          <span className="mt-0.5 block whitespace-normal break-words pr-1 text-xs leading-4 text-muted-foreground">
                            {option.description}
                          </span>
                        ) : null}
                      </span>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
