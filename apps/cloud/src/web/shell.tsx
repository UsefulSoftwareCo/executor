import { Shell as SharedShell, defaultShellNavItems } from "@executor-js/react/multiplayer/shell";
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
// The shared shell already renders the account dropdown frame, API-keys link,
// and sign-out; `orgMenuSlot` is injected above the API-keys link.
// ---------------------------------------------------------------------------

const navItems = [
  ...defaultShellNavItems,
  { to: "/org", label: "Organization" },
  { to: "/billing", label: "Billing" },
];

const signOut = async () => {
  await fetch(AUTH_PATHS.logout, { method: "POST" });
  window.location.href = "/";
};

export function Shell() {
  return (
    <SharedShell
      onSignOut={signOut}
      navItems={navItems}
      apiKeysTo="/api-keys"
      orgMenuSlot={<OrgMenuSlot />}
      supportSlot={<SupportSlot />}
    />
  );
}
