import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

import { ScopeId } from "@executor-js/sdk";

import { useScope, useUserScope } from "../api/scope-context";
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

export interface CredentialTargetScopeOption {
  readonly scopeId: ScopeId;
  readonly label: string;
  readonly description: string;
}

export const credentialTargetScopeOptions = (input: {
  readonly sourceScope: ScopeId;
  readonly userScope: ScopeId;
  readonly sourceScopeLabel?: string;
}): readonly CredentialTargetScopeOption[] => {
  if (input.sourceScope === input.userScope) {
    return [
      {
        scopeId: input.userScope,
        label: "Personal",
        description: "Saved only for your account.",
      },
    ];
  }

  return [
    {
      scopeId: input.userScope,
      label: "Personal",
      description: "Saved only for your account.",
    },
    {
      scopeId: input.sourceScope,
      label: input.sourceScopeLabel ?? "Organization",
      description: "Shared with everyone who can use this source.",
    },
  ];
};

export const normalizeCredentialTargetScope = (
  value: ScopeId,
  options: readonly CredentialTargetScopeOption[],
): ScopeId => options.find((option) => option.scopeId === value)?.scopeId ?? options[0]!.scopeId;

export function useCredentialTargetScope(input?: {
  readonly sourceScope?: ScopeId;
  readonly sourceScopeLabel?: string;
  readonly initialTargetScope?: ScopeId;
}): {
  readonly credentialTargetScope: ScopeId;
  readonly setCredentialTargetScope: (scope: ScopeId) => void;
  readonly credentialScopeOptions: readonly CredentialTargetScopeOption[];
} {
  const routeScope = useScope();
  const sourceScope = input?.sourceScope ?? routeScope;
  const userScope = useUserScope();
  const credentialScopeOptions = useMemo(
    () =>
      credentialTargetScopeOptions({
        sourceScope,
        userScope,
        sourceScopeLabel: input?.sourceScopeLabel,
      }),
    [sourceScope, userScope, input?.sourceScopeLabel],
  );
  const initialTargetScope = input?.initialTargetScope ?? credentialScopeOptions[0]!.scopeId;
  const [credentialTargetScope, setCredentialTargetScope] = useState<ScopeId>(
    normalizeCredentialTargetScope(initialTargetScope, credentialScopeOptions),
  );

  useEffect(() => {
    setCredentialTargetScope((current) =>
      normalizeCredentialTargetScope(
        current === routeScope && input?.sourceScope !== undefined ? initialTargetScope : current,
        credentialScopeOptions,
      ),
    );
  }, [credentialScopeOptions, initialTargetScope, input?.sourceScope, routeScope]);

  return {
    credentialTargetScope,
    setCredentialTargetScope,
    credentialScopeOptions,
  };
}

export function CredentialTargetScopeSelector(props: {
  readonly value: ScopeId;
  readonly options: readonly CredentialTargetScopeOption[];
  readonly onChange: (scope: ScopeId) => void;
  readonly title?: string;
  readonly description?: string;
}) {
  if (props.options.length <= 1) return null;

  const active = props.options.find((option) => option.scopeId === props.value);

  return (
    <CardStack>
      <CardStackContent className="border-t-0">
        <CardStackEntry>
          <CardStackEntryContent>
            <CardStackEntryTitle>{props.title ?? "Credentials"}</CardStackEntryTitle>
            <CardStackEntryDescription>
              {props.description ??
                active?.description ??
                "Choose where new credentials are saved."}
            </CardStackEntryDescription>
          </CardStackEntryContent>
          <FilterTabs<ScopeId>
            tabs={props.options.map((option) => ({
              value: option.scopeId,
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

export function CredentialScopeSection(props: {
  readonly value: ScopeId;
  readonly options: readonly CredentialTargetScopeOption[];
  readonly onChange: (scope: ScopeId) => void;
  readonly children: ReactNode;
  readonly title?: string;
  readonly description?: string;
}) {
  return (
    <div className="space-y-3">
      <CredentialTargetScopeSelector
        value={props.value}
        options={props.options}
        onChange={props.onChange}
        title={props.title ?? "Used by"}
        description={props.description ?? "Choose who can use these credentials."}
      />
      {props.children}
    </div>
  );
}

export function CredentialScopeDropdown(props: {
  readonly value: ScopeId;
  readonly options: readonly CredentialTargetScopeOption[];
  readonly onChange: (scope: ScopeId) => void;
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
          {props.help ?? "Choose who can use these credentials."}
        </HelpTooltip>
      </div>
      <Select
        value={String(props.value)}
        onValueChange={(value) => props.onChange(ScopeId.make(value))}
      >
        <SelectTrigger className={props.triggerClassName ?? "w-full"} size={props.size}>
          <SelectValue placeholder={label} />
        </SelectTrigger>
        <SelectContent>
          {props.options.map((option) => (
            <SelectItem key={option.scopeId} value={option.scopeId}>
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

export function CredentialUsageRow(props: {
  readonly value: ScopeId;
  readonly options: readonly CredentialTargetScopeOption[];
  readonly onChange: (scope: ScopeId) => void;
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
      <CredentialScopeDropdown
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
