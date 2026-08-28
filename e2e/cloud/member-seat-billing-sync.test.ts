// Cloud-only (billing): seat-based pricing bills the seat count Autumn holds,
// so that count must actually REACH Autumn. Seats change through paths the
// app never sees a mutation for (invitation acceptance in AuthKit, SSO JIT
// provisioning, join by domain), so the app reconciles instead of tracking
// deltas: it recounts active members from WorkOS and SETS the members balance
// (`balances.update`), forked off org creation, login, invitation acceptance,
// and member removal.
//
// Three guarantees are pinned here, all read from Autumn's own state (the
// mutating responses can never show them):
//
//   1. creating an organization lands its creator's seat on the members
//      balance,
//   2. a pending invite occupies a plan-gate seat but is NOT billed — active
//      members only, and
//   3. a later membership mutation reconciles rather than increments: the
//      recount after removing the pending membership still reports exactly
//      the active seats.
import { expect } from "@effect/vitest";
import { Effect, Schedule } from "effect";
import { AccountHttpApi } from "@executor-js/api";

import { scenario } from "../src/scenario";
import { Api, Autumn, Billing, Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

// apps/cloud/src/extensions/billing/plans.ts → MEMBER_LIMITS.free, mirrored by
// the free plan's members item in autumn.config.ts.
const FREE_MEMBER_SEATS = 3;

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

scenario(
  "Billing · the billed seat count reaches Autumn: active members only, reconciled not incremented",
  { timeout: 180_000 },
  Effect.gen(function* () {
    yield* Billing;
    const autumn = yield* Autumn;
    const target = yield* Target;
    const mcp = yield* Mcp;
    const { client: apiClient } = yield* Api;

    // A fresh user who owns a brand-new free org. Creating the org forks the
    // first seat recount, so the creator's seat is on the meter before anyone
    // is invited.
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));
    const customerId = orgIdOf(bearer);
    const client = yield* apiClient(AccountHttpApi, identity);

    const seats = yield* autumn.expectMemberSeats(customerId, 1);
    expect(seats.granted, "the free plan's members item grants the advertised seats").toBe(
      FREE_MEMBER_SEATS,
    );
    expect(seats.unlimited, "free-plan seats are capped, not unlimited").toBe(false);

    // An outstanding invite: the plan gate charges it a seat (so the org
    // cannot invite past the cap), but billing counts active members only —
    // nobody pays for a person who has not joined.
    yield* client.account.inviteMember({ payload: { email: "invited@example.com" } });
    const { members, seats: gateSeats } = yield* client.account.listMembers();
    expect(gateSeats?.used, "the plan gate counts the pending invite as a seat").toBe(2);
    const billedWithPendingInvite = yield* autumn.memberSeats(customerId);
    expect(billedWithPendingInvite?.usage, "the pending invite is not billed").toBe(1);

    // Removing the pending membership forks another recount. Its ledger entry
    // is the barrier that separates "not billed yet" from "never billed": once
    // the second reconciliation has landed, the balance is the recount's
    // answer, not a stale read.
    const pending = members.find((member) => member.status === "pending");
    expect(pending, "the invited person appears as a pending membership").toBeTruthy();
    yield* client.account.removeMember({ params: { membershipId: pending!.id } });

    yield* autumn.ledgerFor("balances.update").pipe(
      Effect.map((entries) => entries.filter((entry) => entry.customerId === customerId)),
      Effect.filterOrFail(
        (entries) => entries.length >= 2,
        (entries) => `only ${entries.length}/2 seat reconciliations reached Autumn`,
      ),
      Effect.retry(Schedule.both(Schedule.spaced("500 millis"), Schedule.recurs(40))),
    );

    const reconciled = yield* autumn.memberSeats(customerId);
    expect(
      reconciled?.usage,
      "the recount reconciles to the active seats — it never counted the invite, so it has nothing to walk back",
    ).toBe(1);

    // The balance moved by reconciliation events, not blind increments: one
    // adjustment for the creator's seat, and none for the no-op recount.
    const events = yield* autumn.usageEvents({ customerId, featureId: "members" });
    expect(
      events.map((event) => event.value),
      "one +1 adjustment for the creator; the no-op recount writes no event",
    ).toEqual([1]);
  }),
);
