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

export function useSetupSequence() {
  const sequence = use(SetupSequenceContext);
  const order: readonly SetupStep[] = setupSteps;
  return {
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

export function useSetupViewed(action: string, assistant?: AssistantId) {
  const { report } = useSetupSequence();
  const viewed = useEffectEvent(() => report(action, "viewed", assistant));
  useEffect(() => viewed(), [action, assistant]);
}

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

export function SetupLink({
  to,
  ...props
}: { readonly to: SetupDestination } & Omit<ComponentProps<typeof Link>, "to">) {
  const { slug } = useOrganizationRoute();
  return <Link {...props} {...linkOptions(slug, to)} />;
}

function useSetupNavigate() {
  const navigate = useNavigate();
  const { slug } = useOrganizationRoute();
  return (to: SetupDestination, options: { readonly replace: boolean } = { replace: false }) =>
    navigate({ ...linkOptions(slug, to), replace: options.replace });
}

export function SetupRedirect({ to }: { readonly to: SetupDestination }) {
  const open = useSetupNavigate();
  const go = useEffectEvent(() => open(to, { replace: true }));
  useEffect(() => void go(), []);
  return null;
}
