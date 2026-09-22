import { PageFrame, PageHeader } from "@executor-js/ui/dashboard/page";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Cause, Exit } from "effect";
import { useState, type ReactNode } from "react";
import { IconPicker } from "../components/icon-picker.tsx";
import {
  selectOrganizationIconAtom,
  OrganizationIconSelectionFailed,
  type SelectedOrganizationIcon,
} from "../../contracts/organization-icon.ts";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@executor-js/ui/components/card";
import {
  changeOrganizationSlugAtom,
  renameOrganizationAtom,
  changeOrganizationLogoAtom,
} from "../../contracts/organization.ts";
import {
  organizationError,
  useOrganization,
  OrganizationDetailsBoundary,
} from "../components/organization.tsx";
import { OrganizationMembers } from "../components/organization-members.tsx";
import { productTitle, useDocumentTitle } from "@executor-js/ui/hooks/document-title";
import { organizationSlugMaxLength } from "@executor-js/hosted-server/organization";

/** Hosts may compose extra admin settings and a footer below the members list. */
export function OrganizationPage({
  emailInvitations = false,
  children,
  footer,
}: {
  readonly emailInvitations?: boolean;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
}) {
  return (
    <OrganizationDetailsBoundary>
      <OrganizationSettings emailInvitations={emailInvitations} footer={footer}>
        {children}
      </OrganizationSettings>
    </OrganizationDetailsBoundary>
  );
}
function OrganizationSettings({
  emailInvitations,
  children,
  footer,
}: {
  readonly emailInvitations: boolean;
  readonly children?: ReactNode;
  readonly footer?: ReactNode;
}) {
  const organization = useOrganization();
  const renaming = useAtomValue(renameOrganizationAtom(organization.organization));
  const changingSlug = useAtomValue(changeOrganizationSlugAtom(organization.organization));
  const changingLogo = useAtomValue(changeOrganizationLogoAtom(organization.organization));
  const pending =
    organization.checking || renaming.waiting || changingSlug.waiting || changingLogo.waiting;
  useDocumentTitle(productTitle(`${organization.name} settings`));
  return (
    <PageFrame>
      <PageHeader title={organization.name} />
      <div className="organization-settings flex flex-col gap-3">
        <OrganizationName disabled={pending} />
        <OrganizationIcon disabled={pending} />
        <OrganizationUrl disabled={pending} />
        {children}
      </div>
      <OrganizationMembers emailInvitations={emailInvitations} />
      {footer && <div className="mt-6">{footer}</div>}
    </PageFrame>
  );
}

function OrganizationIcon({ disabled }: { readonly disabled: boolean }) {
  const organization = useOrganization();
  const disabledReason =
    organization.role === "member"
      ? "Only organization owners and admins can change organization settings."
      : undefined;
  const save = useAtomSet(changeOrganizationLogoAtom(organization.organization), {
    mode: "promiseExit",
  });
  const state = useAtomValue(changeOrganizationLogoAtom(organization.organization));
  const select = useAtomSet(selectOrganizationIconAtom(`settings:${organization.organization}`), {
    mode: "promiseExit",
  });
  const selection = useAtomValue(
    selectOrganizationIconAtom(`settings:${organization.organization}`),
  );
  const [draft, setDraft] = useState<
    SelectedOrganizationIcon | { readonly kind: "removed"; readonly logo: null }
  >();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const pending = disabled || selection.waiting || disabledReason !== undefined;
  const preview =
    draft === undefined
      ? (organization.logo ?? null)
      : draft.kind === "removed"
        ? null
        : draft.preview;
  return (
    <Card asChild className="organization-setting gap-0 py-0">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (pending || draft === undefined) return;
          setError(undefined);
          setSaved(false);
          const result = await save(draft.logo);
          if (Exit.isFailure(result)) setError(organizationError(result.cause));
          else {
            setDraft(undefined);
            setSaved(true);
          }
        }}
      >
        <CardHeader className="gap-1.5 px-4 pt-4 pb-3">
          <CardTitle>
            <h2>Organization icon</h2>
          </CardTitle>
          <CardDescription>Shown in the organization menu.</CardDescription>
        </CardHeader>
        <CardContent className="px-4 pb-4">
          <IconPicker
            name={organization.name}
            preview={preview}
            label="Upload organization icon"
            disabledReason={disabledReason}
            disabled={pending}
            onRemove={() => {
              setDraft({ kind: "removed", logo: null });
              setError(undefined);
              setSaved(false);
            }}
            onSelect={async (file) => {
              setError(undefined);
              setSaved(false);
              const result = await select(file);
              if (Exit.isSuccess(result)) setDraft(result.value);
              else {
                const failure = Cause.squash(result.cause);
                setError(
                  failure instanceof OrganizationIconSelectionFailed
                    ? failure.message
                    : "This image could not be read. Choose another file.",
                );
              }
            }}
          />
          {(selection.waiting || draft?.kind === "file") && (
            <span role="status" className="sr-only">
              {selection.waiting ? "Reading icon" : "Icon selected"}
            </span>
          )}
          {error && (
            <p role="alert" className="mt-3 text-[13px] text-destructive">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
          <p>PNG, JPG, or WebP · up to 2 MB</p>
          <div className="flex items-center gap-3">
            {saved && <span role="status">Saved</span>}
            <Button
              variant="outline"
              loading={state.waiting}
              disabled={pending || draft === undefined}
              disabledReason={disabledReason}
            >
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

function OrganizationName({ disabled }: { readonly disabled: boolean }) {
  const organization = useOrganization();
  const disabledReason =
    organization.role === "member"
      ? "Only organization owners and admins can change organization settings."
      : undefined;
  const rename = useAtomSet(renameOrganizationAtom(organization.organization), {
    mode: "promiseExit",
  });
  const state = useAtomValue(renameOrganizationAtom(organization.organization));
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const name = draft ?? organization.name;
  return (
    <Card
      asChild
      className="organization-setting border border-border rounded-[10px] bg-background shadow-none flex flex-col gap-0 p-0 [&_[data-slot='card-header']]:gap-1 [&_[data-slot='card-header']]:[padding:14px_16px_10px] [&_[data-slot='card-title']_h2]:text-[14px] [&_[data-slot='card-title']_h2]:leading-[1.4] [&_[data-slot='card-title']_h2]:font-medium [&_[data-slot='card-description']]:text-[12px] [&_[data-slot='card-description']]:leading-[1.5] [&_[data-slot='card-content']]:min-w-0 [&_[data-slot='card-content']]:[padding:0_16px_10px] [&_[data-slot='card-footer']]:justify-between [&_[data-slot='card-footer']]:gap-3 [&_[data-slot='card-footer']]:[padding:0_16px_12px] [&_[data-slot='card-footer']]:border-0 [&_[data-slot='card-footer']_>_p]:text-muted-foreground [&_[data-slot='card-footer']_>_p]:text-[11px] max-[640px]:[&_[data-slot='card-header']]:[padding:12px_12px_10px] max-[640px]:[&_[data-slot='card-content']]:[padding:0_12px_12px] max-[640px]:[&_[data-slot='card-footer']]:[padding:0_12px_10px]"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || disabledReason !== undefined) return;
          setError(undefined);
          setSaved(false);
          const result = await rename(name.trim());
          if (Exit.isFailure(result)) setError(organizationError(result.cause));
          else {
            setDraft(undefined);
            setSaved(true);
          }
        }}
      >
        <CardHeader>
          <CardTitle>
            <h2>Organization name</h2>
          </CardTitle>
          <CardDescription>Shown across Executor.</CardDescription>
        </CardHeader>
        <CardContent>
          <Input
            aria-label="Organization name"
            aria-describedby="organization-name-hint"
            className="organization-name-input w-[min(100%,_520px)] h-9 rounded-[6px] bg-transparent shadow-none max-[640px]:h-10 max-[640px]:text-[16px]"
            value={name}
            onChange={(event) => {
              setDraft(event.target.value);
              setSaved(false);
              setError(undefined);
            }}
            required
            pattern=".*\S.*"
            maxLength={120}
            disabled={disabled}
            disabledReason={disabledReason}
          />
          {error && (
            <p role="alert" className="auth-error mt-3 text-destructive text-[13px]">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <p id="organization-name-hint">Up to 120 characters</p>
          <div className="organization-setting-action flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10">
            {saved && <span role="status">Saved</span>}
            <Button
              variant="outline"
              loading={state.waiting}
              disabled={disabled || !name.trim() || name.trim() === organization.name}
              disabledReason={disabledReason}
            >
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}

function OrganizationUrl({ disabled }: { readonly disabled: boolean }) {
  const organization = useOrganization();
  const disabledReason =
    organization.role === "member"
      ? "Only organization owners and admins can change organization settings."
      : undefined;
  const changeSlug = useAtomSet(changeOrganizationSlugAtom(organization.organization), {
    mode: "promiseExit",
  });
  const state = useAtomValue(changeOrganizationSlugAtom(organization.organization));
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const slug = draft ?? organization.slug;
  return (
    <Card
      asChild
      className="organization-setting border border-border rounded-[10px] bg-background shadow-none flex flex-col gap-0 p-0 [&_[data-slot='card-header']]:gap-1 [&_[data-slot='card-header']]:[padding:14px_16px_10px] [&_[data-slot='card-title']_h2]:text-[14px] [&_[data-slot='card-title']_h2]:leading-[1.4] [&_[data-slot='card-title']_h2]:font-medium [&_[data-slot='card-description']]:text-[12px] [&_[data-slot='card-description']]:leading-[1.5] [&_[data-slot='card-content']]:min-w-0 [&_[data-slot='card-content']]:[padding:0_16px_10px] [&_[data-slot='card-footer']]:justify-between [&_[data-slot='card-footer']]:gap-3 [&_[data-slot='card-footer']]:[padding:0_16px_12px] [&_[data-slot='card-footer']]:border-0 [&_[data-slot='card-footer']_>_p]:text-muted-foreground [&_[data-slot='card-footer']_>_p]:text-[11px] max-[640px]:[&_[data-slot='card-header']]:[padding:12px_12px_10px] max-[640px]:[&_[data-slot='card-content']]:[padding:0_12px_12px] max-[640px]:[&_[data-slot='card-footer']]:[padding:0_12px_10px]"
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (disabled || disabledReason !== undefined) return;
          setError(undefined);
          setSaved(false);
          const result = await changeSlug(slug);
          if (Exit.isFailure(result)) setError(organizationError(result.cause));
          else {
            setDraft(undefined);
            setSaved(true);
          }
        }}
      >
        <CardHeader>
          <CardTitle>
            <h2>Organization URL</h2>
          </CardTitle>
          <CardDescription>Changing this replaces your organization’s URL.</CardDescription>
        </CardHeader>
        <CardContent>
          <label className="organization-url-input flex w-[min(100%,_520px)] min-w-0 items-center border border-input rounded-[6px] bg-transparent overflow-hidden focus-within:border-ring focus-within:[outline:2px_solid_var(--ring)] focus-within:outline-offset-[2px] [&_input]:h-8.5 [&_input]:border-0 [&_input]:rounded-none [&_input]:bg-transparent [&_input]:shadow-none [&_input]:[outline:none] [&_input:focus-visible]:[outline:none] [&_input:focus-visible]:shadow-none max-[640px]:[&_input]:h-9.5 max-[640px]:[&_input]:text-[16px]">
            <span
              className="organization-url-prefix shrink-0 max-w-[50%] py-[7px] px-[10px] border-r border-r-input text-muted-foreground text-[12px] overflow-hidden text-ellipsis whitespace-nowrap"
              aria-hidden
            >
              {window.location.host}/org/
            </span>
            <Input
              aria-label="Organization URL"
              aria-describedby="organization-slug-hint"
              value={slug}
              onChange={(event) => {
                setDraft(event.target.value);
                setSaved(false);
                setError(undefined);
              }}
              required
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              maxLength={organizationSlugMaxLength}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={disabled}
              disabledReason={disabledReason}
            />
          </label>
          {error && (
            <p role="alert" className="auth-error mt-3 text-destructive text-[13px]">
              {error}
            </p>
          )}
        </CardContent>
        <CardFooter>
          <p id="organization-slug-hint">
            Lowercase letters, numbers, hyphens · {organizationSlugMaxLength} characters max
          </p>
          <div className="organization-setting-action flex items-center gap-2.5 text-[12px] [&_>_button]:h-7.5 [&_>_button]:py-0 [&_>_button]:px-[12px] [&_>_button]:text-[12px] [&_>_button]:bg-transparent [&_>_button]:shadow-none max-[640px]:[&_>_button]:min-h-10">
            {saved && <span role="status">Saved</span>}
            <Button
              variant="outline"
              loading={state.waiting}
              disabled={disabled || slug === organization.slug}
              disabledReason={disabledReason}
            >
              Save
            </Button>
          </div>
        </CardFooter>
      </form>
    </Card>
  );
}
