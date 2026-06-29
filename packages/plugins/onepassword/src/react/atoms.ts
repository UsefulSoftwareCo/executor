import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { OnePasswordClient } from "./client";

// 1Password is a CredentialProvider in v2 — its owner-scoped config lives in
// the `providers` reactivity family (the v1 `secrets` key is gone).
export const onepasswordWriteKeys = [ReactivityKey.providers] as const;

// ---------------------------------------------------------------------------
// Query atoms
//
// v2: the 1Password config is a single owner-partitioned binding the server
// derives from the executor's owner — there are no owner path params here; the
// server reads the acting owner from the executor binding.
// ---------------------------------------------------------------------------

export const onepasswordConfigAtom = OnePasswordClient.query("onepassword", "getConfig", {
  timeToLive: "30 seconds",
  reactivityKeys: [ReactivityKey.providers],
});

export const onepasswordStatusAtom = OnePasswordClient.query("onepassword", "status", {
  timeToLive: "15 seconds",
  reactivityKeys: [ReactivityKey.providers],
});

// ---------------------------------------------------------------------------
// Query atoms — vaults
// ---------------------------------------------------------------------------

export const onepasswordVaultsAtom = (
  authKind: "desktop-app" | "service-account",
  account: string,
) =>
  OnePasswordClient.query("onepassword", "listVaults", {
    query: { authKind, account },
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.providers],
  });

// ---------------------------------------------------------------------------
// Mutation atoms
// ---------------------------------------------------------------------------

export const configureOnePassword = OnePasswordClient.mutation("onepassword", "configure");

export const removeOnePasswordConfig = OnePasswordClient.mutation("onepassword", "removeConfig");
