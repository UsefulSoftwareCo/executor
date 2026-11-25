import {
  createContext,
  use,
  useEffect,
  useEffectEvent,
  type ComponentProps,
  type ReactNode,
} from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { setupSteps, type SetupSkip, type SetupStep } from "@executor-js/hosted-server/setup";
import type { AssistantId } from "@executor-js/ui/contracts/dashboard";
import type { SetupHandoff } from "../../contracts/navigation.ts";
import { reportBrowserUsage, type BrowserUsage } from "../../contracts/product-analytics.ts";
import { useOrganizationRoute } from "./organization.tsx";

/**
 * Whether a team's setup steps can be skipped, with whether the member is in Cloud's onboarding
 * skip experiment. Cloud reads it for the team before the first step renders; other hosts provide
 * none and show skippable steps. Every host runs the steps in `setupSteps`' order.
 */
export interface SetupSequence {
  readonly skip: { readonly variant: SetupSkip; readonly enrolled: boolean };
}

const SetupSequenceContext = createContext<SetupSequence>({
  skip: { variant: "skippable", enrolled: false },
});

export function SetupSequenceProvider({
  value,
  children,
}: {
  readonly value: SetupSequence;
  readonly children: ReactNode;
}) {
  return <SetupSequenceContext value={value}>{children}</SetupSequenceContext>;
}

export type { SetupStep };

/**
 * Where a step leads. The account step carries the assistant's handoff; the first prompt needs it.
 * Without one, because the member skipped the assistant, setup ends at the dashboard.
 */
export type SetupDestination =
  | { readonly screen: "accounts"; readonly handoff: SetupHandoff | undefined }
  | { readonly screen: "assistant" }
  | { readonly screen: "prompt"; readonly handoff: SetupHandoff }
  | { readonly screen: "dashboard" };

const destination = (
  step: SetupStep | undefined,
  handoff: SetupHandoff | undefined,
): SetupDestination =>
  step === "accounts"
    ? { screen: "accounts", handoff }
    : step === "assistant"
      ? { screen: "assistant" }
      : handoff === undefined
        ? { screen: "dashboard" }
        : { screen: "prompt", handoff };

/**
 * The team's setup steps as destinations: the first step, and the one after each step, given
 * the assistant handoff known there. A step's one forward action leads to `after` whether it
 * skips or continues; skipping the assistant just carries no handoff. Steps report their onboarding
 * events through `report`, which adds the skip experiment's variant for an enrolled member and the
 * assistant a step is for.
 */
export function useSetupSequence() {
  const sequence = use(SetupSequenceContext);
  const order: readonly SetupStep[] = setupSteps;
  return {
    /**
     * The member's steps cannot be skipped: each forward button waits until its step is done, and
     * the server keeps the dashboard closed until both are.
     */
    required: sequence.skip.variant === "required",
    first: destination(order[0], undefined),
    after: (step: SetupStep, handoff: SetupHandoff | undefined) =>
      destination(order[order.indexOf(step) + 1], handoff),
    report: (action: string, outcome: BrowserUsage["outcome"], assistant?: AssistantId) =>
      reportBrowserUsage({
        area: "onboarding",
        action,
        outcome,
        ...(sequence.skip.enrolled ? { onboarding_skip_variant: sequence.skip.variant } : {}),
        ...(assistant === undefined ? {} : { assistant }),
      }),
  };
}

/**
 * Reports a setup screen once each time it is shown, such as `setup_accounts`, with the assistant
 * it is for once one is picked.
 */
export function useSetupViewed(action: string, assistant?: AssistantId) {
  const { report } = useSetupSequence();
  const viewed = useEffectEvent(() => report(action, "viewed", assistant));
  useEffect(() => viewed(), [action, assistant]);
}

/** Router options for a destination in this organization's setup. */
function linkOptions(slug: string, to: SetupDestination) {
  const params = { organizationSlug: slug };
  switch (to.screen) {
    case "accounts":
      return {
        to: "/org/$organizationSlug/setup/accounts" as const,
        params,
        search: to.handoff ?? {},
      };
    case "assistant":
      return { to: "/org/$organizationSlug/setup/assistant" as const, params, search: {} };
    case "prompt":
      return {
        to: "/org/$organizationSlug/setup/assistant" as const,
        params,
        search: {
          assistant: to.handoff.assistant,
          step: "prompt" as const,
          agent: to.handoff.agent,
        },
      };
    case "dashboard":
      return { to: "/org/$organizationSlug/apps" as const, params, search: {} };
  }
}

/** A link to a setup destination. */
export function SetupLink({
  to,
  ...props
}: { readonly to: SetupDestination } & Omit<ComponentProps<typeof Link>, "to">) {
  const { slug } = useOrganizationRoute();
  return <Link {...props} {...linkOptions(slug, to)} />;
}

/** Opens a setup destination, as a new history entry unless `replace`. */
function useSetupNavigate() {
  const navigate = useNavigate();
  const { slug } = useOrganizationRoute();
  return (to: SetupDestination, options: { readonly replace: boolean } = { replace: false }) =>
    navigate({ ...linkOptions(slug, to), replace: options.replace });
}

/** Replaces the current entry with a setup destination, such as the first step, once. */
export function SetupRedirect({ to }: { readonly to: SetupDestination }) {
  const open = useSetupNavigate();
  const go = useEffectEvent(() => open(to, { replace: true }));
  useEffect(() => void go(), []);
  return null;
}
