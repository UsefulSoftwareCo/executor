import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
/** Sharing uses group grants; personal ownership is not a named-person assignment. */
import { useForm, useStore } from "@tanstack/react-form";
import { Exit } from "effect";
import { useEffect, useId, useRef, useState } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { AlertCircleIcon } from "@hugeicons/core-free-icons";
import { DisabledTooltip } from "@executor-js/ui/components/disabled-tooltip";
import { Button } from "@executor-js/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@executor-js/ui/components/alert";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@executor-js/ui/components/select";
import type { Group } from "@executor-js/hosted-server/groups";
import type {
  AppAudience,
  SharedAudience,
  AccessRevision,
} from "@executor-js/hosted-server/resource-access";
import { appError, type HostedError } from "../../contracts/errors.ts";
import { Link } from "@tanstack/react-router";
import { useOrganizationRoute } from "./organization.tsx";

type AudienceInputProps = {
  readonly groups: readonly Group[];
  readonly disabled?: boolean;
  readonly disabledReason?: string | undefined;
  readonly error?: string | undefined;
  readonly onBlur: () => void;
} & (
  | {
      readonly mode: "app";
      readonly value: typeof AppAudience.Type;
      readonly allowPrivate: boolean;
      readonly privateLabel: string;
      readonly onChange: (value: typeof AppAudience.Type) => void;
    }
  | {
      readonly mode: "account";
      readonly value: typeof SharedAudience.Type;
      readonly onChange: (value: typeof SharedAudience.Type) => void;
    }
);
/** Controlled sharing fields can be used in Settings and before authenticating a new team account. */
export function AudienceInput(props: AudienceInputProps) {
  const id = useId();
  const value = props.value;
  return (
    <fieldset
      className="space-y-3"
      aria-invalid={Boolean(props.error)}
      aria-describedby={props.error ? `${id}-error` : undefined}
      tabIndex={-1}
    >
      <label htmlFor={id} className="block text-sm font-medium">
        Who can use {props.mode === "app" ? "this app" : "this account"}?
      </label>
      <Select
        value={value.kind}
        disabled={props.disabled === true || props.disabledReason !== undefined}
        onValueChange={(kind) => {
          if (kind === "private" && props.mode === "app" && props.allowPrivate)
            props.onChange({ kind: "private" });
          else if (kind === "groups")
            props.onChange({ kind: "groups", groups: value.kind === "groups" ? value.groups : [] });
          else if (kind === "everyone") props.onChange({ kind: "everyone" });
        }}
      >
        <DisabledTooltip reason={props.disabledReason} className="w-full">
          <SelectTrigger id={id} onBlur={props.onBlur} className="w-full">
            <SelectValue />
          </SelectTrigger>
        </DisabledTooltip>
        <SelectContent>
          {props.mode === "app" && (
            <SelectItem value="private" disabled={!props.allowPrivate}>
              {props.privateLabel}
            </SelectItem>
          )}
          <SelectItem value="groups">Selected groups</SelectItem>
          <SelectItem value="everyone">Everyone in the organization</SelectItem>
        </SelectContent>
      </Select>
      {value.kind === "groups" && (
        <div className="max-h-64 overflow-y-auto rounded-lg border divide-y">
          {props.groups.map((group) => (
            <DisabledTooltip key={group.id} reason={props.disabledReason} className="w-full">
              <label className="flex items-center gap-3 p-3 text-sm cursor-pointer">
                <input
                  type="checkbox"
                  disabled={props.disabled || props.disabledReason !== undefined}
                  className="size-4 accent-foreground"
                  checked={value.groups.includes(group.id)}
                  onBlur={props.onBlur}
                  onChange={(event) =>
                    props.onChange({
                      kind: "groups",
                      groups: event.target.checked
                        ? [...value.groups, group.id]
                        : value.groups.filter((id) => id !== group.id),
                    })
                  }
                />
                {group.name}
              </label>
            </DisabledTooltip>
          ))}
          {value.groups
            .filter((id) => !props.groups.some((group) => group.id === id))
            .map((removed) => (
              <DisabledTooltip key={removed} reason={props.disabledReason} className="w-full">
                <label className="flex items-center gap-3 p-3 text-sm text-destructive">
                  <input
                    type="checkbox"
                    disabled={props.disabled || props.disabledReason !== undefined}
                    checked
                    onChange={() =>
                      props.onChange({
                        kind: "groups",
                        groups: value.groups.filter((id) => id !== removed),
                      })
                    }
                  />
                  Unavailable group
                </label>
              </DisabledTooltip>
            ))}
          {!props.groups.length && <GroupSetup />}
        </div>
      )}
      {props.error && (
        <p id={`${id}-error`} role="alert" className="text-sm font-medium text-destructive">
          {props.error}
        </p>
      )}
    </fieldset>
  );
}
function GroupSetup() {
  const { slug: organizationSlug, role } = useOrganizationRoute();
  const canCreate = role === "owner" || role === "admin";
  return (
    <EmptyState
      size="compact"
      className="px-3 md:px-3"
      title="No groups available"
      action={
        <Button
          asChild
          variant="outline"
          size="sm"
          disabledReason={
            canCreate ? undefined : "Only organization owners and admins can create groups."
          }
        >
          <Link
            to="/org/$organizationSlug/groups"
            params={{ organizationSlug }}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open Groups
          </Link>
        </Button>
      }
    >
      {canCreate
        ? "Create a group in a new tab, then return here to select it."
        : "Ask an organization admin to create a group for the people you want to share with."}
    </EmptyState>
  );
}
/** A failed save is visible at the form and focused without resetting the draft. */
export function SharingFailure({
  message,
  title = "Could not save access",
}: {
  readonly message: string;
  readonly title?: string;
}) {
  const alert = useRef<HTMLDivElement>(null);
  useEffect(() => {
    alert.current?.focus();
  }, [message]);
  return (
    <Alert
      ref={alert}
      tabIndex={-1}
      variant="destructive"
      className="border-destructive/50 bg-destructive/10 outline-none focus-visible:ring-2 focus-visible:ring-destructive"
    >
      <HugeiconsIcon icon={AlertCircleIcon} />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
type SharingProps = {
  readonly disabledReason?: string | undefined;
  readonly groups: readonly Group[];
  readonly revision: typeof AccessRevision.Type;
} & (
  | {
      readonly mode: "app";
      readonly value: typeof AppAudience.Type;
      readonly allowPrivate: boolean;
      readonly privateLabel: string;
      readonly save: (
        value: typeof AppAudience.Type,
        revision: typeof AccessRevision.Type,
      ) => Promise<Exit.Exit<{ readonly revision: typeof AccessRevision.Type }, HostedError>>;
    }
  | {
      readonly mode: "account";
      readonly value: typeof SharedAudience.Type;
      readonly save: (
        value: typeof SharedAudience.Type,
        revision: typeof AccessRevision.Type,
      ) => Promise<Exit.Exit<{ readonly revision: typeof AccessRevision.Type }, HostedError>>;
    }
);
/** The revision belongs to the edited draft, so a refresh cannot silently permit an overwrite. */
export function SharingEditor(props: SharingProps) {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const element = useRef<HTMLFormElement>(null);
  const focusInvalid = useRef(false);
  const form = useForm({
    defaultValues: { audience: props.value, revision: props.revision },
    onSubmitInvalid: () => {
      focusInvalid.current = true;
    },
    onSubmit: async ({ value, formApi }) => {
      if (props.disabledReason !== undefined) return;
      setError(undefined);
      setSaved(false);
      let result: Exit.Exit<{ readonly revision: typeof AccessRevision.Type }, HostedError>;
      if (value.audience.kind === "private") {
        if (props.mode !== "app" || !props.allowPrivate) {
          setError("Choose selected groups or everyone in the organization.");
          return;
        }
        result = await props.save(value.audience, value.revision);
      } else result = await props.save(value.audience, value.revision);
      if (Exit.isFailure(result)) setError(appError(result.cause));
      else {
        formApi.reset({ audience: value.audience, revision: result.value.revision });
        setSaved(true);
      }
    },
  });
  const pending = useStore(form.store, (state) => state.isSubmitting);
  const attempts = useStore(form.store, (state) => state.submissionAttempts);
  useEffect(() => {
    if (!pending && focusInvalid.current) {
      focusInvalid.current = false;
      element.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [pending, attempts]);
  return (
    <form
      ref={element}
      noValidate
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        await form.handleSubmit();
      }}
    >
      <form.Field
        name="audience"
        validators={{
          onChange: ({ value }) =>
            value.kind === "groups" && !value.groups.length
              ? "Choose at least one group."
              : undefined,
        }}
      >
        {(field) => {
          const common = {
            groups: props.groups,
            disabled: pending,
            disabledReason: props.disabledReason,
            onBlur: field.handleBlur,
            error: field.state.meta.isTouched
              ? field.state.meta.errors.filter((message) => typeof message === "string").join(" ")
              : undefined,
          };
          return props.mode === "app" ? (
            <AudienceInput
              {...common}
              mode="app"
              allowPrivate={props.allowPrivate}
              privateLabel={props.privateLabel}
              value={field.state.value}
              onChange={(value) => {
                field.handleChange(value);
                setSaved(false);
              }}
            />
          ) : field.state.value.kind !== "private" ? (
            <AudienceInput
              {...common}
              mode="account"
              value={field.state.value}
              onChange={(value) => {
                field.handleChange(value);
                setSaved(false);
              }}
            />
          ) : null;
        }}
      </form.Field>
      {error && <SharingFailure message={error} />}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" loading={pending} disabledReason={props.disabledReason}>
          Save access
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={pending}
          disabledReason={props.disabledReason}
          onClick={() => {
            form.reset({ audience: props.value, revision: props.revision });
            setError(undefined);
            setSaved(false);
          }}
        >
          Reset changes
        </Button>
        {saved && (
          <span role="status" className="text-sm text-muted-foreground">
            Saved
          </span>
        )}
      </div>
    </form>
  );
}
/** Read-only sharing copy does not imply management grants execution. */
export function SharingSummary({
  value,
  groups,
}: {
  readonly value: typeof AppAudience.Type;
  readonly groups: readonly Group[];
}) {
  return (
    <p className="text-sm text-muted-foreground">
      {value.kind === "everyone"
        ? "Everyone in the organization"
        : value.kind === "private"
          ? "Private to the app creator"
          : value.groups.length
            ? value.groups
                .map((id) => groups.find((group) => group.id === id)?.name ?? "Unavailable group")
                .join(", ")
            : "No groups have access."}
    </p>
  );
}
