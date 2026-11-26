import { expect, layer } from "@effect/vitest";
import { Effect, Fiber, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import type { Response } from "../support/platform.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { cloudLocks } from "../support/cloud-locks.ts";
import { connectionsPath, linkedAccountIds } from "../support/app-accounts.ts";
import { managementApp } from "../support/management-app.ts";

const managedName = "Executor app (created automatically)";
const replaceKeySentence =
  "This Executor API key was revoked, has expired or does not exist; unless Executor restores access by itself, create a new token on the Tokens page and connect it to the account that uses this key.";
const Keys = Schema.Struct({
  apiKeys: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.NullOr(Schema.String),
      expiresAt: Schema.NullOr(Schema.String),
      metadata: Schema.NullOr(
        Schema.Struct({
          organization: Schema.optional(Schema.String),
          executorApp: Schema.optional(Schema.Boolean),
        }),
      ),
    }),
  ),
});
const Created = Schema.Struct({ id: Schema.String, key: Schema.RedactedFromValue(Schema.String) });
const Identity = Schema.Struct({ organization: Schema.String, role: Schema.String });
const Connection = Schema.Struct({ id: Schema.String });
const Refused = Schema.Struct({
  _tag: Schema.Literal("AppProviderFailed"),
  reason: Schema.Literal("unauthorized"),
  account: Schema.Struct({ id: Schema.String }),
  upstream: Schema.Struct({ code: Schema.String, message: Schema.String }),
});
const Holder = Schema.Tuple([Schema.Struct({ pid: Schema.Number })]);
const Backends = Schema.Array(Schema.Struct({ pid: Schema.Number }));
const Generations = Schema.Tuple([Schema.Struct({ generations: Schema.NullOr(Schema.Unknown) })]);

const pinnedKeys = (actor: Session, organization: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const page = yield* body(
      Keys,
      yield* api.request(actor, "GET", "/api/auth/api-key/list?limit=100"),
    );
    return page.apiKeys.filter((key) => key.metadata?.organization === organization);
  });
const managedKeys = (actor: Session, organization: string) =>
  Effect.map(pinnedKeys(actor, organization), (keys) =>
    keys.filter((key) => key.name === managedName),
  );
const revokeKey = (actor: Session, keyId: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const revoked = yield* api.request(actor, "POST", "/api/auth/api-key/delete", { keyId });
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200);
  });
const ownToken = (actor: Session, organization: string, name: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    const created = yield* body(
      Created,
      yield* api.request(actor, "POST", "/api/auth/api-key/create", {
        name,
        metadata: { organization },
      }),
    );
    yield* Effect.addFinalizer(() =>
      api
        .request(actor, "POST", "/api/auth/api-key/delete", { keyId: created.id })
        .pipe(Effect.ignore),
    );
    return created;
  });
const restoredSentence =
  "Access was restored. This call was not repeated; earlier steps may have changed data. Check the result and retry only if the user chooses.";
const answeredOrRestored = (response: Response, organization: string, restored: string[]) =>
  Effect.gen(function* () {
    if (response.status === 200) {
      expect(yield* body(Identity, response)).toEqual({ organization, role: "owner" });
      return;
    }
    expect(response.status, JSON.stringify(response.body)).toBe(502);
    expect(response.body).toMatchObject({ reason: "unauthorized", credentialsRenewed: true });
    restored.push(JSON.stringify(response.body));
  });
const saidRestored = (restored: ReadonlyArray<string>) =>
  Effect.sync(() => {
    for (const text of restored) expect(text).toContain(restoredSentence);
  });
const contextRead = (actor: Session, path: string) =>
  Effect.flatMap(Api, (api) =>
    api.request(actor, "POST", `${path}/tools/call`, {
      tool: "context.get",
      kind: "query",
      input: {},
    }),
  );
const refusedRead = (actor: Session, path: string, account: string, attempt: string) =>
  Effect.gen(function* () {
    const refused = yield* contextRead(actor, path);
    expect(refused.status, `${attempt}: ${JSON.stringify(refused.body)}`).toBe(502);
    expect(refused.body, attempt).not.toHaveProperty("credentialsRenewed");
    const failure = yield* Schema.decodeUnknownEffect(Refused)(refused.body);
    expect(failure.account.id).toBe(account);
    expect(failure.upstream.code).toBe("Unauthorized");
    return failure;
  });

layer(HostedLive, { excludeTestServices: true })("Executor app key rows", (it) => {
  it.effect(scenarios.executorKeyReconnectDuringRenewal.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const organization = actors.organization.id;
        const { app, account } = yield* managementApp(actors.owner);
        const path = `/api/organizations/${organization}/apps/${app.id}`;
        const [original] = yield* managedKeys(actors.owner, organization);
        if (original === undefined) return yield* Effect.die("The managed key is missing");
        const own = yield* ownToken(actors.owner, organization, "Synthetic own token");
        const connection = yield* body(
          Connection,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {
            account,
          }),
        );
        yield* revokeKey(actors.owner, original.id);

        const locks = yield* cloudLocks;
        yield* Effect.addFinalizer(() => Effect.ignore(locks.release));
        const [holder] = yield* locks
          .hold({ sql: "select pg_backend_pid() as pid" })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Holder)), Effect.orDie);
        yield* locks.hold({
          sql: "select id from executor_accounts where id = $1 for update",
          params: [account],
        });
        const waiting = (statement: string, label: string, excluded: number) =>
          locks
            .run({
              sql: `select pid from pg_stat_activity
                where cardinality(pg_blocking_pids(pid)) > 0 and pid <> $1 and ${statement}`,
              params: [excluded],
            })
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Backends)),
              Effect.filterOrFail(
                (rows) => rows.length === 1,
                () => new Error(`${label} did not wait on the account row`),
              ),
              Effect.map((rows) => rows[0]!.pid),
              Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 150 }),
              Effect.orDie,
            );
        const renewal = yield* Effect.forkChild(contextRead(actors.owner, path));
        const renewing = yield* waiting(
          `${holder!.pid} = any(pg_blocking_pids(pid)) and query ilike '%from executor_accounts%for update%'`,
          "The renewal",
          holder!.pid,
        );
        const reconnect = yield* Effect.forkChild(
          api.request(
            actors.owner,
            "POST",
            `/api/organizations/${organization}/connections/${connection.id}/submit`,
            {
              method: "apiKey",
              label: "Synthetic own access",
              fields: { token: Redacted.value(own.key), organization },
            },
          ),
        );
        yield* waiting(
          `pid <> ${renewing} and (${holder!.pid} = any(pg_blocking_pids(pid)) or ${renewing} = any(pg_blocking_pids(pid))) and ltrim(query) ilike 'update%executor_accounts%'`,
          "The reconnect",
          holder!.pid,
        );
        yield* locks.release;

        const restored: string[] = [];
        yield* answeredOrRestored(yield* Fiber.join(renewal), organization, restored);
        const reconnected = yield* Fiber.join(reconnect);
        expect(reconnected.status, JSON.stringify(reconnected.body)).toBe(200);
        expect(yield* linkedAccountIds(actors.owner, path)).toEqual([account]);
        const minted = (yield* managedKeys(actors.owner, organization)).map((key) => key.id);
        expect(minted).toHaveLength(1);

        yield* revokeKey(actors.owner, own.id);
        for (const attempt of ["first", "second"]) {
          const failure = yield* refusedRead(actors.owner, path, account, attempt);
          expect(failure.upstream.message).toBe(replaceKeySentence);
          expect((yield* managedKeys(actors.owner, organization)).map((key) => key.id)).toEqual(
            minted,
          );
        }
        yield* saidRestored(restored);
      }),
    ),
  );

  it.effect(scenarios.executorKeyNameNotMarking.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const organization = actors.organization;
        const { app, account } = yield* managementApp(actors.owner);
        const path = `/api/organizations/${organization.id}/apps/${app.id}`;
        const [managed] = yield* managedKeys(actors.owner, organization.id);
        if (managed === undefined) return yield* Effect.die("The managed key is missing");
        const named = yield* ownToken(actors.owner, organization.id, "Synthetic ordinary token");
        const locks = yield* cloudLocks;
        yield* locks.run({
          sql: "update apikey set name = $1 where id = $2",
          params: [managedName, named.id],
        });

        yield* browser.login(actors.owner);
        yield* browser.use("Open the account Tokens page", (page) => page.goto("/account/tokens"));
        const rows = yield* browser.use("Both tokens with the name are listed", (page) => {
          const rows = page.getByRole("row").filter({ hasText: managedName });
          return rows
            .nth(1)
            .waitFor()
            .then(() => rows);
        });
        expect(yield* browser.use("Count the named rows", () => rows.count())).toBe(2);
        expect(
          yield* browser.use("Count the marked rows", () =>
            rows.filter({ hasText: "In use by the Executor app" }).count(),
          ),
        ).toBe(1);
        const ordinary = rows.filter({ hasNotText: "In use by the Executor app" });
        expect(yield* browser.use("Read the ordinary row", () => ordinary.innerText())).toContain(
          "Created by you",
        );
        yield* browser.use("Open the ordinary token's revoke dialog", () =>
          ordinary.getByRole("button", { name: `Revoke ${managedName}`, exact: true }).click(),
        );
        const dialog = yield* browser.use("The revoke dialog opens", (page) => {
          const dialog = page.getByRole("dialog");
          return dialog.waitFor().then(() => dialog);
        });
        const explanation = yield* browser.use("Read the revoke dialog", () => dialog.innerText());
        expect(explanation).toContain("Create and install a replacement first");
        expect(explanation).not.toContain("Executor creates a new key for the app automatically");
        yield* browser.use("Close the revoke dialog", (page) => page.keyboard.press("Escape"));
        const pinned = yield* pinnedKeys(actors.owner, organization.id);
        expect(pinned.find((key) => key.id === named.id)?.metadata?.executorApp).toBeUndefined();
        expect(pinned.find((key) => key.id === managed.id)?.metadata?.executorApp).toBe(true);

        const started = yield* body(
          Connection,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `/api/organizations/${organization.id}/connections/${started.id}/submit`,
          {
            method: "apiKey",
            label: "Synthetic named access",
            fields: { token: Redacted.value(named.key), organization: organization.id },
          },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        const linked = yield* linkedAccountIds(actors.owner, path);
        expect(linked).toHaveLength(1);
        expect(linked[0]).not.toBe(account);
        const answered = yield* contextRead(actors.owner, path);
        expect(answered.status, JSON.stringify(answered.body)).toBe(200);
        yield* revokeKey(actors.owner, named.id);
        for (const attempt of ["first", "second"]) {
          yield* refusedRead(actors.owner, path, linked[0]!, attempt);
          expect((yield* managedKeys(actors.owner, organization.id)).map((key) => key.id)).toEqual([
            managed.id,
          ]);
        }
      }),
    ),
  );

  it.effect(scenarios.executorKeyExistingOrFailedRenewal.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const organization = actors.organization.id;
        const { app, account } = yield* managementApp(actors.owner);
        const path = `/api/organizations/${organization}/apps/${app.id}`;
        const [key] = yield* managedKeys(actors.owner, organization);
        if (key === undefined) return yield* Effect.die("The managed key is missing");
        const locks = yield* cloudLocks;
        const keyIds = Effect.map(managedKeys(actors.owner, organization), (keys) =>
          keys.map((item) => item.id),
        );
        expect((yield* managedKeys(actors.owner, organization))[0]?.expiresAt).toBeNull();
        yield* locks.run({
          sql: "update apikey set enabled = false where id = $1",
          params: [key.id],
        });
        for (const attempt of ["first", "second"]) {
          yield* refusedRead(actors.owner, path, account, `disabled, ${attempt}`);
          expect(yield* keyIds).toEqual([key.id]);
        }
        yield* locks.run({
          sql: `update apikey set enabled = true, "expiresAt" = now() - interval '1 minute' where id = $1`,
          params: [key.id],
        });
        const restored: string[] = [];
        yield* answeredOrRestored(yield* contextRead(actors.owner, path), organization, restored);
        const recreated = yield* managedKeys(actors.owner, organization);
        expect(recreated).toHaveLength(1);
        expect(recreated[0]?.id).not.toBe(key.id);
        expect(recreated[0]?.expiresAt).toBeNull();
        const answered = yield* contextRead(actors.owner, path);
        expect(answered.status, JSON.stringify(answered.body)).toBe(200);

        yield* revokeKey(actors.owner, recreated[0]!.id);
        if (!/^[A-Za-z0-9_-]+$/.test(account)) return yield* Effect.die("Unexpected account ID");
        const suffix = randomUUID().replaceAll("-", "");
        const refusal = `e2e_refuse_account_${suffix}`;
        yield* Effect.addFinalizer(() =>
          Effect.ignore(
            Effect.andThen(
              locks.run({ sql: `drop trigger if exists ${refusal} on executor_accounts` }),
              locks.run({ sql: `drop function if exists ${refusal}()` }),
            ),
          ),
        );
        yield* locks.run({
          sql: `create function ${refusal}() returns trigger language plpgsql as $$
            begin raise exception 'synthetic failure after a key was minted'; end $$`,
        });
        yield* locks.run({
          sql: `create trigger ${refusal} before update on executor_accounts for each row
            when (old.id = '${account}') execute function ${refusal}()`,
        });
        const generations = locks
          .run({
            sql: `select metadata::jsonb -> 'executorKeyGenerations' as generations
              from "organization" where id = $1`,
            params: [organization],
          })
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Generations)), Effect.orDie);
        const before = yield* generations;
        for (const attempt of ["first", "second"]) {
          const failure = yield* refusedRead(actors.owner, path, account, `failing, ${attempt}`);
          expect(failure.upstream.message).toBe(replaceKeySentence);
          expect(yield* keyIds).toEqual([]);
          expect(yield* generations).toEqual(before);
        }
        yield* locks.run({ sql: `drop trigger ${refusal} on executor_accounts` });
        yield* answeredOrRestored(yield* contextRead(actors.owner, path), organization, restored);
        const later = yield* contextRead(actors.owner, path);
        expect(later.status, JSON.stringify(later.body)).toBe(200);
        expect(yield* body(Identity, later)).toEqual({ organization, role: "owner" });
        expect(yield* keyIds).toHaveLength(1);
        yield* saidRestored(restored);
      }),
    ),
  );
});
