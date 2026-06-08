import { useState } from "react";
import type { ReactNode } from "react";

import { Owner } from "@executor-js/sdk/shared";

import { useOrganizationId } from "../api/organization-context";
import {
  CardStack,
  CardStackContent,
  CardStackEntry,
  CardStackEntryContent,
  CardStackEntryDescription,
  CardStackEntryTitle,
} from "../components/card-stack";
import { FilterTabs } from "../components/filter-tabs";
import { FieldLabel } from "../components/field";
import { HelpTooltip } from "../components/help-tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/select";

// ---------------------------------------------------------------------------
// Connection owner selector (v2).
//
// v2 connections are owner-scoped: Personal (`user`) or Workspace (`org`) in
// cloud, and one Local (`org`) bucket in local/desktop. Keep that host clamp in
// one place so OAuth, API-key, and plugin-specific add flows cannot disagree.
// ---------------------------------------------------------------------------

export interface ConnectionOwnerOption {
  readonly owner: Owner;
  readonly label: string;
  readonly description: string;
}

export const DEFAULT_CONNECTION_OWNER: Owner = "user";
export const LOCAL_CONNECTION_OWNER: Owner = "org";

/** The two owner choices a connection can be saved under in cloud. */
export const connectionOwnerOptions = (): readonly ConnectionOwnerOption[] => [
  {
    owner: "user",
    label: "Personal",
    description: "Saved only for your account.",
  },
  {
    owner: "org",
    label: "Workspace",
    description: "Shared with everyone in this workspace.",
  },
];

export const localConnectionOwnerOptions = (): readonly ConnectionOwnerOption[] => [
  {
    owner: LOCAL_CONNECTION_OWNER,
    label: "Local",
    description: "Saved on this device for this project.",
  },
];

export const connectionOwnerOptionsForHost = (
  organizationId: string | null,
): readonly ConnectionOwnerOption[] =>
  organizationId === null ? localConnectionOwnerOptions() : connectionOwnerOptions();

export const defaultConnectionOwnerForHost = (organizationId: string | null): Owner =>
  organizationId === null ? LOCAL_CONNECTION_OWNER : DEFAULT_CONNECTION_OWNER;

export const normalizeConnectionOwner = (
  value: Owner,
  options: readonly ConnectionOwnerOption[],
): Owner => options.find((option) => option.owner === value)?.owner ?? options[0]!.owner;

export const resolveConnectionOwnerForHost = (
  organizationId: string | null,
  requestedOwner: Owner,
): Owner => normalizeConnectionOwner(requestedOwner, connectionOwnerOptionsForHost(organizationId));

export const resolveOAuthConnectionOwnerForHost = (input: {
  readonly organizationId: string | null;
  readonly requestedOwner: Owner;
  readonly clientOwner: Owner;
}): Owner =>
  resolveConnectionOwnerForHost(
    input.organizationId,
    input.clientOwner === "org" ? input.requestedOwner : "user",
  );

/**
 * Owns the Personal/Workspace selection for a connection-create flow. The global
 * owner toggle is retired, so this is an explicit, required create-time choice
 * that defaults to `"user"` (Personal) in org-scoped hosts; pass
 * `initialOwner` to override.
 *
 * Non-org-scoped hosts (local/desktop) have one local workspace. Existing local
 * v1 data migrates there as `owner: "org"`, so we offer only a Local/org
 * option; every picker below hides on a single option, so the owner choice
 * disappears entirely on local.
 */
export function useConnectionOwner(input?: { readonly initialOwner?: Owner }): {
  readonly connectionOwner: Owner;
  readonly setConnectionOwner: (owner: Owner) => void;
  readonly connectionOwnerOptions: readonly ConnectionOwnerOption[];
} {
  const organizationId = useOrganizationId();
  const options = connectionOwnerOptionsForHost(organizationId);
  const [connectionOwner, setConnectionOwner] = useState<Owner>(
    input?.initialOwner ?? defaultConnectionOwnerForHost(organizationId),
  );

  // Always keep the selection valid against the available options — on a
  // non-org host this forces Local regardless of any passed `initialOwner`.
  const normalizedOwner = normalizeConnectionOwner(connectionOwner, options);

  return {
    connectionOwner: normalizedOwner,
    setConnectionOwner,
    connectionOwnerOptions: options,
  };
}

export function ConnectionOwnerSelector(props: {
  readonly value: Owner;
  readonly options: readonly ConnectionOwnerOption[];
  readonly onChange: (owner: Owner) => void;
  readonly title?: string;
  readonly description?: string;
}) {
  if (props.options.length <= 1) return null;

  const active = props.options.find((option) => option.owner === props.value);

  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <CardStackEntry>
          <CardStackEntryContent>
            <CardStackEntryTitle>{props.title ?? "Connection owner"}</CardStackEntryTitle>
            <CardStackEntryDescription>
              {props.description ??
                active?.description ??
                "Choose where new connections are saved."}
            </CardStackEntryDescription>
          </CardStackEntryContent>
          <FilterTabs<Owner>
            tabs={props.options.map((option) => ({
              value: option.owner,
              label: option.label,
            }))}
            value={props.value}
            onChange={props.onChange}
          />
        </CardStackEntry>
      </CardStackContent>
    </CardStack>
  );
}

export function ConnectionOwnerSection(props: {
  readonly value: Owner;
  readonly options: readonly ConnectionOwnerOption[];
  readonly onChange: (owner: Owner) => void;
  readonly children: ReactNode;
  readonly title?: string;
  readonly description?: string;
}) {
  return (
    <div className="space-y-3">
      <ConnectionOwnerSelector
        value={props.value}
        options={props.options}
        onChange={props.onChange}
        title={props.title ?? "Used by"}
        description={props.description ?? "Choose who can use these connections."}
      />
      {props.children}
    </div>
  );
}

export function ConnectionOwnerDropdown(props: {
  readonly value: Owner;
  readonly options: readonly ConnectionOwnerOption[];
  readonly onChange: (owner: Owner) => void;
  readonly label?: string;
  readonly help?: ReactNode;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly size?: "sm" | "default";
}) {
  const label = props.label ?? "Used by";
  if (props.options.length <= 1) return null;

  return (
    <div className={props.className ?? "space-y-1.5"}>
      <div className="flex items-center gap-1.5">
        <FieldLabel className="text-[11px]">{label}</FieldLabel>
        <HelpTooltip label={label}>
          {props.help ?? "Choose who can use these connections."}
        </HelpTooltip>
      </div>
      <Select value={String(props.value)} onValueChange={(value) => props.onChange(value as Owner)}>
        <SelectTrigger className={props.triggerClassName ?? "w-full"} size={props.size}>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent position="popper" side="bottom" sideOffset={4}>
          {props.options.map((option) => (
            <SelectItem key={option.owner} value={option.owner}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function CredentialControlField(props: {
  readonly label: string;
  readonly children: ReactNode;
  readonly help?: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-1.5">
        <FieldLabel className="text-[11px]">{props.label}</FieldLabel>
        {props.help ? <HelpTooltip label={props.label}>{props.help}</HelpTooltip> : null}
      </div>
      {props.children}
    </div>
  );
}

export function ConnectionOwnerUsageRow(props: {
  readonly value: Owner;
  readonly options: readonly ConnectionOwnerOption[];
  readonly onChange: (owner: Owner) => void;
  readonly children: ReactNode;
  readonly label?: string;
  readonly help?: ReactNode;
}) {
  if (props.options.length <= 1) {
    return <div className="space-y-2.5">{props.children}</div>;
  }

  return (
    <div className="grid items-stretch gap-2 md:grid-cols-2">
      <div className="min-w-0 space-y-2.5">{props.children}</div>
      <ConnectionOwnerDropdown
        value={props.value}
        options={props.options}
        onChange={props.onChange}
        label={props.label}
        help={props.help}
        className="flex h-full flex-col space-y-1.5"
        triggerClassName="w-full min-h-9 flex-1 data-[size=default]:h-full"
      />
    </div>
  );
}
