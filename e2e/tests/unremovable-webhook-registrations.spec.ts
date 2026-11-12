/**
 * Before #3915, an app-account webhook that registered after its source lost its app link saved
 * the registration with the app's remaining links, without its source. The apps framework refuses
 * every webhook command whose source is not among its accounts, so removing it was refused on every
 * attempt: it stayed `stopping` with failure `unregister`, and its app could not be removed. Data
 * step `11_unremovable_webhook_registrations` disables each such subscription, so a person removes
 * it at the provider and confirms, as Executor asks for any registration it can no longer remove.
 *
 * The fixed product can no longer save such a registration, so the fixture lets the product put a
 * subscription into `stopping` with failure `unregister` itself (the app's provider fails for that
 * account), then writes the one column the race wrote differently: the saved accounts, as a
 * registration that ran after the source's link went saved them.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Api, body, type Session } from "../support/api.ts";
import { TestLive, withCase, withHostedCase } from "../support/case.ts";
import { appLinksFixture, keyProvider, ok, okBody } from "../support/app-links.ts";
import { connectAccountsThroughOtherApp, unlinkAccount } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { App } from "../support/contracts.ts";
import type { Evidence } from "../support/evidence.ts";
import { linkLocal, localAgent, localAppPath } from "../support/local-links.ts";
import { nextDataStepSummary, dataStepSummaries } from "../support/data-steps.ts";
import { legacyStorage } from "../support/legacy-storage.ts";
import { Target } from "../support/platform.ts";
import { serverControl } from "../support/server-control.ts";
import {
  removeAppWhenStopped,
  settleWebhookSubscriptions,
  webhookSubscriptions,
  type WebhookSubscriptionRow,
} from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";

const step = "11_unremovable_webhook_registrations";

const provider = keyProvider("Unremovable webhook fixture");
/** An app-account webhook whose provider refuses every call for an account keyed `provider-down`. */
const source = `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = ${provider};
const down = (input) => input.account.fields.token === "provider-down";
const incoming = { account: { app: "svc" }, config: object({}), state: object({}),
  register: async (_ctx, input) => { if (down(input)) throw new Error("synthetic provider outage"); return {}; },
  unregister: async (_ctx, input) => { if (down(input)) throw new Error("synthetic provider outage"); },
  handle: async () => Response.json({}) };
export default defineApp({ app: { accounts: { svc: team.many() } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }), webhooks: { incoming } }));`;

const Stored = Schema.Struct({
  id: Schema.String,
  status: Schema.String,
  failure: Schema.NullOr(Schema.String),
  registered_accounts: Schema.Unknown,
  revision: Schema.String,
});
const Status = Schema.Struct({ status: Schema.String });

/** The services a host's operations use. */
type Needs = Api | Evidence | HttpClient.HttpClient | Target;

/** One statement against the stopped product's tables. */
interface Statement {
  readonly sql: string;
  readonly params?: ReadonlyArray<string>;
}

/** How a host's app links, unlinks, confirms a removal at the provider and removes the app. */
interface Host {
  readonly actor: Session;
  /** The path whose `webhooks` lists the app's subscriptions. */
  readonly path: string;
  /** Save an account with this token and link it to the app's `svc` requirement for everyone. */
  readonly link: (token: string) => Effect.Effect<string, unknown, Needs>;
  readonly unlink: (account: string) => Effect.Effect<unknown, unknown, Needs>;
  readonly confirm: (subscription: string) => Effect.Effect<string, unknown, Needs>;
  /** One attempt to remove the app; its HTTP status. */
  readonly remove: Effect.Effect<number, unknown, Needs>;
  /** The runner's write to the stopped product's database (`legacyStorage`). */
  readonly storage: (
    statements: readonly [Statement, ...Statement[]],
  ) => Effect.Effect<ReadonlyArray<ReadonlyArray<Record<string, unknown>>>, unknown, Needs>;
}

/**
 * Put one subscription into the stuck state, report and apply the step, run it again, and remove the
 * app once a person confirms. Healthy and merely stopping subscriptions are left as they were.
 */
const journey = (host: Host) =>
  Effect.gen(function* () {
    const target = yield* Target;
    const log = `${target.directory}/server.log`;
    const hookOf = (rows: readonly WebhookSubscriptionRow[], account: string) => {
      const hook = rows.find((row) => row.sourceAccount === account);
      if (hook === undefined) throw new Error("Webhook subscription missing");
      return hook;
    };
    const settled = (expected: Record<string, { status: string; failure: string | null }>) =>
      settleWebhookSubscriptions(host.actor, host.path, (rows) =>
        Object.entries(expected).every(([account, state]) =>
          rows.some(
            (row) =>
              row.sourceAccount === account &&
              row.status === state.status &&
              row.failure === state.failure,
          ),
        ),
      );
    const stored = (ids: ReadonlyArray<string>) =>
      host
        .storage([
          {
            sql: `SELECT id, status, failure, registered_accounts, revision FROM executor_webhooks
            WHERE id = ANY($1::text[]) ORDER BY id`,
            params: [`{${ids.join(",")}}`],
          },
        ])
        .pipe(
          Effect.flatMap(([rows = []]) => Schema.decodeUnknownEffect(Schema.Array(Stored))(rows)),
          Effect.orDie,
        );

    // Two healthy app links, each registered with the app's links at the time.
    const healthy = yield* host.link("healthy");
    const merely = yield* host.link("merely-stopping");
    yield* settled({
      [healthy]: { status: "active", failure: null },
      [merely]: { status: "active", failure: null },
    });
    // A third whose provider is down: its registration saves all three links and fails.
    const stuck = yield* host.link("provider-down");
    yield* settled({ [stuck]: { status: "pending", failure: "register" } });
    // Unlinking it removes its registration with those accounts, which the provider refuses: the
    // product leaves it stopping with failure `unregister`, as the race did.
    yield* host.unlink(stuck);
    const before = yield* settled({ [stuck]: { status: "stopping", failure: "unregister" } });
    const stuckHook = hookOf(before, stuck),
      healthyHook = hookOf(before, healthy),
      merelyHook = hookOf(before, merely);

    const seen = (yield* dataStepSummaries(log, step)).length;
    // What the race saved: the app's links once the source's had gone. The other subscription waits
    // for a provider that is down, a removal the product's next attempt finishes.
    yield* host.storage([
      {
        sql: `UPDATE executor_webhooks SET registered_accounts = $2::json WHERE id = $1`,
        params: [stuckHook.id, JSON.stringify({ svc: [healthy, merely] })],
      },
      {
        sql: `UPDATE executor_webhooks SET status = 'stopping', failure = 'unregister' WHERE id = $1`,
        params: [merelyHook.id],
      },
    ]);
    const ids = [stuckHook.id, healthyHook.id, merelyHook.id];
    const written = yield* stored(ids);
    const rowOf = (rows: ReadonlyArray<typeof Stored.Type>, id: string) =>
      rows.find((row) => row.id === id);
    // The stuck subscription's source keeps retrying its removal, and each attempt's claim gives it
    // a new revision; nothing retries the other two, which stay exactly as written.
    const state = (rows: ReadonlyArray<typeof Stored.Type>) =>
      rows.map(({ id, status, failure, registered_accounts }) => ({
        id,
        status,
        failure,
        registered_accounts,
      }));
    const unchanged = (rows: ReadonlyArray<typeof Stored.Type>, earlier: typeof rows) => {
      expect(state(rows)).toEqual(state(earlier));
      for (const id of [healthyHook.id, merelyHook.id])
        expect(rowOf(rows, id)).toEqual(rowOf(earlier, id));
    };

    // A report names the one unremovable registration and writes nothing.
    yield* serverControl("start");
    expect(yield* nextDataStepSummary(log, step, seen)).toMatchObject({
      mode: "report",
      status: "complete",
      outcomes: { would_disable: 1 },
    });
    // Its app cannot be removed.
    expect(yield* host.remove).toBe(409);
    unchanged(yield* stored(ids), written);

    // Applying it disables only that subscription, keeping its saved registration.
    const reported = (yield* dataStepSummaries(log, step)).length;
    yield* serverControl("data-steps", 200, { mode: "apply" });
    yield* serverControl("start");
    expect(yield* nextDataStepSummary(log, step, reported)).toMatchObject({
      mode: "apply",
      status: "complete",
      outcomes: { disabled: 1 },
    });
    const after = yield* webhookSubscriptions(host.actor, host.path);
    expect(hookOf(after, stuck)).toMatchObject({ status: "disabled", failure: null });
    expect(hookOf(after, healthy)).toMatchObject({ status: "active", failure: null });
    expect(hookOf(after, merely)).toMatchObject({ status: "stopping", failure: "unregister" });
    const applied = yield* stored(ids);
    expect(rowOf(applied, stuckHook.id)).toMatchObject({
      status: "disabled",
      failure: null,
      registered_accounts: rowOf(written, stuckHook.id)?.registered_accounts,
    });
    expect(rowOf(applied, stuckHook.id)?.revision).not.toBe(rowOf(written, stuckHook.id)?.revision);
    expect(rowOf(applied, healthyHook.id)).toEqual(rowOf(written, healthyHook.id));
    expect(rowOf(applied, merelyHook.id)).toEqual(rowOf(written, merelyHook.id));

    // Running again changes nothing: an applied step does not run again, and a report after it
    // finds nothing left to disable. Startup runs data steps before the product serves.
    const appliedPasses = (yield* dataStepSummaries(log, step)).length;
    yield* serverControl("start");
    expect((yield* dataStepSummaries(log, step)).length).toBe(appliedPasses);
    yield* serverControl("stop");
    yield* serverControl("data-steps", 200, { mode: "report" });
    yield* serverControl("start");
    expect(yield* nextDataStepSummary(log, step, appliedPasses)).toMatchObject({
      mode: "report",
      status: "complete",
      outcomes: {},
    });
    unchanged(yield* stored(ids), applied);
    yield* serverControl("start");

    // A person removes it at the provider and confirms. The product's next removal of the merely
    // stopping one succeeds now that its provider answers, and the app can be removed.
    expect(yield* host.confirm(stuckHook.id)).toBe("stopped");
    yield* host.unlink(merely);
    yield* host.unlink(healthy);
    yield* settled({
      [stuck]: { status: "stopped", failure: null },
      [merely]: { status: "stopped", failure: null },
      [healthy]: { status: "stopped", failure: null },
    });
    expect(yield* host.remove).toBe(200);
  });

layer(TestLive, { excludeTestServices: true })("Unremovable webhook registrations", (it) => {
  it.effect(scenarios.unremovableWebhookRegistrations.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, path, connect, unlink } = yield* appLinksFixture([
          { path: "index.ts", content: source },
        ]);
        yield* journey({
          actor: actors.owner,
          path,
          link: (token) => connect(actors.owner, "app", "svc", token),
          unlink: (account) => unlink(actors.owner, "svc", account).pipe(Effect.flatMap(ok)),
          confirm: (subscription) =>
            api
              .request(actors.owner, "POST", `${path}/webhooks/${subscription}/confirm-removal`)
              .pipe(
                Effect.flatMap((response) => okBody(Status, response)),
                Effect.map((result) => result.status),
              ),
          remove: removeAppOnce(actors.owner, path),
          storage: legacyStorage,
        });
      }),
    ),
  );

  it.effect(scenarios.localUnremovableWebhookRegistrations.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { api, agent } = yield* localAgent;
        const deployed = yield* api.request(agent, "POST", "/v1/apps/deploy", {
          owner: "local",
          name: `Unremovable webhooks ${randomUUID().slice(0, 8)}`,
          files: [{ path: "index.ts", content: source }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Schema.Struct({ app: App }), deployed);
        const path = localAppPath(app.id);
        const accounts: string[] = [];
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            yield* removeAppWhenStopped(agent, `/v1/apps/${app.id}`);
            for (const account of accounts)
              yield* api.request(agent, "DELETE", `/dashboard/api/accounts/${account}`);
          }).pipe(Effect.orDie),
        );
        yield* journey({
          actor: agent,
          path,
          link: (token) =>
            Effect.gen(function* () {
              const [saved] = yield* connectAccountsThroughOtherApp(agent, {
                provider,
                method: "key",
                accounts: [{ label: token, fields: { token } }],
              });
              if (saved === undefined) return yield* Effect.die("Account fixture missing");
              accounts.push(saved.id);
              yield* linkLocal(agent, app.id, "svc", saved.id, "app");
              return saved.id;
            }),
          unlink: (account) => unlinkAccount(agent, path, "svc", account, "app"),
          confirm: (subscription) =>
            api
              .request(agent, "POST", `/v1/apps/${app.id}/webhooks/${subscription}/confirm-removal`)
              .pipe(
                Effect.flatMap((response) => okBody(Status, response)),
                Effect.map((result) => result.status),
              ),
          remove: removeAppOnce(agent, `/v1/apps/${app.id}`),
          storage: legacyStorage,
        });
      }),
    ),
  );
});

/** One attempt to remove the app at `appPath`; its HTTP status. */
const removeAppOnce = (actor: Session, appPath: string) =>
  Effect.gen(function* () {
    const api = yield* Api;
    return (yield* api.request(actor, "DELETE", appPath)).status;
  });
