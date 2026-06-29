import type { IntegrationSlug } from "@executor-js/sdk/shared";
import * as Atom from "effect/unstable/reactivity/Atom";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { GoogleClient } from "./client";

export const googleIntegrationAtom = (slug: IntegrationSlug) =>
  GoogleClient.query("google", "getIntegration", {
    params: { slug },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.integrations, ReactivityKey.tools],
  });

export const googleConfigAtom = (slug: IntegrationSlug) =>
  GoogleClient.query("google", "getConfig", {
    params: { slug },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.integrations, ReactivityKey.tools],
  });

export const addGoogleBundle = GoogleClient.mutation("google", "addBundle");

export const updateGoogleBundle = GoogleClient.mutation("google", "updateBundle");

export const removeGoogleBundle = GoogleClient.mutation("google", "removeBundle");

export const googleConfigure = GoogleClient.mutation("google", "configure");

export const googleIntegrationFamily = Atom.family(googleIntegrationAtom);

export const googleConfigFamily = Atom.family(googleConfigAtom);
