import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { TestLive, withCase } from "../support/case.ts";
import { accountIdentityIssuer } from "../support/account-identity-issuer.ts";
import { accountIdentityProduct, IdentityAccount } from "../support/account-identity-product.ts";
import { body } from "../support/api.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { beforeAccountIdentities } from "../support/profile-removal-rollback.ts";
import { serverControl } from "../support/server-control.ts";
import { scenarios } from "../test-plan.ts";

layer(TestLive, { excludeTestServices: true })("Verified account identities", (it) => {
  it.effect(scenarios.accountIdentityUpgrade.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct;
        const app = yield* product.deploy(issuer.origin, "Retained identity", ["read"], {
          identity: undefined,
        });
        const before = yield* product.connect(app);
        expect(before.identity).toBeUndefined();
        yield* legacyStorage([
          ...beforeAccountIdentities(),
          { sql: "UPDATE private_executor_settings SET value = '4.0.16' WHERE key = 'version'" },
        ]);
        yield* serverControl("start");
        expect((yield* product.read(app)).status).toBe(200);
        // Adding identity discovery preserves the exact provider reference and the saved binding.
        expect(yield* product.deploy(issuer.origin, "Retained identity", ["read"], {}, app)).toBe(
          app,
        );
        const identified = yield* body(
          IdentityAccount,
          yield* product.request("POST", `/v1/accounts/${before.id}/identity`),
        );
        expect(identified.id).toBe(before.id);
        expect(identified.provider).toBe(before.provider);
        expect(identified.identity?.label).toBe("same@example.test");
        expect((yield* product.read(app)).status).toBe(200);
        const storage = yield* legacyStorage([
          { sql: "SELECT value FROM private_executor_settings WHERE key = 'version'" },
        ]);
        expect(storage).toEqual([[{ value: "4.0.24" }]]);
        yield* serverControl("start");
        expect((yield* product.read(app)).status).toBe(200);
        const again = yield* body(
          IdentityAccount,
          yield* product.request("GET", `/v1/accounts/${before.id}`),
        );
        expect(again.identity?.id).toBe(identified.identity?.id);
      }),
    ),
  );

  it.effect(scenarios.accountIdentityGrouping.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct;
        const ids: string[] = [],
          bindings: string[] = [];
        for (let index = 0; index < 5; index++) {
          const app = yield* product.deploy(issuer.origin, `Identity app ${index}`, [
            "read",
            "write",
          ]);
          const account = yield* product.connect(app);
          expect(account.identity?.label).toBe("same@example.test");
          if (account.identity === undefined)
            return yield* Effect.die("Verified identity was omitted");
          ids.push(account.identity.id);
          bindings.push(account.id);
          expect((yield* product.read(app)).status).toBe(200);
        }
        expect(new Set(ids).size).toBe(1);
        expect(new Set(bindings).size).toBe(5);
        yield* issuer.configure({ subject: "person-two" });
        const second = yield* product.connect(
          yield* product.deploy(issuer.origin, "Second identity", ["read"]),
        );
        expect(second.identity?.label).toBe("same@example.test");
        expect(second.identity?.id).not.toBe(ids[0]);
        const other = yield* accountIdentityIssuer;
        const provider = yield* product.connect(
          yield* product.deploy(other.origin, "Other provider", ["read"]),
        );
        expect(provider.identity?.id).not.toBe(ids[0]);
        expect(provider.identity?.id).not.toBe(second.identity?.id);
      }),
    ),
  );
  it.effect(scenarios.accountGrantReuse.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct;
        yield* issuer.configure({ expiresIn: 20 });
        const firstApp = yield* product.deploy(issuer.origin, "Grant source", ["read", "write"]);
        const first = yield* product.connect(firstApp);
        const secondApp = yield* product.deploy(issuer.origin, "Grant borrower", ["read"]);
        const before = yield* issuer.metrics;
        const reused = yield* product.reuse(secondApp, first.id);
        expect(reused.status).toBe("completed");
        if (reused.status !== "completed")
          return yield* Effect.die("Covering grant was not reused");
        expect(reused.account.id).not.toBe(first.id);
        expect(reused.account.identity?.id).toBe(first.identity?.id);
        expect((yield* issuer.metrics).authorizations).toBe(before.authorizations);
        // Both invocations resolve one refresh lock, including the first token's early-renewal window.
        const results = yield* Effect.all([product.read(firstApp), product.read(secondApp)], {
          concurrency: 2,
        });
        for (const result of results) expect(result.status, JSON.stringify(result.body)).toBe(200);
        expect((yield* issuer.metrics).refreshes).toBe(1);
        yield* serverControl("restart");
        expect((yield* product.read(firstApp)).status).toBe(200);
        expect((yield* product.read(secondApp)).status).toBe(200);
        // Reconnecting one binding as another subject must leave its sibling on the old grant.
        yield* issuer.configure({ subject: "person-two", expiresIn: 3600 });
        const reconnect = yield* product.connection(firstApp, first.id);
        const changed = yield* product.consent(reconnect);
        expect(changed.status, JSON.stringify(changed.body)).toBe(200);
        const readSubject = Schema.Struct({ value: Schema.Struct({ subject: Schema.String }) });
        expect((yield* body(readSubject, yield* product.read(firstApp))).value.subject).toBe(
          "person-two",
        );
        expect((yield* body(readSubject, yield* product.read(secondApp))).value.subject).toBe(
          "person-one",
        );
        const revocations = (yield* issuer.metrics).revocations;
        expect((yield* product.remove(first.id)).status).toBe(200);
        yield* issuer.awaitRevocation;
        expect((yield* issuer.metrics).revocations).toBe(revocations + 1);
        expect((yield* product.read(secondApp)).status).toBe(200);
        expect((yield* product.remove(reused.account.id)).status).toBe(200);
        yield* issuer.awaitRevocation;
        expect((yield* issuer.metrics).revocations).toBe(revocations + 2);
      }),
    ),
  );
  it.effect(scenarios.accountGrantRefusal.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const issuer = yield* accountIdentityIssuer,
          product = yield* accountIdentityProduct;
        const readApp = yield* product.deploy(issuer.origin, "Read grant", ["read"]);
        const read = yield* product.connect(readApp);
        const write = yield* product.connect(
          yield* product.deploy(issuer.origin, "Write grant", ["write"]),
        );
        expect(read.identity?.id).toBe(write.identity?.id);
        const combined = yield* product.deploy(issuer.origin, "Combined scopes", ["read", "write"]);
        expect(yield* product.reuse(combined, read.id)).toEqual({
          status: "consent-required",
          reason: "scopes",
        });
        expect(yield* product.reuse(combined, write.id)).toEqual({
          status: "consent-required",
          reason: "scopes",
        });
        const differentResource = yield* product.deploy(
          issuer.origin,
          "Different resource",
          ["read"],
          { resource: issuer.origin + "/other" },
        );
        expect(yield* product.reuse(differentResource, read.id)).toEqual({
          status: "consent-required",
          reason: "resource",
        });
        // A failed authenticated profile lookup cannot overwrite a working binding.
        yield* issuer.configure({ subject: "person-two", profileFails: true });
        const reconnect = yield* product.connection(readApp, read.id);
        expect((yield* product.consent(reconnect)).status).not.toBe(200);
        const retained = yield* body(
          IdentityAccount,
          yield* product.request("GET", `/v1/accounts/${read.id}`),
        );
        expect(retained.identity?.id).toBe(read.identity?.id);
        expect((yield* product.read(readApp)).status).toBe(200);
        yield* issuer.configure({ profileFails: false, denied: true });
        expect(
          (yield* product.consent(yield* product.connection(readApp, read.id))).status,
        ).not.toBe(200);
        expect((yield* product.read(readApp)).status).toBe(200);
        yield* issuer.configure({ denied: false, expiresIn: 20 });
        const narrowing = yield* product.deploy(issuer.origin, "Narrowing grant", [
          "read",
          "write",
        ]);
        const source = yield* product.connect(narrowing);
        const reader = yield* product.deploy(issuer.origin, "Narrowed reader", ["read"]);
        expect((yield* product.reuse(reader, source.id)).status).toBe("completed");
        yield* issuer.configure({ scopes: ["read"] });
        // The first refresh result must enforce its new scope set before the app receives credentials.
        expect((yield* product.read(narrowing)).status).not.toBe(200);
        expect((yield* product.read(reader)).status).toBe(200);
      }),
    ),
  );
});
