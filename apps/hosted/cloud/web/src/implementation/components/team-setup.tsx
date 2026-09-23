import { useAtomRefresh, useAtomSet, useAtomValue, useAtomMount } from "@effect/atom-react";
import { sessionAtom } from "@executor-js/hosted-web/contracts/auth";
import { OrganizationEntry } from "@executor-js/hosted-web/organization";
import { SetupPageFrame } from "@executor-js/hosted-web/pages/agent-setup";
import { organizationsAtom } from "@executor-js/hosted-web/contracts/organization";
import { HostedEntry, HostedEntryLoading } from "@executor-js/hosted-web/entry";
import { McpConsentLoading } from "@executor-js/ui/dashboard/mcp-consent";
import { IconPicker } from "@executor-js/hosted-web/icon-picker";
import {
  selectOrganizationIconAtom,
  OrganizationIconSelectionFailed,
  type SelectedOrganizationIcon,
} from "@executor-js/hosted-web/contracts/organization-icon";
import { Button } from "@executor-js/ui/components/button";
import { Input } from "@executor-js/ui/components/input";
import { Link, Navigate, useLocation } from "@tanstack/react-router";
import { Cause, Exit, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useEffect, useState, type ReactNode } from "react";
import { reportBrowserUsage } from "@executor-js/hosted-web/contracts/product-analytics";
import {
  OnboardingDraft,
  OnboardingInvitation,
  type TeamDetails,
} from "../../../../src/contracts/onboarding.ts";
import { prepareTeamAtom, createTeamAtom } from "../../contracts/onboarding.ts";

/** Confirm first-team details at entry; exact invitation and organization links remain intact. */
export function TeamSetupBoundary({ children }: { readonly children: ReactNode }) {
  const session = Option.getOrUndefined(AsyncResult.value(useAtomValue(sessionAtom)));
  const { pathname } = useLocation();
  if (
    session === undefined ||
    session === null ||
    (pathname !== "/" && pathname !== "/mcp/authorize")
  )
    return children;
  return (
    <OrganizationEntryGate
      key={session.user.id}
      userId={session.user.id}
      destination={pathname === "/mcp/authorize" ? "mcp" : "entry"}
    >
      {children}
    </OrganizationEntryGate>
  );
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
    .onInitial(() => (destination === "mcp" ? <McpConsentLoading /> : <HostedEntryLoading />))
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
      <SetupPageFrame>
        <div className="flex min-h-[200px] flex-col items-center justify-center gap-4">
          <p role="alert">Unable to open your workspace. Try again.</p>
          <Button onClick={retry}>Try again</Button>
        </div>
      </SetupPageFrame>
    );
  const entry = AsyncResult.isSuccess(created) ? created.value : prepared.value;
  if (Schema.is(OnboardingInvitation)(entry)) {
    if (mcp)
      return (
        <SetupPageFrame>
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
        </SetupPageFrame>
      );
    return <Navigate to="/invite" search={{ invitation: entry.invitation }} replace />;
  }
  if (Schema.is(OnboardingDraft)(entry))
    return <TeamForm userId={userId} suggestion={entry.suggestion} />;
  // The confirmed entry can publish before the mutation settles; both states go to agent setup.
  if (!mcp && (created.waiting || AsyncResult.isSuccess(created)))
    return <Navigate to="/create/agent" replace />;
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
  return (
    <SetupPageFrame>
      <section
        className="w-full max-w-[560px] rounded-2xl border bg-card p-10 max-[600px]:p-6"
        aria-labelledby="team-setup-title"
      >
        <header className="mb-5 flex items-center gap-3.5 [&_h1]:text-2xl [&_h1]:font-medium [&_h1]:tracking-[-0.04em]">
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
          <h1 id="team-setup-title">Create your team</h1>
        </header>
        <p className="mb-8 text-sm leading-6 text-muted-foreground">
          You use Executor through your AI agent. Connect your agent over MCP to build apps and use
          your tools. Your team keeps your apps, accounts, and access together.
        </p>
        <form
          className="flex flex-col gap-2.5 [&_label]:text-sm [&_label]:text-muted-foreground [&_input]:h-12 [&_input]:px-3.5 [&_input]:text-base"
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
            const result = await create({ name: name.trim(), logo: icon.logo });
            reportBrowserUsage({
              area: "onboarding",
              action: "create_team",
              outcome: Exit.isSuccess(result) ? "success" : "failure",
            });
            if (Exit.isFailure(result)) setError("Unable to create your team. Try again.");
          }}
        >
          <label htmlFor="team-name">Team name</label>
          <Input
            id="team-name"
            name="name"
            defaultValue={suggestion.name}
            required
            maxLength={120}
            autoComplete="organization"
            autoFocus
            disabled={pending}
          />
          <span className="sr-only" role="status">
            {selection.waiting ? "Reading icon" : icon.kind === "file" ? "Icon selected" : ""}
          </span>
          {error && (
            <p className="auth-error text-[13px] text-destructive" role="alert">
              {error}
            </p>
          )}
          <Button className="mt-[30px] min-h-12 w-full text-base" type="submit" loading={pending}>
            Continue
          </Button>
        </form>
      </section>
    </SetupPageFrame>
  );
}
