import { Effect, Layer } from "effect";
import type { Autumn } from "autumn-js";

import { AutumnService, type IAutumnService } from "./autumn";

export type AutumnTestSubscriptionSummary = {
  readonly planId?: string | null;
  readonly status?: string | null;
};

export type AutumnTestState = {
  readonly subscriptionsByOrgId: Readonly<Record<string, readonly AutumnTestSubscriptionSummary[]>>;
};

export const makeAutumnTestState = (overrides: Partial<AutumnTestState> = {}): AutumnTestState => ({
  subscriptionsByOrgId: {},
  ...overrides,
});

const makeAutumnTestService = (state: AutumnTestState): IAutumnService => {
  const fakeClient = {
    customers: {
      getOrCreate: async ({ customerId }: { readonly customerId: string }) => ({
        subscriptions: state.subscriptionsByOrgId[customerId] ?? [],
      }),
    },
  } as Autumn;

  return {
    use: (fn) => Effect.promise(() => fn(fakeClient)),
    trackExecution: () => Effect.void,
  };
};

export const AutumnTestLayer = (state: AutumnTestState) =>
  Layer.succeed(AutumnService)(makeAutumnTestService(state));
