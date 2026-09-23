/** Public Better Auth initialization over its real memory adapter. */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { BetterAuthOptions } from "better-auth";
import type { DBAdapter } from "@better-auth/core/db/adapter";
import { getAuthTables } from "@better-auth/core/db";
import { oauthProvider, seedOAuthResources } from "@better-auth/oauth-provider";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { Schema } from "effect";

type OAuthOptions = Omit<Parameters<typeof oauthProvider>[0], "loginPage" | "consentPage">;
const origin = "https://resources.example.test";
const Resource = Schema.Struct({
  identifier: Schema.String,
  name: Schema.String,
  accessTokenTtl: Schema.NullOr(Schema.Number),
});

const store = () => {
  const rows: Record<string, Array<Record<string, unknown>>> = {};
  const calls = { reads: 0, creates: 0 };
  let readFailure: Error | undefined;
  let createFailure: Error | undefined;
  let raceOnCreate = false;
  const database = (options: BetterAuthOptions): DBAdapter => {
    for (const table of Object.values(getAuthTables(options))) rows[table.modelName] ??= [];
    const adapter = memoryAdapter(rows)(options);
    return {
      ...adapter,
      findOne: async (input) => {
        if (input.model === "oauthResource") {
          calls.reads++;
          if (readFailure) throw readFailure;
        }
        return adapter.findOne(input);
      },
      findMany: async (input) => {
        if (input.model === "oauthResource") {
          calls.reads++;
          if (readFailure) throw readFailure;
        }
        return adapter.findMany(input);
      },
      create: async (input) => {
        if (input.model === "oauthResource") {
          calls.creates++;
          if (createFailure) throw createFailure;
          if (raceOnCreate) {
            raceOnCreate = false;
            await adapter.create(input);
            throw new Error("duplicate key value violates unique constraint");
          }
        }
        return adapter.create(input);
      },
    };
  };
  return {
    database,
    calls,
    disable: (identifier: string) => {
      const row = rows.oauthResource?.find((row) => row.identifier === identifier);
      assert.ok(row);
      row.disabled = true;
    },
    reset: () => {
      calls.reads = 0;
      calls.creates = 0;
    },
    failReads: (failure: Error | undefined) => {
      readFailure = failure;
    },
    failCreates: (failure: Error | undefined) => {
      createFailure = failure;
    },
    race: () => {
      raceOnCreate = true;
    },
    resources: () => Schema.decodeUnknownSync(Schema.Array(Resource))(rows.oauthResource ?? []),
  };
};

const createAuth = (database: ReturnType<typeof store>["database"], options: OAuthOptions) =>
  betterAuth({
    baseURL: origin,
    secret: "synthetic-resource-seeding-secret-1234567890",
    database,
    logger: { disabled: true },
    telemetry: { enabled: false },
    plugins: [
      oauthProvider({
        disableJwtPlugin: true,
        loginPage: "/login",
        consentPage: "/consent",
        ...options,
      }),
    ],
  });

const initialize = async (
  database: ReturnType<typeof store>["database"],
  options: OAuthOptions,
) => {
  const auth = createAuth(database, options);
  assert.equal(await auth.api.getSession({ headers: new Headers() }), null);
  return auth;
};

const provision = async (database: ReturnType<typeof store>["database"], options: OAuthOptions) => {
  const auth = await initialize(database, { ...options, resourceSeedMode: "manual" });
  await seedOAuthResources(await auth.$context, {
    disableJwtPlugin: true,
    loginPage: "/login",
    consentPage: "/consent",
    ...options,
  });
  return auth;
};

test("request auth instances never seed configured OAuth resources", async () => {
  const database = store();
  const resources = [{ identifier: `${origin}/mcp`, name: "Saved", accessTokenTtl: 300 }];
  for (let i = 0; i < 3; i++)
    await initialize(database.database, { resources, resourceSeedMode: "manual" });
  assert.deepEqual(database.calls, { reads: 0, creates: 0 });
  assert.deepEqual(database.resources(), []);
  await provision(database.database, { resources });
  database.reset();
  for (let i = 0; i < 3; i++)
    await initialize(database.database, { resources, resourceSeedMode: "manual" });
  assert.deepEqual(database.calls, { reads: 0, creates: 0 });
  assert.deepEqual(database.resources(), resources);
});

test("provisioning inserts missing resources and preserves existing policy on repeat deployments", async () => {
  const database = store();
  const resources = Array.from({ length: 125 }, (_, index) => ({
    identifier: `${origin}/resource-${index}`,
    name: `Saved ${index}`,
    accessTokenTtl: 300,
  }));
  await provision(database.database, { resources });
  assert.deepEqual(database.resources(), resources);
  database.reset();
  await provision(database.database, {
    resources: [
      ...resources.map((resource) => ({
        ...resource,
        name: "Do not replace",
        accessTokenTtl: 900,
      })),
      { identifier: `${origin}/new`, name: "New", accessTokenTtl: 600 },
    ],
  });
  assert.equal(database.calls.creates, 1);
  assert.deepEqual(database.resources(), [
    ...resources,
    { identifier: `${origin}/new`, name: "New", accessTokenTtl: 600 },
  ]);
});

test("explicit provisioning keeps the first duplicate and tolerates an insertion race", async () => {
  for (const concurrent of [false, true]) {
    const database = store();
    const identifier = `${origin}/duplicate`;
    if (concurrent) database.race();
    await provision(database.database, {
      resources: [
        { identifier, name: "First", accessTokenTtl: 300 },
        { identifier, name: "Second", accessTokenTtl: 900 },
      ],
    });
    assert.equal(database.calls.creates, 1);
    assert.deepEqual(database.resources(), [{ identifier, name: "First", accessTokenTtl: 300 }]);
  }
});

test("provisioning rejects missing tables and database errors instead of deferring to a request", async () => {
  for (const operation of ["read", "create"] as const)
    for (const failure of [
      new Error('relation "oauthResource" does not exist'),
      new Error("synthetic database failure"),
      new Error("duplicate value in another constraint"),
    ]) {
      const database = store();
      if (operation === "read") database.failReads(failure);
      else database.failCreates(failure);
      await assert.rejects(
        provision(database.database, { resources: [`${origin}/required`] }),
        failure,
      );
      database.failReads(undefined);
      database.failCreates(undefined);
      await provision(database.database, { resources: [`${origin}/required`] });
      assert.equal(database.resources().length, 1);
    }
});

test("invalid configured resource identifiers fail explicit provisioning", async () => {
  const database = store();
  await assert.rejects(
    provision(database.database, { resources: ["not a URL"] }),
    /Invalid OAuth resource identifier/,
  );
  assert.deepEqual(database.resources(), []);
});

test("OAuth registration fails closed before provisioning and reads persisted policy afterward", async () => {
  const database = store();
  const identifier = `${origin}/mcp`;
  const resources = [{ identifier, allowedScopes: ["mcp"] }];
  const options = {
    resources,
    scopes: ["mcp", "restricted"],
    resourceSeedMode: "manual" as const,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    clientRegistrationDefaultResources: [identifier],
  };
  const auth = await initialize(database.database, options);
  const register = (scope: string) =>
    auth.api.registerOAuthClient({
      body: {
        client_name: "Synthetic client",
        redirect_uris: ["https://client.example.test/callback"],
        token_endpoint_auth_method: "none",
        scope,
      },
    });
  await assert.rejects(register("mcp"), /OAuth resources have not been provisioned/);
  assert.equal(database.calls.creates, 0, "A request must not repair missing provisioning");
  await provision(database.database, options);
  const client = await register("mcp");
  assert.ok(client.client_id);
  database.disable(identifier);
  await provision(database.database, options);
  await assert.rejects(register("mcp"), {
    statusCode: 400,
    body: {
      error: "invalid_target",
      error_description: `requested resource ${identifier} is disabled`,
    },
  });
  assert.equal(database.calls.creates, 1);
});

test("upstream automatic seed modes retain their existing behavior", async () => {
  for (const mode of ["insertOnly", "merge", "overwrite"] as const) {
    const database = store();
    const identifier = `${origin}/legacy`;
    await initialize(database.database, {
      resources: [{ identifier, name: "Original", accessTokenTtl: 300 }],
    });
    await initialize(database.database, {
      resourceSeedMode: mode,
      resources: [
        { identifier, name: "First" },
        { identifier, name: "Last" },
      ],
    });
    assert.deepEqual(database.resources(), [
      {
        identifier,
        name: mode === "insertOnly" ? "Original" : "Last",
        accessTokenTtl: mode === "overwrite" ? null : 300,
      },
    ]);
  }
});
