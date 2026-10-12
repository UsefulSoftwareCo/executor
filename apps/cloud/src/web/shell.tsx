import type React from "react";

import { Shell as SharedShell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
import { useAdminNavItems } from "@executor-js/react/multiplayer/use-admin-nav";
import { trackEvent } from "@executor-js/react/api/analytics";
import { McpServerMoveProvider } from "@executor-js/react/api/mcp-server-move";
import { AUTH_PATHS } from "../auth/api";
import { OrgMenuSlot } from "./components/org-menu-slot";
import { SupportSlot } from "./components/support-slot";
import { V2ImportLink } from "./components/v2-import-link";
import { V2MovedNotice } from "./components/v2-moved-notice";
import { useV2McpMove } from "./v2-mcp-move";

// ---------------------------------------------------------------------------
// Cloud shell — the SHARED multiplayer shell, identical to self-host, with
// cloud-only bits injected through its slots:
//   - sign-out          navigate through cloud's WorkOS logout, land home
//   - nav items         defaults + Organization + Billing (cloud-only sections)
//   - org menu slot     multi-org switcher + create-org dialog (cloud-only)
//   - MCP server move  a moved org's connect card leads with its v2 MCP URL
//   - support slot      the "Move to Executor v2" link, shown only to users
//                       v2 would let import this org ("Open in Executor v2"
//                       once it has moved, with the moved notice), and the
//                       "Get support" dialog button (cloud-only)
// API keys live in the main sidebar nav (via `defaultShellNavItems`); the
// shared shell renders the account dropdown frame and sign-out, with
// `orgMenuSlot` injected at the top of the dropdown.
// ---------------------------------------------------------------------------

const navItems = [
  ...defaultShellNavItems.filter((item) => item.to !== "/secrets"),
  { to: "/api-keys", label: "API keys" },
  { to: "/org", label: "Organization" },
  { to: "/billing", label: "Billing" },
];

// Sections only an admin of the org may open. The Users page reads the
// tenant-wide admin plane, which cloud gates on an admin-role membership — so
// a plain member is not shown a link that would only refuse them. The page
// still renders its own denied state if one arrives by URL.
const adminNavItems = [{ to: "/users", label: "Users" }];

// A top-level form POST, not fetch: the logout response 302s through the
// WorkOS logout endpoint (ending the hosted AuthKit session) before landing
// back home. A fetch would follow that chain invisibly inside the XHR and
// leave the page where it was; the browser navigation is the logout.
const signOut = () => {
  trackEvent("signed_out");
  const form = document.createElement("form");
  form.method = "POST";
  form.action = AUTH_PATHS.logout;
  document.body.appendChild(form);
  form.submit();
};

export function Shell(props: { readonly content?: React.ReactNode }) {
  const items = useAdminNavItems(navItems, adminNavItems);
  const mcpMove = useV2McpMove();
  return (
    <McpServerMoveProvider move={mcpMove}>
      <SharedShell
        onSignOut={signOut}
        navItems={items}
        orgMenuSlot={<OrgMenuSlot />}
        supportSlot={
          <>
            <V2ImportLink />
            <V2MovedNotice />
            <SupportSlot />
          </>
        }
        content={props.content}
      />
    </McpServerMoveProvider>
  );
}
