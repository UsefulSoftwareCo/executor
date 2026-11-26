import { organizationOwner, type OrganizationId } from "@executor-js/hosted-server";
import { Schema } from "effect";

export const BillingEnvironment = Schema.Literals(["sandbox", "live"]);
export type BillingEnvironment = typeof BillingEnvironment.Type;

export const BillingCatalog = Schema.Struct({
  environment: BillingEnvironment,
  namespace: Schema.NonEmptyString,
  members: Schema.NonEmptyString,
  domainVerification: Schema.NonEmptyString,
  free: Schema.NonEmptyString,
  team: Schema.NonEmptyString,
  enterprise: Schema.NonEmptyString,
});
export type BillingCatalog = typeof BillingCatalog.Type;

export const billingCustomerId = (catalog: BillingCatalog, organization: OrganizationId) =>
  `${catalog.namespace}:${organizationOwner(organization)}`;

export const freeMembers = 3;
export const teamMemberPrice = 15;

export type BillingFeatureDeclaration = {
  readonly featureId: string;
  readonly name: string;
} & (
  | { readonly type: "metered"; readonly consumable: boolean }
  | { readonly type: "boolean"; readonly consumable: false }
);
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
export interface BillingCatalogDeclaration {
  readonly catalog: BillingCatalog;
  readonly features: {
    readonly members: BillingFeatureDeclaration;
    readonly domainVerification: BillingFeatureDeclaration;
  };
  readonly plans: {
    readonly free: BillingPlanDeclaration;
    readonly team: BillingPlanDeclaration;
    readonly enterprise: BillingPlanDeclaration;
  };
}

export const billingCatalogDeclaration = (
  stage: string,
  environment: BillingEnvironment,
): BillingCatalogDeclaration => {
  const namespace = `executor-next-${stage}`;
  const members = `${namespace}-members`;
  const domainVerification = `${namespace}-domain-verification`;
  return {
    catalog: {
      environment,
      namespace,
      members,
      domainVerification,
      free: `${namespace}-free`,
      team: `${namespace}-team`,
      enterprise: `${namespace}-enterprise`,
    },
    features: {
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
        items: [{ featureId: members, included: freeMembers, unlimited: false }],
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
          { featureId: domainVerification, included: 0, unlimited: false },
        ],
      },
      enterprise: {
        planId: `${namespace}-enterprise`,
        group: namespace,
        name: `Enterprise (${stage})`,
        freeTrial: null,
        items: [
          { featureId: members, included: 0, unlimited: true },
          { featureId: domainVerification, included: 0, unlimited: false },
        ],
      },
    },
  };
};
