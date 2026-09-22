import { ProfileStatus } from "@executor-js/ui/dashboard/profile-status";
import { profileMutations } from "../../contracts/profiles.ts";
import { HostedFailure } from "../components/dashboard-bindings.tsx";
import { useAtomSet } from "@effect/atom-react";
import { Json, type App, type Tool, type Profile, type ProfileId } from "@executor-js/sdk";
import { Exit, Schema } from "effect";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Code } from "@executor-js/ui/dashboard/code";
import { ToolBrowser } from "@executor-js/ui/dashboard/tools";
import { appToolReadiness, type AccountSummary } from "@executor-js/ui/contracts/dashboard";
import { Button } from "@executor-js/ui/components/button";
import { Textarea } from "@executor-js/ui/components/textarea";
import { appError, callToolAtom, toolListAtom } from "../../contracts/apps.ts";
import { useOrganizationRoute } from "../components/organization.tsx";

/** Discover and run tools using the selected profile's exact bindings and revision. */
export function AppTools({
  app,
  accounts,
  selected,
  profile,
}: {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly selected: string | undefined;
  readonly profile: Profile | undefined;
}) {
  const { organization, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  if (profile?.enabled === false || profile?.status === "removing")
    return (
      <p className="p-5 text-sm text-muted-foreground">
        This profile is disabled. Enable it from the profile menu to use its tools.
      </p>
    );
  const readiness = appToolReadiness(app, accounts);
  if (readiness.state === "not-deployed")
    return <p className="p-5 text-sm text-muted-foreground">Deploy this app to load its tools.</p>;
  if (readiness.state !== "ready")
    return (
      <p className="p-5 text-sm text-muted-foreground">
        Review the selected accounts in{" "}
        <Link
          to="/org/$organizationSlug/apps/$appId"
          params={{ organizationSlug, appId: app.id }}
          search={{ view: "accounts", profile: profile?.id }}
        >
          Accounts
        </Link>{" "}
        to load tools.
      </p>
    );
  return (
    <>
      {profile && (
        <ProfileStatus
          profile={profile}
          retry={profileMutations({ organization, app: app.id, profile: profile.id }).reconcile}
          Failure={HostedFailure}
        />
      )}
      <ToolBrowser
        key={`${app.id}:${app.activeDeployment}:${profile?.id}:${profile?.revision}:${JSON.stringify(app.accounts)}`}
        query={toolListAtom({
          organization,
          app: app.id,
          profile: profile?.id,
          expectedProfileRevision: profile?.revision,
          deployment: app.activeDeployment ?? undefined,
          accounts: JSON.stringify(app.accounts),
        })}
        Failure={HostedFailure}
        selected={selected}
        onSelect={(tool) => {
          void navigate({
            to: "/org/$organizationSlug/apps/$appId",
            params: { organizationSlug, appId: app.id },
            search: { view: "tools", tool, profile: profile?.id },
          });
        }}
        back={
          <Link
            className="text-xs text-muted-foreground"
            to="/org/$organizationSlug/apps/$appId"
            params={{ organizationSlug, appId: app.id }}
            search={{ view: "tools", profile: profile?.id }}
          >
            All tools
          </Link>
        }
        renderAction={(tool) => (
          <ToolRunner
            key={tool.name}
            app={app}
            tool={tool}
            profile={profile?.id}
            revision={profile?.revision}
          />
        )}
      />
    </>
  );
}
function ToolRunner({
  app,
  tool,
  profile,
  revision,
}: {
  readonly app: App;
  readonly tool: Tool;
  readonly profile?: ProfileId | undefined;
  readonly revision?: number | undefined;
}) {
  const { organization } = useOrganizationRoute();
  const call = useAtomSet(callToolAtom({ organization, app: app.id, profile, tool: tool.name }), {
    mode: "promiseExit",
  });
  const [input, setInput] = useState("{}");
  const [pending, setPending] = useState(false);
  const [output, setOutput] = useState<string>();
  const [error, setError] = useState<string>();
  return (
    <div className="tool-runner flex flex-col gap-4 mt-6 min-w-0 [&_pre]:whitespace-pre-wrap [&_pre]:wrap-anywhere [&_pre]:text-[11px] [&_pre]:bg-muted [&_pre]:p-[12px] [&_pre]:rounded-[6px]">
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setError(undefined);
          const parsed = Schema.decodeUnknownExit(Schema.fromJsonString(Json))(input);
          if (Exit.isFailure(parsed)) {
            setError("Enter valid JSON.");
            return;
          }
          setPending(true);
          setOutput(undefined);
          const result = await call({
            input: parsed.value,
            deployment: app.activeDeployment ?? undefined,
            expectedProfileRevision: revision,
          });
          setPending(false);
          if (Exit.isFailure(result)) setError(appError(result.cause));
          else setOutput(JSON.stringify(result.value, null, 2));
        }}
      >
        <label className="field-label flex flex-col gap-2.25 text-[13px] font-medium [&_[data-slot='select-trigger']]:w-full">
          Input
          <Textarea
            className="font-mono text-xs min-h-40"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            spellCheck={false}
            disabled={pending}
          />
        </label>
        <Button className="mt-3" disabled={pending}>
          {pending ? "Running…" : "Run tool"}
        </Button>
      </form>
      {error && (
        <p role="alert" className="auth-error text-destructive text-[13px]">
          {error}
        </p>
      )}
      {output !== undefined && (
        <section aria-label="Tool result">
          <Code code={output} copyable copyLabel="Copy result" />
        </section>
      )}
    </div>
  );
}
