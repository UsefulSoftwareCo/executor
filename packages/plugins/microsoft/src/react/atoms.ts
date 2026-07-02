import type { IntegrationSlug } from "@executor-js/sdk/shared";
import * as Atom from "effect/unstable/reactivity/Atom";
import { ReactivityKey } from "@executor-js/react/api/reactivity-keys";
import { MicrosoftClient } from "./client";

export const microsoftIntegrationAtom = (slug: IntegrationSlug) =>
  MicrosoftClient.query("microsoft", "getIntegration", {
    params: { slug },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.integrations, ReactivityKey.tools],
  });

export const microsoftConfigAtom = (slug: IntegrationSlug) =>
  MicrosoftClient.query("microsoft", "getConfig", {
    params: { slug },
    timeToLive: "15 seconds",
    reactivityKeys: [ReactivityKey.integrations, ReactivityKey.tools],
  });

export const addMicrosoftGraph = MicrosoftClient.mutation("microsoft", "addGraph");

export const updateMicrosoftGraph = MicrosoftClient.mutation("microsoft", "updateGraph");

export const removeMicrosoftGraph = MicrosoftClient.mutation("microsoft", "removeGraph");

export const microsoftConfigure = MicrosoftClient.mutation("microsoft", "configure");

export const microsoftIntegrationFamily = Atom.family(microsoftIntegrationAtom);

export const microsoftConfigFamily = Atom.family(microsoftConfigAtom);
