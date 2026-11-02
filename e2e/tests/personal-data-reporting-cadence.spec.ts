/** Cadence and retry rules are observed through real OAuth, health and scheduled HTTP traffic. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { reportingCase } from "../support/personal-data-reporting.ts";
import { scenarios } from "../test-plan.ts";

layer(HostedLive, { excludeTestServices: true })("Reporting cadence", (it) => {
  it.effect(scenarios.personalDataReconnectCadence.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* reportingCase;
        expect((yield* fixture.run).reportingRequests).toHaveLength(1);
        expect(yield* fixture.connect(fixture.account)).toBe(fixture.account);
        expect((yield* fixture.run).reportingRequests).toHaveLength(1);
      }),
    ),
  );
  it.effect(scenarios.personalDataOldestIdentity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* reportingCase;
        const checked = yield* fixture.api.request(
          fixture.owner,
          "POST",
          `${fixture.accountPath}/health`,
        );
        expect(checked.status, JSON.stringify(checked.body)).toBe(200);
        const health = yield* body(Schema.Struct({ infoCheckedAt: Schema.String }), checked);
        const metrics = yield* fixture.run;
        expect(metrics.reportingRequests).toHaveLength(1);
        const updatedAt = metrics.reportingRequests[0]?.accounts[0]?.updatedAt;
        expect(updatedAt).toBeDefined();
        expect(Date.parse(updatedAt ?? "")).toBeLessThanOrEqual(Date.parse(health.infoCheckedAt));
      }),
    ),
  );
  it.effect(scenarios.personalDataRetryCadence.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* reportingCase;
        yield* fixture.issuer.configure({ reportingFailure: { status: 429, retryAfter: "0" } });
        expect((yield* fixture.run).reportingRequests).toHaveLength(1);
        yield* fixture.issuer.configure({ reportingFailure: { status: 429, retryAfter: "3600" } });
        expect((yield* fixture.run).reportingRequests).toHaveLength(2);
        expect((yield* fixture.run).reportingRequests).toHaveLength(2);
      }),
    ),
  );
  it.effect(scenarios.personalDataBatching.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* reportingCase;
        const subjects = ["reporting-cycle-subject"];
        for (let index = 1; index <= 90; index++) {
          const subject = `reporting-batch-subject-${index}`;
          subjects.push(subject);
          yield* fixture.issuer.configure({ reportingAccountId: subject });
          yield* fixture.connect();
        }
        const reported = (yield* fixture.run).reportingRequests;
        expect(reported).toHaveLength(2);
        expect(reported.every((request) => request.accounts.length <= 90)).toBe(true);
        expect(
          reported
            .flatMap((request) => request.accounts.map((account) => account.accountId))
            .toSorted(),
        ).toEqual(subjects.toSorted());
        expect((yield* fixture.run).reportingRequests).toHaveLength(2);
      }),
    ),
  );
  it.effect(scenarios.personalDataOwnerIsolation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const fixture = yield* reportingCase;
        yield* fixture.issuer.configure({ reportingAccountId: "reporting-peer-subject" });
        const otherOrganization = yield* body(
          Schema.Struct({ id: Schema.String }),
          yield* fixture.api.request(fixture.peer, "POST", "/api/auth/organization/create", {
            name: "Reporting boundary",
            slug: "reporting-boundary",
            keepCurrentActiveOrganization: true,
          }),
        );
        const peerAccount = yield* fixture.connectInOrganization(
          otherOrganization.id,
          fixture.peer,
        );
        const reported = (yield* fixture.run).reportingRequests;
        expect(reported).toHaveLength(2);
        for (const request of reported) {
          expect(request.accounts).toHaveLength(1);
          expect(request.reporterSubject).toBe(request.accounts[0]?.accountId);
        }
        expect(
          reported
            .flatMap((request) => request.accounts.map((entry) => entry.accountId))
            .toSorted(),
        ).toEqual(["reporting-cycle-subject", "reporting-peer-subject"]);
        expect(
          (yield* fixture.api.request(
            fixture.peer,
            "GET",
            `/api/organizations/${otherOrganization.id}/accounts/${peerAccount}`,
          )).status,
        ).toBe(200);
        expect(
          (yield* fixture.api.request(
            fixture.owner,
            "GET",
            `/api/organizations/${otherOrganization.id}/accounts/${peerAccount}`,
          )).status,
        ).not.toBe(200);
      }),
    ),
  );
});
