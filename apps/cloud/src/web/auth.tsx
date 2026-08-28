import React from "react";
import * as Atom from "effect/unstable/reactivity/Atom";
import { usePostHog } from "posthog-js/react";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import {
  AuthProvider as SharedAuthProvider,
  useAuth,
  type IdentifyFn,
} from "@executor-js/react/multiplayer/auth-context";
import type { AuthHint } from "@executor-js/react/multiplayer/auth-hint";

import { writeLastOrgCookie } from "../auth/last-org-cookie";
import { CloudApiClient } from "./client";

// ---------------------------------------------------------------------------
// Cloud auth — the SHARED multiplayer auth seam (`useAuth` reads `/account/me`)
// with a thin cloud wrapper that wires PostHog identify/group/reset through the
// shared `onIdentify` callback. Identity comes from the provider-neutral
// account surface, identical to self-host.
//
// Cloud-only multi-org bits (org switcher, create-org, pending invites) stay
// here as cloud-local atoms over CloudApiClient — they are NOT part of the
// shared account contract and coexist with the shared `/account/*` atoms.
// ---------------------------------------------------------------------------

export { useAuth };

// ── Cloud-only multi-org atoms (CloudAuthApi) ──────────────────────────────

export const organizationsAtom = Atom.refreshOnWindowFocus(
  CloudApiClient.query("cloudAuth", "organizations", {
    timeToLive: "1 minute",
    reactivityKeys: [ReactivityKey.auth],
  }),
);

export const createOrganization = CloudApiClient.mutation("cloudAuth", "createOrganization");

export const deleteOrganization = CloudApiClient.mutation("cloudAuth", "deleteOrganization");

export const pendingInvitationsAtom = CloudApiClient.query("cloudAuth", "pendingInvitations", {
  timeToLive: "1 minute",
  reactivityKeys: [ReactivityKey.auth],
});

export const acceptInvitation = CloudApiClient.mutation("cloudAuth", "acceptInvitation");

// ── Provider ───────────────────────────────────────────────────────────────

export const AuthProvider = ({
  children,
  initialHint,
}: {
  children: React.ReactNode;
  initialHint?: AuthHint | null;
}) => {
  const posthog = usePostHog();

  const onIdentify = React.useCallback<IdentifyFn>(
    (state) => {
      // Record the org this browser is verifiably viewing: onIdentify fires
      // only on resolved `/account/me` answers (never hint optimism), and that
      // call is URL-scoped, so `state.organization` IS the org of the current
      // tab. The cookie makes the next bare entry (`/`) and the next login
      // land here instead of the session's login-time org — see
      // ../auth/last-org-cookie.ts. Deliberately not cleared on signout: the
      // preference is the point of surviving the session.
      if (state.status === "authenticated" && state.organization) {
        writeLastOrgCookie(state.organization.slug);
      }
      if (!posthog) return;
      if (state.status === "authenticated") {
        posthog.identify(state.user.id, {
          email: state.user.email,
          name: state.user.name,
        });
        if (state.organization) {
          posthog.group("organization", state.organization.id, {
            name: state.organization.name,
          });
        }
      } else {
        posthog.reset();
      }
    },
    [posthog],
  );

  return (
    <SharedAuthProvider onIdentify={onIdentify} initialHint={initialHint}>
      {children}
    </SharedAuthProvider>
  );
};
