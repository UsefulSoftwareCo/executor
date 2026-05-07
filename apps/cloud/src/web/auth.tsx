import React, { createContext, useContext, useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";
import { usePostHog } from "posthog-js/react";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";

import { CloudApiClient } from "./client";

// ---------------------------------------------------------------------------
// Types (from CloudAuthApi response schema)
// ---------------------------------------------------------------------------

type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export type AuthOrganization = {
  id: string;
  handle: string;
  name: string;
};

// ---------------------------------------------------------------------------
// Auth atom — typed query against CloudAuthApi
// ---------------------------------------------------------------------------

export const authAtom = CloudApiClient.query("cloudAuth", "me", {
  timeToLive: "5 minutes",
  reactivityKeys: [ReactivityKey.auth],
});

export const createOrganization = CloudApiClient.mutation("cloudAuth", "createOrganization");

export const pendingInvitationsAtom = CloudApiClient.query("cloudAuth", "pendingInvitations", {
  timeToLive: "1 minute",
  reactivityKeys: [ReactivityKey.auth],
});

export const acceptInvitation = CloudApiClient.mutation("cloudAuth", "acceptInvitation");

// ---------------------------------------------------------------------------
// Provider + hook
// ---------------------------------------------------------------------------

type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | {
      status: "authenticated";
      user: AuthUser;
      organizations: ReadonlyArray<AuthOrganization>;
    };

const AuthContext = createContext<AuthState>({ status: "loading" });

export const useAuth = () => useContext(AuthContext);

const AuthProviderClient = ({ children }: { children: React.ReactNode }) => {
  const result = useAtomValue(authAtom);
  const posthog = usePostHog();

  const state: AuthState = AsyncResult.match(result, {
    onInitial: () => ({ status: "loading" as const }),
    onSuccess: ({ value }) => ({
      status: "authenticated" as const,
      user: value.user,
      organizations: value.organizations,
    }),
    onFailure: () => ({ status: "unauthenticated" as const }),
  });

  const userId = state.status === "authenticated" ? state.user.id : null;
  const email = state.status === "authenticated" ? state.user.email : null;
  const name = state.status === "authenticated" ? state.user.name : null;
  // PostHog org grouping uses the first membership; the user can navigate
  // between orgs in-session. If we want richer grouping later we can
  // re-emit on URL change.
  const firstOrgId = state.status === "authenticated" ? (state.organizations[0]?.id ?? null) : null;
  const firstOrgName =
    state.status === "authenticated" ? (state.organizations[0]?.name ?? null) : null;
  const isUnauthenticated = state.status === "unauthenticated";

  useEffect(() => {
    if (!posthog) return;
    if (userId) {
      posthog.identify(userId, { email, name });
      if (firstOrgId) {
        posthog.group("organization", firstOrgId, { name: firstOrgName });
      }
    } else if (isUnauthenticated) {
      posthog.reset();
    }
  }, [posthog, userId, email, name, firstOrgId, firstOrgName, isUnauthenticated]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
};

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  if (typeof window === "undefined") {
    return <AuthContext.Provider value={{ status: "loading" }}>{children}</AuthContext.Provider>;
  }
  return <AuthProviderClient>{children}</AuthProviderClient>;
};

/** Find the organization in the auth state matching a given URL handle. */
export const findOrgByHandle = (state: AuthState, handle: string): AuthOrganization | null => {
  if (state.status !== "authenticated") return null;
  return state.organizations.find((o) => o.handle === handle) ?? null;
};
