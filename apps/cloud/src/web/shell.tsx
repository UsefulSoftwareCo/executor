import type React from "react";

import { Shell as SharedShell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
import { trackEvent } from "@executor-js/react/api/analytics";
import { AUTH_PATHS } from "../auth/api";
import { OrgMenuSlot } from "./components/org-menu-slot";
import { SupportSlot } from "./components/support-slot";

// ---------------------------------------------------------------------------
// Cloud shell — the SHARED multiplayer shell, identical to self-host, with
// cloud-only bits injected through its slots:
//   - sign-out          POST cloud's WorkOS logout, then redirect home
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

const signOut = async () => {
  await fetch(AUTH_PATHS.logout, { method: "POST" });
  trackEvent("signed_out");
  window.location.href = "/";
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
