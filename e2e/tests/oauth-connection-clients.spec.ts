import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Resource } from "../support/contracts.ts";
import { connectionsPath } from "../support/app-accounts.ts";
import { Browser } from "../support/browser.ts";
import {
  type ChooserCall,
  type ChooserRefresh,
  organizationChooserService,
} from "../support/organization-chooser-service.ts";
import { scenarios } from "../test-plan.ts";

const Imported = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Struct({ service: Schema.Struct({ provider: Schema.String }) }),
  }),
});
const Redirect = Schema.Struct({
  authorizationUrl: Schema.String,
  ownClientUnavailable: Schema.optional(Schema.String),
});
const Called = Schema.Struct({ structuredContent: Schema.Struct({ organization: Schema.String }) });
const Setup = Schema.Struct({ chooseAgain: Schema.optional(Schema.Boolean) });
const Refusal = Schema.Struct({ reason: Schema.String });

type Service = Effect.Success<ReturnType<typeof organizationChooserService>>;

const chooserFlows = (service: Service) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      http = yield* HttpClient.HttpClient;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const suffix = randomUUID().slice(0, 8);
    const imported = (name: string, actor: Session = actors.owner) =>
      Effect.gen(function* () {
        const response = yield* api.request(actor, "POST", `${prefix}/apps/import`, {
          source: { kind: "mcp", name: `${name} ${suffix}`, url: service.url },
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(Imported, response);
        yield* Effect.addFinalizer(() =>
          api.request(actor, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.ignore),
        );
        return {
          id: app.id,
          name: `${name} ${suffix}`,
          provider: app.requirements.accounts.service.provider,
        };
      });
    const connect = (
      app: string,
      organization: "X" | "Y",
      options: {
        readonly account?: string;
        readonly start?: object;
        readonly as?: Session;
        readonly refused?: true;
      } = {},
    ) =>
      Effect.gen(function* () {
        const actor = options.as ?? actors.owner;
        const id = (yield* body(
          Resource,
          yield* api.request(
            actor,
            "POST",
            connectionsPath(`${prefix}/apps/${app}`, "user", "service"),
            options.account === undefined ? {} : { account: options.account },
          ),
        )).id;
        const started = yield* api.request(
          actor,
          "POST",
          `${prefix}/connections/${id}/oauth/start`,
          { method: "oauth", ...options.start },
        );
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const redirect = yield* body(Redirect, started);
        const sent = new URL(redirect.authorizationUrl);
        const callbackUrl = yield* Effect.scoped(
          Effect.gen(function* () {
            const client = HttpClient.withScope(http);
            const page = yield* client.get(sent.href);
            if (page.status === 302) return page.headers.location ?? "";
            const link = new RegExp(`href="([^"]*organization=${organization})"`, "u").exec(
              yield* page.text,
            )?.[1];
            if (link === undefined) return yield* Effect.die("The chooser offered no link");
            return (
              (yield* client.get(new URL(link.replaceAll("&amp;", "&"), service.origin).href))
                .headers.location ?? ""
            );
          }),
        ).pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }));
        const completed = yield* api.request(
          actor,
          "POST",
          `${prefix}/connections/${id}/oauth/complete`,
          { callbackUrl },
        );
        if (options.refused === true) {
          expect(completed.status, JSON.stringify(completed.body)).toBe(400);
          return {
            account: options.account ?? "",
            clientId: sent.searchParams.get("client_id") ?? "",
            prompt: sent.searchParams.get("prompt"),
            notice: (yield* body(Refusal, completed)).reason,
          };
        }
        expect(completed.status, JSON.stringify(completed.body)).toBe(200);
        return {
          account: (yield* body(Resource, completed)).id,
          clientId: sent.searchParams.get("client_id") ?? "",
          prompt: sent.searchParams.get("prompt"),
          notice: redirect.ownClientUnavailable,
        };
      });
    const actsIn = (app: string, account: string, actor: Session = actors.owner) =>
      Effect.gen(function* () {
        const response = yield* api.request(actor, "POST", `${prefix}/apps/${app}/tools/call`, {
          tool: "whoami",
          kind: "query",
          input: { accountId: account, input: {} },
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return (yield* body(Called, response)).structuredContent.organization;
      });
    const remove = (account: string) =>
      Effect.gen(function* () {
        const response = yield* api.request(
          actors.owner,
          "DELETE",
          `${prefix}/accounts/${account}`,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
      });
    const setup = (provider: string) =>
      Effect.gen(function* () {
        const response = yield* api.request(
          actors.owner,
          "GET",
          `${prefix}/providers/${provider}/oauth/oauth/setup`,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return yield* body(Setup, response);
      });
    const attempted = (clientId: string) =>
      service.deletionAttempts.pipe(
        Effect.flatMap((calls) =>
          calls.includes(clientId)
            ? Effect.void
            : Effect.fail(new Error("The client deletion was not attempted")),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
      );
    const deleted = (count: number) =>
      service.deletions.pipe(
        Effect.flatMap((calls) =>
          calls.length >= count
            ? Effect.succeed(calls)
            : Effect.fail(new Error("The client deletion has not arrived")),
        ),
        Effect.retry({ schedule: Schedule.spaced("100 millis"), times: 100 }),
      );
    return { api, actors, prefix, imported, connect, actsIn, remove, setup, deleted, attempted };
  });

layer(HostedLive, { excludeTestServices: true })("OAuth connection clients", (it) => {
  it.effect(scenarios.oauthConnectionClients.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const service = yield* organizationChooserService();
        const { actors, imported, connect, actsIn, setup } = yield* chooserFlows(service);
        const first = yield* imported("Reports");
        const second = yield* imported("Reports again");

        const reportsX = yield* connect(first.id, "X");
        const [shared] = yield* service.registrations;
        expect(reportsX.clientId).toBe(shared?.clientId);
        expect(shared?.clientName).toBe("Executor");

        const againY = yield* connect(second.id, "Y");
        const reportsY = yield* connect(first.id, "Y");
        expect(yield* actsIn(first.id, reportsX.account)).toBe("X");
        expect(yield* actsIn(second.id, againY.account)).toBe("Y");
        expect(yield* actsIn(first.id, reportsY.account)).toBe("Y");
        const clients = [reportsX.clientId, againY.clientId, reportsY.clientId];
        expect(new Set(clients).size).toBe(3);
        expect((yield* service.registrations).map((entry) => entry.clientName)).toEqual([
          "Executor",
          "Executor",
          "Executor",
        ]);
        expect((yield* service.authorizations).map((entry) => entry.chooserShown)).toEqual([
          true,
          true,
          true,
        ]);

        yield* service.signInAs("sam");
        const theirs = yield* imported("Their reports", actors.admin);
        const teammate = yield* connect(theirs.id, "Y", { as: actors.admin });
        expect(teammate.clientId).toBe(reportsX.clientId);
        expect(yield* service.registrations).toHaveLength(3);
        expect(yield* actsIn(theirs.id, teammate.account, actors.admin)).toBe("Y");

        yield* service.signInAs("alex");
        const reconnected = yield* connect(first.id, "X", { account: reportsY.account });
        expect(reconnected.clientId).toBe(reportsY.clientId);
        expect(yield* actsIn(first.id, reportsY.account)).toBe("Y");
        const pickedAutomatic = yield* connect(first.id, "X", {
          account: reportsY.account,
          start: { client: { automatic: true } },
        });
        expect(pickedAutomatic.clientId).toBe(reportsY.clientId);
        expect(yield* actsIn(first.id, reportsY.account)).toBe("Y");
        expect(yield* service.registrations).toHaveLength(3);

        expect((yield* setup(first.provider)).chooseAgain).toBe(true);
        const chosenAgain = yield* connect(second.id, "X", {
          account: againY.account,
          start: { chooseAgain: true },
        });
        expect(chosenAgain.clientId).not.toBe(againY.clientId);
        expect(yield* actsIn(second.id, againY.account)).toBe("X");
        expect(yield* service.clients).toContain(againY.clientId);
        expect(yield* service.deletions).toEqual([]);
        expect(yield* service.clients).toContain(reportsX.clientId);

        const sharedAgain = yield* connect(first.id, "Y", {
          account: reportsX.account,
          start: { chooseAgain: true },
        });
        expect(sharedAgain.clientId).not.toBe(reportsX.clientId);
        expect(yield* actsIn(first.id, reportsX.account)).toBe("Y");
        expect(yield* actsIn(theirs.id, teammate.account, actors.admin)).toBe("Y");
        expect(yield* service.clients).toContain(reportsX.clientId);

        expect(
          [
            reportsX,
            againY,
            reportsY,
            teammate,
            reconnected,
            pickedAutomatic,
            chosenAgain,
            sharedAgain,
          ].map((signIn) => [signIn.prompt, signIn.notice]),
        ).toEqual([...Array(8)].map(() => [null, undefined]));

        const browser = yield* Browser;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Open the connect form for a further connection", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${second.id}?view=accounts`)
            .then(() =>
              page.getByRole("button", { name: "Connect new account", exact: true }).click(),
            )
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: `Connect ${second.name}`, exact: true })
                .waitFor(),
            ),
        );
        expect(
          yield* browser.use("A new connection offers nothing more", (page) =>
            page
              .getByRole("dialog")
              .getByText("Advanced", { exact: true })
              .count()
              .then((advanced) =>
                advanced === 0
                  ? 0
                  : page
                      .getByRole("dialog")
                      .getByText("Advanced", { exact: true })
                      .click()
                      .then(() => page.getByRole("dialog").getByRole("checkbox").count()),
              ),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Connect form for a further connection, unchanged");
        yield* browser.use("Connect goes to the service's chooser", (page) =>
          page
            .getByRole("dialog")
            .getByRole("button", { name: `Connect ${second.name}`, exact: true })
            .click()
            .then(() => page.getByRole("heading", { name: "Choose an organization" }).waitFor()),
        );
        yield* browser.checkpoint("The service shows its chooser for a further connection");

        yield* browser.use("Open the reconnect form", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${second.id}?view=accounts`)
            .then(() => page.getByRole("button", { name: "Manage Default", exact: true }).click())
            .then(() => page.getByRole("menuitem", { name: "Reconnect", exact: true }).click())
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: `Reconnect ${second.name}`, exact: true })
                .waitFor(),
            )
            .then(() => page.getByRole("dialog").getByText("Advanced", { exact: true }).click()),
        );
        const option = `Let me choose the ${second.name} account or organization again`;
        expect(
          yield* browser.use("The reconnect form offers to choose again", (page) =>
            page.getByRole("dialog").getByRole("checkbox", { name: option }).count(),
          ),
        ).toBe(1);
        yield* browser.checkpoint("Reconnect form with the option to choose again");
        yield* browser.use("Choose again goes to the service's chooser", (page) =>
          page
            .getByRole("dialog")
            .getByRole("checkbox", { name: option })
            .click()
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: `Reconnect ${second.name}`, exact: true })
                .click(),
            )
            .then(() => page.getByRole("heading", { name: "Choose an organization" }).waitFor()),
        );
      }),
    ),
  );

  it.effect(scenarios.oauthConnectionClientsFallback.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const service = yield* organizationChooserService();
        const { actors, connect, actsIn, imported } = yield* chooserFlows(service);
        const app = yield* imported("Reports");
        const first = yield* connect(app.id, "X");

        yield* service.answerRegistrations("rate_limited");
        const limited = yield* connect(app.id, "Y");
        expect(limited.clientId).toBe(first.clientId);
        expect(limited.notice).toBe("registration_refused");
        expect(yield* actsIn(app.id, limited.account)).toBe("X");

        yield* service.answerRegistrations("rejected");
        const rejected = yield* connect(app.id, "Y");
        expect(rejected.clientId).toBe(first.clientId);
        expect(rejected.notice).toBe("registration_refused");

        yield* service.answerRegistrations("same_client");
        const same = yield* connect(app.id, "Y");
        expect(same.clientId).toBe(first.clientId);
        expect(same.notice).toBe("registration_refused");

        yield* service.revokeApp(first.clientId, "alex");
        const revoked = yield* connect(app.id, "Y");
        expect(revoked.clientId).toBe(first.clientId);
        expect(yield* actsIn(app.id, revoked.account)).toBe("Y");
        expect((yield* service.authorizations).map((entry) => entry.chooserShown)).toEqual([
          true,
          false,
          false,
          false,
          true,
        ]);

        yield* service.answerRegistrations("rejected");
        const browser = yield* Browser;
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Connect while the service refuses registrations", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`)
            .then(() =>
              page.getByRole("button", { name: "Connect new account", exact: true }).click(),
            )
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: `Connect ${app.name}`, exact: true })
                .click(),
            )
            .then(() =>
              page
                .getByRole("dialog")
                .getByRole("button", { name: `Continue to ${app.name}`, exact: true })
                .waitFor(),
            ),
        );
        expect(
          yield* browser.use("The form says the service may reuse the earlier choice", (page) =>
            page.getByRole("dialog").getByRole("status").innerText(),
          ),
        ).toBe(
          `${app.name} may reuse your earlier choice\n\nExecutor couldn’t give this connection its own sign-in at ${app.name}, so ${app.name} may skip asking which account or organization to use. To choose again, revoke Executor’s access in ${app.name}’s settings, then continue; your other ${app.name} connections may then need reconnecting.`,
        );
        yield* browser.checkpoint("Notice when the service refuses a client of its own");

        yield* service.answerRegistrations("issue");
        const own: Array<string> = [];
        for (let index = 0; index < 20; index++) {
          const signIn = yield* connect(app.id, index % 2 === 0 ? "X" : "Y");
          expect(signIn.notice).toBeUndefined();
          own.push(signIn.clientId);
        }
        expect(new Set(own).size).toBe(20);
        const capped = yield* connect(app.id, "Y");
        expect(capped.clientId).toBe(first.clientId);
        expect(capped.notice).toBe("limit_reached");
        expect(yield* service.registrations).toHaveLength(23);
      }),
    ),
  );

  it.effect(scenarios.oauthConnectionClientsRefresh.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const service = yield* organizationChooserService({
          expiresIn: 20,
          promptValues: "overflowing",
        });
        const { connect, actsIn, imported } = yield* chooserFlows(service);
        const first = yield* imported("Reports");
        const second = yield* imported("Reports again");
        const shared = yield* connect(first.id, "X");
        const own = yield* connect(second.id, "Y");
        expect(own.clientId).not.toBe(shared.clientId);
        const live = new Set([shared.clientId, own.clientId]);
        const renewsWith = (
          app: string,
          account: string,
          clientId: string,
          organization: "X" | "Y",
        ) =>
          Effect.gen(function* () {
            const mark = (yield* service.refreshes).length;
            const called = (yield* service.calls).length;
            expect(yield* actsIn(app, account)).toBe(organization);
            const served = (yield* service.calls).slice(called);
            expect(served.length).toBeGreaterThanOrEqual(1);
            expect(served).toEqual(served.map((): ChooserCall => ({ clientId, renewed: true })));
            const renewals = (yield* service.refreshes).slice(mark);
            expect(
              renewals.filter((entry) => !entry.accepted || !live.has(entry.clientId)),
            ).toEqual([]);
          });
        const renewedBy = (entries: ReadonlyArray<ChooserRefresh>, clientId: string) =>
          entries.filter((entry) => entry.clientId === clientId && entry.accepted).length;

        for (let round = 0; round < 2; round++) {
          yield* renewsWith(first.id, shared.account, shared.clientId, "X");
          yield* renewsWith(second.id, own.account, own.clientId, "Y");
        }
        const before = yield* service.refreshes;
        expect(renewedBy(before, shared.clientId)).toBeGreaterThanOrEqual(1);
        expect(renewedBy(before, own.clientId)).toBeGreaterThanOrEqual(1);

        const again = yield* connect(second.id, "X", {
          account: own.account,
          start: { chooseAgain: true },
        });
        expect([shared.clientId, own.clientId]).not.toContain(again.clientId);
        live.delete(own.clientId);
        live.add(again.clientId);
        const mark = (yield* service.refreshes).length;
        for (let round = 0; round < 2; round++) {
          yield* renewsWith(second.id, own.account, again.clientId, "X");
          yield* renewsWith(first.id, shared.account, shared.clientId, "X");
        }
        const after = (yield* service.refreshes).slice(mark);
        expect(renewedBy(after, again.clientId)).toBeGreaterThanOrEqual(1);
        expect(renewedBy(after, shared.clientId)).toBeGreaterThanOrEqual(1);
        expect(after.filter((entry) => entry.clientId === own.clientId)).toEqual([]);
        const observed = new Set([shared.clientId, own.clientId, again.clientId]);
        expect(
          (yield* service.refreshes).filter(
            (entry) => !entry.accepted || !observed.has(entry.clientId),
          ),
        ).toEqual([]);
      }),
    ),
  );

  it.effect(scenarios.oauthConnectionClientsRemoval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const service = yield* organizationChooserService();
        const { connect, actsIn, imported, remove, deleted, attempted } =
          yield* chooserFlows(service);
        const app = yield* imported("Reports");
        const first = yield* connect(app.id, "X");
        const second = yield* connect(app.id, "Y");
        const third = yield* connect(app.id, "Y");
        const fourth = yield* connect(app.id, "X");

        yield* remove(second.account);
        expect(yield* deleted(1)).toEqual([second.clientId]);
        expect(yield* service.clients).toEqual([first.clientId, third.clientId, fourth.clientId]);

        yield* remove(first.account);
        expect(yield* service.clients).toContain(first.clientId);

        yield* service.refuseTokens(fourth.clientId);
        const refused = yield* connect(app.id, "X", { account: fourth.account, refused: true });
        expect(refused.clientId).toBe(fourth.clientId);
        expect(refused.notice).toBe("registered_client_rejected");
        const replaced = yield* connect(app.id, "Y", { account: fourth.account });
        expect(replaced.clientId).not.toBe(fourth.clientId);
        expect(yield* actsIn(app.id, fourth.account)).toBe("Y");
        expect(yield* service.clients).toContain(fourth.clientId);
        expect(yield* service.deletions).toEqual([second.clientId]);

        yield* service.answerDeletions(500);
        yield* remove(third.account);
        yield* attempted(third.clientId);
        expect(yield* service.clients).toContain(third.clientId);

        const unmanaged = yield* organizationChooserService({
          management: false,
          promptValues: "null",
        });
        const flows = yield* chooserFlows(unmanaged);
        const other = yield* flows.imported("Notes");
        yield* flows.connect(other.id, "X");
        const kept = yield* flows.connect(other.id, "Y");
        expect(yield* flows.actsIn(other.id, kept.account)).toBe("Y");
        yield* flows.remove(kept.account);
        expect(yield* unmanaged.clients).toContain(kept.clientId);
        expect(yield* unmanaged.deletions).toEqual([]);
      }),
    ),
  );
});
