import React, { createContext, useContext, useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult";

import { meAtom } from "../api/account-atoms";

// ---------------------------------------------------------------------------
// Shared auth seam for the multiplayer apps (cloud + self-host).
//
// `useAuth()` reflects the `/account/me` query: loading → unauthenticated →
// authenticated. Provider-neutral — the only difference between cloud (WorkOS)
// and self-host (Better Auth) is which server answers `me` and how the session
// cookie was minted. Analytics stay OUT of here; a host that wants to identify
// the user (cloud → PostHog) passes an `onIdentify` callback.
// ---------------------------------------------------------------------------

export type AuthUser = {
  id: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
};

export type AuthOrganization = {
  id: string;
  name: string;
};

export type AuthState =
  | { status: "loading" }
  | { status: "unauthenticated" }
  | { status: "authenticated"; user: AuthUser; organization: AuthOrganization | null };

export type IdentifyFn = (
  state: Extract<AuthState, { status: "authenticated" }> | { status: "unauthenticated" },
) => void;

const AuthContext = createContext<AuthState>({ status: "loading" });

export const useAuth = () => useContext(AuthContext);

const AuthProviderClient = ({
  children,
  onIdentify,
}: {
  children: React.ReactNode;
  onIdentify?: IdentifyFn;
}) => {
  const result = useAtomValue(meAtom);

  const state: AuthState = AsyncResult.match(result, {
    onInitial: () => ({ status: "loading" as const }),
    onSuccess: ({ value }) => ({
      status: "authenticated" as const,
      user: value.user,
      organization: value.organization,
    }),
    onFailure: () => ({ status: "unauthenticated" as const }),
  });

  // Primitive identity fields so the identify effect fires only on real
  // transitions (the `state` object is rebuilt every render).
  const status = state.status;
  const userId = state.status === "authenticated" ? state.user.id : null;
  const email = state.status === "authenticated" ? state.user.email : null;
  const name = state.status === "authenticated" ? state.user.name : null;
  const avatarUrl = state.status === "authenticated" ? state.user.avatarUrl : null;
  const organizationId = state.status === "authenticated" ? (state.organization?.id ?? null) : null;
  const organizationName =
    state.status === "authenticated" ? (state.organization?.name ?? null) : null;

  useEffect(() => {
    if (!onIdentify) return;
    if (status === "authenticated" && userId && email !== null) {
      onIdentify({
        status: "authenticated",
        user: { id: userId, email, name, avatarUrl },
        organization: organizationId ? { id: organizationId, name: organizationName ?? "" } : null,
      });
    } else if (status === "unauthenticated") {
      onIdentify({ status: "unauthenticated" });
    }
  }, [onIdentify, status, userId, email, name, avatarUrl, organizationId, organizationName]);

  return <AuthContext.Provider value={state}>{children}</AuthContext.Provider>;
};

export const AuthProvider = ({
  children,
  onIdentify,
}: {
  children: React.ReactNode;
  onIdentify?: IdentifyFn;
}) => {
  if (typeof window === "undefined") {
    return <AuthContext.Provider value={{ status: "loading" }}>{children}</AuthContext.Provider>;
  }
  return <AuthProviderClient onIdentify={onIdentify}>{children}</AuthProviderClient>;
};
