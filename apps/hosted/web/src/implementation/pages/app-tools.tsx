import { HostedFailure, useDashboardAtoms } from "../components/dashboard-bindings.tsx";
import { useAtomSet } from "@effect/atom-react";
import { Json, type App, type Tool } from "@executor-js/sdk";
import { Exit, Schema } from "effect";
import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Code } from "@executor-js/ui/dashboard/code";
import { ToolBrowser } from "@executor-js/ui/dashboard/tools";
import { appToolReadiness, type AccountSummary } from "@executor-js/ui/contracts/dashboard";
import { Button } from "@executor-js/ui/components/button";
import { Textarea } from "@executor-js/ui/components/textarea";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon } from "@hugeicons/core-free-icons";
import { appError, callToolAtom } from "../../contracts/apps.ts";
import { AppAccounts } from "./app-accounts.tsx";
import { useOrganizationRoute } from "../components/organization.tsx";

/** Tool execution is a hosted action slot; the browser and schema view are shared with local. */
export function AppTools({
  app,
  accounts,
  selected,
  redirectUri,
}: {
  readonly app: App;
  readonly accounts: readonly AccountSummary[];
  readonly selected: string | undefined;
  readonly redirectUri: string;
}) {
  const atoms = useDashboardAtoms();
  const { role, slug: organizationSlug } = useOrganizationRoute();
  const navigate = useNavigate();
  if (appToolReadiness(app, accounts).state !== "ready")
    return <AppAccounts app={app} accounts={accounts} redirectUri={redirectUri} />;
  return (
    <ToolBrowser
      Failure={HostedFailure}
      key={app.id}
      query={atoms.tools(app.id)}
      selected={selected}
      onSelect={(tool) => {
        void navigate({
          to: "/org/$organizationSlug/apps/$appId",
          params: { organizationSlug, appId: app.id },
          search: { view: "tools", tool },
        });
      }}
      back={
        <Link
          className="inline-flex min-h-11 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          to="/org/$organizationSlug/apps/$appId"
          params={{ organizationSlug, appId: app.id }}
          search={{ view: "tools" }}
        >
          <HugeiconsIcon icon={ArrowLeft02Icon} size={16} />
          All tools
        </Link>
      }
      {...(role === "owner" || role === "admin"
        ? {
            renderAction: (tool: Tool) => (
              <ToolRunner key={`${app.id}:${tool.name}`} app={app} tool={tool} />
            ),
          }
        : {})}
    />
  );
}
function ToolRunner({ app, tool }: { readonly app: App; readonly tool: Tool }) {
  const { organization } = useOrganizationRoute();
  const call = useAtomSet(callToolAtom, { mode: "promiseExit" });
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
            params: { organization, app: app.id },
            payload: { tool: tool.name, input: parsed.value },
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
