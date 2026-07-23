import type React from "react";

import { Shell as SharedShell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
import { trackEvent } from "@executor-js/react/api/analytics";
import { AUTH_PATHS } from "../auth/api";
import { OrgMenuSlot } from "./components/org-menu-slot";
import { SupportSlot } from "./components/support-slot";

// ---------------------------------------------------------------------------
// Cloud shell — the SHARED multiplayer shell, identical to self-host, with
// cloud-only bits injected through its slots:
//   - sign-out          navigate through cloud's WorkOS logout, land home
//   - nav items         defaults + Organization + Billing (cloud-only sections)
//   - org menu slot     multi-org switcher + create-org dialog (cloud-only)
//   - support slot      the "Get support" dialog button (cloud-only)
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
  return (
    <SharedShell
      onSignOut={signOut}
      navItems={navItems}
      orgMenuSlot={<OrgMenuSlot />}
      supportSlot={<SupportSlot />}
      content={props.content}
    />
  );
}
