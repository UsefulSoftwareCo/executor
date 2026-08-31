// Which screens carry which workspace state. Jumping straight to a late step
// has to bring that step's state with it, or the screen is not the one the
// step is about.

import type { StepId } from "./flow";
import { gmailIntegration, posthogIntegration, type DemoIntegration } from "./fixtures";

export type AccountModal = "none" | "credential" | "place" | "oauth-stuck";
export type ScreenView = "integrations" | "add" | "detail";

export interface StepState {
  readonly integrations: readonly DemoIntegration[];
  readonly connectOpen: boolean;
  readonly accountModal: AccountModal;
  readonly view: ScreenView;
}

const EMPTY: StepState = {
  integrations: [],
  connectOpen: false,
  accountModal: "none",
  view: "integrations",
};

const WITH_POSTHOG: StepState = {
  integrations: [posthogIntegration],
  connectOpen: false,
  accountModal: "none",
  view: "detail",
};

export const stepState: Readonly<Record<StepId, StepState>> = {
  "integrations-empty": EMPTY,
  "connect-dialog": { ...EMPTY, connectOpen: true },
  "add-openapi": { ...EMPTY, view: "add" },
  "detail-accounts": WITH_POSTHOG,
  "add-account-credential": { ...WITH_POSTHOG, accountModal: "credential" },
  "add-account-place": { ...WITH_POSTHOG, accountModal: "place" },
  "oauth-stuck": {
    ...WITH_POSTHOG,
    integrations: [gmailIntegration],
    accountModal: "oauth-stuck",
  },
  "integrations-populated": { ...WITH_POSTHOG, view: "integrations" },
};
