import { Schema } from "effect";

/**
 * The Autumn environment a catalog belongs to. Sandbox subscriptions are never paid ones, so a
 * stage's key must belong to the same environment as its catalog.
 */
export const BillingEnvironment = Schema.Literals(["sandbox", "live"]);
export type BillingEnvironment = typeof BillingEnvironment.Type;

/** The catalog stack exports identities, never management credentials or customer data. */
export const BillingCatalog = Schema.Struct({
  environment: BillingEnvironment,
  namespace: Schema.NonEmptyString,
  executions: Schema.NonEmptyString,
  members: Schema.NonEmptyString,
  domainVerification: Schema.NonEmptyString,
  free: Schema.NonEmptyString,
  payAsYouGo: Schema.NonEmptyString,
  team: Schema.NonEmptyString,
  enterprise: Schema.NonEmptyString,
});
/** One catalog is shared by the API and MCP runtime in the same deployment stage. */
export type BillingCatalog = typeof BillingCatalog.Type;

/** Free includes 100,000 monthly executions and three members. */
export const freeMonthlyExecutions = 100_000;
export const freeMembers = 3;
/** Team costs USD 15 per active member per month, billed in arrears. */
export const teamMemberPrice = 15;
/**
 * A private Autumn instance is provisioned for one throwaway stage, so its free plan carries an
 * allowance a test run cannot exhaust. Only the seeded declaration differs; the product applies
 * the same admission rules to every endpoint.
 */
export const seededMonthlyExecutions = 100_000_000;

/** An immutable metered or boolean feature. Changing a meaning requires a new ID. */
export type BillingFeatureDeclaration = {
  readonly featureId: string;
  readonly name: string;
} & (
  | { readonly type: "metered"; readonly consumable: boolean }
  | { readonly type: "boolean"; readonly consumable: false }
);
/** One mutually exclusive plan. Never a global default: customers select it explicitly. */
export interface BillingPlanDeclaration {
  readonly planId: string;
  readonly group: string;
  readonly name: string;
  readonly freeTrial: {
    readonly durationLength: number;
    readonly durationType: "day";
    readonly cardRequired: boolean;
  } | null;
  readonly items: ReadonlyArray<{
    readonly featureId: string;
    readonly included: number;
    readonly unlimited: boolean;
    readonly reset?: { readonly interval: "month" };
    readonly price?: {
      readonly amount: number;
      readonly billingUnits: number;
      readonly billingMethod: "usage_based";
      readonly interval: "month";
    };
  }>;
}
/** The catalog a stage declares, independent of the endpoint it is provisioned against. */
export interface BillingCatalogDeclaration {
  readonly catalog: BillingCatalog;
  readonly features: {
    readonly executions: BillingFeatureDeclaration;
    readonly members: BillingFeatureDeclaration;
    readonly domainVerification: BillingFeatureDeclaration;
  };
  readonly plans: {
    readonly free: BillingPlanDeclaration;
    readonly payAsYouGo: BillingPlanDeclaration;
    readonly team: BillingPlanDeclaration;
    readonly enterprise: BillingPlanDeclaration;
  };
}

/**
 * Every catalog identity is namespaced by stage, so one Autumn account can hold several of them
 * and a customer ID from one stage never selects another stage's plan.
 */
export const billingCatalogDeclaration = (
  stage: string,
  environment: BillingEnvironment,
  options: { readonly freeExecutions?: number } = {},
): BillingCatalogDeclaration => {
  const namespace = `executor-next-${stage}`;
  const executions = `${namespace}-executions`;
  const members = `${namespace}-members`;
  const domainVerification = `${namespace}-domain-verification`;
  return {
    catalog: {
      environment,
      namespace,
      executions,
      members,
      domainVerification,
      free: `${namespace}-free`,
      payAsYouGo: `${namespace}-free-pay-as-you-go`,
      team: `${namespace}-team`,
      enterprise: `${namespace}-enterprise`,
    },
    features: {
      executions: {
        featureId: executions,
        name: `Executions (${stage})`,
        type: "metered",
        consumable: true,
      },
      members: {
        featureId: members,
        name: `Members (${stage})`,
        type: "metered",
        consumable: false,
      },
      domainVerification: {
        featureId: domainVerification,
        name: `Domain Verification (${stage})`,
        type: "boolean",
        consumable: false,
      },
    },
    plans: {
      free: {
        planId: `${namespace}-free`,
        group: namespace,
        name: `Free (${stage})`,
        freeTrial: null,
        items: [
          { featureId: members, included: freeMembers, unlimited: false },
          {
            featureId: executions,
            included: options.freeExecutions ?? freeMonthlyExecutions,
            unlimited: false,
            reset: { interval: "month" },
          },
        ],
      },
      payAsYouGo: {
        planId: `${namespace}-free-pay-as-you-go`,
        group: namespace,
        name: `Free Pay As You Go (${stage})`,
        freeTrial: null,
        items: [
          {
            featureId: executions,
            included: freeMonthlyExecutions,
            unlimited: false,
            reset: { interval: "month" },
            price: {
              amount: 0.2,
              billingUnits: 1000,
              billingMethod: "usage_based",
              interval: "month",
            },
          },
        ],
      },
      team: {
        planId: `${namespace}-team`,
        group: namespace,
        name: `Team (${stage})`,
        freeTrial: { durationLength: 14, durationType: "day", cardRequired: true },
        items: [
          {
            featureId: members,
            included: 0,
            unlimited: false,
            price: {
              amount: teamMemberPrice,
              billingUnits: 1,
              billingMethod: "usage_based",
              interval: "month",
            },
          },
          { featureId: executions, included: 0, unlimited: true, reset: { interval: "month" } },
          { featureId: domainVerification, included: 0, unlimited: false },
        ],
      },
      enterprise: {
        planId: `${namespace}-enterprise`,
        group: namespace,
        name: `Enterprise (${stage})`,
        freeTrial: null,
        // V1's Enterprise plan is assigned manually; each contract sets its own price.
        items: [
          { featureId: members, included: 0, unlimited: true },
          { featureId: executions, included: 0, unlimited: true, reset: { interval: "month" } },
          { featureId: domainVerification, included: 0, unlimited: false },
        ],
      },
    },
  };
};
