/** Privileged deploy-time fixtures for dedicated e2e stages; never imported by the Worker. */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Config, Console, Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { Pool } from "pg";
import { authOptions } from "@executor-js/hosted-server";
import { OrganizationSlug } from "@executor-js/hosted-server/organization";
import { cloudSessionCookiePrefix } from "../src/contracts/browser.ts";

class FixtureFailed extends Schema.TaggedError<FixtureFailed>()("FixtureFailed", {
  phase: Schema.Literals(["configuration", "database", "accounts", "output"]),
}) {}
const Organization = Schema.Struct({ id: Schema.String, slug: Schema.String });
const stagePattern = /^test-e2e-[a-z0-9](?:[a-z0-9-]{0,36}[a-z0-9])?$/;

const provision = Effect.scoped(
  Effect.gen(function* () {
    const stage = yield* Config.String("ALCHEMY_STAGE");
    const origin = yield* Config.String("BETTER_AUTH_URL");
    const databaseUrl = yield* Config.Redacted("DATABASE_URL");
    const secret = yield* Config.Redacted("BETTER_AUTH_SECRET");
    const output = yield* Config.String("TEST_STAGE_ACCOUNTS_OUTPUT");
    const databaseBranch = yield* Config.String("TEST_STAGE_DATABASE_BRANCH");
    const databaseUsername = yield* Config.String("TEST_STAGE_DATABASE_USERNAME");
    const requestedOrganization = yield* Config.String("TEST_STAGE_APP_ORGANIZATION").pipe(
      Config.option,
    );
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    if (
      !stagePattern.test(stage) ||
      origin !== `https://${stage.slice(5)}.executor.engineering` ||
      !path.isAbsolute(output)
    )
      return yield* new FixtureFailed({ phase: "configuration" });
    const databaseName = "postgres";
    const url = new URL(Redacted.value(databaseUrl));
    if (
      decodeURIComponent(url.pathname.slice(1)) !== databaseName ||
      databaseBranch !== stage ||
      decodeURIComponent(url.username) !== databaseUsername ||
      url.searchParams.get("sslmode") !== "verify-full"
    )
      return yield* new FixtureFailed({ phase: "configuration" });
    yield* fs.makeDirectory(path.dirname(output), { recursive: true, mode: 0o700 });
    // Reserve a private output file before mutating anything. Never overwrite another run's sessions.
    const file = yield* fs.open(output, { flag: "wx", mode: 0o600 });
    let complete = false;
    yield* Effect.addFinalizer(() =>
      complete ? Effect.void : fs.remove(output).pipe(Effect.orDie),
    );
    const pool = yield* Effect.acquireRelease(
      Effect.sync(() => new Pool({ connectionString: Redacted.value(databaseUrl), max: 2 })),
      (pool) => Effect.promise(() => pool.end()),
    );
    const actual = yield* Effect.tryPromise({
      try: () => pool.query("select current_database() as name"),
      catch: () => new FixtureFailed({ phase: "database" }),
    });
    const names = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ name: Schema.String })),
    )(actual.rows);
    if (names[0]?.name !== databaseName) return yield* new FixtureFailed({ phase: "database" });
    const accountOperation = <A>(run: () => Promise<A>) =>
      Effect.tryPromise({ try: run, catch: () => new FixtureFailed({ phase: "accounts" }) });
    const sessions = yield* Effect.gen(function* () {
      const base = authOptions({ url: origin, oauthRedirectUri: Option.none() }, []);
      const helpers = testUtils();
      const auth = betterAuth({
        ...base,
        database: pool,
        secret: Redacted.value(secret),
        advanced: { ...base.advanced, cookiePrefix: cloudSessionCookiePrefix(origin) },
        session: { ...base.session, expiresIn: 3600 },
        plugins: [
          ...base.plugins,
          {
            ...helpers,
            init(ctx: Parameters<typeof helpers.init>[0]) {
              const { options, ...result } = helpers.init(ctx);
              return { ...result, ...(options === undefined ? {} : { options }) };
            },
          },
        ],
      });
      const context = yield* accountOperation(() => auth.$context);
      const fixtures = context.test;
      if (!fixtures.createOrganization || !fixtures.saveOrganization || !fixtures.addMember)
        return yield* new FixtureFailed({ phase: "accounts" });
      const suffix = crypto.randomUUID().slice(0, 8);
      const saveOrganization = fixtures.saveOrganization;
      const slug = Option.isSome(requestedOrganization)
        ? yield* Schema.decodeUnknownEffect(OrganizationSlug)(requestedOrganization.value)
        : `e2e-${suffix}`;
      const initial = fixtures.createOrganization({ name: "E2E parity", slug });
      const organization = yield* accountOperation(() => saveOrganization(initial)).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Organization)),
      );
      const addMember = fixtures.addMember;
      const actor = (role: "owner" | "admin" | "member") =>
        Effect.gen(function* () {
          const user = yield* accountOperation(() =>
            fixtures.saveUser(
              fixtures.createUser({
                name: `E2E ${role}`,
                email: `e2e-${suffix}-${role}@example.test`,
                emailVerified: true,
              }),
            ),
          );
          yield* accountOperation(() =>
            addMember({ userId: user.id, organizationId: organization.id, role }),
          );
          const session = yield* accountOperation(() => fixtures.login({ userId: user.id }));
          return {
            userId: user.id,
            role,
            expiresAt: session.session.expiresAt.toISOString(),
            cookies: session.cookies,
          };
        });
      return Redacted.make({
        version: 1,
        stage,
        origin,
        organization,
        actors: {
          owner: yield* actor("owner"),
          admin: yield* actor("admin"),
          member: yield* actor("member"),
        },
      });
    });
    yield* file.writeAll(
      new TextEncoder().encode(JSON.stringify(Redacted.value(sessions), null, 2)),
    );
    complete = true;
    yield* Console.log("Created one-hour synthetic sessions for the dedicated test stage.");
  }),
);
NodeRuntime.runMain(provision.pipe(Effect.provide(NodeServices.layer)));
