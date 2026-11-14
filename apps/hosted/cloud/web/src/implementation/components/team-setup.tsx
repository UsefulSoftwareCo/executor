import { useAtomRefresh, useAtomSet, useAtomValue, useAtomMount } from "@effect/atom-react";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { OrganizationEntry } from "@executor-js/hosted-web/organization";
import { SetupActions, SetupLede, SetupPage, SetupTitle } from "@executor-js/hosted-web/setup-page";
import {
  SetupRedirect,
  SetupSequenceProvider,
  firstSetupStep,
  useSetupSequence,
} from "@executor-js/hosted-web/setup-sequence";
import { useOrganizationRoute } from "@executor-js/hosted-web/organization";
import { organizationsAtom } from "@executor-js/hosted-web/contracts/organization";
import { HostedEntry, HostedEntryLoading } from "@executor-js/hosted-web/entry";
import { UnknownPagePending } from "@executor-js/hosted-web/page-pending";
import { McpConsentLoading } from "@executor-js/ui/dashboard/mcp-consent";
import { IconPicker } from "@executor-js/hosted-web/icon-picker";
import { OrganizationFormError } from "@executor-js/hosted-web/organization-form";
import {
  selectOrganizationIconAtom,
  OrganizationIconSelectionFailed,
  type SelectedOrganizationIcon,
} from "@executor-js/hosted-web/contracts/organization-icon";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { ArrowRight02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
// oxlint-disable-next-line no-restricted-imports -- OrganizationEntryGate renders it only at /, which its navigation leaves; TeamEntry reads atoms, not the location
import { Link, Navigate, useLocation } from "@tanstack/react-router";
import { Cause, Exit, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useId, useState, type ReactNode } from "react";
import { reportBrowserUsage } from "@executor-js/hosted-web/contracts/product-analytics";
import {
  OnboardingDraft,
  OnboardingInvitation,
  OnboardingTeamCreated,
  type TeamDetails,
} from "../../../../src/contracts/onboarding.ts";
import { prepareTeamAtom, createTeamAtom, setupSequenceAtom } from "../../contracts/onboarding.ts";

/** Confirm first-team details at entry; exact invitation and organization links remain intact. */
export function TeamSetupBoundary({ children }: { readonly children: ReactNode }) {
  const session = Option.getOrUndefined(AsyncResult.value(useAtomValue(sessionAtom)));
  const { pathname } = useLocation();
  // Approving a client, by consent or by a device's code, can create the first team on the way.
  const approval = pathname === "/mcp/authorize" || pathname === "/device";
  if (session === undefined || session === null || (pathname !== "/" && !approval)) return children;
  return (
    <OrganizationEntryGate
      key={session.user.id}
      userId={session.user.id}
      destination={approval ? "mcp" : "entry"}
    >
      {children}
    </OrganizationEntryGate>
  );
}

/**
 * What the entry gate shows while it reads memberships. On the server that read suspends the root,
 * so the root shows this too; no other page waits there, so any other page stays blank.
 */
export function TeamSetupPending() {
  const { pathname } = useLocation();
  if (pathname === "/mcp/authorize") return <McpConsentLoading />;
  if (pathname === "/") return <HostedEntryLoading />;
  return <UnknownPagePending fullScreen />;
}

/** The dedicated setup route owns its membership check, form, and completion navigation. */
export function CreateTeamPage() {
  // Keep the supplied membership snapshot available for the confirmed-write handoff.
  useAtomMount(organizationsAtom);
  const session = Option.getOrUndefined(AsyncResult.value(useAtomValue(sessionAtom)));
  if (session === undefined || session === null) return <HostedEntryLoading />;
  return (
    <TeamEntry key={session.user.id} userId={session.user.id} mcp={false}>
      <OrganizationEntry />
    </TeamEntry>
  );
}

function OrganizationEntryGate({
  userId,
  destination,
  children,
}: {
  readonly userId: string;
  readonly destination: "entry" | "mcp";
  readonly children: ReactNode;
}) {
  const organizations = useAtomValue(organizationsAtom);
  const refresh = useAtomRefresh(organizationsAtom);
  return AsyncResult.builder(organizations)
    .onInitial(() => <TeamSetupPending />)
    .onFailure(() => (
      <HostedEntry title="Unable to load your organizations" description="Try again to continue.">
        <Button onClick={refresh}>Try again</Button>
      </HostedEntry>
    ))
    .onSuccess((items) =>
      items.length > 0 ? (
        children
      ) : destination === "mcp" ? (
        <TeamEntry userId={userId} mcp>
          {children}
        </TeamEntry>
      ) : (
        <Navigate to="/create" replace />
      ),
    )
    .exhaustive();
}

function TeamEntry({
  userId,
  mcp,
  children,
}: {
  readonly userId: string;
  readonly mcp: boolean;
  readonly children: ReactNode;
}) {
  const prepared = useAtomValue(prepareTeamAtom(userId));
  const created = useAtomValue(createTeamAtom(userId));
  const refresh = useAtomRefresh(prepareTeamAtom(userId));
  const reset = useAtomSet(createTeamAtom(userId));
  const step = AsyncResult.isInitial(prepared)
    ? "preparing"
    : AsyncResult.isFailure(prepared)
      ? "prepare_failed"
      : Schema.is(OnboardingInvitation)(prepared.value)
        ? "invitation"
        : Schema.is(OnboardingDraft)(prepared.value)
          ? "team_details"
          : "ready";
  useEffect(() => {
    reportBrowserUsage({ area: "onboarding", action: step, outcome: "viewed" });
  }, [step]);
  const retry = () => {
    reportBrowserUsage({ area: "onboarding", action: "retry", outcome: "started" });
    reset(Atom.Reset);
    refresh();
  };
  if (AsyncResult.isInitial(prepared))
    return (
      <HostedEntryLoading
        title="Preparing your team"
        description="Getting your team details ready…"
        label="Preparing your team"
      />
    );
  if (AsyncResult.isFailure(prepared))
    return (
      <SetupPage>
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-4">
          <p role="alert">Unable to open your workspace. Try again.</p>
          <Button onClick={retry}>Try again</Button>
        </div>
      </SetupPage>
    );
  const entry = AsyncResult.isSuccess(created) ? created.value : prepared.value;
  if (Schema.is(OnboardingInvitation)(entry)) {
    if (mcp)
      return (
        <SetupPage>
          <div className="flex min-h-[200px] flex-col items-center justify-center gap-4">
            <p>Accept your invitation, then return here to connect.</p>
            <Button asChild>
              <Link to="/invite" search={{ invitation: entry.invitation }} target="_blank">
                Open invitation
              </Link>
            </Button>
            <Button variant="ghost" onClick={retry}>
              Continue
            </Button>
          </div>
        </SetupPage>
      );
    return <Navigate to="/invite" search={{ invitation: entry.invitation }} replace />;
  }
  if (Schema.is(OnboardingDraft)(entry))
    return <TeamForm userId={userId} suggestion={entry.suggestion} />;
  // The confirmed entry can publish before the mutation settles; both states open the new team's
  // setup. A confirmation that found other memberships instead leaves the choice to the entry.
  const team = entry.organizations.length === 1 ? entry.organizations[0] : undefined;
  if (!mcp && team !== undefined && (created.waiting || AsyncResult.isSuccess(created))) {
    // A confirmation that carried the team's setup order opens its first step directly.
    const setup = Schema.is(OnboardingTeamCreated)(entry) ? entry.setup : undefined;
    const first = setup === undefined ? undefined : firstSetupStep(setup);
    return (
      <Navigate
        to={
          first === "accounts"
            ? "/org/$organizationSlug/setup/accounts"
            : first === "assistant"
              ? "/org/$organizationSlug/setup/assistant"
              : "/org/$organizationSlug/setup"
        }
        params={{ organizationSlug: team.slug }}
        replace
      />
    );
  }
  return children;
}

function TeamForm({
  userId,
  suggestion,
}: {
  readonly userId: string;
  readonly suggestion: TeamDetails;
}) {
  const create = useAtomSet(createTeamAtom(userId), { mode: "promiseExit" });
  const state = useAtomValue(createTeamAtom(userId));
  const [icon, setIcon] = useState<
    SelectedOrganizationIcon | { readonly kind: "url"; readonly logo: string | null }
  >({ kind: "url", logo: suggestion.logo });
  const selectIcon = useAtomSet(selectOrganizationIconAtom(`signup:${userId}`), {
    mode: "promiseExit",
  });
  const selection = useAtomValue(selectOrganizationIconAtom(`signup:${userId}`));
  const pending = state.waiting || selection.waiting;
  const [error, setError] = useState<string | null>(null);
  const form = useId();
  const field = useId();
  return (
    <SetupPage>
      <section aria-labelledby="team-setup-title">
        <SetupTitle id="team-setup-title">Create your team</SetupTitle>
        <SetupLede>Your team keeps your apps, accounts and access together.</SetupLede>
        <form
          id={form}
          className="mt-7 flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            if (pending) return;
            reportBrowserUsage({ area: "onboarding", action: "create_team", outcome: "started" });
            setError(null);
            const name = new FormData(event.currentTarget).get("name");
            if (typeof name !== "string" || !name.trim()) {
              setError("Enter a team name.");
              reportBrowserUsage({
                area: "onboarding",
                action: "team_name_validation",
                outcome: "failure",
              });
              return;
            }
            const result = await create({ name: name.trim(), logo: icon.logo, next: "setup" });
            reportBrowserUsage({
              area: "onboarding",
              action: "create_team",
              outcome: Exit.isSuccess(result) ? "success" : "failure",
            });
            if (Exit.isFailure(result)) setError("Unable to create your team. Try again.");
          }}
        >
          <label htmlFor={field} className="text-sm text-muted-foreground">
            Team name
          </label>
          <div className="flex items-center gap-2.5">
            <IconPicker
              name={suggestion.name}
              preview={icon.kind === "file" ? icon.preview : icon.logo}
              label="Upload team icon"
              disabled={pending}
              onRemove={() => setIcon({ kind: "url", logo: null })}
              onSelect={async (file) => {
                setError(null);
                const result = await selectIcon(file);
                if (Exit.isSuccess(result)) setIcon(result.value);
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
            <Input
              id={field}
              name="name"
              defaultValue={suggestion.name}
              required
              maxLength={120}
              autoComplete="organization"
              autoFocus
              disabled={pending}
              className="h-11 min-w-0 flex-1 px-3.5 text-base"
            />
          </div>
          <span className="sr-only" role="status">
            {selection.waiting ? "Reading icon" : icon.kind === "file" ? "Icon selected" : ""}
          </span>
          <OrganizationFormError>{error}</OrganizationFormError>
        </form>
      </section>
      <SetupActions>
        <Button type="submit" form={form} loading={pending}>
          Continue
          <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} aria-hidden />
        </Button>
      </SetupActions>
    </SetupPage>
  );
}

/**
 * The team's setup steps in the order its setup sequence names. They render only once the order
 * is known, which the setup document reads with the page, so no step shows in the wrong place.
 */
export function CloudSetupSequence({ children }: { readonly children: ReactNode }) {
  const { organization } = useOrganizationRoute();
  const sequence = useAtomValue(setupSequenceAtom(organization));
  const retry = useAtomRefresh(setupSequenceAtom(organization));
  return AsyncResult.builder(sequence)
    .onInitial(() => <SetupPage />)
    .onFailure(() => (
      <SetupPage>
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-4">
          <p role="alert">Unable to open your team's setup. Try again.</p>
          <Button onClick={retry} loading={sequence.waiting}>
            Try again
          </Button>
        </div>
      </SetupPage>
    ))
    .onSuccess((value) => <SetupSequenceProvider value={value}>{children}</SetupSequenceProvider>)
    .exhaustive();
}

/** A new team's setup starts at the first step of its sequence, replacing this entry. */
export function SetupStart() {
  return (
    <>
      <SetupPage />
      <SetupRedirect to={useSetupSequence().first} />
    </>
  );
}
