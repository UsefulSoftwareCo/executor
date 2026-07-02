import { feature, item, plan } from "atmn";

// Features
export const executions = feature({
  id: "executions",
  name: "Executions",
  type: "metered",
  consumable: true,
});

export const domainVerification = feature({
  id: "domain-verification",
  name: "Domain Verification",
  type: "boolean",
});

export const members = feature({
  id: "members",
  name: "Members",
  type: "metered",
  consumable: false,
  archived: true,
});

// Plans
export const free = plan({
  id: "free",
  name: "Free",
  addOn: false,
  autoEnable: true,
  items: [
    item({
      featureId: executions.id,
      included: 10000,
      reset: {
        interval: "month",
      },
    }),
  ],
});

export const freePayAsYouGo = plan({
  id: "free-pay-as-you-go",
  name: "Free Pay As You Go",
  addOn: false,
  autoEnable: false,
  items: [
    item({
      featureId: executions.id,
      included: 10000,
      price: {
        amount: 0.2,
        billingUnits: 1000,
        billingMethod: "usage_based",
        interval: "month",
      },
    }),
  ],
});

export const team = plan({
  id: "team",
  name: "Team",
  addOn: false,
  autoEnable: false,
  price: {
    amount: 150,
    interval: "month",
  },
  freeTrial: {
    durationLength: 14,
    durationType: "day",
    cardRequired: true,
  },
  items: [
    item({
      featureId: executions.id,
      included: 250000,
      price: {
        amount: 0.2,
        billingUnits: 1000,
        billingMethod: "usage_based",
        interval: "month",
      },
    }),
    item({
      featureId: domainVerification.id,
    }),
  ],
});

export const enterprise = plan({
  id: "enterprise",
  name: "Enterprise",
  addOn: false,
  autoEnable: false,
  items: [
    item({
      featureId: executions.id,
      unlimited: true,
      reset: {
        interval: "month",
      },
    }),
    item({
      featureId: domainVerification.id,
    }),
  ],
});
