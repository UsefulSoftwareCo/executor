import { useLocation } from "@tanstack/react-router";
import { InteractionId } from "@executor-js/mcp/browser";
import { HostedApprovalQuery } from "@executor-js/hosted-server/mcp/browser";
import { BrowserApprovalPage } from "@executor-js/ui/dashboard/browser-approval";
import { browserApprovalAtoms } from "@executor-js/ui/contracts/browser-approval";
import { Option, Schema } from "effect";
import { BrowserAtoms } from "../../contracts/telemetry.ts";
const approvals = browserApprovalAtoms(BrowserAtoms);
const Address = Schema.Struct({ requestId: InteractionId, ...HostedApprovalQuery.fields });
/** Both hosted products use their existing AuthBoundary and the same browser review page. */
export function McpApprovePage() {
  const location = useLocation();
  const query = new URLSearchParams(window.location.search);
  const address = Schema.decodeUnknownOption(Address)({
    requestId: location.pathname.split("/").at(-1),
    sessionId: query.get("sessionId"),
    grantId: query.get("grantId"),
  });
  if (Option.isNone(address))
    return (
      <main className="p-8">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35]">
          This approval link is invalid.
        </h1>
      </main>
    );
  const { requestId, ...routing } = address.value;
  return (
    <BrowserApprovalPage
      atoms={approvals(
        `/api/mcp/approvals/${encodeURIComponent(requestId)}?${new URLSearchParams(routing)}`,
      )}
    />
  );
}
