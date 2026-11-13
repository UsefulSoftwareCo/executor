import { usePageUrl } from "@executor-js/dashboard-start/page";
import { EmptyState } from "@executor-js/ui/dashboard/empty-state";
import { reportBrowserUsage } from "../../contracts/product-analytics.ts";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Cause, Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { grantTarget, type GrantTarget } from "@executor-js/mcp-auth/grants";
import {
  McpConsentActions,
  McpConsentDestination,
  McpConsentLayout,
  McpConsentLoading,
  McpConsentSummary,
  consentDestination,
} from "@executor-js/ui/dashboard/mcp-consent";
import { McpConnectionFailed, mcpClientAtom, mcpConsentAtom } from "../../contracts/mcp.ts";
import { organizationsAtom, type OrganizationSummary } from "../../contracts/organization.ts";
import { useResourceOrigins } from "../resource-origin.ts";
import { useGrantChoices } from "../components/grant-choices.tsx";

/**
 * The person approves the request, choosing its organization, which apps it reaches and where
 * approvals are answered. The request's resource preselects the last two. It may name a resource
 * at any of the deployment's resource origins.
 */
export function McpAuthorizePage() {
  const page = usePageUrl();
  const resourceOrigins = useResourceOrigins();
  // Keep the signed query intact; repeated OAuth fields must not be reserialized by the router.
  const query = page.search.slice(1),
    params = new URLSearchParams(query);
  const clientId = params.get("client_id") ?? "";
  const target = grantTarget(resourceOrigins, params.getAll("resource"));
  const client = useAtomValue(mcpClientAtom(clientId));
  const organizations = useAtomValue(organizationsAtom);
  if (
    clientId === "" ||
    target === undefined ||
    AsyncResult.isFailure(client) ||
    AsyncResult.isFailure(organizations)
  )
    return (
      <McpConsentLayout description="This connection request could not be loaded.">
        <p role="alert">Start again from your MCP client.</p>
      </McpConsentLayout>
    );
  if (!AsyncResult.isSuccess(client) || !AsyncResult.isSuccess(organizations))
    return <McpConsentLoading />;
  return (
    <McpConsent
      query={query}
      target={target}
      client={client.value.client_name ?? "An application"}
      destination={consentDestination(params.get("redirect_uri"))}
      organizations={organizations.value}
    />
  );
}

function McpConsent({
  query,
  target,
  client,
  destination,
  organizations,
}: {
  readonly query: string;
  readonly target: GrantTarget;
  readonly client: string;
  readonly destination: string | undefined;
  readonly organizations: readonly OrganizationSummary[];
}) {
  const consent = useAtomSet(mcpConsentAtom, { mode: "promiseExit" });
  const state = useAtomValue(mcpConsentAtom);
  const [error, setError] = useState<string | null>(null);
  const choices = useGrantChoices({ target, organizations, disabled: state.waiting });
  const decide = async (accept: boolean) => {
    const action = accept ? "approve_connection" : "decline_connection";
    reportBrowserUsage({ area: "mcp", action, outcome: "started" });
    setError(null);
    const result = await consent({ accept, ...choices.decision, query });
    reportBrowserUsage({
      area: "mcp",
      action,
      outcome: Exit.isSuccess(result) ? "success" : "failure",
    });
    if (Exit.isFailure(result)) {
      const failure = Cause.squash(result.cause);
      setError(
        failure instanceof McpConnectionFailed
          ? failure.message
          : "Unable to complete this connection. Try again.",
      );
      return false;
    }
    window.location.assign(result.value.url);
    return true;
  };
  return (
    <McpConsentLayout
      description={
        <p>
          <strong>{client}</strong> wants to connect to Executor.
        </p>
      }
    >
      {organizations.length === 0 ? (
        <EmptyState size="compact" title="No organizations">
          Ask an organization admin for an invitation, then return here to connect.
        </EmptyState>
      ) : (
        <McpConsentSummary
          note={
            destination === undefined ? undefined : <McpConsentDestination origin={destination} />
          }
        >
          {choices.rows}
        </McpConsentSummary>
      )}
      {error && (
        <p role="alert" className="auth-error text-destructive text-[13px]">
          {error}
        </p>
      )}
      <McpConsentActions
        onDecline={() => decide(false)}
        onConnect={organizations.length > 0 ? () => decide(true) : undefined}
        connectDisabled={!choices.ready}
        waiting={state.waiting}
      />
    </McpConsentLayout>
  );
}
