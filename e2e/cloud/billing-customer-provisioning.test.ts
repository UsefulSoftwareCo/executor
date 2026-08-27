// Cloud-only (billing): an organization must EXIST as a customer at the billing
// provider, or every billing call for it answers `customer_not_found` forever.
//
// That state is invisible from the product side and catastrophic underneath it:
// the balance gate fails open (by design — a billing outage must not stop
// executions), and usage tracking is fire-and-forget, so the org runs unlimited
// executions and NONE of them reach the meter. The product looks perfectly
// healthy while every execution is unbilled and unmetered.
//
// Three guarantees are pinned here, all read from Autumn's own state rather than
// from the execution's response (which can never show any of them):
//
//   1. creating an organization provisions its billing customer up front,
//   2. if a customer is missing anyway, the billing seam heals it in place and
//      the execution still lands on the meter, and
//   3. any OTHER billing failure is left alone — the repair is scoped to the
//      "no such customer" answer, so a real provider failure is still reported
//      rather than quietly retried away.
//
// The missing customer is produced with the emulator's fault injector — one
// 404 `customer_not_found` per billing endpoint — because the emulator, like
// real Autumn's SDK flow, otherwise auto-creates customers on contact.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { scenario } from "../src/scenario";
import { Autumn, Billing, Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

/** The org the bearer is scoped to — the Autumn customer id every billing call
 *  is made against — read from the JWT's public claims. */
const orgIdOf = (bearer: string): string => {
  const claims = JSON.parse(Buffer.from(bearer.split(".")[1] ?? "", "base64url").toString()) as {
    readonly org_id?: string;
  };
  if (!claims.org_id) throw new Error("orgIdOf: bearer carries no org_id claim");
  return claims.org_id;
};

/** A 404 `customer_not_found`, byte-for-byte the shape Autumn answers with for
 *  an organization it has no customer record for. */
const CUSTOMER_NOT_FOUND = {
  status: 404,
  body: { message: "Customer not found", code: "customer_not_found" },
} as const;

/** A 404 that is NOT a missing customer — a moved route, a proxy, a gateway.
 *  Autumn carries a different code, and that code is the entire safety margin
 *  between "provision and retry" and "quietly retry away a real failure". */
const UNRELATED_NOT_FOUND = {
  status: 404,
  body: { message: "Not Found", code: "not_found" },
} as const;

scenario(
  "Billing · creating an organization provisions it as a billing customer",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const mcp = yield* Mcp;

    // A brand-new user creating their first organization: none of the
    // opportunistic billing lookups (the over-the-free-limit check, the members
    // page's seat count, the rate limiter's paid-plan exemption) are reached on
    // this journey, so org creation is the only chance to provision.
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const organizationId = orgIdOf(bearer);

    const customerIds = yield* autumn.customerIds();
    expect(
      customerIds,
      "the new organization exists as a customer at the billing provider",
    ).toContain(organizationId);
  }),
);

scenario(
  "Billing · a missing billing customer is healed in place and the execution is still metered",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const customerId = orgIdOf(bearer);

    const before = yield* autumn.usageEvents({ customerId, featureId: "executions" });
    expect(before.length, "a brand-new org starts with zero metered executions").toBe(0);

    yield* Effect.gen(function* () {
      // One 404 each: the next balance check and the next usage track both
      // answer "this customer does not exist". A single `times: 1` fault means
      // a seam that heals and retries gets through, while one that gives up
      // loses the usage permanently — exactly the production failure.
      yield* autumn.armFault({
        match: { operationId: "balances.check" },
        response: CUSTOMER_NOT_FOUND,
        times: 1,
      });
      yield* autumn.armFault({
        match: { operationId: "balances.track" },
        response: CUSTOMER_NOT_FOUND,
        times: 1,
      });

      const session = mcp.session(identity);
      const result = yield* session.call("execute", { code: "return 6 * 7;" });

      // The gate still fails open: a billing problem never blocks a customer.
      expect(result.ok, "the execution runs despite the missing billing customer").toBe(true);
      expect(result.text, "it returns its value").toContain("42");

      // Both billing calls really did reach Autumn and really were rejected —
      // without this the scenario could pass on a fault that never armed.
      const checks = yield* autumn.ledgerFor("balances.check");
      expect(
        checks.some((entry) => entry.faulted),
        "the balance check reached Autumn and was answered customer_not_found",
      ).toBe(true);
      const tracks = yield* autumn.ledgerFor("balances.track");
      expect(
        tracks.some((entry) => entry.faulted),
        "the usage track reached Autumn and was answered customer_not_found",
      ).toBe(true);

      // The guarantee: the seam provisions the customer and retries, so the
      // execution lands on the meter. Before the fix this ledger stays empty
      // forever — the execution ran, and nobody was ever billed for it.
      const metered = yield* autumn.expectUsage({
        customerId,
        featureId: "executions",
        count: 1,
      });
      expect(metered.length, "the execution is metered exactly once").toBe(1);
      expect(metered[0]?.value, "it meters a single unit").toBe(1);

      // Healing the customer is what made the retry possible, so the customer
      // must exist at the provider afterwards.
      const customerIds = yield* autumn.customerIds();
      expect(customerIds, "the organization has a billing customer afterwards").toContain(
        customerId,
      );
    }).pipe(Effect.ensuring(autumn.clearFaults().pipe(Effect.ignore)));
  }),
);

scenario(
  "Billing · an unrelated billing failure is reported, not retried away",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const mcp = yield* Mcp;

    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const customerId = orgIdOf(bearer);

    yield* Effect.gen(function* () {
      // A 404 that is not "no such customer". If the seam treated every 404 as
      // a provisioning gap it would create a customer and retry, turning a real
      // provider failure into a silent success — and the alert never fires.
      yield* autumn.armFault({
        match: { operationId: "balances.track" },
        response: UNRELATED_NOT_FOUND,
        times: 1,
      });

      const session = mcp.session(identity);
      const faulted = yield* session.call("execute", { code: "return 1 + 1;" });
      expect(faulted.ok, "the execution runs — billing never blocks a customer").toBe(true);

      // A second, unfaulted execution. Its usage landing is the barrier: the
      // first execution's track (and any retry of it) is already done by the
      // time this one is on the meter, so the counts below are settled without
      // waiting on a clock.
      const clean = yield* session.call("execute", { code: "return 2 + 2;" });
      expect(clean.ok, "the follow-up execution runs too").toBe(true);
      yield* autumn.expectUsage({ customerId, featureId: "executions", count: 1 });

      const tracks = (yield* autumn.ledgerFor("balances.track")).filter(
        (entry) => entry.customerId === customerId,
      );
      expect(
        tracks.filter((entry) => entry.faulted).length,
        "the first usage track was answered with the unrelated 404",
      ).toBe(1);
      // Two executions, two attempts: the failed one was reported and dropped,
      // not repaired and replayed.
      expect(tracks.length, "the rejected usage track is not retried").toBe(2);

      const metered = yield* autumn.usageEvents({ customerId, featureId: "executions" });
      expect(metered.length, "only the unfaulted execution reaches the meter").toBe(1);
    }).pipe(Effect.ensuring(autumn.clearFaults().pipe(Effect.ignore)));
  }),
);
