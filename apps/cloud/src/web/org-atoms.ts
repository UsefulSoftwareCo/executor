import * as Atom from "effect/unstable/reactivity/Atom";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { CloudApiClient } from "./client";

// Cloud-only WorkOS domain-verification atoms over the surviving `/org/domains`
// endpoints. Members / roles / invite / org-name now flow through the shared
// `@executor-js/react` account atoms (`/account/*`), so they no longer live
// here.

export const orgDomainsAtom = Atom.refreshOnWindowFocus(
  CloudApiClient.query("org", "listDomains", {
    timeToLive: "30 seconds",
    reactivityKeys: [ReactivityKey.orgDomains],
  }),
);

export const getDomainVerificationLink = CloudApiClient.mutation(
  "org",
  "getDomainVerificationLink",
);

export const deleteDomain = CloudApiClient.mutation("org", "deleteDomain");
