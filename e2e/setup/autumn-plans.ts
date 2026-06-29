// The plan catalog the Autumn emulator advertises, derived from the deploy-time
// source of truth (repo-root `autumn.config.ts`). In production Autumn learns
// these plans via `atmn` sync; the emulator has no such sync, so the e2e boot
// seeds them. Keeping this derived from autumn.config.ts means plans, prices,
// and the Team free trial can never drift from what the app actually ships.
import { free, team, enterprise } from "../../autumn.config";

type AtmnPlan = {
  id: string;
  name: string;
  addOn?: boolean;
  autoEnable?: boolean;
  price?: { amount: number; interval: string };
  freeTrial?: { durationLength: number; durationType: string; cardRequired?: boolean };
  items?: ReadonlyArray<{ featureId: string; included?: number; unlimited?: boolean }>;
};

export interface AutumnSeedPlan {
  id: string;
  name: string;
  add_on: boolean;
  auto_enable: boolean;
  price: { amount: number; interval: string } | null;
  free_trial: { duration_length: number; duration_type: string; card_required: boolean } | null;
  items: Array<{ feature_id: string; included?: number; unlimited?: boolean }>;
}

const toSeed = (plan: AtmnPlan): AutumnSeedPlan => ({
  id: plan.id,
  name: plan.name,
  add_on: plan.addOn ?? false,
  auto_enable: plan.autoEnable ?? false,
  price: plan.price ? { amount: plan.price.amount, interval: plan.price.interval } : null,
  free_trial: plan.freeTrial
    ? {
        duration_length: plan.freeTrial.durationLength,
        duration_type: plan.freeTrial.durationType,
        card_required: plan.freeTrial.cardRequired ?? false,
      }
    : null,
  items: (plan.items ?? []).map((it) => ({
    feature_id: it.featureId,
    included: it.included,
    unlimited: it.unlimited,
  })),
});

/** Free, Team (card-required 14-day trial), and Enterprise, in display order. */
export const AUTUMN_PLAN_SEED: AutumnSeedPlan[] = [free, team, enterprise].map((p) =>
  toSeed(p as AtmnPlan),
);
