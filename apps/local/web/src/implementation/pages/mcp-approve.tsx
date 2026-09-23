import { GrantId } from "@executor-js/mcp-auth";
import { useLocation } from "@tanstack/react-router";
import { BrowserApprovalAddress } from "@executor-js/mcp/browser";
import { BrowserApprovalPage } from "@executor-js/ui/dashboard/browser-approval";
import { browserApprovalAtoms } from "@executor-js/ui/contracts/browser-approval";
import { Option, Schema } from "effect";
import { BrowserAtoms } from "../../contracts/telemetry.ts";
import { AuthenticationGate } from "../app.tsx";
const approvals = browserApprovalAtoms(BrowserAtoms);
function Review() {
  const location = useLocation();
  const address = Schema.decodeUnknownOption(
    Schema.Struct({ ...BrowserApprovalAddress.fields, grantId: GrantId }),
  )({
    requestId: location.pathname.split("/").at(-1),
    grantId: new URLSearchParams(window.location.search).get("grantId"),
    sessionId: new URLSearchParams(window.location.search).get("sessionId"),
  });
  if (Option.isNone(address))
    return (
      <main className="p-8">
        <h1 className="text-[22px] font-semibold tracking-[-0.035em] leading-[1.35]">
          This approval link is invalid.
        </h1>
      </main>
    );
  return (
    <BrowserApprovalPage
      atoms={approvals(
        `/dashboard/api/mcp/approvals/${encodeURIComponent(address.value.requestId)}?${new URLSearchParams({ sessionId: address.value.sessionId, grantId: address.value.grantId })}`,
      )}
    />
  );
}
/** Local pairing stays independent of MCP bearer credentials. */
export function McpApprovePage() {
  return (
    <AuthenticationGate>
      <Review />
    </AuthenticationGate>
  );
}
