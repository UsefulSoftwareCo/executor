import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { Exit } from "effect";
import { AsyncResult } from "effect/unstable/reactivity";
import { grantTarget } from "@executor-js/mcp-auth/grants";
import {
  McpConsentLayout,
  McpConsentLoading,
  McpConsentSummary,
  consentDestination,
} from "@executor-js/ui/dashboard/mcp-consent";
import { Button } from "@executor-js/ui/components/button";
import { localMcpClientAtom, localMcpConsentAtom } from "../../contracts/mcp.ts";

/** Pairing establishes the operator; the MCP URL determines this connection's approval mode. */
export function LocalMcpAuthorizePage() {
  const query = window.location.search.slice(1),
    params = new URLSearchParams(query);
  const id = params.get("client_id") ?? "";
  const target = grantTarget(window.location.origin, params.getAll("resource"));
  const destination = consentDestination(params.get("redirect_uri"));
  const client = useAtomValue(localMcpClientAtom(id));
  const submit = useAtomSet(localMcpConsentAtom, { mode: "promiseExit" });
  const pending = useAtomValue(localMcpConsentAtom);
  const [error, setError] = useState<string | null>(null);
  const decide = async (accept: boolean) => {
    setError(null);
    const result = await submit({ accept, query });
    if (Exit.isFailure(result))
      setError("This connection could not be completed. Start again from your MCP client.");
    else window.location.assign(result.value.url);
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
      <McpConsentSummary target={target} destination={destination} />
      {error && (
        <p role="alert" className="auth-error text-destructive text-[13px]">
          {error}
        </p>
      )}
      <div className="mcp-consent-actions flex items-center justify-end gap-2.5 border-t border-t-border pt-5 [&_>_p]:mr-auto [&_>_p]:text-muted-foreground [&_>_p]:text-[12px] max-[480px]:flex-wrap">
        <Button variant="outline" disabled={pending.waiting} onClick={() => decide(false)}>
          Cancel
        </Button>
        <Button loading={pending.waiting} disabled={pending.waiting} onClick={() => decide(true)}>
          Connect
        </Button>
      </div>
    </McpConsentLayout>
  );
}
