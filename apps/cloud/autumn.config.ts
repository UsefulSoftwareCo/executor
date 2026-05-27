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

// Plans
export const free = plan({
  id: "free",
  name: "Free",
  autoEnable: true,
  items: [
    item({
      featureId: executions.id,
      included: 10000,
      reset: { interval: "month" },
    }),
  ],
});

export const freePayAsYouGo = plan({
  id: "free-pay-as-you-go",
  name: "Free Pay As You Go",
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
  price: {
    amount: 49,
    interval: "month",
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
  items: [
    item({
      featureId: executions.id,
      unlimited: true,
      reset: { interval: "month" },
    }),
    item({
      featureId: domainVerification.id,
    }),
  ],
});
