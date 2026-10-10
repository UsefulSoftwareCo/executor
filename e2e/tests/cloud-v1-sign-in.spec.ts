/**
 * New Cloud accounts whose email belongs to an Executor v1 organization with data or a paid plan
 * stay on v1. The check reads the emulated v1 WorkOS through the same two list calls production
 * makes, the managed Cloud's emulated v1 database as v1's read-only login, and the emulated
 * Autumn account, only for accounts that have not already used v2.
 */
import { randomBytes } from "node:crypto";
import { expect, layer } from "@effect/vitest";
import { DateTime, Effect, FileSystem, Layer, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestLive, withCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { Emulators } from "../support/emulators.ts";
import { Onboarding } from "../support/onboarding.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { targetHosts } from "../support/role-hosts.ts";

const stopTitle = "Your workspace is on Executor v1";
const Created = Schema.Struct({ status: Schema.Literal("v1") });
/** Better Auth's refusal; only the stable code is compared, not its wording. */
const Refused = Schema.Struct({
  status: Schema.Number,
  body: Schema.Struct({ code: Schema.optionalKey(Schema.String) }),
});

const services = Layer.mergeAll(Onboarding.layer, Emulators.layer);

/**
 * Apply statements in one transaction to a managed Cloud database: Cloud's own
 * (`sso-database.json`) or the emulated v1 database (`v1-database.json`).
 */
const writeRows = (
  database: "sso-database.json" | "v1-database.json",
  statements: ReadonlyArray<{ readonly sql: string; readonly params?: ReadonlyArray<string> }>,
) =>
  Effect.gen(function* () {
    const target = yield* Target,
      fs = yield* FileSystem.FileSystem,
      processes = yield* ChildProcessSpawner.ChildProcessSpawner;
    const file = `${target.directory}/v1-rows-${randomBytes(6).toString("hex")}.json`;
    yield* fs.writeFileString(file, JSON.stringify(statements), { mode: 0o600 });
    const output = yield* processes
      .string(
        ChildProcess.make(
          "node",
          [
            "apps/hosted/testing/cloud-rows-fixture.ts",
            "--configuration",
            `${target.directory}/${database}`,
            "--statements",
            file,
          ],
          { env: { PATH: process.env.PATH ?? "", NODE_ENV: "test" }, extendEnv: false },
        ),
      )
      .pipe(Effect.ensuring(fs.remove(file).pipe(Effect.ignore)));
    return yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.Array(Schema.Array(Schema.Unknown))),
    )(output);
  });

/** Give a v1 organization a row in one of the v1 tables that hold its data. */
const v1Data = (organizationId: string, table: "connection" | "artifact") =>
  writeRows("v1-database.json", [
    { sql: `insert into ${table} (tenant) values ($1)`, params: [organizationId] },
  ]);
const Invited = Schema.Struct({
  status: Schema.Literal(200),
  body: Schema.Struct({ id: Schema.String }),
});

/** Ask Better Auth to create an organization directly, as the signed-in browser session. */
const createOrganizationDirectly = (step: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser
      .use(step, (page) =>
        page.evaluate(() =>
          fetch("/api/auth/organization/create", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: "Not created",
              slug: `not-created-${crypto.randomUUID().slice(0, 8)}`,
              keepCurrentActiveOrganization: true,
            }),
          }).then((response) =>
            response.json().then((body: unknown) => ({ status: response.status, body })),
          ),
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Refused)));
  });

/** Sign in with a seeded Google identity. */
const googleSignIn = (email: string, step: string) =>
  Effect.gen(function* () {
    const onboarding = yield* Onboarding,
      browser = yield* Browser;
    yield* browser.use("Open Cloud sign-in", (page) => page.goto("/login"));
    yield* onboarding.chooseSocial("google");
    yield* browser.use(step, (page) => page.getByRole("button").filter({ hasText: email }).click());
  });

/** Seed a fresh Google identity that is also a member of a v1 organization with data, and sign in with it. */
const v1GoogleSignIn = (options: { readonly workosFailsOnce: boolean }) =>
  Effect.gen(function* () {
    const onboarding = yield* Onboarding,
      emulators = yield* Emulators,
      browser = yield* Browser;
    const identity = yield* emulators.identity("google");
    yield* v1Data(yield* emulators.v1Member(identity.email), "connection");
    if (options.workosFailsOnce) yield* emulators.failNextV1MembershipRead;
    yield* browser.use("Open Cloud sign-in", (page) => page.goto("/login"));
    yield* onboarding.chooseSocial("google");
    yield* browser.use("Choose the v1 member on the Google emulator", (page) =>
      page.getByRole("button").filter({ hasText: identity.email }).click(),
    );
    return identity;
  });

/** Sign out, then sign in with a seeded Google identity. */
const switchTo = (email: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Sign the previous account out", (page) => page.context().clearCookies());
    yield* googleSignIn(email, "Choose the v1 member on the Google emulator");
  });

const teamSetup = Effect.gen(function* () {
  const browser = yield* Browser;
  yield* browser.use("Team setup opens instead of the v1 page", (page) =>
    page.getByLabel("Team name", { exact: true }).waitFor({ state: "visible" }),
  );
});

const stopPage = Effect.gen(function* () {
  const browser = yield* Browser;
  yield* browser.use("The v1 page replaces team setup", (page) =>
    page.getByRole("heading", { name: stopTitle, exact: true }).waitFor({ state: "visible" }),
  );
});

layer(TestLive, { excludeTestServices: true })("Cloud v1 sign-in", (it) => {
  it.effect(scenarios.v1SignInStop.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding,
          browser = yield* Browser;
        yield* v1GoogleSignIn({ workosFailsOnce: true });
        yield* browser.use("WorkOS failure fails closed with a retry", (page) =>
          page
            .getByRole("heading", { name: "Unable to open Executor", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("v1 check unavailable");
        expect(yield* onboarding.organizations).toEqual([]);
        yield* browser.use("Retry entry", (page) =>
          page.getByRole("link", { name: "Try again", exact: true }).click(),
        );
        yield* stopPage;
        const entry = yield* browser.use("Read the stop page", (page) =>
          Promise.all([
            page
              .getByRole("link", { name: "Sign in to Executor v1", exact: true })
              .getAttribute("href"),
            page.getByRole("button", { name: "Sign out", exact: true }).count(),
            page.getByLabel("Team name", { exact: true }).count(),
            Promise.resolve(new URL(page.url()).pathname),
          ]).then(([href, signOut, teamForm, pathname]) => ({ href, signOut, teamForm, pathname })),
        );
        expect(entry).toEqual({
          href: "https://executor.sh/login",
          signOut: 1,
          teamForm: 0,
          pathname: "/create",
        });
        yield* browser.checkpoint("v1 stop page");
        const html = yield* browser.use("Request the setup document", (page) =>
          page
            .context()
            .request.get("/create", { headers: { accept: "text/html" } })
            .then((document) => document.text()),
        );
        expect(html).toContain(stopTitle);
        expect(html).not.toContain("Create your team");
        const created = yield* browser
          .use("Confirming a team directly creates nothing", (page) =>
            page.evaluate(() =>
              fetch("/api/onboarding/create", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ name: "Not created", logo: null }),
              }).then((response) => response.json()),
            ),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Created)));
        expect(created).toEqual({ status: "v1" });
        expect(yield* onboarding.organizations).toEqual([]);
        const direct = yield* createOrganizationDirectly(
          "Better Auth's organization create refuses a v1 account",
        );
        expect(direct).toEqual({
          status: 403,
          body: { code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION" },
        });
        expect(yield* onboarding.organizations).toEqual([]);
        yield* browser.use("Sign out from the stop page", (page) =>
          page.getByRole("button", { name: "Sign out", exact: true }).click(),
        );
        yield* browser.use("Signing out leaves the stop page", (page) =>
          page.waitForURL((url) => url.pathname !== "/create"),
        );
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1SignInExisting.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding,
          browser = yield* Browser,
          target = yield* Target;
        /** Set this scenario's own account creation time in the managed Cloud's database. */
        const created = (email: string, at: string) =>
          writeRows("sso-database.json", [
            {
              sql: `update "user" set "createdAt" = $2::timestamptz where email = $1 returning id`,
              params: [email, at],
            },
          ]).pipe(Effect.map((rows) => expect(rows[0]).toHaveLength(1)));
        const identity = yield* v1GoogleSignIn({ workosFailsOnce: false });
        yield* stopPage;
        // An account from before the check shipped already used v2 and is never stopped.
        yield* created(identity.email, "2000-01-01T00:00:00Z");
        yield* browser.use("Reload entry as an account from before the check", (page) =>
          page.goto("/create"),
        );
        const name = yield* onboarding.prepareTeam;
        yield* browser.use("Create the team", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Team creation opens agent setup", (page) =>
          page.waitForURL(`${targetHosts(target).browser}/create/agent`),
        );
        const teams = yield* onboarding.organizations;
        expect(teams.map((team) => team.name)).toEqual([name]);
        // A v2 team member skips the check whenever the account was created.
        yield* created(identity.email, DateTime.formatIso(yield* DateTime.now));
        yield* browser.use("Return to entry as a v2 team member", (page) => page.goto("/"));
        yield* browser.use("The team opens instead of the v1 page", (page) =>
          page.waitForURL(`**/org/${teams[0]?.slug}/apps`),
        );
      }).pipe(Effect.provide(services)),
    ),
  );
  it.effect(scenarios.v1SignInInvited.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const onboarding = yield* Onboarding,
          emulators = yield* Emulators,
          browser = yield* Browser;
        // An account that is not on v1 creates a team and invites a v1 member to it.
        const owner = yield* emulators.identity("google");
        yield* googleSignIn(owner.email, "Choose the team owner on the Google emulator");
        yield* onboarding.prepareTeam;
        yield* browser.use("Create the owner's team", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Team creation opens agent setup", (page) =>
          page.waitForURL((url) => url.pathname === "/create/agent"),
        );
        const [team] = yield* onboarding.organizations;
        if (team === undefined) return yield* Effect.die("The owner's team was not created");
        const member = yield* emulators.identity("google");
        yield* v1Data(yield* emulators.v1Member(member.email), "artifact");
        const invitation = yield* browser
          .use("Invite the v1 member", (page) =>
            page.evaluate(
              ({ organizationId, email }) =>
                fetch("/api/auth/organization/invite-member", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ organizationId, email, role: "member" }),
                }).then((response) =>
                  response.json().then((body: unknown) => ({ status: response.status, body })),
                ),
              { organizationId: team.id, email: member.email },
            ),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Invited)));
        yield* browser.use("Sign the owner out", (page) => page.context().clearCookies());

        // The v1 member signs in and joins the inviting team.
        yield* googleSignIn(member.email, "Choose the invited v1 member on the Google emulator");
        yield* browser.use("Open the invitation", (page) =>
          page.goto(`/invite?invitation=${encodeURIComponent(invitation.body.id)}`),
        );
        yield* browser.use("Accept the invitation", (page) =>
          page.getByRole("button", { name: "Accept invitation", exact: true }).click(),
        );
        yield* browser.use("Accepting leaves the invitation page", (page) =>
          page.waitForURL((url) => url.pathname !== "/invite"),
        );
        yield* browser.checkpoint("v1 member joined the inviting team");
        expect((yield* onboarding.organizations).map((joined) => joined.id)).toEqual([team.id]);

        // Joining does not let the v1 member create another organization.
        expect(
          yield* createOrganizationDirectly("Better Auth's organization create refuses the member"),
        ).toEqual({
          status: 403,
          body: { code: "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION" },
        });
        // Nor does an unanswered v1 check: creation fails closed.
        yield* emulators.failNextV1MembershipRead;
        const unavailable = yield* createOrganizationDirectly(
          "Organization create while WorkOS is unavailable",
        );
        expect(unavailable.status).toBe(503);
        expect((yield* onboarding.organizations).map((joined) => joined.id)).toEqual([team.id]);
      }).pipe(Effect.provide(services)),
    ),
  );
  it.effect(scenarios.v1SignInEmpty.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          browser = yield* Browser;
        const member = () =>
          emulators.identity("google").pipe(Effect.map((identity) => identity.email));

        // Only empty organizations: one never billed, one on v1's free plan. A plugin's storage
        // other than toolkits is not data.
        const free = yield* member();
        const unbilled = yield* emulators.v1Member(free);
        yield* writeRows("v1-database.json", [
          {
            sql: `insert into plugin_storage (tenant, plugin_id) values ($1, 'other')`,
            params: [unbilled],
          },
        ]);
        yield* emulators.v1Plan(yield* emulators.v1Member(free), "free");
        yield* googleSignIn(free, "Choose the member of empty free v1 organizations");
        yield* teamSetup;
        yield* browser.checkpoint("empty free v1 organizations continue to v2");

        // An empty organization on a paid plan keeps its member on v1.
        const paying = yield* member();
        yield* emulators.v1Plan(yield* emulators.v1Member(paying), "team");
        yield* switchTo(paying);
        yield* stopPage;

        // Toolkits in plugin storage are data; one such organization outweighs an empty one.
        const mixed = yield* member();
        yield* emulators.v1Member(mixed);
        yield* writeRows("v1-database.json", [
          {
            sql: `insert into plugin_storage (tenant, plugin_id) values ($1, 'toolkits')`,
            params: [yield* emulators.v1Member(mixed)],
          },
        ]);
        yield* switchTo(mixed);
        yield* stopPage;

        // Without an answer from v1's database the check fails closed, then answers on retry.
        const unanswered = yield* member();
        yield* emulators.v1Member(unanswered);
        const hide = writeRows("v1-database.json", [
          { sql: "alter table artifact rename to artifact_hidden" },
        ]);
        const restore = writeRows("v1-database.json", [
          { sql: "alter table artifact_hidden rename to artifact" },
        ]).pipe(Effect.orDie);
        yield* hide.pipe(
          Effect.andThen(
            Effect.gen(function* () {
              yield* switchTo(unanswered);
              yield* browser.use("v1's database failure fails closed with a retry", (page) =>
                page
                  .getByRole("heading", { name: "Unable to open Executor", exact: true })
                  .waitFor({ state: "visible" }),
              );
            }),
          ),
          Effect.ensuring(restore),
        );
        yield* browser.use("Retry entry", (page) =>
          page.getByRole("link", { name: "Try again", exact: true }).click(),
        );
        yield* teamSetup;
      }).pipe(Effect.provide(services)),
    ),
  );
});
