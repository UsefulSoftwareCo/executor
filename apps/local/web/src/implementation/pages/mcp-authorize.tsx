import { usePageUrl } from "@executor-js/dashboard-start/page";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Exit } from "effect";
import { AsyncResult } from "effect/reactivity";
import { grantTarget, singleResourceOrigin } from "@executor-js/mcp-auth/grants";
import {
  McpConsentActions,
  McpConsentDestination,
  McpConsentLayout,
  McpConsentLoading,
  McpConsentSummary,
  McpConsentTargetRows,
  consentDestination,
} from "@executor-js/ui/dashboard/mcp-consent";
import { localMcpClientAtom, localMcpConsentAtom } from "../../contracts/mcp.ts";

/**
 * Pairing establishes the operator. The page approves what the MCP URL names, shown as plain
 * values: the access and where approvals are answered.
 */
export function LocalMcpAuthorizePage() {
  const page = usePageUrl();
  const query = page.search.slice(1),
    params = new URLSearchParams(query);
  const id = params.get("client_id") ?? "";
  const target = grantTarget(singleResourceOrigin(page.origin), params.getAll("resource"));
  const destination = consentDestination(params.get("redirect_uri"));
  const client = useAtomValue(localMcpClientAtom(id));
  const submit = useAtomSet(localMcpConsentAtom, { mode: "promiseExit" });
  const pending = useAtomValue(localMcpConsentAtom);
  const [error, setError] = useState<string | null>(null);
  const decide = async (accept: boolean) => {
    setError(null);
    const result = await submit({ accept, query });
    if (Exit.isFailure(result)) {
      setError("This connection could not be completed. Start again from your MCP client.");
      return false;
    }
    window.location.assign(result.value.url);
    return true;
  };
  if (id === "" || target?.kind !== "mcp" || AsyncResult.isFailure(client))
    return (
      <McpConsentLayout description="This connection request could not be loaded.">
        <p role="alert">Start again from your MCP client.</p>
      </McpConsentLayout>
    );
  if (!AsyncResult.isSuccess(client)) return <McpConsentLoading />;
  return (
    <McpConsentLayout
      description={
        <p>
          <strong>{client.value.client_name ?? "An application"}</strong> wants to connect to
          Executor Local.
        </p>
      }
    >
      <McpConsentSummary
        note={
          destination === undefined ? undefined : <McpConsentDestination origin={destination} />
        }
      >
        <McpConsentTargetRows target={target} />
      </McpConsentSummary>
      {error && (
        <p role="alert" className="auth-error text-destructive text-[13px]">
          {error}
        </p>
      )}
      <McpConsentActions
        onDecline={() => decide(false)}
        onConnect={() => decide(true)}
        waiting={pending.waiting}
      />
    </McpConsentLayout>
  );
}
