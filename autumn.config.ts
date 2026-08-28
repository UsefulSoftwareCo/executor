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
});

// Plans
export const free = plan({
  id: "free",
  name: "Free",
  addOn: false,
  autoEnable: true,
  items: [
    item({
      featureId: members.id,
      included: 3,
    }),
    item({
      featureId: executions.id,
      included: 100000,
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
      included: 100000,
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
  freeTrial: {
    durationLength: 14,
    durationType: "day",
    cardRequired: true,
  },
  items: [
    // Billed in arrears on the seat count the app reports (active members
    // only — see apps/cloud/src/extensions/billing/member-seats.ts).
    item({
      featureId: members.id,
      included: 0,
      price: {
        amount: 15,
        billingUnits: 1,
        billingMethod: "usage_based",
        interval: "month",
      },
    }),
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

export const enterprise = plan({
  id: "enterprise",
  name: "Enterprise",
  addOn: false,
  autoEnable: false,
  items: [
    // Seat usage is tracked for visibility; pricing is set per contract at
    // attach time, so the plan itself carries no price.
    item({
      featureId: members.id,
      unlimited: true,
    }),
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
