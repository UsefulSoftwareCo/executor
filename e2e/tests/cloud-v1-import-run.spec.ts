/**
 * The server-side v1 move: an operator starts the `V1Import` Workflow for v1 organizations with the
 * deployment's operator token, and reads each organization's report. The scenarios write synthetic
 * v1 rows into the managed Cloud's emulated v1 database, members into the emulated v1 WorkOS and
 * secrets into its Vault, and read v2's own rows to prove what was and was not written.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Schedule, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import { TestLive, withCase } from "../support/case.ts";
import { Browser } from "../support/browser.ts";
import { writeRows, type RowStatement } from "../support/cloud-rows.ts";
import { Emulators } from "../support/emulators.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Telemetry } from "../support/evidence.ts";
import { Onboarding } from "../support/onboarding.ts";
import { Target } from "../support/platform.ts";
import {
  allowV1Import,
  allowV1ImportRow,
  listV1Into,
  listV1IntoRow,
  listV1SlugDisplacement,
  v1ImportOperator,
  v1RunId,
  type V1Report,
} from "../support/v1-import.ts";
import {
  V1McpForwardSecret,
  v1ForwardBearer,
  v1McpForwardFile,
  v1ToolkitConnectionId,
} from "../support/v1-mcp-forward.ts";
import { scenarios } from "../test-plan.ts";

const services = Layer.mergeAll(Onboarding.layer, Emulators.layer);

/**
 * OAuth MCP servers at `/<name>/mcp` on loopback, for each of `names`, as far as a sign-in reaches
 * them: each refuses a request without a token with a challenge naming its resource metadata,
 * which names this origin's authorization server. The import discovers them before it saves an
 * account, and the dry run does too.
 */
const mcpSignInServers = (names: readonly string[]) =>
  Effect.gen(function* () {
    const at = Effect.map(
      HttpServerRequest.HttpServerRequest,
      (request) => `http://${request.headers.host}`,
    );
    const routes = Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-authorization-server",
        Effect.flatMap(at, (origin) =>
          HttpServerResponse.json({
            issuer: origin,
            authorization_endpoint: `${origin}/authorize`,
            token_endpoint: `${origin}/token`,
            response_types_supported: ["code"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["client_secret_post"],
          }),
        ),
      ),
      ...names.flatMap((name) => [
        HttpRouter.add(
          "*",
          `/${name}/mcp`,
          Effect.map(at, (origin) =>
            HttpServerResponse.empty({
              status: 401,
              headers: {
                "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/${name}/mcp"`,
              },
            }),
          ),
        ),
        HttpRouter.add(
          "GET",
          `/.well-known/oauth-protected-resource/${name}/mcp`,
          Effect.flatMap(at, (origin) =>
            HttpServerResponse.json({
              resource: `${origin}/${name}/mcp`,
              authorization_servers: [origin],
            }),
          ),
        ),
      ]),
    );
    const built = yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      ),
    );
    const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(built));
    if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
    return `127.0.0.1:${server.address.port}`;
  });

const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
const Rows = Schema.Array(Schema.Array(Schema.Unknown));

/** v2's own rows, read as the database holds them. */
const cloudRows = <S extends Schema.Top>(schema: S, sql: string, ...params: string[]) =>
  writeRows("sso-database.json", [row(sql, ...params)]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
    Effect.flatMap((results) => Schema.decodeUnknownEffect(Schema.Array(schema))(results[0] ?? [])),
  );

/** The emulated v1's rows, read as its owner. */
const v1Rows = <S extends Schema.Top>(schema: S, sql: string, ...params: string[]) =>
  writeRows("v1-database.json", [row(sql, ...params)]).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
    Effect.flatMap((results) => Schema.decodeUnknownEffect(Schema.Array(schema))(results[0] ?? [])),
  );

const Flag = Schema.Struct({
  state: Schema.String,
  v2_org_id: Schema.NullOr(Schema.String),
  v2_org_slug: Schema.NullOr(Schema.String),
});
const movedFlag = (organization: string) =>
  v1Rows(
    Flag,
    "select state, v2_org_id, v2_org_slug from org_moved_to_v2 where org_id = $1",
    organization,
  );
const importState = (organization: string) =>
  cloudRows(
    Schema.Struct({ state: Schema.String }),
    "select state from private_v1_import_org where v1_org_id = $1",
    organization,
  );

const Response = Schema.Struct({ status: Schema.Number, body: Schema.Unknown });
const Source = Schema.Struct({
  files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
});

/** Call Cloud's API from the signed-in page, as the dashboard does. */
const call = (step: string, path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser
      .use(step, (page) =>
        page.evaluate(
          (path) =>
            fetch(path).then((response) =>
              response.json().then((body: unknown) => ({ status: response.status, body })),
            ),
          path,
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Response)));
  });

/** Sign in with Google as a v1 member; v2 keeps them on v1 until their workspace moves. */
const signInOnV1 = (email: string) =>
  Effect.gen(function* () {
    const onboarding = yield* Onboarding,
      browser = yield* Browser;
    yield* browser.use("Open Cloud sign-in", (page) => page.goto("/login"));
    yield* onboarding.chooseSocial("google");
    yield* browser.use("Choose the v1 member on the Google emulator", (page) =>
      page.getByRole("button").filter({ hasText: email }).click(),
    );
    yield* browser.use("v2 keeps the member on v1", (page) =>
      page.getByText("Your workspace is on Executor v1").waitFor({ state: "visible" }),
    );
  });

const vaultScope = (organization: string, user?: string) =>
  user === undefined
    ? `executor/org/${encodeURIComponent(organization)}`
    : `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;

const personalApproveDropped =
  "In a workspace with more than one member, a member's own approve rules are not imported, so these tools ask again.";

/**
 * A shared workspace's MCP server that takes an API key: the organization's `team` connection, a
 * `mine` connection of two members, and a `gone` connection of someone who left. Rules: one member
 * approves `search` for themselves, another blocks `delete_item`, and the former member blocked
 * `search`. An org toolkit grants the `team` connection; one member's own toolkit grants theirs.
 * `toolkits` gives the two toolkits' rows their ids, which a toolkit copy's id is made from.
 */
const seedShared = (
  organization: string,
  slug: string,
  members: { readonly first: string; readonly second: string; readonly former: string },
  toolkits: { readonly team: string; readonly mine: string } = {
    team: randomUUID(),
    mine: randomUUID(),
  },
) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const tracker = `shared_${randomUUID().slice(0, 6)}`;
    const keyOf = (owner: "org" | "user", name: string) =>
      `connection:${owner}:${tracker}:${name}:token`;
    const secrets = [
      [vaultScope(organization), keyOf("org", "team"), "synthetic-team-key"],
      [vaultScope(organization, members.first), keyOf("user", "mine"), "synthetic-first-key"],
      [vaultScope(organization, members.second), keyOf("user", "mine"), "synthetic-second-key"],
      [vaultScope(organization, members.former), keyOf("user", "gone"), "synthetic-former-key"],
    ] as const;
    for (const [scope, item, value] of secrets)
      yield* emulators.v1VaultObject(`${scope}/secrets/${encodeURIComponent(item)}`, value);
    const mcp = {
      transport: "remote",
      endpoint: "https://shared.example.com/mcp",
      remoteTransport: "auto",
      authenticationTemplate: [
        { slug: "header", kind: "apikey", placements: [{ carrier: "header", name: "X-Key" }] },
        // Unused here; the dry run's first-party connections sign in with it.
        { slug: "oauth2", kind: "oauth2" },
      ],
    };
    const connection = (owner: "org" | "user", subject: string, name: string, age: string) =>
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, created_at) values ($1, $2, $3, $4, $5, 'header', $6::json, now() - $7::interval)",
        organization,
        owner,
        subject,
        tracker,
        name,
        JSON.stringify({ token: keyOf(owner, name) }),
        age,
      );
    const tools = (owner: "org" | "user", subject: string, name: string) =>
      ["search", "delete_item"].map((tool) =>
        row(
          "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, $2, $3, $4, $5, 'mcp', $6, $7::json)",
          organization,
          owner,
          subject,
          tracker,
          name,
          tool,
          JSON.stringify({ mcp: { toolName: tool } }),
        ),
      );
    const policy = (subject: string, pattern: string, action: string) =>
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'user', $2, $3, $4, 'a0')",
        organization,
        subject,
        pattern,
        action,
      );
    const storage = (
      owner: "org" | "user",
      subject: string,
      collection: string,
      key: string,
      data: object,
      rowId: string = randomUUID(),
    ) =>
      row(
        "insert into plugin_storage (row_id, tenant, owner, subject, plugin_id, collection, key, data) values ($1, $2, $3, $4, 'toolkits', $5, $6, $7::json)",
        rowId,
        organization,
        owner,
        subject,
        collection,
        key,
        JSON.stringify(data),
      );
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic shared workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'mcp', 'Shared Tracker', $3::json)",
        organization,
        tracker,
        JSON.stringify(mcp),
      ),
      connection("org", "", "team", "3 days"),
      connection("user", members.first, "mine", "2 days"),
      connection("user", members.second, "mine", "1 day"),
      connection("user", members.former, "gone", "4 days"),
      ...tools("org", "", "team"),
      ...tools("user", members.first, "mine"),
      ...tools("user", members.second, "mine"),
      ...tools("user", members.former, "gone"),
      policy(members.second, `${tracker}.*.*.search`, "approve"),
      policy(members.first, `${tracker}.*.*.delete_item`, "block"),
      policy(members.former, `${tracker}.*.*.search`, "block"),
      storage(
        "org",
        "",
        "toolkits",
        "tk_team",
        { id: "tk_team", name: "Team kit", slug: "team" },
        toolkits.team,
      ),
      storage("org", "", "toolkitConnections", "tc_team", {
        id: "tc_team",
        toolkitId: "tk_team",
        pattern: `${tracker}.org.team.*`,
        position: "a0",
      }),
      storage(
        "user",
        members.first,
        "toolkits",
        "tk_mine",
        { id: "tk_mine", name: "Mine", slug: "mine" },
        toolkits.mine,
      ),
      storage("user", members.first, "toolkitConnections", "tc_mine", {
        id: "tc_mine",
        toolkitId: "tk_mine",
        pattern: `${tracker}.user.mine.*`,
        position: "a0",
      }),
    ]);
    return { tracker };
  });

/**
 * A shared workspace whose toolkits are as large as a busy organization's: 20 members, 8 MCP
 * servers of 200 tools each, 344 workspace rules, and 10 toolkits (8 the organization's, 2 members'
 * own) with 58 connection rules and 1,052 policies. Every server has the organization's `team`
 * connection; two members also have their own `mine` on the first, whose `team` alone v1 blocks a
 * tool for, so it becomes an app per connection. The workspace blocks one tool on each other
 * server. Each toolkit's policies name a tool each, so the tools a copy grants are the server's,
 * less the toolkit's blocks and the workspace's.
 */
const toolkitScale = (organization: string, members: readonly string[]) => {
  const prefix = `scale_${randomUUID().slice(0, 6)}`;
  const servers = Array.from({ length: 8 }, (_, index) => ({
    slug: `${prefix}_${index}`,
    label: `Scale ${index}`,
  }));
  const tools = Array.from({ length: 200 }, (_, index) => `tool_${String(index).padStart(3, "0")}`);
  const slugOf = (server: number) => servers[server]?.slug ?? "";
  const memberOf = (index: number) => members[index] ?? "";
  const connections = [
    ...servers.map((server) => ({
      row_id: `${server.slug}-team`,
      owner: "org",
      subject: "",
      integration: server.slug,
      name: "team",
    })),
    ...[0, 1].map((index) => ({
      row_id: `${slugOf(0)}-mine-${index}`,
      owner: "user",
      subject: memberOf(index),
      integration: slugOf(0),
      name: "mine",
    })),
  ];
  const workspaceRules = [
    { owner: "org", subject: "", pattern: `${slugOf(0)}.org.team.tool_000`, action: "block" },
    ...servers.slice(1).map((server) => ({
      owner: "org",
      subject: "",
      pattern: `${server.slug}.*.*.tool_001`,
      action: "block",
    })),
    // The rest ask or allow, so they shape each app's approvals but leave every tool in.
    ...Array.from({ length: 336 }, (_, index) => ({
      owner: index % 3 === 0 ? "user" : "org",
      subject: index % 3 === 0 ? memberOf(index % members.length) : "",
      pattern: `${slugOf(index % 8)}.*.*.${tools[2 + (index % (tools.length - 2))]}`,
      action: index % 2 === 0 ? "approve" : "require_approval",
    })),
  ].map((rule, index) => ({
    ...rule,
    id: `rule-${index}`,
    position: `a${String(index).padStart(4, "0")}`,
  }));
  /** The organization's toolkits are 0 to 7; 8 is the second member's own, 9 the first's. */
  const owners = [...Array.from({ length: 8 }, () => ""), memberOf(1), memberOf(0)];
  const kits = owners.map((subject, kit) => {
    // Each organization toolkit reaches the `team` connection of seven or six servers.
    const access =
      kit === 8
        ? [`${slugOf(0)}.user.mine.*`, `${slugOf(1)}.org.team.*`]
        : kit === 9
          ? [`${slugOf(0)}.*`, `${slugOf(2)}.org.team.*`]
          : servers
              .filter((_, server) => server !== kit && (kit < 6 || server !== (kit + 1) % 8))
              .map((server) => `${server.slug}.org.team.*`);
    const policies = Array.from({ length: kit === 0 ? 500 : kit === 9 ? 64 : 61 }, (_, index) => ({
      server: index % 8,
      tool: tools[2 + ((Math.floor(index / 8) + 7 * kit) % (tools.length - 2))] ?? "",
      action: index % 7 === 0 ? "block" : index % 7 === 1 ? "require_approval" : "approve",
    }));
    return { id: `kit-${kit}`, name: `Kit ${kit}`, subject, access, policies };
  });
  const storage = kits.flatMap((kit) => {
    const owner = kit.subject === "" ? "org" : "user";
    const rule = (collection: string, key: string, data: object) => ({
      owner,
      subject: kit.subject,
      collection,
      key,
      data: { id: key, toolkitId: kit.id, ...data },
    });
    return [
      {
        owner,
        subject: kit.subject,
        collection: "toolkits",
        key: kit.id,
        data: { id: kit.id, name: kit.name, slug: kit.id },
      },
      ...kit.access.map((pattern, index) =>
        rule("toolkitConnections", `${kit.id}-c${index}`, {
          pattern,
          position: `a${index}`,
        }),
      ),
      ...kit.policies.map((policy, index) =>
        rule("toolkitPolicies", `${kit.id}-p${index}`, {
          pattern: `${slugOf(policy.server)}.*.*.${policy.tool}`,
          action: policy.action,
          position: `a${String(index).padStart(4, "0")}`,
        }),
      ),
    ];
  });
  const keyOf = (connection: (typeof connections)[number]) =>
    `connection:${connection.owner}:${connection.integration}:${connection.name}:token`;
  const mcp = (server: number) => ({
    transport: "remote",
    endpoint: `https://scale-${server}.example.com/mcp`,
    remoteTransport: "auto",
    authenticationTemplate: [
      { slug: "header", kind: "apikey", placements: [{ carrier: "header", name: "X-Key" }] },
    ],
  });
  const seed = Effect.gen(function* () {
    const emulators = yield* Emulators;
    for (const connection of connections)
      yield* emulators.v1VaultObject(
        `${connection.owner === "org" ? vaultScope(organization) : vaultScope(organization, connection.subject)}/secrets/${encodeURIComponent(keyOf(connection))}`,
        `synthetic-${connection.row_id}`,
      );
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic toolkit scale workspace",
        `v1-${randomUUID().slice(0, 8)}`,
      ),
      ...servers.map((server, index) =>
        row(
          "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'mcp', $3, $4::json)",
          organization,
          server.slug,
          server.label,
          JSON.stringify(mcp(index)),
        ),
      ),
      row(
        `insert into connection (tenant, row_id, owner, subject, integration, name, template, item_ids)
          select $1, c->>'row_id', c->>'owner', c->>'subject', c->>'integration', c->>'name',
            'header', json_build_object('token', c->>'key')
          from json_array_elements($2::json) c`,
        organization,
        JSON.stringify(
          connections.map((connection) => ({ ...connection, key: keyOf(connection) })),
        ),
      ),
      // Every connection lists all 200 of its server's tools.
      row(
        `insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations)
          select $1, c->>'owner', c->>'subject', c->>'integration', c->>'name', 'mcp', t.name,
            json_build_object('mcp', json_build_object('toolName', t.name))
          from json_array_elements($2::json) c,
            json_array_elements_text($3::json) as t(name)`,
        organization,
        JSON.stringify(connections),
        JSON.stringify(tools),
      ),
      row(
        `insert into tool_policy (tenant, owner, subject, id, pattern, action, position)
          select $1, r->>'owner', r->>'subject', r->>'id', r->>'pattern', r->>'action', r->>'position'
          from json_array_elements($2::json) r`,
        organization,
        JSON.stringify(workspaceRules),
      ),
      row(
        `insert into plugin_storage (tenant, owner, subject, plugin_id, collection, key, data)
          select $1, r->>'owner', r->>'subject', 'toolkits', r->>'collection', r->>'key', r->'data'
          from json_array_elements($2::json) r`,
        organization,
        JSON.stringify(storage),
      ),
    ]);
  });
  /**
   * What each toolkit's copy grants, from its rules: for each server it reaches, the tools of each
   * app it runs in, less what the toolkit blocks there and what the app leaves out, run as the
   * app for `team` and as the member's own account for `mine`. `apps` names each server's app and
   * `accounts` each connection's account, by connection row id.
   */
  const expectedPolicy = (
    kit: (typeof kits)[number],
    apps: ReadonlyMap<string, string>,
    accounts: ReadonlyMap<string, string>,
  ) => {
    const granted = kit.access.flatMap((pattern) => {
      const server = servers.findIndex((candidate) => pattern.startsWith(`${candidate.slug}.`));
      const through = connections.filter(
        (connection) =>
          connection.integration === slugOf(server) &&
          (pattern.endsWith(".org.team.*")
            ? connection.owner === "org"
            : pattern.endsWith(".user.mine.*")
              ? connection.subject === kit.subject
              : connection.owner === "org" || connection.subject === kit.subject),
      );
      return through.map((connection) => ({ server, connection }));
    });
    const blocked = (server: number) =>
      new Set(
        kit.policies
          .filter((policy) => policy.server === server && policy.action === "block")
          .map((policy) => policy.tool),
      );
    return granted
      .map(({ server, connection }) => {
        // The first server's `team` app alone leaves out `tool_000`; the others' apps `tool_001`.
        const left =
          server === 0 ? (connection.owner === "org" ? "tool_000" : undefined) : "tool_001";
        return {
          app: apps.get(server === 0 ? connection.row_id : connection.integration) ?? "unknown app",
          runsAs:
            connection.owner === "org"
              ? [{ kind: "app" }]
              : [{ kind: "account", id: accounts.get(connection.row_id) ?? "unknown account" }],
          tools: {
            kind: "selected",
            names: tools.filter((tool) => tool !== left && !blocked(server).has(tool)),
          },
        };
      })
      .toSorted((a, b) => (a.app < b.app ? -1 : 1));
  };
  /** The tools each organization toolkit grants that the workspace blocks, as its note lists them. */
  const blockedNote = (kit: (typeof kits)[number]) => {
    const left = kit.access
      .map((pattern) => servers.findIndex((server) => pattern.startsWith(`${server.slug}.`)))
      .map((server) => `Scale ${server} ${server === 0 ? "tool_000" : "tool_001"}`)
      .toSorted();
    return `${left.length} tools v1 allowed only through this toolkit are blocked in the workspace, so they are left out: ${left.join(", ")}.`;
  };
  return { seed, servers, connections, kits, expectedPolicy, blockedNote };
};

const ToolkitCopy = Schema.Struct({
  name: Schema.String,
  userId: Schema.String,
  policy: Schema.fromJsonString(
    Schema.Struct({
      apps: Schema.Array(
        Schema.Struct({
          app: Schema.String,
          runsAs: Schema.Array(
            Schema.Struct({ kind: Schema.String, id: Schema.optional(Schema.String) }),
          ),
          tools: Schema.Struct({ kind: Schema.String, names: Schema.Array(Schema.String) }),
        }),
      ),
    }),
  ),
});

const IdRow = Schema.Struct({ id: Schema.String });

/** A synthetic address no other scenario uses. */
const syntheticEmail = (label: string) => `${label}-${randomUUID().slice(0, 8)}@example.test`;

/** The statement of a v2 user with a verified email, as v2 sign-in leaves them. */
const v2UserRow = (id: string, email: string) =>
  row(
    `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, 'Synthetic member', $2, true, now(), now())`,
    id,
    email,
  );

/** The statements of a v2 team its owner made. */
const v2TeamRows = (id: string, owner: string) => [
  row(
    `insert into organization (id, name, slug, "createdAt") values ($1, 'Synthetic team', $2, now())`,
    id,
    `team-${randomUUID().slice(0, 8)}`,
  ),
  row(
    `insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $3, 'owner', now())`,
    randomUUID(),
    id,
    owner,
  ),
];

/** A v2 user with a verified email, as v2 sign-in leaves them. */
const v2User = (email: string) =>
  Effect.gen(function* () {
    const id = randomUUID();
    yield* writeRows("sso-database.json", [v2UserRow(id, email)]);
    return id;
  });

/** A v2 team its owner made. */
const v2Team = (owner: string) =>
  Effect.gen(function* () {
    const id = randomUUID();
    yield* writeRows("sso-database.json", v2TeamRows(id, owner));
    return id;
  });

/**
 * Statements a scenario collects to write in one transaction per database, in the order it
 * collected them. Each `writeRows` starts a process, so a scenario with dozens of rows writes them
 * once instead of once a row.
 */
const rowBatch = () => {
  const cloud: RowStatement[] = [];
  const v1: RowStatement[] = [];
  return {
    cloud,
    v1,
    write: Effect.gen(function* () {
      if (v1.length > 0) yield* writeRows("v1-database.json", v1);
      if (cloud.length > 0) yield* writeRows("sso-database.json", cloud);
    }),
  };
};

/** Each statement's rows, read from one database in one process, in the order given. */
const readRows = <S extends Schema.Top>(
  database: "sso-database.json" | "v1-database.json",
  schema: S,
  statements: readonly RowStatement[],
) =>
  writeRows(database, statements).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Rows)),
    Effect.flatMap((results) =>
      Effect.forEach(statements, (_, index) =>
        Schema.decodeUnknownEffect(Schema.Array(schema))(results[index] ?? []),
      ),
    ),
  );

/** A v1 workspace of these members, allowed and listed to move into `into`, in `mode`. */
const listedV1Workspace = (
  label: string,
  members: readonly [string, ...string[]],
  into: string,
  mode?: string,
) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const created = yield* emulators.v1Workspace(members);
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        created.organization,
        `Synthetic ${label} workspace`,
        `v1-${randomUUID().slice(0, 8)}`,
      ),
    ]);
    yield* allowV1Import(created.organization);
    yield* listV1Into(created.organization, into, mode);
    return created;
  });

/** A rule of an integration v1 deleted: an item the import plans, with nothing to run. */
const goneRule = (organization: string) =>
  row(
    "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, 'block', 'a0')",
    organization,
    `gone_${randomUUID().slice(0, 6)}.*.*.search`,
  );

/** A v1 member: their WorkOS user id and their email. */
interface V1Member {
  readonly user: string;
  readonly email: string;
}

const byJson = (a: unknown, b: unknown) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1);

const Copy = Schema.Struct({ id: Schema.String, name: Schema.String, userId: Schema.String });
/** An organization's live MCP connections: its members' toolkit copies. */
const liveCopies = (organization: string) =>
  cloudRows(
    Copy,
    `select id, name, "userId" from "mcpConnection" where resource = $1 and not revoked`,
    organization,
  );
/** Whether each of these MCP connections is revoked. */
const connectionsRevoked = (ids: readonly string[]) =>
  cloudRows(
    Schema.Struct({ id: Schema.String, revoked: Schema.Boolean }),
    `select id, revoked from "mcpConnection"
      where id in (select jsonb_array_elements_text($1::jsonb)) order by id`,
    JSON.stringify(ids),
  );

/**
 * The status of the initialize request v1 forwards when `member` opens the v1 URL of `toolkit`, a
 * toolkit row of `organization`, once it moved to `v2Organization`. v1 names the member's copy by
 * the id it computes.
 */
const forwardedToolkit = (input: {
  readonly organization: string;
  readonly v2Organization: string;
  readonly toolkit: string;
  readonly member: string;
}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem,
      target = yield* Target,
      http = yield* HttpClient.HttpClient;
    const { secret } = yield* fs
      .readFileString(`${target.directory}/${v1McpForwardFile}`)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(V1McpForwardSecret))));
    const connection = v1ToolkitConnectionId(input.v2Organization, input.toolkit, input.member);
    const bearer = v1ForwardBearer(secret, {
      account: input.member,
      organization: input.organization,
      exp: Math.floor(Date.now() / 1000) + 300,
      toolkit: input.toolkit,
      connection,
    });
    const request = HttpClientRequest.post(
      `${target.metadata.origin}/mcp?connection=${connection}`,
    ).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${bearer}`,
      }),
    );
    const response = yield* http.execute(
      yield* HttpClientRequest.bodyJson(request, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "forwarded-toolkit", version: "1" },
        },
      }),
    );
    yield* response.text;
    return response.status;
  }).pipe(Effect.scoped, Effect.provide(FetchHttpClient.layer));

/**
 * Import a rolled-back workspace of the shared seed (`seedShared`) again and check its toolkit
 * copies. Its own import instance has completed, so starting it again runs nothing; an operator
 * restarts it. A twin workspace with the same members and toolkit rows stands in for that restart:
 * a copy's id comes from the v2 organization, the toolkit's row and the member, so the twin's
 * copies take the ids of the copies the first import made (`earlier`). It moves into `into` as a
 * copy, or into a new organization. It cuts over, its owner and teammate each have a live copy of
 * the org toolkit and the owner one of their own toolkit, none under an id of `earlier`, the import
 * map names each, and v1's URL of the org toolkit forwards each member to their copy. The twin and
 * its report.
 */
const importTwin = (input: {
  readonly label: string;
  readonly owner: V1Member;
  readonly teammate: V1Member;
  readonly former: string;
  readonly toolkits: { readonly team: string; readonly mine: string };
  readonly into?: string;
  readonly earlier: readonly string[];
}) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const operator = yield* v1ImportOperator;
    const twin = yield* emulators.v1Workspace([input.owner.email, input.teammate.email]);
    expect(twin.user).toBe(input.owner.user);
    const organization = twin.organization;
    yield* seedShared(
      organization,
      `v1-${randomUUID().slice(0, 8)}`,
      { first: input.owner.user, second: input.teammate.user, former: input.former },
      input.toolkits,
    );
    yield* allowV1Import(organization);
    if (input.into !== undefined) yield* listV1Into(organization, input.into, "copy_into_empty");
    const run = v1RunId(input.label);
    const started = yield* operator.start({
      mode: "import",
      runId: run,
      organizations: [organization],
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const report = yield* operator.waitForReport(run, organization);
    const toolkits = (report.items ?? []).filter((item) => item.kind === "toolkit");
    expect(
      toolkits.map((item) => [item.label, item.status, item.reason ?? null]).toSorted(byJson),
    ).toEqual([
      ["Mine", "imported", null],
      ["Team kit", "imported", null],
    ]);
    expect(report.status, report.reason ?? "").toBe("imported");
    expect(report.verification).toMatchObject({ items: { failed: 0 }, passed: true });
    expect(report.cutover).toBe(true);
    const target = report.v2Organization;
    if (target === undefined) return yield* Effect.die("The import named no organization");
    expect(yield* movedFlag(organization)).toEqual([
      { state: "moved", v2_org_id: target.id, v2_org_slug: target.slug },
    ]);

    const v2Id = (member: V1Member) =>
      cloudRows(IdRow, `select id from "user" where lower(email) = lower($1)`, member.email).pipe(
        Effect.map((users) => users[0]?.id),
      );
    const owner = yield* v2Id(input.owner);
    const teammate = yield* v2Id(input.teammate);
    const copies = yield* liveCopies(target.id);
    expect(copies.map((copy) => [copy.name, copy.userId]).toSorted(byJson)).toEqual(
      [
        ["Mine", owner],
        ["Team kit", owner],
        ["Team kit", teammate],
      ].toSorted(byJson),
    );
    expect(copies.filter((copy) => input.earlier.includes(copy.id))).toEqual([]);
    const mapped = yield* cloudRows(
      Schema.Struct({ v2_id: Schema.String }),
      `select v2_id from private_v1_import_map
        where v1_org_id = $1 and v1_kind = 'toolkit' and status = 'imported'`,
      organization,
    );
    expect(mapped.map((row) => row.v2_id).toSorted()).toEqual(
      copies.map((copy) => copy.id).toSorted(),
    );

    // v1 names each member's copy by the id it computes; the forward finds their live copy.
    expect(toolkits.find((item) => item.label === "Team kit")?.id).toBe(input.toolkits.team);
    for (const member of [input.owner, input.teammate])
      expect(
        yield* forwardedToolkit({
          organization,
          v2Organization: target.id,
          toolkit: input.toolkits.team,
          member: member.user,
        }),
      ).toBe(200);

    return { organization, report };
  });

/** Names longer than an app's address holds: it keeps the first 63 characters of a name's slug. */
const longNames = {
  integration: "Billing System (Account 1234567, read-only)",
  connection: "personalBillingSystemAccount1234567ReadOnly",
  artifact: "Billing reconciliation board for account 1234567, read-only weekly view",
};

/**
 * A workspace of three members whose names are longer than an app's address holds. Its MCP server
 * `longNames.integration` becomes an app per connection (decision 33): a workspace rule blocks a
 * tool through the workspace's connection alone. Each member named a connection
 * `longNames.connection`; the workspace's connection and one member's other connection add a digit
 * to it. Its org artifacts are `artifacts`, by their place among six. Every row's id starts with
 * `ids`, so another workspace seeded alike can take over this one's import map.
 */
const seedLongNames = (
  organization: string,
  ids: string,
  server: string,
  members: readonly [string, string, string],
  artifacts: readonly { readonly index: number; readonly title: string }[],
) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const [first, second, third] = members;
    const connections = [
      { owner: "org", subject: "", name: `${longNames.connection}2`, age: "5 days" },
      { owner: "user", subject: first, name: longNames.connection, age: "4 days" },
      { owner: "user", subject: second, name: longNames.connection, age: "3 days" },
      { owner: "user", subject: third, name: longNames.connection, age: "2 days" },
      { owner: "user", subject: first, name: `${longNames.connection}3`, age: "1 day" },
    ] as const;
    const keyOf = (connection: (typeof connections)[number]) =>
      `connection:${connection.owner}:${server}:${connection.name}:token`;
    for (const connection of connections)
      yield* emulators.v1VaultObject(
        `${connection.owner === "org" ? vaultScope(organization) : vaultScope(organization, connection.subject)}/secrets/${encodeURIComponent(keyOf(connection))}`,
        `synthetic-${randomUUID().slice(0, 8)}`,
      );
    const mcp = {
      transport: "remote",
      endpoint: "https://billing.example.com/mcp",
      remoteTransport: "auto",
      authenticationTemplate: [
        { slug: "header", kind: "apikey", placements: [{ carrier: "header", name: "X-Key" }] },
      ],
    };
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic long names workspace",
        `v1-${randomUUID().slice(0, 8)}`,
      ),
      row(
        "insert into integration (tenant, row_id, slug, plugin_id, name, config) values ($1, $2, $3, 'mcp', $4, $5::json)",
        organization,
        `${ids}-server`,
        server,
        longNames.integration,
        JSON.stringify(mcp),
      ),
      ...connections.flatMap((connection, index) => [
        row(
          "insert into connection (tenant, row_id, owner, subject, integration, name, template, item_ids, created_at) values ($1, $2, $3, $4, $5, $6, 'header', $7::json, now() - $8::interval)",
          organization,
          `${ids}-connection-${index}`,
          connection.owner,
          connection.subject,
          server,
          connection.name,
          JSON.stringify({ token: keyOf(connection) }),
          connection.age,
        ),
        ...["search", "delete_item"].map((tool) =>
          row(
            "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, $2, $3, $4, $5, 'mcp', $6, $7::json)",
            organization,
            connection.owner,
            connection.subject,
            server,
            connection.name,
            tool,
            JSON.stringify({ mcp: { toolName: tool } }),
          ),
        ),
      ]),
      row(
        "insert into tool_policy (tenant, row_id, owner, subject, pattern, action, position) values ($1, $2, 'org', '', $3, 'block', 'b0')",
        organization,
        `${ids}-rule`,
        `${server}.org.${longNames.connection}2.search`,
      ),
      ...artifacts.map(({ index, title }) =>
        row(
          "insert into artifact (tenant, row_id, owner, subject, title, code, bindings, created_at) values ($1, $2, 'org', '', $3, 'export const App = () => null', '{}'::json, now() - $4::interval)",
          organization,
          `${ids}-artifact-${index}`,
          title,
          `${6 - index} minutes`,
        ),
      ),
    ]);
  });

layer(TestLive, { excludeTestServices: true })("Cloud v1 import runs", (it) => {
  it.effect(
    scenarios.v1ImportLongNames.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const emulators = yield* Emulators;
          const operator = yield* v1ImportOperator;
          const emails = [
            syntheticEmail("long-first"),
            syntheticEmail("long-second"),
            syntheticEmail("long-third"),
          ] as const;
          const server = `billing_${randomUUID().slice(0, 6)}`;
          // The first run imports a twin workspace; handing its import map to this one makes this
          // one's import run again over what the first made, as a restarted import does.
          const twin = yield* emulators.v1Workspace([...emails]);
          const members = [
            twin.user,
            yield* emulators.v1User(emails[1]),
            yield* emulators.v1User(emails[2]),
          ] as const;
          const twinIds = `twin-${randomUUID().slice(0, 8)}`;
          // Six artifacts share one long title.
          yield* seedLongNames(
            twin.organization,
            twinIds,
            server,
            members,
            Array.from({ length: 6 }, (_, index) => ({ index, title: longNames.artifact })),
          );
          yield* allowV1Import(twin.organization);

          // Each app's name is shortened only as far as its address needs to hold its connection's
          // name and number whole, so every app has an address of its own.
          const shortened = `Billing System… (${longNames.connection}`;
          const connectionApps = [
            [`${shortened})`, "billing-system-personalbillingsystemaccount1234567readonly"],
            [`${shortened} 2)`, "billing-system-personalbillingsystemaccount1234567readonly-2"],
            [`${shortened} 3)`, "billing-system-personalbillingsystemaccount1234567readonly-3"],
            [`${shortened}2)`, "billing-system-personalbillingsystemaccount1234567readonly2"],
            [`${shortened}3)`, "billing-system-personalbillingsystemaccount1234567readonly3"],
          ];
          // Artifacts of one title are numbered by retries, each shortened so its number survives.
          const artifactApps = [
            [longNames.artifact, "billing-reconciliation-board-for-account-1234567-read-only-week"],
            ...[2, 3, 4, 5].map((attempt) => [
              `Billing reconciliation board for account 1234567, read-only… (v1 ${attempt})`,
              `billing-reconciliation-board-for-account-1234567-read-only-v1-${attempt}`,
            ]),
          ];
          const at = (index: number) => (a: readonly string[], b: readonly string[]) =>
            (a[index] ?? "") < (b[index] ?? "") ? -1 : 1;
          const appsOf = (report: V1Report) =>
            (
              report.splitIntegrations?.find((split) => split.label === longNames.integration)
                ?.apps ?? []
            ).toSorted((a, b) => (a.name < b.name ? -1 : 1));
          const namesTaken = "Every name for this app is taken in the organization.";
          const run = (mode: "dry-run" | "import", label: string, organization: string) =>
            Effect.gen(function* () {
              const id = v1RunId(label);
              const started = yield* operator.start({
                mode,
                runId: id,
                organizations: [organization],
              });
              expect(started.status, JSON.stringify(started.body)).toBe(200);
              return yield* operator.waitForReport(id, organization);
            });

          // The dry run plans the import's names, and finds that the last artifact of one title
          // would have none left.
          const planned = yield* run("dry-run", "long-dry", twin.organization);
          expect(planned.integrationFailures).toEqual([]);
          expect(appsOf(planned).map((app) => [app.name, app.status])).toEqual(
            connectionApps.map(([name = ""]) => [name, "planned"]).toSorted(at(0)),
          );
          expect(
            planned.artifacts.flatMap((artifact) =>
              artifact.error === undefined ? [] : [[artifact.id, artifact.error]],
            ),
          ).toEqual([[`${twinIds}-artifact-5`, namesTaken]]);
          expect(planned.status).toBe("blocked");

          // The import makes every connection's app, and fails the artifact the dry run named.
          const first = yield* run("import", "long", twin.organization);
          expect(appsOf(first).map((app) => [app.name, app.status])).toEqual(
            connectionApps.map(([name = ""]) => [name, "imported"]).toSorted(at(0)),
          );
          const artifacts = (first.items ?? []).filter((item) => item.kind === "artifact");
          expect(
            artifacts.map((item) => [item.id, item.status, item.reason ?? ""]).toSorted(at(0)),
          ).toEqual([
            ...[0, 1, 2, 3, 4].map((index) => [`${twinIds}-artifact-${index}`, "imported", ""]),
            [`${twinIds}-artifact-5`, "failed", namesTaken],
          ]);
          expect(first.status).toBe("failed");
          expect(first.cutover).not.toBe(true);
          const target = first.v2Organization;
          if (target === undefined) return yield* Effect.die("The import named no organization");
          const appRows = cloudRows(
            Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }),
            `select id, name, slug from executor_apps where owner = $1 and name like 'Billing%'`,
            `organization:${target.id}`,
          ).pipe(Effect.map((apps) => apps.toSorted((a, b) => (a.slug < b.slug ? -1 : 1))));
          const before = yield* appRows;
          expect(before.map((app) => [app.name, app.slug])).toEqual(
            [...connectionApps, ...artifactApps].toSorted(at(1)),
          );

          // This workspace has the same server, connections and rule, and the artifact the import
          // failed, which its member gave another title. It takes over the twin's import map, and
          // its import keeps every app the first run made, saves that artifact and cuts over. The
          // artifacts the first run saved are left out: saving one again commits to its source,
          // which managed local Cloud cannot store; their apps stay as the first run made them.
          const own = yield* emulators.v1Workspace([...emails]);
          const ownIds = `own-${randomUUID().slice(0, 8)}`;
          yield* seedLongNames(own.organization, ownIds, server, members, [
            { index: 5, title: "Billing reconciliation archive" },
          ]);
          yield* allowV1Import(own.organization);
          yield* writeRows("sso-database.json", [
            row(
              "update private_v1_import_map set v1_id = replace(replace(v1_id, $1, $2), $3, $4), v1_org_id = $4 where v1_org_id = $3",
              twinIds,
              ownIds,
              twin.organization,
              own.organization,
            ),
          ]);
          const second = yield* run("import", "long-again", own.organization);
          expect(
            second.status,
            JSON.stringify((second.items ?? []).filter((item) => item.status === "failed")),
          ).toBe("imported");
          expect(second.cutover).toBe(true);
          expect(second.v2Organization).toEqual(target);
          expect(appsOf(second).map((app) => [app.name, app.v2Id])).toEqual(
            appsOf(first).map((app) => [app.name, app.v2Id]),
          );
          const after = yield* appRows;
          expect(after.filter((app) => app.name !== "Billing reconciliation archive")).toEqual(
            before,
          );
          expect(after.map((app) => app.name)).toContain("Billing reconciliation archive");
          expect(after).toHaveLength(before.length + 1);
        }).pipe(Effect.provide(services)),
      ),
    // A dry run and two imports of a workspace whose five apps each build.
    { timeout: 120_000 },
  );

  it.effect(scenarios.v1ImportSplitNames.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const older = `older-${randomUUID().slice(0, 8)}@example.test`;
        const first = yield* emulators.identity("google");
        const workspace = yield* emulators.v1Workspace([older, first.email]);
        const olderUser = workspace.user;
        const firstUser = yield* emulators.v1User(first.email);
        yield* emulators.setV1MemberRole(workspace.organization, olderUser, "member");
        const former = yield* emulators.v1Workspace([
          `former-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        const { tracker } = yield* seedShared(
          workspace.organization,
          `v1-${randomUUID().slice(0, 8)}`,
          { first: firstUser, second: olderUser, former: former.user },
        );
        // A workspace rule blocks searching through the team connection alone, so each connection
        // becomes its own app; both members named their own connection `mine`.
        yield* writeRows("v1-database.json", [
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, 'block', 'b0')",
            workspace.organization,
            `${tracker}.org.team.search`,
          ),
        ]);
        yield* signInOnV1(first.email);
        yield* allowV1Import(workspace.organization);
        const run = v1RunId("split-names");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [workspace.organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, workspace.organization);
        expect(report.status, report.reason ?? "").toBe("imported");
        const target = report.v2Organization;
        if (target === undefined) return yield* Effect.die("The import named no organization");
        expect(
          (report.splitIntegrations?.[0]?.apps ?? []).map((app) => [app.name, app.status]).sort(),
        ).toEqual([
          ["Shared Tracker (mine 2)", "imported"],
          ["Shared Tracker (mine)", "imported"],
          ["Shared Tracker (team)", "imported"],
        ]);
        // The first member made their `mine` first, so theirs keeps the name; each member's app is
        // theirs alone, and the team connection's is everyone's, made by the owner.
        const userOf = (email: string) =>
          cloudRows(
            Schema.Struct({ id: Schema.String }),
            `select id from "user" where lower(email) = lower($1)`,
            email,
          ).pipe(Effect.map((users) => users[0]?.id));
        const firstV2 = yield* userOf(first.email);
        const olderV2 = yield* userOf(older);
        const access = yield* cloudRows(
          Schema.Struct({
            name: Schema.String,
            audience: Schema.String,
            creator: Schema.NullOr(Schema.String),
          }),
          `select a.name, h.audience, h.creator_id as creator from executor_apps a
            join hosted_app_access h on h.id = a.id
            where a.owner = $1 and a.name like 'Shared Tracker%'`,
          `organization:${target.id}`,
        );
        expect([...access].sort((a, b) => (a.name < b.name ? -1 : 1))).toEqual([
          { name: "Shared Tracker (mine 2)", audience: "private", creator: olderV2 },
          { name: "Shared Tracker (mine)", audience: "private", creator: firstV2 },
          { name: "Shared Tracker (team)", audience: "everyone", creator: firstV2 },
        ]);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportShared.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        // The oldest membership is a member's, so the oldest admin owns the organization: the
        // signed-in member, whose v2 account the import keeps.
        const older = `older-${randomUUID().slice(0, 8)}@example.test`;
        const first = yield* emulators.identity("google");
        const third = `third-${randomUUID().slice(0, 8)}@example.test`;
        const workspace = yield* emulators.v1Workspace([older, first.email, third]);
        const olderUser = workspace.user;
        const firstUser = yield* emulators.v1User(first.email);
        const thirdUser = yield* emulators.v1User(third);
        yield* emulators.setV1MemberRole(workspace.organization, olderUser, "member");
        // Someone who left: their rows stay in v1's database, and they are a member elsewhere.
        const former = yield* emulators.v1Workspace([
          `former-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        const slug = `v1-${randomUUID().slice(0, 8)}`;
        const { tracker } = yield* seedShared(workspace.organization, slug, {
          first: firstUser,
          second: olderUser,
          former: former.user,
        });
        // The first member already has a v2 account with the same verified email.
        yield* signInOnV1(first.email);

        yield* allowV1Import(workspace.organization);
        const run = v1RunId("shared");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [workspace.organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, workspace.organization);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.emailMatches).toEqual([{ email: first.email, match: "merge" }]);
        const target = report.v2Organization;
        if (target === undefined) return yield* Effect.die("The import named no organization");
        expect(target.slug).toBe(slug);
        // Verified, then cut over: v1 forwards the workspace to its v2 organization.
        const verification = report.verification;
        expect(verification).toMatchObject({
          members: { planned: 3, inV2: 3 },
          accounts: { checked: 3, unreadable: 0 },
          apps: { checked: 1, withoutVersion: 0 },
          passed: true,
        });
        expect(verification?.items.withResult).toBe(verification?.items.planned);
        expect(verification?.items.failed).toBe(0);
        expect(report.cutover).toBe(true);
        expect(yield* movedFlag(workspace.organization)).toEqual([
          { state: "moved", v2_org_id: target.id, v2_org_slug: slug },
        ]);
        expect(yield* importState(workspace.organization)).toEqual([{ state: "cutover" }]);
        const items = report.items ?? [];
        const statusOf = (kind: string, label: string) =>
          items
            .filter((item) => item.kind === kind && item.label === label)
            .map((item) => item.status);
        expect(statusOf("integration", "Shared Tracker")).toEqual(["imported"]);
        expect(statusOf("connection", "team")).toEqual(["imported"]);
        expect(statusOf("connection", "mine")).toEqual(["imported", "imported"]);
        // The former member's connection and rules are not read at all.
        expect(items.filter((item) => item.label === "gone")).toEqual([]);
        const policies = items.filter((item) => item.kind === "tool_policy");
        expect(policies).toHaveLength(2);
        expect(policies).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              label: `${tracker}.*.*.search`,
              status: "skipped",
              reason: personalApproveDropped,
            }),
            expect.objectContaining({ label: `${tracker}.*.*.delete_item`, status: "imported" }),
          ]),
        );
        expect(statusOf("toolkit", "Team kit")).toEqual(["imported"]);
        expect(statusOf("toolkit", "Mine")).toEqual(["imported"]);

        // Members and roles: the oldest admin owns it; every other admin stays one.
        const v2User = (email: string) =>
          cloudRows(
            Schema.Struct({ id: Schema.String, emailVerified: Schema.Boolean }),
            `select id, "emailVerified" from "user" where lower(email) = lower($1)`,
            email,
          ).pipe(Effect.map((users) => users[0]));
        const [firstV2, olderV2, thirdV2] = [
          yield* v2User(first.email),
          yield* v2User(older),
          yield* v2User(third),
        ];
        if (firstV2 === undefined || olderV2 === undefined || thirdV2 === undefined)
          return yield* Effect.die("A member has no v2 user");
        expect([olderV2.emailVerified, thirdV2.emailVerified]).toEqual([true, true]);
        const roles = yield* cloudRows(
          Schema.Struct({ userId: Schema.String, role: Schema.String }),
          `select "userId", role from member where "organizationId" = $1`,
          target.id,
        );
        expect(Object.fromEntries(roles.map((member) => [member.userId, member.role]))).toEqual({
          [olderV2.id]: "member",
          [firstV2.id]: "owner",
          [thirdV2.id]: "admin",
        });
        // Imported users are not queued for the welcome email.
        expect(
          yield* cloudRows(
            Schema.Struct({ user_id: Schema.String }),
            "select user_id from cloud_welcome_email where user_id in ($1, $2)",
            olderV2.id,
            thirdV2.id,
          ),
        ).toEqual([]);
        // The import map tells merged accounts from created ones.
        const mapped = yield* cloudRows(
          Schema.Struct({ v1_id: Schema.String, v2_kind: Schema.String, v2_id: Schema.String }),
          "select v1_id, v2_kind, v2_id from private_v1_import_map where v1_kind = 'user' and v1_org_id = $1",
          workspace.organization,
        );
        expect(
          Object.fromEntries(mapped.map((entry) => [entry.v1_id, [entry.v2_kind, entry.v2_id]])),
        ).toEqual({
          [firstUser]: ["merged_user", firstV2.id],
          [olderUser]: ["user", olderV2.id],
          [thirdUser]: ["user", thirdV2.id],
        });

        // The app is shared with everyone and created by the owner.
        const app = items.find((item) => item.kind === "integration")?.v2Id ?? "";
        expect(
          yield* cloudRows(
            Schema.Struct({ creator_id: Schema.NullOr(Schema.String), audience: Schema.String }),
            "select creator_id, audience from hosted_app_access where id = $1",
            app,
          ),
        ).toEqual([{ creator_id: firstV2.id, audience: "everyone" }]);
        // Every account is personal: the org connection's is the owner's, linked for everyone; each
        // member's is their own, linked for them.
        const access = yield* cloudRows(
          Schema.Struct({
            account_id: Schema.String,
            kind: Schema.String,
            audience: Schema.NullOr(Schema.String),
            personal_user_id: Schema.NullOr(Schema.String),
          }),
          "select account_id, kind, audience, personal_user_id from hosted_account_access where organization_id = $1 and account_id in (select account from hosted_app_account_links where app = $2)",
          target.id,
          app,
        );
        expect(
          access
            .map((entry) => [entry.kind, entry.audience, entry.personal_user_id])
            .toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        ).toEqual(
          [
            ["personal", null, firstV2.id],
            ["personal", null, firstV2.id],
            ["personal", null, olderV2.id],
          ].toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        );
        const links = yield* cloudRows(
          Schema.Struct({
            requirement: Schema.String,
            subject: Schema.NullOr(Schema.String),
            account: Schema.String,
          }),
          "select requirement, subject, account from hosted_app_account_links where app = $1",
          app,
        );
        const workspaceAccount = links.find((link) => link.subject === null)?.account;
        expect(
          access.find((entry) => entry.account_id === workspaceAccount)?.personal_user_id,
          "the org connection's account is the owner's",
        ).toBe(firstV2.id);
        expect(
          links
            .map((link) => [link.requirement, link.subject, link.account === workspaceAccount])
            .toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        ).toEqual(
          [
            ["service", firstV2.id, false],
            ["service", olderV2.id, false],
            ["workspace", null, true],
          ].toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        );

        // A member's block applies to everyone; their approve does not lower anyone's.
        const source = yield* call(
          "Read the shared app's source",
          `/api/organizations/${target.id}/apps/${app}/source`,
        );
        expect(source.status, JSON.stringify(source.body)).toBe(200);
        const files = (yield* Schema.decodeUnknownEffect(Source)(source.body)).files;
        const toolsFile = files.find((file) => file.path === "tools.ts")?.content ?? "";
        const compact = toolsFile.replace(/\s+/gu, "");
        expect(compact).toContain('constomitted=newSet<string>(["delete_item"])');
        // The member's own approve of `search` is dropped, so no tool skips its approval.
        expect(compact).toContain('constapprovals:Record<string,"always"|"never">={}');
        expect(files.find((file) => file.path === "index.ts")?.content).toContain(
          "workspace: provider.many()",
        );
        for (const secret of ["synthetic-team-key", "synthetic-first-key", "synthetic-second-key"])
          expect(JSON.stringify(files)).not.toContain(secret);

        // Every member has their own copy of the org toolkit; the personal one is its owner's.
        const copies = yield* cloudRows(
          Schema.Struct({ name: Schema.String, userId: Schema.String }),
          `select name, "userId" from "mcpConnection" where resource = $1 and not revoked`,
          target.id,
        );
        expect(
          copies
            .map((copy) => [copy.name, copy.userId])
            .toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        ).toEqual(
          [
            ["Mine", firstV2.id],
            ["Team kit", firstV2.id],
            ["Team kit", olderV2.id],
            ["Team kit", thirdV2.id],
          ].toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        );

        // Starting it again finds the same instance and writes nothing new.
        const again = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [workspace.organization],
        });
        expect(again.status).toBe(200);
        expect(
          yield* cloudRows(
            IdRow,
            `select o.id from organization o where o.slug like $1`,
            `${slug}%`,
          ),
        ).toEqual([{ id: target.id }]);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(
    scenarios.v1ImportToolkitScale.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const emulators = yield* Emulators;
          const operator = yield* v1ImportOperator;
          const emails = Array.from({ length: 20 }, (_, index) => syntheticEmail(`scale-${index}`));
          const [owner, ...others] = emails;
          if (owner === undefined) return yield* Effect.die("The workspace has no members");
          const workspace = yield* emulators.v1Workspace([owner, ...others]);
          const members = [workspace.user];
          for (const email of others) members.push(yield* emulators.v1User(email));
          const scale = toolkitScale(workspace.organization, members);
          yield* scale.seed;
          const copies = 8 * members.length + 2;

          // The dry run plans every member's copy of every toolkit in one step.
          const dry = v1RunId("kits-dry");
          expect(
            (yield* operator.start({
              mode: "dry-run",
              runId: dry,
              organizations: [workspace.organization],
            })).status,
          ).toBe(200);
          const planned = yield* operator.waitForReport(dry, workspace.organization);
          expect(planned.status, planned.reason ?? "").toBe("planned");
          expect(planned.counts.v1).toMatchObject({
            integrations: 8,
            connections: scale.connections.length,
            policies: 344,
            toolkits: 10,
          });
          // Only planned toolkits count their copies: one that failed or whose step gave up has
          // none.
          expect(planned.counts.v2).toMatchObject({
            apps: 7 + 3,
            accounts: scale.connections.length,
            mcpConnections: copies,
          });
          expect(planned.integrationFailures).toEqual([]);
          expect(planned.connectionFailures).toEqual([]);
          expect(
            (planned.splitIntegrations ?? []).map((split) => [
              split.label,
              split.apps.map((app) => app.status),
            ]),
          ).toEqual([["Scale 0", ["planned", "planned", "planned"]]]);

          yield* allowV1Import(workspace.organization);
          const run = v1RunId("kits");
          expect(
            (yield* operator.start({
              mode: "import",
              runId: run,
              organizations: [workspace.organization],
            })).status,
          ).toBe(200);
          const report = yield* operator.waitForReport(run, workspace.organization);
          expect(report.status, report.reason ?? "").toBe("imported");
          expect(report.verification?.passed).toBe(true);
          expect(report.verification?.items.failed).toBe(0);
          const target = report.v2Organization;
          if (target === undefined) return yield* Effect.die("The import named no organization");
          const items = report.items ?? [];
          const toolkits = items.filter((item) => item.kind === "toolkit");
          expect(toolkits.map((item) => [item.label, item.status]).toSorted()).toEqual(
            scale.kits.map((kit) => [kit.name, "imported"]).toSorted(),
          );
          expect(report.counts.v2.mcpConnections).toBe(copies);
          // A toolkit's note is its first copy's, which lists what the workspace blocks.
          for (const kit of scale.kits.slice(0, 8))
            expect(toolkits.find((item) => item.label === kit.name)?.note).toBe(
              scale.blockedNote(kit),
            );

          // Each server's app, each connection's own app on the first, and each account.
          const apps = new Map<string, string>();
          for (const item of items)
            if (item.kind === "integration" && item.v2Id !== undefined) {
              const server = scale.servers.find((candidate) => candidate.label === item.label);
              if (server !== undefined) apps.set(server.slug, item.v2Id);
            }
          for (const split of report.splitIntegrations ?? [])
            for (const app of split.apps)
              if (app.v2Id !== undefined) apps.set(app.connection, app.v2Id);
          expect(apps.size).toBe(7 + 3);
          const accounts = new Map(
            items.flatMap((item) =>
              item.kind === "connection" && item.v2Id !== undefined
                ? [[item.id, item.v2Id] as const]
                : [],
            ),
          );
          expect(accounts.size).toBe(scale.connections.length);

          // Every member has their own copy of each organization toolkit, granting exactly what
          // its rules and the workspace allow; a member's own toolkit is theirs alone.
          const users = yield* cloudRows(
            Schema.Struct({ id: Schema.String, email: Schema.String }),
            `select id, lower(email) as email from "user"
              where lower(email) in (select lower(value) from json_array_elements_text($1::json))`,
            JSON.stringify(emails),
          );
          const v2Of = new Map(
            emails.map((email, index) => [
              members[index] ?? "",
              users.find((user) => user.email === email.toLowerCase())?.id ?? "",
            ]),
          );
          const saved = yield* cloudRows(
            ToolkitCopy,
            `select name, "userId", policy::text as policy from "mcpConnection"
              where resource = $1 and not revoked`,
            target.id,
          );
          expect(saved).toHaveLength(copies);
          for (const kit of scale.kits) {
            const own = saved.filter((copy) => copy.name === kit.name);
            expect(own.map((copy) => copy.userId).toSorted()).toEqual(
              (kit.subject === "" ? members : [kit.subject])
                .map((member) => v2Of.get(member) ?? "")
                .toSorted(),
            );
            const expected = scale.expectedPolicy(kit, apps, accounts);
            for (const copy of own)
              expect(
                copy.policy.apps.toSorted((a, b) => (a.app < b.app ? -1 : 1)),
                `${kit.name} for ${copy.userId}`,
              ).toEqual(expected);
          }
        }).pipe(Effect.provide(services)),
      ),
    // A dry run and an import of a workspace of 20 members.
    { timeout: 240_000 },
  );

  it.effect(scenarios.v1ImportRollback.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          browser = yield* Browser;
        const operator = yield* v1ImportOperator;
        const identity = yield* emulators.identity("google");
        // A workspace with a teammate and the shared seed's integration, connections, rules and
        // toolkits; its data holds the member on v1 at sign-in.
        const teammate = syntheticEmail("teammate");
        const workspace = yield* emulators.v1Workspace([identity.email, teammate]);
        const teammateUser = yield* emulators.v1User(teammate);
        const former = yield* emulators.v1Workspace([syntheticEmail("former")]);
        const toolkits = { team: randomUUID(), mine: randomUUID() };
        yield* seedShared(
          workspace.organization,
          `v1-${randomUUID().slice(0, 8)}`,
          { first: workspace.user, second: teammateUser, former: former.user },
          toolkits,
        );
        yield* signInOnV1(identity.email);

        yield* allowV1Import(workspace.organization);
        const run = v1RunId("rollback");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [workspace.organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, workspace.organization);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.cutover).toBe(true);
        const target = report.v2Organization;
        if (target === undefined) return yield* Effect.die("The import named no organization");
        expect(yield* movedFlag(workspace.organization)).toEqual([
          { state: "moved", v2_org_id: target.id, v2_org_slug: target.slug },
        ]);
        const copies = (yield* liveCopies(target.id)).map((copy) => copy.id);
        expect(copies).toHaveLength(3);

        // While its v2 organization exists, its grants could renew beside v1's: no rollback.
        const refused = yield* operator.rollback(workspace.organization);
        expect(refused.status).toBe(409);
        expect(JSON.stringify(refused.body)).toContain("still exists");
        expect((yield* movedFlag(workspace.organization))[0]?.state).toBe("moved");

        const deleted = yield* browser.use("Delete the imported v2 organization", (page) =>
          page.evaluate(
            (id) => fetch(`/api/organizations/${id}`, { method: "DELETE" }).then((r) => r.status),
            target.id,
          ),
        );
        expect(deleted).toBeLessThan(300);
        // Removal is durable and finishes shortly; the rollback waits for its organization row.
        const rolledBack = yield* operator.rollback(workspace.organization).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(new Error(JSON.stringify(response.body))),
          ),
          Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "50 seconds" }))),
        );
        expect(rolledBack.body).toEqual({
          organization: workspace.organization,
          state: "rolled_back",
        });
        expect(yield* movedFlag(workspace.organization)).toEqual([
          { state: "rolled_back", v2_org_id: null, v2_org_slug: null },
        ]);
        expect(yield* importState(workspace.organization)).toEqual([{ state: "rolled_back" }]);
        // Users stay mapped, for their other organizations; everything else is gone.
        expect(
          yield* cloudRows(
            Schema.Struct({ v1_kind: Schema.String }),
            "select distinct v1_kind from private_v1_import_map where v1_org_id = $1",
            workspace.organization,
          ),
        ).toEqual([{ v1_kind: "user" }]);

        // Workflows forgets an instance some time after it ends. A workspace that moved before
        // that, and whose v2 organization is gone, still rolls back.
        const forgotten = (yield* emulators.v1Workspace([syntheticEmail("forgotten")]))
          .organization;
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, $2, $3)",
            forgotten,
            "Synthetic forgotten workspace",
            `forgotten-${randomUUID().slice(0, 8)}`,
          ),
          row(
            "insert into org_moved_to_v2 (org_id, state, v2_org_id, v2_org_slug) values ($1, 'moved', $2, 'removed-team')",
            forgotten,
            randomUUID(),
          ),
        ]);
        yield* writeRows("sso-database.json", [
          row(
            "insert into private_v1_import_org (v1_org_id, v2_org_id, state, run_id, report) values ($1, $2, 'cutover', $3, '{}'::jsonb)",
            forgotten,
            randomUUID(),
            run,
          ),
        ]);
        const forgottenRollback = yield* operator.rollback(forgotten);
        expect(forgottenRollback.status, JSON.stringify(forgottenRollback.body)).toBe(200);
        expect((yield* movedFlag(forgotten))[0]?.state).toBe("rolled_back");
        expect(yield* importState(forgotten)).toEqual([{ state: "rolled_back" }]);

        // Imported again, it moves into a new v2 organization with every member's toolkit copy.
        const again = yield* importTwin({
          label: "rollback-again",
          owner: { user: workspace.user, email: identity.email },
          teammate: { user: teammateUser, email: teammate },
          former: former.user,
          toolkits,
          earlier: copies,
        });
        expect(again.report.v2Organization?.id).not.toBe(target.id);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportPaidBilling.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const identity = yield* emulators.identity("google");
        const workspace = (label: string, email: string) =>
          Effect.gen(function* () {
            const created = yield* emulators.v1Workspace([email]);
            yield* writeRows("v1-database.json", [
              row(
                "insert into organizations (id, name, slug) values ($1, $2, $3)",
                created.organization,
                `Synthetic ${label} workspace`,
                `v1-${randomUUID().slice(0, 8)}`,
              ),
            ]);
            return created.organization;
          });
        const seats = yield* workspace("per-member", identity.email);
        const flat = yield* workspace("flat", `flat-${randomUUID().slice(0, 8)}@example.test`);
        const hobby = yield* workspace("hobby", `hobby-${randomUUID().slice(0, 8)}@example.test`);
        // v1's Team version 3 per member, cancelled at the end of its period; version 1 at a flat
        // USD 49 with executions metered on top; and grandfathered Hobby, which moves to Free.
        const perMember = yield* emulators.v1TeamSubscription(seats, {
          version: 3,
          seats: 1,
          cancelled: true,
        });
        const flatPrice = yield* emulators.v1TeamSubscription(flat, { version: 1 });
        yield* emulators.v1Plan(hobby, "hobby");
        yield* signInOnV1(identity.email);

        yield* allowV1Import(seats, flat, hobby);
        const run = v1RunId("paid");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [seats, flat, hobby],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);

        const carried = (organization: string) =>
          Effect.gen(function* () {
            const report = yield* operator.waitForReport(run, organization);
            expect(report.status, report.reason ?? "").toBe("imported");
            expect(report.cutover).toBe(true);
            const target = report.v2Organization;
            if (target === undefined) return yield* Effect.die("The import named no organization");
            // v1's customer became the v2 organization's: v1's id has none left.
            expect(yield* emulators.autumnCustomer(organization)).toBeNull();
            const customerId = yield* emulators.v2BillingCustomer(target.id);
            const namespace = customerId.slice(0, customerId.indexOf(":organization:"));
            const customer = yield* emulators.autumnCustomer(customerId);
            if (customer === null) return yield* Effect.die("The v2 organization has no customer");
            return { report, target, customerId, namespace, customer };
          });

        const moved = yield* carried(seats);
        expect(moved.report.billing).toEqual({
          subscription: {
            plan: "team",
            version: 3,
            pricing: "per_member",
            v2Pricing: "per_member",
            trialing: false,
            cancelling: true,
          },
          problem: null,
          carried: true,
        });
        // v2's Team plan alone bills it, on v1's Stripe subscription, renewing when v1's did and
        // still cancelled then. v1's free plan stays scheduled after it, which v2 ignores.
        const team = moved.customer.subscriptions.filter((sub) => sub.status !== "scheduled");
        expect(team).toMatchObject([
          {
            plan_id: `${moved.namespace}-team`,
            current_period_end: perMember.periodEnd,
            expires_at: perMember.periodEnd,
          },
        ]);
        expect(team[0]?.canceled_at).not.toBeNull();
        expect(yield* emulators.autumnStripeSubscriptions(moved.customerId)).toEqual([
          perMember.stripeSubscription,
        ]);
        // Its seats synced once the subscription was v2's.
        expect(moved.customer.balances[`${moved.namespace}-members`]?.usage).toBe(1);
        expect(
          yield* cloudRows(
            Schema.Struct({ state: Schema.String, stripe_subscription_id: Schema.String }),
            "select state, stripe_subscription_id from private_v1_import_billing where organization_id = $1",
            moved.target.id,
          ),
        ).toEqual([{ state: "carried", stripe_subscription_id: perMember.stripeSubscription }]);
        const overview = yield* call(
          "Read the moved organization's billing",
          `/api/organizations/${moved.target.id}/billing`,
        );
        expect(overview.status).toBe(200);
        expect(overview.body).toMatchObject({
          subscriptions: [{ planId: `${moved.namespace}-team` }],
        });

        // A flat price stays the price, with unlimited members, on its Stripe subscription.
        const kept = yield* carried(flat);
        expect(kept.report.billing).toMatchObject({
          subscription: { version: 1, pricing: "flat", v2Pricing: "flat", cancelling: false },
          carried: true,
        });
        expect(kept.customer.subscriptions).toMatchObject([
          {
            plan_id: `${kept.namespace}-team`,
            current_period_end: flatPrice.periodEnd,
            canceled_at: null,
            plan: { price: { amount: 49, interval: "month" } },
          },
        ]);
        expect(kept.customer.balances[`${kept.namespace}-members`]?.unlimited).toBe(true);
        expect(yield* emulators.autumnStripeSubscriptions(kept.customerId)).toEqual([
          flatPrice.stripeSubscription,
        ]);

        // Hobby moves as a free organization does: nothing carries over and v1's customer is
        // left as it was, while v2's billing puts the organization on its Free plan.
        const free = yield* operator.waitForReport(run, hobby);
        expect(free.status, free.reason ?? "").toBe("imported");
        expect(free.cutover).toBe(true);
        expect(free.billing).toBeUndefined();
        expect(free.flags).toMatchObject({ paidPlans: ["hobby"] });
        const freeTarget = free.v2Organization;
        if (freeTarget === undefined) return yield* Effect.die("The import named no organization");
        expect(yield* movedFlag(hobby)).toEqual([
          { state: "moved", v2_org_id: freeTarget.id, v2_org_slug: freeTarget.slug },
        ]);
        expect(
          yield* cloudRows(
            Schema.Struct({ state: Schema.String }),
            "select state from private_v1_import_billing where organization_id = $1",
            freeTarget.id,
          ),
        ).toEqual([]);
        expect((yield* emulators.autumnCustomer(hobby))?.subscriptions).toMatchObject([
          { plan_id: "hobby" },
        ]);
        const freeCustomerId = yield* emulators.v2BillingCustomer(freeTarget.id);
        const freePlan = `${freeCustomerId.slice(0, freeCustomerId.indexOf(":organization:"))}-free`;
        const onFree = yield* emulators.autumnCustomer(freeCustomerId).pipe(
          Effect.flatMap((customer) =>
            customer === null
              ? Effect.fail(new Error("v2 has not made the organization's customer yet"))
              : Effect.succeed(customer),
          ),
          Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "50 seconds" }))),
        );
        expect(onFree.subscriptions.map((sub) => sub.plan_id)).toEqual([freePlan]);
        expect(yield* emulators.autumnStripeSubscriptions(freeCustomerId)).toEqual([]);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportBillingReturn.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          browser = yield* Browser;
        const operator = yield* v1ImportOperator;
        const identity = yield* emulators.identity("google");
        const workspace = yield* emulators.v1Workspace([identity.email]);
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, $2, $3)",
            workspace.organization,
            "Synthetic returned workspace",
            `v1-${randomUUID().slice(0, 8)}`,
          ),
        ]);
        const v1 = yield* emulators.v1TeamSubscription(workspace.organization, {
          version: 3,
          seats: 1,
        });
        yield* signInOnV1(identity.email);
        yield* allowV1Import(workspace.organization);

        // Autumn refuses the attach once, after the customer took v2's id.
        const fault = yield* emulators.failAutumnReads("billing.attach", { status: 400, times: 1 });
        yield* Effect.addFinalizer(() => emulators.clearAutumnFault(fault).pipe(Effect.orDie));
        const run = v1RunId("billing-return");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [workspace.organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, workspace.organization);
        expect(report.status).toBe("failed");
        expect(report.reason).toContain("Its subscription did not carry over");
        expect(report.cutover).toBe(false);
        expect(report.billing).toMatchObject({ carried: false });
        const target = report.v2Organization;
        if (target === undefined) return yield* Effect.die("The import named no organization");
        // It stays frozen in v1, charged nothing, and its billing stays held.
        expect((yield* movedFlag(workspace.organization))[0]?.state).toBe("moving");
        const customerId = yield* emulators.v2BillingCustomer(target.id);
        const halfway = yield* emulators.autumnCustomer(customerId);
        expect(halfway?.subscriptions).toMatchObject([{ plan_id: "team" }]);
        expect(
          yield* cloudRows(
            Schema.Struct({ state: Schema.String }),
            "select state from private_v1_import_billing where organization_id = $1",
            target.id,
          ),
        ).toEqual([{ state: "held" }]);
        // While held, v2's billing makes no customer and offers no checkout.
        const overview = yield* call(
          "Read the held organization's billing",
          `/api/organizations/${target.id}/billing`,
        );
        expect(overview.status).toBe(503);
        const checkout = yield* browser.use("Try a checkout for the held organization", (page) =>
          page.evaluate(
            (id) =>
              fetch(`/api/organizations/${id}/billing/checkout`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ plan: "team" }),
              }).then((response) => response.status),
            target.id,
          ),
        );
        expect(checkout).toBe(503);
        // v1 meters an execution meanwhile and makes itself a free customer under its id.
        yield* emulators.v1MeteredCustomer(workspace.organization);

        const returned = yield* operator.returnBilling(workspace.organization);
        expect(returned).toEqual({
          status: 200,
          body: { organization: workspace.organization, billing: "returned" },
        });
        // v1's Team plan bills it again, on the same Stripe subscription, with v1's seats.
        expect(yield* emulators.autumnCustomer(customerId)).toBeNull();
        const back = yield* emulators.autumnCustomer(workspace.organization);
        expect(back?.subscriptions).toMatchObject([
          {
            plan_id: "team",
            current_period_end: v1.periodEnd,
            canceled_at: null,
            plan: { version: 3 },
          },
        ]);
        expect(back?.balances.members?.usage).toBe(1);
        expect(yield* emulators.autumnStripeSubscriptions(workspace.organization)).toEqual([
          v1.stripeSubscription,
        ]);
        // A second return changes nothing.
        expect((yield* operator.returnBilling(workspace.organization)).status).toBe(200);

        // Deleting the v2 organization now cancels nothing, and the organization rolls back.
        const deleted = yield* browser.use("Delete the imported v2 organization", (page) =>
          page.evaluate(
            (id) => fetch(`/api/organizations/${id}`, { method: "DELETE" }).then((r) => r.status),
            target.id,
          ),
        );
        expect(deleted).toBeLessThan(300);
        const rolledBack = yield* operator.rollback(workspace.organization).pipe(
          Effect.flatMap((response) =>
            response.status === 200
              ? Effect.succeed(response)
              : Effect.fail(new Error(JSON.stringify(response.body))),
          ),
          Effect.retry(Schedule.spaced("1 second").pipe(Schedule.upTo({ duration: "50 seconds" }))),
        );
        expect(rolledBack.body).toEqual({
          organization: workspace.organization,
          state: "rolled_back",
        });
        expect(
          (yield* emulators.autumnCustomer(workspace.organization))?.subscriptions,
        ).toMatchObject([{ plan_id: "team", canceled_at: null }]);
        expect(yield* emulators.autumnStripeSubscriptions(workspace.organization)).toEqual([
          v1.stripeSubscription,
        ]);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportSlugDisplacement.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          onboarding = yield* Onboarding,
          browser = yield* Browser;
        const operator = yield* v1ImportOperator;
        // Someone else's v2 team, with its Executor app, holds the slug a v1 workspace has.
        yield* onboarding.socialSignIn("google");
        const team = yield* onboarding.confirmTeam(yield* onboarding.prepareTeam);
        const slug = team.slug;
        const SlugRow = Schema.Struct({ slug: Schema.String });
        const slugOf = (organization: string) =>
          cloudRows(SlugRow, "select slug from organization where id = $1", organization).pipe(
            Effect.map((rows) => rows[0]?.slug),
          );
        const MemberRow = Schema.Struct({ userId: Schema.String, role: Schema.String });
        const membersOf = (organization: string) =>
          cloudRows(
            MemberRow,
            `select "userId", role from member where "organizationId" = $1 order by "userId"`,
            organization,
          );
        const teamMembers = yield* membersOf(team.id);
        const domainJobs = (organization: string) =>
          cloudRows(
            Schema.Struct({ jobs: Schema.Number }),
            "select count(*)::int as jobs from hosted_provisioning where kind = 'domain' and organization_id = $1",
            organization,
          ).pipe(Effect.map((rows) => rows[0]?.jobs ?? 0));
        const jobsBefore = yield* domainJobs(team.id);
        const workspace = (label: string, workspaceSlug: string) =>
          Effect.gen(function* () {
            const created = yield* emulators.v1Workspace([
              `${label}-${randomUUID().slice(0, 8)}@example.test`,
            ]);
            yield* writeRows("v1-database.json", [
              row(
                "insert into organizations (id, name, slug) values ($1, $2, $3)",
                created.organization,
                `Synthetic ${label} workspace`,
                workspaceSlug,
              ),
            ]);
            yield* allowV1Import(created.organization);
            return created.organization;
          });
        const listed = yield* workspace("listed", slug);
        yield* listV1SlugDisplacement(listed, team.id);
        // Listed, but the team does not hold this workspace's slug.
        const freeSlug = `v1-${randomUUID().slice(0, 8)}`;
        const mislisted = yield* workspace("mislisted", freeSlug);
        yield* listV1SlugDisplacement(mislisted, team.id);
        // Another v2 organization holds this one's slug, and nobody listed it.
        const heldSlug = `v1-${randomUUID().slice(0, 8)}`;
        const holder = randomUUID();
        yield* writeRows("sso-database.json", [
          row(
            `insert into organization (id, name, slug, "createdAt") values ($1, 'Synthetic holder', $2, now())`,
            holder,
            heldSlug,
          ),
        ]);
        const unlisted = yield* workspace("unlisted", heldSlug);

        const dry = v1RunId("displace-dry");
        expect(
          (yield* operator.start({
            mode: "dry-run",
            runId: dry,
            organizations: [listed, mislisted, unlisted],
          })).status,
        ).toBe(200);
        const planned = yield* operator.waitForReport(dry, listed);
        expect(planned.status, planned.reason ?? "").toBe("planned");
        const renamedTo = planned.slug?.displaced?.slug;
        if (renamedTo === undefined || renamedTo === null)
          return yield* Effect.die(
            `The dry run planned no rename: ${JSON.stringify(planned.slug)}`,
          );
        // The team's new slug is its own slug with a suffix; the workspace keeps the slug as it is.
        expect(renamedTo).toMatch(/^[a-z0-9-]+-[0-9a-f]{6}$/u);
        expect(slug.startsWith(renamedTo.slice(0, -7))).toBe(true);
        expect(planned.slug).toEqual({
          v1: slug,
          v2: slug,
          changed: false,
          displaced: { organization: team.id, slug: renamedTo },
        });
        expect((yield* operator.waitForReport(dry, mislisted)).slug).toEqual({
          v1: freeSlug,
          v2: freeSlug,
          changed: false,
          displaced: {
            organization: team.id,
            slug: null,
            reason: `The listed v2 organization does not hold ${freeSlug}, which is free.`,
          },
        });
        const unlistedPlan = yield* operator.waitForReport(dry, unlisted);
        expect(unlistedPlan.slug?.changed).toBe(true);
        expect(unlistedPlan.slug?.displaced).toBeUndefined();
        expect(unlistedPlan.slug?.v2).toMatch(new RegExp(`^${heldSlug}-[0-9a-f]{6}$`, "u"));
        // A dry run renames nothing.
        expect(yield* slugOf(team.id)).toBe(slug);

        const run = v1RunId("displace");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [listed, unlisted],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, listed);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.cutover).toBe(true);
        const target = report.v2Organization;
        if (target === undefined) return yield* Effect.die("The import named no organization");
        expect(target.slug).toBe(slug);
        expect(report.slug).toEqual({
          v1: slug,
          v2: slug,
          changed: false,
          displaced: { organization: team.id, slug: renamedTo },
        });
        expect(yield* movedFlag(listed)).toEqual([
          { state: "moved", v2_org_id: target.id, v2_org_slug: slug },
        ]);
        // The team is renamed as a rename in its settings is: its app domain is queued again.
        expect(yield* slugOf(team.id)).toBe(renamedTo);
        expect(yield* membersOf(team.id)).toEqual(teamMembers);
        expect(yield* domainJobs(team.id)).toBeGreaterThan(jobsBefore);
        expect(
          yield* cloudRows(
            Schema.Struct({ reason: Schema.NullOr(Schema.String) }),
            "select reason from private_v1_import_map where v1_kind = 'organization' and v1_id = $1",
            listed,
          ),
        ).toEqual([
          {
            reason: `Renamed v2 organization ${team.id} from ${slug} to ${renamedTo} to take its slug.`,
          },
        ]);

        // The team's member keeps the team and its apps at the new slug; the old one is the
        // workspace's now, which they are not a member of.
        expect(
          (yield* call(
            "Read the team at its new slug",
            `/api/organizations/${renamedTo}/inventory`,
          )).status,
        ).toBe(200);
        expect(
          (yield* call("Read the team by its id", `/api/organizations/${team.id}/inventory`))
            .status,
        ).toBe(200);
        expect(
          (yield* call("The old slug names the workspace", `/api/organizations/${slug}/inventory`))
            .status,
        ).toBe(403);
        expect(yield* onboarding.organizations).toEqual([{ ...team, slug: renamedTo }]);
        yield* browser.use("Open the team's apps at its new slug", (page) =>
          page.goto(`/org/${renamedTo}/apps`),
        );
        yield* browser.use("The team's Executor app is still there", (page) =>
          page
            .getByRole("link", { name: "Open Executor", exact: true })
            .waitFor({ state: "visible" }),
        );

        // Without a listing, the holder keeps its slug and the workspace takes its suffix.
        const suffixed = yield* operator.waitForReport(run, unlisted);
        expect(suffixed.status, suffixed.reason ?? "").toBe("imported");
        expect(suffixed.v2Organization?.slug).toBe(unlistedPlan.slug?.v2);
        expect(yield* slugOf(holder)).toBe(heldSlug);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportInto.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          onboarding = yield* Onboarding,
          fs = yield* FileSystem.FileSystem,
          target = yield* Target,
          mcp = yield* McpClient;
        const operator = yield* v1ImportOperator;
        // The member already has their own v2 team.
        const identity = yield* onboarding.socialSignIn("google");
        const team = yield* onboarding.confirmTeam(yield* onboarding.prepareTeam);
        const user = (yield* cloudRows(
          IdRow,
          `select id from "user" where email = $1`,
          identity.email,
        ))[0]?.id;
        if (user === undefined) return yield* Effect.die("The member has no v2 user");
        // Their v1 workspace has nothing to copy.
        const workspace = yield* emulators.v1Workspace([identity.email]);
        const slug = `v1-${randomUUID().slice(0, 8)}`;
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, $2, $3)",
            workspace.organization,
            "Synthetic empty workspace",
            slug,
          ),
        ]);
        yield* allowV1Import(workspace.organization);
        yield* listV1Into(workspace.organization, team.id);

        const teamRow = cloudRows(
          Schema.Struct({ name: Schema.String, slug: Schema.String }),
          "select name, slug from organization where id = $1",
          team.id,
        );
        const teamMembers = cloudRows(
          Schema.Struct({ userId: Schema.String, role: Schema.String }),
          `select "userId", role from member where "organizationId" = $1 order by "userId"`,
          team.id,
        );
        const before = { team: yield* teamRow, members: yield* teamMembers };
        expect(before.team).toEqual([{ name: team.name, slug: team.slug }]);
        /** Nothing in v2 is created or changed: the team, its members, the member's teams, billing. */
        const unchanged = Effect.gen(function* () {
          expect(yield* teamRow).toEqual(before.team);
          expect(yield* teamMembers).toEqual(before.members);
          expect(
            yield* cloudRows(
              Schema.Struct({ organizationId: Schema.String }),
              `select "organizationId" from member where "userId" = $1`,
              user,
            ),
          ).toEqual([{ organizationId: team.id }]);
          expect(
            yield* cloudRows(IdRow, "select id from organization where slug like $1", `${slug}%`),
          ).toEqual([]);
          expect(
            yield* cloudRows(
              IdRow,
              "select organization_id as id from private_v1_import_billing where organization_id = $1",
              team.id,
            ),
          ).toEqual([]);
          expect(
            yield* cloudRows(IdRow, `select id from "user" where email = $1`, identity.email),
          ).toEqual([{ id: user }]);
        });
        const MapEntry = Schema.Struct({
          v1_kind: Schema.String,
          v2_kind: Schema.NullOr(Schema.String),
          v2_id: Schema.NullOr(Schema.String),
        });
        const mapRows = cloudRows(
          MapEntry,
          "select v1_kind, v2_kind, v2_id from private_v1_import_map where v1_org_id = $1 order by v1_kind",
          workspace.organization,
        );
        const plannedInto = (report: V1Report) => {
          expect(report.status, report.reason ?? "").toBe("planned");
          expect(report.into).toEqual({ organization: team.id, mode: "nothing_to_copy" });
          expect(report.slug).toEqual({ v1: slug, v2: team.slug, changed: true });
          expect(report.emailMatches).toEqual([{ email: identity.email, match: "merge" }]);
          expect(report.counts.v2).toMatchObject({
            users: 0,
            mergedUsers: 1,
            apps: 0,
            accounts: 0,
            mcpConnections: 0,
            undeployedApps: 0,
            policies: 0,
          });
        };

        // The dry run plans the move and writes nothing.
        const dry = v1RunId("into-dry");
        expect(
          (yield* operator.start({
            mode: "dry-run",
            runId: dry,
            organizations: [workspace.organization],
          })).status,
        ).toBe(200);
        plannedInto(yield* operator.waitForReport(dry, workspace.organization));
        expect(yield* movedFlag(workspace.organization)).toEqual([]);
        expect(yield* mapRows).toEqual([]);
        yield* unchanged;

        const run = v1RunId("into");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [workspace.organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, workspace.organization);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.into).toEqual({ organization: team.id, mode: "nothing_to_copy" });
        expect(report.v2Organization).toEqual({ id: team.id, slug: team.slug });
        expect(report.slug).toEqual({ v1: slug, v2: team.slug, changed: true });
        expect(report.verification).toEqual({
          items: { planned: 0, withResult: 0, failed: 0 },
          members: { planned: 1, inV2: 1 },
          accounts: { checked: 0, unreadable: 0 },
          apps: { checked: 0, withoutVersion: 0 },
          passed: true,
        });
        expect(report.cutover).toBe(true);
        // v1 redirects and forwards the workspace to the team, at the team's own slug.
        expect(yield* movedFlag(workspace.organization)).toEqual([
          { state: "moved", v2_org_id: team.id, v2_org_slug: team.slug },
        ]);
        expect(yield* importState(workspace.organization)).toEqual([{ state: "cutover" }]);
        const moved = [
          { v1_kind: "organization", v2_kind: "existing_organization", v2_id: team.id },
          { v1_kind: "user", v2_kind: "merged_user", v2_id: user },
        ];
        expect(yield* mapRows).toEqual(moved);
        yield* unchanged;

        // A request v1 forwards for the workspace runs in the team, as its member.
        const { secret } = yield* fs
          .readFileString(`${target.directory}/${v1McpForwardFile}`)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(V1McpForwardSecret))),
          );
        let minted = 0;
        const sign = () =>
          Redacted.make(
            v1ForwardBearer(secret, {
              account: workspace.user,
              organization: workspace.organization,
              exp: Math.floor(Date.now() / 1000) + 300 + minted++,
            }),
          );
        const forwarded = yield* mcp.connect(sign, "forwarded-into-team");
        const listed = yield* forwarded.use(
          "List the forwarded session's tools",
          (client, signal) => client.listTools(undefined, { signal }),
        );
        expect(listed.tools.map((tool) => tool.name)).toContain("execute");
        /** The status of one initialize request v1 forwards for the workspace. */
        const initialize = Effect.scoped(
          Effect.gen(function* () {
            const http = yield* HttpClient.HttpClient;
            const request = HttpClientRequest.post(`${target.metadata.origin}/mcp`).pipe(
              HttpClientRequest.setHeaders({
                accept: "application/json, text/event-stream",
                authorization: `Bearer ${Redacted.value(sign())}`,
              }),
            );
            const response = yield* http.execute(
              yield* HttpClientRequest.bodyJson(request, {
                jsonrpc: "2.0",
                id: 1,
                method: "initialize",
                params: {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  clientInfo: { name: "forwarded-into", version: "1" },
                },
              }),
            );
            yield* response.text;
            return response.status;
          }),
        ).pipe(Effect.provide(FetchHttpClient.layer));
        expect(yield* initialize).toBe(200);

        // Starting it again finds the same instance; a later dry run finds the team through the
        // workspace's map row. Neither writes anything.
        expect(
          (yield* operator.start({
            mode: "import",
            runId: run,
            organizations: [workspace.organization],
          })).status,
        ).toBe(200);
        const later = v1RunId("into-later");
        expect(
          (yield* operator.start({
            mode: "dry-run",
            runId: later,
            organizations: [workspace.organization],
          })).status,
        ).toBe(200);
        plannedInto(yield* operator.waitForReport(later, workspace.organization));
        expect(yield* mapRows).toEqual(moved);
        yield* unchanged;

        // No billing carried over, so there is none to give back.
        const billing = yield* operator.returnBilling(workspace.organization);
        expect(billing.status).toBe(409);
        expect(billing.body).toEqual({
          error: "It moved into an existing v2 organization, and no billing carried over.",
        });

        // The team is the member's own: the workspace goes back to v1 and the team stays.
        const rolledBack = yield* operator.rollback(workspace.organization);
        expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(200);
        expect(rolledBack.body).toEqual({
          organization: workspace.organization,
          state: "rolled_back",
          removed: { apps: 0, accounts: 0, toolkitCopies: 0, members: 0 },
        });
        expect(yield* movedFlag(workspace.organization)).toEqual([
          { state: "rolled_back", v2_org_id: null, v2_org_slug: null },
        ]);
        expect(yield* importState(workspace.organization)).toEqual([{ state: "rolled_back" }]);
        expect(yield* mapRows).toEqual([{ v1_kind: "user", v2_kind: "merged_user", v2_id: user }]);
        yield* unchanged;
        // v2 no longer maps the workspace, so it refuses what v1 would have forwarded.
        expect(yield* initialize).toBe(403);
      }).pipe(Effect.provide(Layer.mergeAll(services, McpClient.layer))),
    ),
  );

  it.effect(scenarios.v1ImportIntoLeave.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const operator = yield* v1ImportOperator;
        // The member works in their own v2 team; their v1 workspace still has an integration and
        // a rule, which stay in v1.
        const address = syntheticEmail("leave");
        const user = yield* v2User(address);
        const team = yield* v2Team(user);
        const teamSlug = (yield* cloudRows(
          Schema.Struct({ slug: Schema.String }),
          "select slug from organization where id = $1",
          team,
        ))[0]?.slug;
        const workspace = yield* listedV1Workspace("leave", [address], team, "leave_v1_data");
        const organization = workspace.organization;
        const tracker = `left_${randomUUID().slice(0, 6)}`;
        const toolkitRow = (collection: string, data: Record<string, string>) =>
          row(
            "insert into plugin_storage (tenant, owner, subject, plugin_id, collection, key, data) values ($1, 'org', '', 'toolkits', $2, $3, $4::json)",
            organization,
            collection,
            data.id ?? "",
            JSON.stringify(data),
          );
        yield* writeRows("v1-database.json", [
          row(
            "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'mcp', 'Left Tracker', $3::json)",
            organization,
            tracker,
            JSON.stringify({
              transport: "remote",
              endpoint: "https://left.example.com/mcp",
              remoteTransport: "auto",
            }),
          ),
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, 'block', 'a0')",
            organization,
            `${tracker}.*.*.search`,
          ),
          goneRule(organization),
          toolkitRow("toolkits", { id: "tk_left", name: "Left kit", slug: "left" }),
          toolkitRow("toolkitConnections", {
            id: "tc_left",
            toolkitId: "tk_left",
            pattern: `${tracker}.org.*.*`,
            position: "a0",
          }),
        ]);
        const v1Data = v1Rows(
          Schema.Struct({ row_id: Schema.String }),
          "select row_id::text from integration where tenant = $1 union all select row_id::text from tool_policy where tenant = $1 union all select row_id::text from plugin_storage where tenant = $1 order by 1",
          organization,
        );
        const before = yield* v1Data;
        expect(before).toHaveLength(5);
        const teamMembers = cloudRows(
          Schema.Struct({ userId: Schema.String, role: Schema.String }),
          `select "userId", role from member where "organizationId" = $1`,
          team,
        );
        const mapRows = cloudRows(
          Schema.Struct({ v1_kind: Schema.String, v2_kind: Schema.NullOr(Schema.String) }),
          "select v1_kind, v2_kind from private_v1_import_map where v1_org_id = $1 order by v1_kind",
          organization,
        );
        const into = { organization: team, mode: "leave_v1_data" };

        const dry = v1RunId("leave-dry");
        expect(
          (yield* operator.start({ mode: "dry-run", runId: dry, organizations: [organization] }))
            .status,
        ).toBe(200);
        const planned = yield* operator.waitForReport(dry, organization);
        expect(planned.status, planned.reason ?? "").toBe("planned");
        expect(planned.into).toEqual(into);
        expect(planned.slug?.v2).toBe(teamSlug);
        // v1's items are counted, and none is planned in v2: no app, rule or toolkit copy.
        expect(planned.counts.v1).toMatchObject({ integrations: 1, policies: 2, toolkits: 1 });
        expect(planned.counts.v2).toMatchObject({
          users: 0,
          mergedUsers: 1,
          apps: 0,
          accounts: 0,
          policies: 0,
          skippedPolicies: 0,
          mcpConnections: 0,
        });
        expect(planned.integrationFailures).toEqual([]);
        expect(planned.unmatchedRules).toEqual([]);

        const run = v1RunId("leave");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, organization);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.into).toEqual(into);
        expect(report.items).toEqual([]);
        expect(report.verification).toMatchObject({
          items: { planned: 0, withResult: 0, failed: 0 },
          members: { planned: 1, inV2: 1 },
          passed: true,
        });
        expect(report.cutover).toBe(true);
        expect(yield* movedFlag(organization)).toEqual([
          { state: "moved", v2_org_id: team, v2_org_slug: teamSlug },
        ]);
        expect(yield* mapRows).toEqual([
          { v1_kind: "organization", v2_kind: "existing_organization" },
          { v1_kind: "user", v2_kind: "merged_user" },
        ]);
        expect(yield* teamMembers).toEqual([{ userId: user, role: "owner" }]);
        // v1's data stays where it was.
        expect(yield* v1Data).toEqual(before);

        const rolledBack = yield* operator.rollback(organization);
        expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(200);
        expect(rolledBack.body).toEqual({
          organization,
          state: "rolled_back",
          removed: { apps: 0, accounts: 0, toolkitCopies: 0, members: 0 },
        });
        expect(yield* movedFlag(organization)).toEqual([
          { state: "rolled_back", v2_org_id: null, v2_org_slug: null },
        ]);
        expect(yield* teamMembers).toEqual([{ userId: user, role: "owner" }]);
        expect(yield* v1Data).toEqual(before);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportIntoCopy.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          onboarding = yield* Onboarding;
        const operator = yield* v1ImportOperator;
        // The owner made a v2 team and set nothing up in it beyond what every team gets.
        const identity = yield* onboarding.socialSignIn("google");
        const team = yield* onboarding.confirmTeam(yield* onboarding.prepareTeam);
        // Their paid v1 workspace has a teammate and the shared seed's integration, connections,
        // rules and toolkits.
        const teammate = syntheticEmail("teammate");
        const workspace = yield* emulators.v1Workspace([identity.email, teammate]);
        const organization = workspace.organization;
        const teammateUser = yield* emulators.v1User(teammate);
        const former = yield* emulators.v1Workspace([syntheticEmail("former")]);
        const toolkits = { team: randomUUID(), mine: randomUUID() };
        yield* seedShared(
          organization,
          `v1-${randomUUID().slice(0, 8)}`,
          { first: workspace.user, second: teammateUser, former: former.user },
          toolkits,
        );
        const subscription = yield* emulators.v1TeamSubscription(organization, {
          version: 3,
          seats: 2,
        });
        yield* allowV1Import(organization);
        yield* listV1Into(organization, team.id, "copy_into_empty");

        const Contents = Schema.Struct({
          name: Schema.String,
          slug: Schema.String,
          apps: Schema.Number,
          accounts: Schema.Number,
          connections: Schema.Number,
          members: Schema.Number,
        });
        /**
         * The team's own row and everything in it, its Executor app included; accounts leave out
         * the Executor keys v2 gives each owner and admin, which a member the import adds also gets.
         */
        const contents = cloudRows(
          Contents,
          `select o.name, o.slug,
            (select count(*)::int from executor_apps a where a.owner = 'organization:' || o.id) as apps,
            (select count(*)::int from executor_accounts a where a.owner = 'organization:' || o.id
              and not exists (
                select 1 from jsonb_each_text(coalesce(o.metadata::jsonb -> 'executorKeyAccounts', '{}'::jsonb)) k
                where k.value = a.id
              )) as accounts,
            (select count(*)::int from "mcpConnection" c where c.resource = o.id and not c.revoked) as connections,
            (select count(*)::int from member m where m."organizationId" = o.id) as members
          from organization o where o.id = $1`,
          team.id,
        ).pipe(Effect.map((rows) => rows[0]));
        const before = yield* contents;
        if (before === undefined) return yield* Effect.die("The team has no row");
        expect(before).toMatchObject({
          name: team.name,
          slug: team.slug,
          accounts: 0,
          connections: 0,
          members: 1,
        });
        const into = { organization: team.id, mode: "copy_into_empty" };

        const dry = v1RunId("copy-dry");
        expect(
          (yield* operator.start({ mode: "dry-run", runId: dry, organizations: [organization] }))
            .status,
        ).toBe(200);
        const planned = yield* operator.waitForReport(dry, organization);
        expect(planned.status, planned.reason ?? "").toBe("planned");
        expect(planned.into).toEqual(into);
        expect(planned.slug?.v2).toBe(team.slug);
        expect(planned.counts.v2).toMatchObject({ apps: 1, accounts: 3, mcpConnections: 3 });
        expect(planned.billing).toMatchObject({ subscription: { plan: "team" }, problem: null });
        expect(yield* contents).toEqual(before);

        const run = v1RunId("copy");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, organization);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.into).toEqual(into);
        expect(report.v2Organization).toEqual({ id: team.id, slug: team.slug });
        expect(report.cutover).toBe(true);
        expect(report.verification).toMatchObject({ members: { planned: 2, inV2: 2 } });
        expect(report.billing).toMatchObject({ carried: true });
        expect(yield* movedFlag(organization)).toEqual([
          { state: "moved", v2_org_id: team.id, v2_org_slug: team.slug },
        ]);
        // The team keeps its name and slug, gains the workspace's app, accounts and toolkit
        // copies, and the teammate joins it.
        expect(yield* contents).toEqual({
          ...before,
          apps: before.apps + 1,
          accounts: before.accounts + 3,
          connections: 3,
          members: 2,
        });
        const copies = (yield* liveCopies(team.id)).map((copy) => copy.id);
        expect(copies).toHaveLength(3);
        // The subscription now bills the team, on v1's Stripe subscription.
        const customerId = yield* emulators.v2BillingCustomer(team.id);
        expect(yield* emulators.autumnStripeSubscriptions(customerId)).toEqual([
          subscription.stripeSubscription,
        ]);
        expect(yield* emulators.autumnCustomer(organization)).toBeNull();

        // Another workspace of the owner cannot copy into the team now: it is no longer empty.
        const second = yield* emulators.v1Workspace([identity.email]);
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, $2, $3)",
            second.organization,
            "Synthetic second workspace",
            `v1-${randomUUID().slice(0, 8)}`,
          ),
          goneRule(second.organization),
        ]);
        yield* allowV1Import(second.organization);
        yield* listV1Into(second.organization, team.id, "copy_into_empty");
        const secondDry = v1RunId("copy-second");
        expect(
          (yield* operator.start({
            mode: "dry-run",
            runId: secondDry,
            organizations: [second.organization],
          })).status,
        ).toBe(200);
        const refused = yield* operator.waitForReport(secondDry, second.organization);
        expect(refused.status, refused.reason ?? "").toBe("held_back");
        expect(refused.into?.refused).toMatch(
          /^The listed v2 organization is not empty \(apps: 1, accounts: 3, connections: 3\)\.$/u,
        );

        // A rollback keeps the team and removes what the import added, once billing went back.
        const early = yield* operator.rollback(organization);
        expect(early.status).toBe(409);
        expect(JSON.stringify(early.body)).toContain("return-billing");
        const returned = yield* operator.returnBilling(organization);
        expect(returned.status, JSON.stringify(returned.body)).toBe(200);
        const rolledBack = yield* operator.rollback(organization);
        expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(200);
        expect(rolledBack.body).toEqual({
          organization,
          state: "rolled_back",
          removed: { apps: 1, accounts: 3, toolkitCopies: 3, members: 1 },
        });
        expect(yield* contents).toEqual(before);
        expect(yield* movedFlag(organization)).toEqual([
          { state: "rolled_back", v2_org_id: null, v2_org_slug: null },
        ]);
        // v1 bills the workspace again, and the team's billing is its own once more.
        expect(yield* emulators.autumnCustomer(organization)).not.toBeNull();
        expect(
          yield* cloudRows(
            IdRow,
            "select organization_id as id from private_v1_import_billing where organization_id = $1",
            team.id,
          ),
        ).toEqual([]);
        // The rollback revoked the members' copies and kept them under their ids.
        expect(yield* connectionsRevoked(copies)).toEqual(
          copies.toSorted().map((id) => ({ id, revoked: true })),
        );

        // Imported again, the workspace copies into the team as before. Each member's toolkit copy
        // is made again under a new id, and v1's toolkit URL forwards to it.
        const again = yield* importTwin({
          label: "copy-again",
          owner: { user: workspace.user, email: identity.email },
          teammate: { user: teammateUser, email: teammate },
          former: former.user,
          toolkits,
          into: team.id,
          earlier: copies,
        });
        expect(again.report.into).toEqual(into);
        expect(again.report.v2Organization).toEqual({ id: team.id, slug: team.slug });
        expect(yield* contents).toEqual({
          ...before,
          apps: before.apps + 1,
          accounts: before.accounts + 3,
          connections: 3,
          members: 2,
        });
        // The first import's copies stay revoked, with their grants and tokens.
        expect(yield* connectionsRevoked(copies)).toEqual(
          copies.toSorted().map((id) => ({ id, revoked: true })),
        );
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportIntoEnterprise.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          onboarding = yield* Onboarding;
        const operator = yield* v1ImportOperator;
        // The owner's v2 team is on v2's Enterprise plan, with a colleague already in it as a
        // member, and nothing else set up.
        const identity = yield* onboarding.socialSignIn("google");
        const team = yield* onboarding.confirmTeam(yield* onboarding.prepareTeam);
        const owner = (yield* cloudRows(
          IdRow,
          `select id from "user" where email = $1`,
          identity.email,
        ))[0]?.id;
        if (owner === undefined) return yield* Effect.die("The owner has no v2 user");
        const colleague = syntheticEmail("colleague");
        const colleagueUser = yield* v2User(colleague);
        yield* writeRows("sso-database.json", [
          row(
            `insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $3, 'member', now())`,
            randomUUID(),
            team.id,
            colleagueUser,
          ),
        ]);
        const customerId = yield* emulators.v2BillingCustomer(team.id);
        const catalog = customerId.slice(0, customerId.indexOf(":organization:"));
        yield* emulators.billingSubscription({
          organizationId: team.id,
          planId: `${catalog}-enterprise`,
          status: "active",
        });
        // Their v1 Enterprise workspace has the colleague, a newcomer and the shared seed's
        // integration, connections, rules and toolkits.
        const newcomer = syntheticEmail("newcomer");
        const workspace = yield* emulators.v1Workspace([identity.email, colleague, newcomer]);
        const organization = workspace.organization;
        const former = yield* emulators.v1Workspace([syntheticEmail("former")]);
        yield* seedShared(organization, `v1-${randomUUID().slice(0, 8)}`, {
          first: workspace.user,
          second: yield* emulators.v1User(colleague),
          former: former.user,
        });
        yield* emulators.v1Plan(organization, "enterprise");
        yield* allowV1Import(organization);
        yield* listV1Into(organization, team.id, "copy_into_empty");
        // Another Enterprise workspace of the owner is allowed but not listed into anything.
        const unlisted = yield* emulators.v1Workspace([identity.email]);
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, $2, $3)",
            unlisted.organization,
            "Synthetic unlisted workspace",
            `v1-${randomUUID().slice(0, 8)}`,
          ),
          goneRule(unlisted.organization),
        ]);
        yield* emulators.v1Plan(unlisted.organization, "enterprise");
        yield* allowV1Import(unlisted.organization);

        const Contents = Schema.Struct({
          apps: Schema.Number,
          accounts: Schema.Number,
          connections: Schema.Number,
        });
        /** What the team holds; accounts leave out the Executor keys v2 gives owners and admins. */
        const contents = cloudRows(
          Contents,
          `select
            (select count(*)::int from executor_apps a where a.owner = 'organization:' || o.id) as apps,
            (select count(*)::int from executor_accounts a where a.owner = 'organization:' || o.id
              and not exists (
                select 1 from jsonb_each_text(coalesce(o.metadata::jsonb -> 'executorKeyAccounts', '{}'::jsonb)) k
                where k.value = a.id
              )) as accounts,
            (select count(*)::int from "mcpConnection" c where c.resource = o.id and not c.revoked) as connections
          from organization o where o.id = $1`,
          team.id,
        ).pipe(Effect.map((rows) => rows[0]));
        const TeamMember = Schema.Struct({ userId: Schema.String, role: Schema.String });
        const teamMembers = cloudRows(
          TeamMember,
          `select "userId", role from member where "organizationId" = $1 order by "createdAt", "userId"`,
          team.id,
        );
        /** Each Autumn customer's plans and Stripe subscriptions, v2's team's and v1's own. */
        const plansOf = (id: string) =>
          Effect.map(emulators.autumnCustomer(id), (customer) =>
            customer === null
              ? null
              : customer.subscriptions
                  .map((plan) => ({ plan: plan.plan_id, status: plan.status }))
                  .toSorted((a, b) => a.plan.localeCompare(b.plan)),
          );
        const billingOf = Effect.gen(function* () {
          const team = yield* plansOf(customerId);
          return {
            team,
            teamStripe:
              team === null ? null : yield* emulators.autumnStripeSubscriptions(customerId),
            v1: yield* plansOf(organization),
          };
        });
        const holds = cloudRows(
          IdRow,
          "select organization_id as id from private_v1_import_billing where organization_id = $1",
          team.id,
        );
        const before = {
          contents: yield* contents,
          members: yield* teamMembers,
          billing: yield* billingOf,
        };
        if (before.contents === undefined) return yield* Effect.die("The team has no row");
        expect(before.contents).toMatchObject({ accounts: 0, connections: 0 });
        expect(before.members).toEqual([
          { userId: owner, role: "owner" },
          { userId: colleagueUser, role: "member" },
        ]);
        expect(before.billing.team).toContainEqual({
          plan: `${catalog}-enterprise`,
          status: "active",
        });
        expect(before.billing.v1).toEqual([{ plan: "enterprise", status: "active" }]);
        const into = { organization: team.id, mode: "copy_into_empty" };

        const dry = v1RunId("enterprise-dry");
        expect(
          (yield* operator.start({ mode: "dry-run", runId: dry, organizations: [organization] }))
            .status,
        ).toBe(200);
        const planned = yield* operator.waitForReport(dry, organization);
        expect(planned.status, planned.reason ?? "").toBe("planned");
        expect(planned.into).toEqual(into);
        expect(planned.slug?.v2).toBe(team.slug);
        // Nothing carries over, so the report has no billing. It still reports the SSO flag, which
        // is null here: the emulated v1 WorkOS does not list SSO connections.
        expect(planned.billing).toBeUndefined();
        expect(planned.flags).toEqual({
          sso: null,
          overFreeMemberLimit: false,
          paidPlans: ["enterprise"],
        });

        const run = v1RunId("enterprise");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [unlisted.organization, organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        // An Enterprise workspace the operator did not list is held back as before, and v1 has it
        // back at once.
        const held = yield* operator.waitForReport(run, unlisted.organization);
        expect(held.status, held.reason ?? "").toBe("held_back");
        expect(held.reason).toBe(
          "Enterprise organizations move by hand, after their v2 SSO is set up.",
        );
        expect(held.into).toBeUndefined();
        expect(yield* movedFlag(unlisted.organization)).toEqual([
          { state: "rolled_back", v2_org_id: null, v2_org_slug: null },
        ]);
        expect(
          yield* cloudRows(
            IdRow,
            "select v1_id as id from private_v1_import_map where v1_org_id = $1",
            unlisted.organization,
          ),
        ).toEqual([]);

        const report = yield* operator.waitForReport(run, organization);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.into).toEqual(into);
        expect(report.v2Organization).toEqual({ id: team.id, slug: team.slug });
        expect(report.cutover).toBe(true);
        expect(report.verification).toMatchObject({ members: { planned: 3, inV2: 3 } });
        expect(report.billing).toBeUndefined();
        expect(report.flags).toMatchObject({ sso: null, paidPlans: ["enterprise"] });
        expect(yield* movedFlag(organization)).toEqual([
          { state: "moved", v2_org_id: team.id, v2_org_slug: team.slug },
        ]);
        expect(yield* contents).toEqual({
          apps: before.contents.apps + 1,
          accounts: 3,
          connections: 4,
        });
        // The newcomer joins with their v1 role; the colleague keeps their membership and role.
        const newcomerUser = yield* cloudRows(
          IdRow,
          `select id from "user" where lower(email) = lower($1)`,
          newcomer,
        );
        expect(newcomerUser).toHaveLength(1);
        expect(yield* teamMembers).toEqual([
          ...before.members,
          { userId: newcomerUser[0]?.id, role: "admin" },
        ]);
        const Membership = Schema.Struct({ v2_kind: Schema.NullOr(Schema.String) });
        expect(
          yield* cloudRows(
            Membership,
            "select v2_kind from private_v1_import_map where v1_org_id = $1 and v1_kind = 'membership' order by v2_kind",
            organization,
          ),
        ).toEqual([{ v2_kind: "existing_member" }, { v2_kind: "member" }]);
        // The team's billing and v1's customer are as they were, and no hold was written.
        expect(yield* billingOf).toEqual(before.billing);
        expect(yield* holds).toEqual([]);

        // A rollback needs no billing return; it removes only what the import added.
        const rolledBack = yield* operator.rollback(organization);
        expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(200);
        expect(rolledBack.body).toEqual({
          organization,
          state: "rolled_back",
          removed: { apps: 1, accounts: 3, toolkitCopies: 4, members: 1 },
        });
        expect(yield* contents).toEqual(before.contents);
        expect(yield* teamMembers).toEqual(before.members);
        expect(yield* billingOf).toEqual(before.billing);
        expect(yield* holds).toEqual([]);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportIntoRefused.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        // Its rows are written once every workspace is made, before the dry run reads them.
        const rows = rowBatch();
        const v2User = (address: string) => {
          const id = randomUUID();
          rows.cloud.push(v2UserRow(id, address));
          return id;
        };
        const v2Team = (owner: string) => {
          const id = randomUUID();
          rows.cloud.push(...v2TeamRows(id, owner));
          return id;
        };
        const ownTeam = (address: string) => v2Team(v2User(address));
        /** A v1 workspace of these members, with no rows of its own, listed to move into `into`. */
        const listed = (
          label: string,
          members: readonly [string, ...string[]],
          into: string,
          mode?: string,
        ) =>
          Effect.gen(function* () {
            const created = yield* emulators.v1Workspace(members);
            rows.v1.push(
              row(
                "insert into organizations (id, name, slug) values ($1, $2, $3)",
                created.organization,
                `Synthetic ${label} workspace`,
                `v1-${randomUUID().slice(0, 8)}`,
              ),
            );
            rows.cloud.push(
              allowV1ImportRow(created.organization),
              listV1IntoRow(created.organization, into, mode),
            );
            return { organization: created.organization, into };
          });
        /** A one-member workspace listed to move into the team its member owns in v2. */
        const ownWorkspace = (label: string, mode?: string) =>
          Effect.suspend(() => {
            const address = syntheticEmail(label);
            return listed(label, [address], ownTeam(address), mode);
          });
        const email = syntheticEmail;

        const items = yield* ownWorkspace("items");
        rows.v1.push(goneRule(items.organization));
        const sharedOwner = email("shared");
        const shared = yield* listed(
          "shared",
          [sharedOwner, email("teammate")],
          ownTeam(sharedOwner),
        );
        const invited = yield* ownWorkspace("invited");
        yield* emulators.inviteV1Member(invited.organization, email("invitee"));
        const paid = yield* ownWorkspace("paid");
        yield* emulators.v1Plan(paid.organization, "team");
        // No v2 user has the member's email.
        const unknown = yield* listed("unknown", [email("unknown")], ownTeam(email("other")));
        // The member is an admin of someone else's team.
        const adminAddress = email("admin");
        const adminUser = v2User(adminAddress);
        const othersTeam = ownTeam(email("teamowner"));
        rows.cloud.push(
          row(
            `insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $3, 'admin', now())`,
            randomUUID(),
            othersTeam,
            adminUser,
          ),
        );
        // Even a copy needs its owner to own the organization it goes into.
        const admin = yield* listed("admin", [adminAddress], othersTeam, "copy_into_empty");
        const missingAddress = email("missing");
        v2User(missingAddress);
        const missing = yield* listed("missing", [missingAddress], randomUUID());
        // Leaving v1's data behind takes only a free workspace of one member too.
        const leavePaid = yield* ownWorkspace("leave-paid", "leave_v1_data");
        rows.v1.push(goneRule(leavePaid.organization));
        yield* emulators.v1Plan(leavePaid.organization, "team");
        const leaveOwner = email("leave-shared");
        const leaveShared = yield* listed(
          "leave-shared",
          [leaveOwner, email("teammate")],
          ownTeam(leaveOwner),
          "leave_v1_data",
        );
        // An Enterprise workspace moves only when listed to copy (decision 34).
        const enterprise = yield* ownWorkspace("enterprise");
        yield* emulators.v1Plan(enterprise.organization, "enterprise");
        const leaveEnterprise = yield* ownWorkspace("leave-enterprise", "leave_v1_data");
        yield* emulators.v1Plan(leaveEnterprise.organization, "enterprise");
        const unlisted = yield* ownWorkspace("mode", "everything");
        yield* rows.write;
        const onlyOne =
          "only a workspace of one moves into an existing v2 organization without its data.";
        const refusals = [
          [items, "nothing_to_copy", "It has items to copy (policies: 1)."],
          [shared, "nothing_to_copy", `It has 2 active members; ${onlyOne}`],
          [invited, "nothing_to_copy", "It has 1 pending invitations."],
          [paid, "nothing_to_copy", "It has a paid v1 plan (team)."],
          [unknown, "nothing_to_copy", "Its owner has no v2 account."],
          [admin, "copy_into_empty", "Its owner is not an owner of the listed v2 organization."],
          [missing, "nothing_to_copy", "The listed v2 organization does not exist."],
          [leavePaid, "leave_v1_data", "It has a paid v1 plan (team)."],
          [leaveShared, "leave_v1_data", `It has 2 active members; ${onlyOne}`],
          [enterprise, "nothing_to_copy", "It has a paid v1 plan (enterprise)."],
          [leaveEnterprise, "leave_v1_data", "It has a paid v1 plan (enterprise)."],
          [unlisted, null, "The allow table lists a mode the import does not know."],
        ] as const;
        const organizations = refusals.map(([workspace]) => workspace.organization);
        const TeamMember = Schema.Struct({ userId: Schema.String, role: Schema.String });
        const membersOf = (organization: string) =>
          row(
            `select "userId", role from member where "organizationId" = $1 order by "userId"`,
            organization,
          );
        const before = yield* readRows(
          "sso-database.json",
          TeamMember,
          refusals.map(([workspace]) => membersOf(workspace.into)),
        );

        const dry = v1RunId("refused-dry");
        expect((yield* operator.start({ mode: "dry-run", runId: dry, organizations })).status).toBe(
          200,
        );
        for (const [workspace, mode, refused] of refusals) {
          const report = yield* operator.waitForReport(dry, workspace.organization);
          expect(report.status, report.reason ?? "").toBe("held_back");
          expect(report.reason).toBe(
            `It does not move into the listed v2 organization: ${refused}`,
          );
          expect(report.into).toEqual({ organization: workspace.into, mode, refused });
        }

        const run = v1RunId("refused");
        const started = yield* operator.start({ mode: "import", runId: run, organizations });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        for (const [workspace, mode, refused] of refusals) {
          const report = yield* operator.waitForReport(run, workspace.organization);
          expect(report.status, report.reason ?? "").toBe("held_back");
          expect(report.into).toEqual({ organization: workspace.into, mode, refused });
          expect(report.v2Organization).toBeUndefined();
        }
        // Nothing was copied, so v1 has each back at once; v2 recorded nothing for any.
        const flags = yield* readRows(
          "v1-database.json",
          Flag,
          organizations.map((organization) =>
            row(
              "select state, v2_org_id, v2_org_slug from org_moved_to_v2 where org_id = $1",
              organization,
            ),
          ),
        );
        const states = yield* readRows(
          "sso-database.json",
          Schema.Struct({ state: Schema.String }),
          organizations.map((organization) =>
            row("select state from private_v1_import_org where v1_org_id = $1", organization),
          ),
        );
        const maps = yield* readRows(
          "sso-database.json",
          Schema.Struct({ v1_kind: Schema.String }),
          organizations.map((organization) =>
            row("select v1_kind from private_v1_import_map where v1_org_id = $1", organization),
          ),
        );
        const after = yield* readRows(
          "sso-database.json",
          TeamMember,
          refusals.map(([workspace]) => membersOf(workspace.into)),
        );
        for (const [index, organization] of organizations.entries()) {
          expect(flags[index], organization).toEqual([
            { state: "rolled_back", v2_org_id: null, v2_org_slug: null },
          ]);
          expect(states[index], organization).toEqual([{ state: "rolled_back" }]);
          expect(maps[index], organization).toEqual([]);
          expect(after[index], organization).toEqual(before[index]);
        }
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportAllowed.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const workspace = (label: string) =>
          Effect.gen(function* () {
            const created = yield* emulators.v1Workspace([
              `${label}-${randomUUID().slice(0, 8)}@example.test`,
            ]);
            yield* writeRows("v1-database.json", [
              row(
                "insert into organizations (id, name, slug) values ($1, $2, $3)",
                created.organization,
                `Synthetic ${label} workspace`,
                `v1-${randomUUID().slice(0, 8)}`,
              ),
            ]);
            return created.organization;
          });
        const unlisted = yield* workspace("unlisted");
        const listed = yield* workspace("listed");
        yield* allowV1Import(listed);
        const notAllowed = (organization: string) => ({
          error: `private_v1_import_allowed has no row for ${organization}, so it is not imported.`,
        });
        const nothingWritten = (organization: string) =>
          Effect.gen(function* () {
            expect(yield* movedFlag(organization)).toEqual([]);
            expect(yield* importState(organization)).toEqual([]);
          });

        // The operator token alone allows nothing: without a row, the import is refused.
        const refused = yield* operator.start({
          mode: "import",
          runId: v1RunId("unlisted"),
          organizations: [unlisted],
        });
        expect(refused.status).toBe(409);
        expect(refused.body).toEqual(notAllowed(unlisted));
        yield* nothingWritten(unlisted);

        // One organization without a row refuses the whole start, naming only that one.
        const mixed = yield* operator.start({
          mode: "import",
          runId: v1RunId("mixed"),
          organizations: [listed, unlisted],
        });
        expect(mixed.status).toBe(409);
        expect(mixed.body).toEqual(notAllowed(unlisted));
        yield* nothingWritten(listed);
        yield* nothingWritten(unlisted);

        // An import never pages through v1, whatever the table holds.
        const paged = yield* operator.start({
          mode: "import",
          runId: v1RunId("paged"),
          after: listed,
          limit: 1,
        });
        expect(paged.status).toBe(409);
        expect(paged.body).toEqual({
          error:
            "An import names its organizations with `organizations`; it never pages through v1 with `after` or `limit`.",
        });

        // A dry run ignores the table: it runs for the organization without a row.
        const dry = v1RunId("unlisted-dry");
        const dryStarted = yield* operator.start({
          mode: "dry-run",
          runId: dry,
          organizations: [unlisted],
        });
        expect(dryStarted.status, JSON.stringify(dryStarted.body)).toBe(200);
        const dryReport = yield* operator.waitForReport(dry, unlisted);
        expect(dryReport.status, dryReport.reason ?? "").toBe("planned");
        yield* nothingWritten(unlisted);

        // With its row, the organization imports and is cut over.
        const run = v1RunId("listed");
        const started = yield* operator.start({
          mode: "import",
          runId: run,
          organizations: [listed],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, listed);
        expect(report.status, report.reason ?? "").toBe("imported");
        expect(report.cutover).toBe(true);
        expect((yield* movedFlag(listed))[0]?.state).toBe("moved");
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportDryRun.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const first = `dry-${randomUUID().slice(0, 8)}@example.test`;
        const second = `dry-${randomUUID().slice(0, 8)}@example.test`;
        const workspace = yield* emulators.v1Workspace([first, second]);
        const secondUser = yield* emulators.v1User(second);
        // Someone invited who has not accepted: their membership is pending, so they do not move.
        const inviteeEmail = `invited-${randomUUID().slice(0, 8)}@example.test`;
        const invited = yield* emulators.v1Workspace([inviteeEmail]);
        yield* emulators.inviteV1Member(workspace.organization, inviteeEmail);
        yield* emulators.setV1OrganizationMetadata(workspace.organization, {
          v1_setting: "synthetic",
        });
        const former = yield* emulators.v1Workspace([
          `gone-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        // 44 characters: v2 allows 45, so the slug moves whole, though a suffixed slug would be
        // cut to leave room for its suffix.
        const slug = `v1-${randomUUID().slice(0, 8)}-a-long-workspace-name-kept-whole`;
        const { tracker } = yield* seedShared(workspace.organization, slug, {
          first: workspace.user,
          second: secondUser,
          former: former.user,
        });
        // What a dry run reports: a TRACE operation, a connection that cannot move, a secret the
        // Vault does not return, rules that match no v2 tool (one only a dropped TRACE tool), an
        // artifact whose role binds nothing, and first-party clients v2 lacks or holds under
        // another client ID than v1's.
        const traced = `traced_${randomUUID().slice(0, 6)}`;
        const document = JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Traced", version: "1" },
          servers: [{ url: "https://traced.example.com" }],
          paths: {
            "/items": {
              get: { operationId: "listItems", responses: { "200": { description: "ok" } } },
              trace: { operationId: "traceItems", responses: { "200": { description: "ok" } } },
            },
          },
        });
        const hash = randomUUID().replaceAll("-", "");
        yield* writeRows("v1-database.json", [
          row(
            "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Traced API', $3::json)",
            workspace.organization,
            traced,
            JSON.stringify({ specHash: hash, authenticationTemplate: [] }),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${workspace.organization}/openapi`,
            `spec/${hash}`,
            document,
          ),
          ...[
            ["items.listItems", "get"],
            ["items.traceItems", "trace"],
          ].map(([tool, method]) =>
            row(
              "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
              workspace.organization,
              `op.${tool}`,
              JSON.stringify({
                integration: traced,
                toolName: tool,
                binding: { method, pathTemplate: "/items" },
              }),
            ),
          ),
          row(
            "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner) values ($1, 'user', $2, $3, 'linear', 'oauth2', '{\"token\":\"oauth:user:linear:token\"}', 'first-party:linear', 'org')",
            workspace.organization,
            workspace.user,
            tracker,
          ),
          row(
            "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner) values ($1, 'org', '', $2, 'mail', 'oauth2', '{\"token\":\"oauth:org:mail:token\"}', 'first-party:synthetic-cloud-mail', 'org')",
            workspace.organization,
            tracker,
          ),
          row(
            "insert into connection (tenant, owner, subject, integration, name, template, item_ids) values ($1, 'org', '', $2, 'lost', 'header', $3::json)",
            workspace.organization,
            tracker,
            JSON.stringify({ token: `connection:org:${tracker}:lost:token` }),
          ),
          row(
            "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'org', '', $2, '', 'openapi', 'items.traceItems')",
            workspace.organization,
            traced,
          ),
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', $2, 'block')",
            workspace.organization,
            `${traced}.*.*.items.traceItems`,
          ),
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', $2, 'require_approval')",
            workspace.organization,
            `${tracker}.*.*.unlisted`,
          ),
          row(
            "insert into artifact (tenant, owner, subject, title, code, bindings) values ($1, 'org', '', 'Board', 'export const App = () => tools.missing_service.list()', '{}'::json)",
            workspace.organization,
          ),
        ]);
        // Held back: an Enterprise organization, decided by its plan. A dry run still checks its
        // items, so its report is a work list too.
        const enterprise = yield* emulators.v1Workspace([
          `ent-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        yield* emulators.v1Plan(enterprise.organization, "enterprise");
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic enterprise', $2)",
            enterprise.organization,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', 'gone.*', 'block')",
            enterprise.organization,
          ),
        ]);

        // v1 returns rows the import cannot read: an OpenAPI operation stored without its binding.
        // The integration reports which rows, not an outage, and without retrying.
        const brokenWorkspace = yield* emulators.v1Workspace([
          `broken-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        const broken = `broken_${randomUUID().slice(0, 6)}`;
        const brokenHash = randomUUID().replaceAll("-", "");
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic broken rows', $2)",
            brokenWorkspace.organization,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
          row(
            "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Broken ops', $3::json)",
            brokenWorkspace.organization,
            broken,
            JSON.stringify({ specHash: brokenHash, authenticationTemplate: [] }),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${brokenWorkspace.organization}/openapi`,
            `spec/${brokenHash}`,
            document,
          ),
          row(
            "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', 'op.items.listItems', $2::json)",
            brokenWorkspace.organization,
            JSON.stringify({ integration: broken, toolName: "items.listItems" }),
          ),
        ]);

        // Nobody else can start or read a run: without the token the routes are not there.
        for (const authorization of [undefined, "Bearer wrong-token"]) {
          const refused = yield* operator.send("POST", "/api/internal/v1-import/start", {
            body: { mode: "dry-run", runId: "refused", organizations: [workspace.organization] },
            authorization,
          });
          expect(refused.status).toBe(404);
        }

        const run = v1RunId("dry");
        const started = yield* operator.start({
          mode: "dry-run",
          runId: run,
          organizations: [
            workspace.organization,
            enterprise.organization,
            brokenWorkspace.organization,
          ],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        expect(started.body).toEqual({
          started: [workspace, enterprise, brokenWorkspace].map(({ organization }) => ({
            organization,
            instance: `${organization}-dry-${run}`,
          })),
          deferred: [],
          skipped: [],
          next: null,
          // The bound counts every run on this Cloud, so other scenarios' organizations too.
          inFlight: expect.any(Number),
          errored: [],
        });
        const { inFlight } = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ inFlight: Schema.Number }),
        )(started.body);
        expect(inFlight).toBeGreaterThanOrEqual(3);
        const report = yield* operator.waitForReport(run, workspace.organization);
        expect(report.mode).toBe("dry-run");
        expect(report.status).toBe("blocked");
        expect(report.items).toBeUndefined();
        expect(report.slug).toEqual({ v1: slug, v2: slug, changed: false });
        expect(report.emailMatches).toEqual([]);
        expect(report.skippedMembers).toEqual([{ user: invited.user, reason: "pending" }]);
        expect(report.counts.v1).toMatchObject({
          members: 2,
          pendingMembers: 1,
          importedMembers: 2,
          integrations: 2,
          policies: 4,
          toolkits: 2,
          artifacts: 1,
        });
        expect(report.counts.v2).toMatchObject({
          users: 2,
          members: 2,
          apps: 2,
          mcpConnections: 3,
        });
        expect(report.integrationFailures).toEqual([]);
        expect(report.droppedTraceTools).toEqual([
          { integration: "Traced API", tools: ["items.traceItems"] },
        ]);
        expect(report.firstPartyMismatches).toHaveLength(2);
        expect(report.firstPartyMismatches).toEqual(
          expect.arrayContaining([
            { client: "linear", reason: "unavailable", connections: 1 },
            { client: "synthetic-cloud-mail", reason: "different_client", connections: 1 },
          ]),
        );
        expect(report.vaultFailures).toEqual([
          expect.objectContaining({
            label: "lost",
            integration: "Shared Tracker",
            reason: "missing",
          }),
        ]);
        expect(
          report.connectionFailures
            .flatMap((failure) => failure.connections.map((c) => c.label))
            .toSorted(),
        ).toEqual(["linear", "mail"]);
        // v1 cannot send a secret its Vault no longer holds either: it is skipped, not blocking.
        expect(report.staleItems).toEqual([
          expect.objectContaining({
            kind: "connection",
            label: "lost",
            integration: "Shared Tracker",
            category: "missing_credential",
          }),
        ]);
        // v1 listed the TRACE tool, but its v2 app leaves it out, so its rule matches no v2 tool.
        expect(report.unmatchedRules).toHaveLength(2);
        expect(report.unmatchedRules).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              pattern: `${tracker}.*.*.unlisted`,
              action: "require_approval",
            }),
            expect.objectContaining({
              pattern: `${traced}.*.*.items.traceItems`,
              action: "block",
            }),
          ]),
        );
        expect(report.artifacts).toEqual([
          expect.objectContaining({
            title: "Board",
            unmappedRoles: [expect.objectContaining({ role: "missing_service" })],
          }),
        ]);
        expect(report.flags).toMatchObject({ overFreeMemberLimit: false, paidPlans: [] });

        const held = yield* operator.waitForReport(run, enterprise.organization);
        expect(held).toMatchObject({
          status: "held_back",
          reason: "Enterprise organizations move by hand, after their v2 SSO is set up.",
          flags: { paidPlans: ["enterprise"] },
          counts: { v1: { policies: 1 }, v2: { skippedPolicies: 1 } },
        });

        // A dry run writes nothing to v2 and nothing to v1.
        expect(
          yield* cloudRows(
            IdRow,
            "select v1_id as id from private_v1_import_map where v1_org_id = $1 union all select v1_org_id from private_v1_import_org where v1_org_id = $1",
            workspace.organization,
          ),
        ).toEqual([]);
        expect(
          yield* cloudRows(
            IdRow,
            `select id from "user" where lower(email) in (lower($1), lower($2))`,
            first,
            second,
          ),
        ).toEqual([]);
        expect(
          yield* cloudRows(IdRow, "select id from organization where slug = $1", slug),
        ).toEqual([]);
        expect(yield* emulators.v1OrganizationMetadata(workspace.organization)).toEqual({
          v1_setting: "synthetic",
        });
        // Nor anything outside its reports: each app is compiled and its requirements declared,
        // but no build is kept in the app build store or its cache. Its run's spans say so.
        const telemetry = yield* Telemetry;
        const steps = yield* telemetry
          .search(
            "v1_import.step",
            { v1Workspace: workspace.organization },
            { "executor.v1_import.step": "integration" },
          )
          .pipe(
            Effect.filterOrFail(
              (found) => found.data.length >= 2,
              () => new Error("The integration steps' spans have not arrived"),
            ),
            Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 60 }),
          );
        for (const trace of new Set(steps.data.map((entry) => entry.traceId))) {
          const spans = (yield* telemetry.query(trace)).data.map(({ span }) => span.operationName);
          expect(spans.filter((name) => name === "sdk.apps.build")).toHaveLength(2);
          expect(spans.filter((name) => name === "runtime.cloud.requirements")).toHaveLength(2);
          expect(spans).not.toContain("runtime.cloud.retain");
        }

        const unreadable = yield* operator.waitForReport(run, brokenWorkspace.organization);
        expect(unreadable.status).toBe("blocked");
        expect(unreadable.integrationFailures).toEqual([
          {
            id: expect.any(String),
            label: "Broken ops",
            error:
              "v1's openapi operation rows could not be read: they do not have the shape the import expects.",
          },
        ]);

        // The aggregate lists every organization once their reports exist.
        const aggregate = yield* operator.aggregate(run);
        expect(aggregate).toMatchObject({
          runId: run,
          complete: true,
          organizations: 3,
          pending: [],
          errored: [],
          statuses: { blocked: 2, held_back: 1 },
          heldBack: [{ organization: enterprise.organization }],
          integrationFailures: [
            {
              organization: brokenWorkspace.organization,
              entry: expect.objectContaining({ label: "Broken ops" }),
            },
          ],
          pages: 1,
        });
        expect(aggregate.blocked.toSorted()).toEqual(
          [workspace.organization, brokenWorkspace.organization].toSorted(),
        );
        // A page at a time, it combines to the same aggregate.
        expect(yield* operator.aggregate(run, 1)).toEqual({ ...aggregate, pages: 3 });
        for (const query of [{ cursor: "not-a-cursor" }, { limit: 0 }, { limit: 201 }])
          expect((yield* operator.aggregatePage(run, query)).status, JSON.stringify(query)).toBe(
            400,
          );

        // Without a list, a batch takes the next live organizations in id order.
        const batch = yield* operator.start({
          mode: "dry-run",
          runId: v1RunId("batch"),
          limit: 1,
        });
        expect(batch.status, JSON.stringify(batch.body)).toBe(200);
        expect(batch.body).toMatchObject({
          started: [expect.anything()],
          next: expect.any(String),
        });

        // An id in v1's list that is not a v1 organization id is skipped, and the walk moves on.
        const prefix = `org_zz${randomUUID().replaceAll("-", "").slice(0, 20)}`;
        const invalid = `${prefix}-bad`;
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic invalid id', $2)",
            invalid,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
        ]);
        const walk = v1RunId("walk");
        const skipped = yield* operator.start({
          mode: "dry-run",
          runId: walk,
          after: prefix,
          limit: 1,
        });
        expect(skipped.status, JSON.stringify(skipped.body)).toBe(200);
        expect(skipped.body).toEqual({
          started: [],
          deferred: [],
          skipped: [{ organization: invalid, reason: "invalid_id" }],
          next: invalid,
          inFlight: expect.any(Number),
          errored: [],
        });
        expect(yield* operator.aggregate(walk)).toMatchObject({
          complete: true,
          organizations: 0,
        });
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportStale.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const secondEmail = `stale-second-${randomUUID().slice(0, 8)}@example.test`;
        const workspace = yield* emulators.v1Workspace([
          `stale-${randomUUID().slice(0, 8)}@example.test`,
          secondEmail,
        ]);
        const second = yield* emulators.v1User(secondEmail);
        const organization = workspace.organization;
        const suffix = randomUUID().slice(0, 6);
        const live = `live_${suffix}`;
        const local = `local_${suffix}`;
        const relative = `relative_${suffix}`;
        const corrupt = `corrupt_${suffix}`;
        const graph = `graph_${suffix}`;
        const hosts = `hosts_${suffix}`;
        const regional = `regional_${suffix}`;
        const revised = `revised_${suffix}`;
        const pastedMcp = `pastedmcp_${suffix}`;
        const gatedMcp = `gatedmcp_${suffix}`;
        const item = (owner: "org" | "user", name: string, integration = live) =>
          `connection:${owner}:${integration}:${name}:token`;
        const saved = (scope: string, itemId: string, value: string) =>
          emulators.v1VaultObject(`${scope}/secrets/${encodeURIComponent(itemId)}`, value);
        // An org connection whose secret a member saved before it was shared: v1 reads it in that
        // member's partition. Another member saved a different value for it, which the report
        // flags without naming either. A token saved on the OAuth method without a client, which
        // v1 sent as is. A connection whose secret the Vault no longer holds has none.
        yield* saved(
          vaultScope(organization, workspace.user),
          item("user", "shared"),
          "synthetic-shared-key",
        );
        yield* saved(
          vaultScope(organization, second),
          item("user", "shared"),
          "synthetic-other-shared-key",
        );
        yield* saved(vaultScope(organization), item("org", "pasted"), "synthetic-pasted-token");
        yield* saved(
          vaultScope(organization),
          item("org", "hostskey", hosts),
          "synthetic-hosts-key",
        );
        yield* saved(
          vaultScope(organization),
          item("org", "signin", pastedMcp),
          "synthetic-signin-token",
        );
        yield* saved(
          vaultScope(organization),
          "oauth-client:org:pasted-client:secret",
          "synthetic-stale-secret-0123456789",
        );
        yield* saved(
          vaultScope(organization),
          item("org", "signin", gatedMcp),
          "synthetic-gated-token",
        );
        const mcp = {
          transport: "remote",
          endpoint: "https://live.example.com/mcp",
          remoteTransport: "auto",
          authenticationTemplate: [
            { slug: "header", kind: "apikey", placements: [{ carrier: "header", name: "X-Key" }] },
            { slug: "oauth", kind: "oauth2" },
          ],
        };
        const spec = (servers: readonly object[]) =>
          JSON.stringify({
            openapi: "3.0.3",
            info: { title: "Stale", version: "1" },
            servers,
            paths: {
              "/items": {
                get: { operationId: "listItems", responses: { "200": { description: "ok" } } },
              },
            },
          });
        const relativeHash = randomUUID().replaceAll("-", "");
        const corruptHash = randomUUID().replaceAll("-", "");
        const hostsHash = randomUUID().replaceAll("-", "");
        const regionalHash = randomUUID().replaceAll("-", "");
        const revisedHash = randomUUID().replaceAll("-", "");
        const ok = { "200": { description: "ok" } };
        // Operations on two services' hosts, and one on a WebSocket server v1 never called.
        const hostsSpec = JSON.stringify({
          openapi: "3.0.3",
          info: { title: "Two services", version: "1" },
          servers: [{ url: "https://api.one.example.com" }],
          paths: {
            "/items": { get: { operationId: "listItems", responses: ok } },
            "/events": {
              get: {
                operationId: "listEvents",
                servers: [{ url: "https://events.two.example.org" }],
                responses: ok,
              },
            },
            "/stream": {
              get: {
                operationId: "openStream",
                servers: [{ url: "wss://stream.two.example.org" }],
                responses: ok,
              },
            },
          },
        });
        const operation = (integration: string, tool: string, path: string) =>
          row(
            "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
            organization,
            `op.${integration}.${tool}`,
            JSON.stringify({
              integration,
              toolName: tool,
              binding: { method: "get", pathTemplate: path },
            }),
          );
        const tool = (integration: string, connection: string, name: string, plugin: string) =>
          row(
            "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'org', '', $2, $3, $4, $5)",
            organization,
            integration,
            connection,
            plugin,
            name,
          );
        const oauthClient = (slug: string, clientId: string, secretItem: string | null) =>
          row(
            "insert into oauth_client (tenant, owner, subject, slug, token_url, client_id, client_secret_item_id, origin_kind) values ($1, 'org', '', $2, 'https://signin.example.com/token', $3, nullif($4, ''), 'manual')",
            organization,
            slug,
            clientId,
            secretItem ?? "",
          );
        // Reachable, so their sign-ins can be discovered as the import discovers them.
        const signIn = yield* mcpSignInServers(["pasted", "gated"]);
        const oauthMcp = (headers: Record<string, string>, name: string) => ({
          transport: "remote",
          endpoint: `http://${signIn}/${name}/mcp`,
          remoteTransport: "auto",
          headers,
          authenticationTemplate: [{ slug: "oauth", kind: "oauth2" }],
        });
        const integration = (slug: string, plugin: string, name: string, config: object) =>
          row(
            "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, $3, $4, $5::json)",
            organization,
            slug,
            plugin,
            name,
            JSON.stringify(config),
          );
        const connection = (
          integration: string,
          name: string,
          template: string,
          items: object,
          client: string | null = null,
        ) =>
          row(
            "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner) values ($1, 'org', '', $2, $3, $4, $5::json, nullif($6, ''), nullif($7, ''))",
            organization,
            integration,
            name,
            template,
            JSON.stringify(items),
            client ?? "",
            client === null ? "" : "org",
          );
        const policy = (pattern: string) =>
          row(
            "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', $2, 'block')",
            organization,
            pattern,
          );
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic stale items', $2)",
            organization,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
          integration(live, "mcp", "Live MCP", mcp),
          integration(local, "mcp", "Local tool", { transport: "stdio", command: "tool" }),
          integration(relative, "openapi", "Relative API", {
            specHash: relativeHash,
            authenticationTemplate: [],
          }),
          integration(corrupt, "openapi", "Corrupt API", {
            specHash: corruptHash,
            authenticationTemplate: [],
          }),
          integration(graph, "graphql", "Ftp GraphQL", {
            endpoint: "ftp://graph.example.com/graphql",
            authenticationTemplate: [],
          }),
          integration(hosts, "openapi", "Two-service API", {
            specHash: hostsHash,
            authenticationTemplate: [
              {
                slug: "header",
                kind: "apikey",
                placements: [{ carrier: "header", name: "X-Key" }],
              },
            ],
          }),
          integration(regional, "openapi", "Regional API", {
            specHash: regionalHash,
            authenticationTemplate: [],
          }),
          integration(revised, "openapi", "Revised API", {
            specHash: revisedHash,
            authenticationTemplate: [],
          }),
          // The organization revised its specification after v1 last listed the tools.
          row(
            "update integration set config_revised_at = 2000 where tenant = $1 and slug = $2",
            organization,
            revised,
          ),
          // An MCP server's fixed headers that are its OAuth client's own ID and secret.
          integration(
            pastedMcp,
            "mcp",
            "Pasted MCP",
            oauthMcp(
              {
                CLIENT_ID: "synthetic-stale-client-0123456789",
                CLIENT_SECRET: "synthetic-stale-secret-0123456789",
              },
              "pasted",
            ),
          ),
          // A self-hosted MCP server behind a gateway that takes its own client ID and secret.
          integration(
            gatedMcp,
            "mcp",
            "Gated MCP",
            oauthMcp(
              {
                "CF-Access-Client-Id": "synthetic0gateway1client2id.access",
                "CF-Access-Client-Secret": "synthetic-gateway-secret-0123456789",
              },
              "gated",
            ),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${hostsHash}`,
            hostsSpec,
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${regionalHash}`,
            spec([{ url: "https://{region}.regional.example.com" }]),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${revisedHash}`,
            spec([{ url: "https://revised.example.com" }]),
          ),
          operation(hosts, "items.list", "/items"),
          operation(hosts, "events.list", "/events"),
          operation(hosts, "stream.open", "/stream"),
          operation(revised, "items.list", "/items"),
          oauthClient(
            "pasted-client",
            "synthetic-stale-client-0123456789",
            "oauth-client:org:pasted-client:secret",
          ),
          oauthClient("gated-client", "synthetic-gated-client", null),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${relativeHash}`,
            spec([{ url: "/v1" }]),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${corruptHash}`,
            JSON.stringify("synthetic text that is not a specification"),
          ),
          connection(live, "shared", "header", { token: item("user", "shared") }),
          connection(live, "pasted", "oauth", { token: item("org", "pasted") }),
          connection(live, "lost", "header", { token: item("org", "lost") }),
          connection(live, "nokey", "header", {}),
          connection(
            live,
            "unclient",
            "oauth",
            { token: item("org", "unclient") },
            "deleted-client",
          ),
          connection(local, "files", "none", {}),
          connection(hosts, "hostskey", "header", { token: item("org", "hostskey", hosts) }),
          connection(revised, "main", "none", {}),
          row(
            "update connection set tools_synced_at = 1000 where tenant = $1 and integration = $2",
            organization,
            revised,
          ),
          tool(revised, "main", "items.list", "openapi"),
          tool(revised, "main", "items.old", "openapi"),
          connection(
            pastedMcp,
            "signin",
            "oauth",
            { token: item("org", "signin", pastedMcp) },
            "pasted-client",
          ),
          connection(
            gatedMcp,
            "signin",
            "oauth",
            { token: item("org", "signin", gatedMcp) },
            "gated-client",
          ),
          row(
            "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, 'org', '', $2, 'shared', 'mcp', 'search', $3::json)",
            organization,
            live,
            JSON.stringify({ mcp: { toolName: "search" } }),
          ),
          policy(`${live}.*.*.search`),
          policy(`${live}.*.*.unlisted`),
          policy(`${local}.*`),
        ]);

        const run = v1RunId("stale");
        const started = yield* operator.start({
          mode: "dry-run",
          runId: run,
          organizations: [organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const report = yield* operator.waitForReport(run, organization);
        // Nothing blocks it: every item that does not move is one v1 cannot run either.
        expect(report.status, JSON.stringify(report)).toBe("planned");
        expect(report.integrationFailures).toEqual([]);
        expect(report.connectionFailures).toEqual([]);
        expect(report.counts.v2).toMatchObject({ apps: 5, accounts: 6, policies: 2 });
        const stale = report.staleItems
          .map((entry) => [entry.kind, entry.label, entry.integration, entry.category])
          .toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
        expect(stale).toEqual(
          [
            ["integration", "Local tool", null, "local_server"],
            ["integration", "Relative API", null, "no_base_url"],
            ["integration", "Corrupt API", null, "unreadable_spec"],
            ["integration", "Ftp GraphQL", null, "not_http"],
            ["integration", "Regional API", null, "undefined_server_variable"],
            // An operation on a WebSocket server, and a tool the revised specification dropped,
            // are left out of apps that move.
            ["tool", "stream.open", "Two-service API", "not_http"],
            ["tool", "items.old", "Revised API", "removed_tool"],
            ["connection", "files", "Local tool", "local_server"],
            ["connection", "lost", "Live MCP", "missing_credential"],
            ["connection", "nokey", "Live MCP", "incomplete_credential"],
            ["connection", "unclient", "Live MCP", "missing_client"],
            ["tool_policy", `${local}.*`, "Local tool", "local_server"],
          ].toSorted((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        );
        // The member's saved secret and the client-less token are read, so neither is stale.
        expect(report.vaultFailures).toEqual([
          expect.objectContaining({ label: "lost", reason: "missing" }),
        ]);
        // A rule that matches no tool still moves, is reported, and does not block.
        expect(report.unmatchedRules).toEqual([
          expect.objectContaining({ pattern: `${live}.*.*.unlisted`, action: "block" }),
        ]);
        // The fixed headers that repeat the MCP server's own OAuth client are left out and
        // reported; the gateway's own credentials move in a second account.
        expect(report.droppedCredentials).toEqual([
          {
            integration: "Pasted MCP",
            carrier: "header",
            name: "CLIENT_ID",
            reason: "oauth_client_id",
          },
          {
            integration: "Pasted MCP",
            carrier: "header",
            name: "CLIENT_SECRET",
            reason: "oauth_client_secret",
          },
        ]);
        // Two members hold different values for the org connection's secret; the first's moves.
        expect(report.memberSecretMismatches).toEqual([
          expect.objectContaining({
            label: "shared",
            integration: "Live MCP",
            members: 2,
            values: 2,
          }),
        ]);
        for (const value of [
          "synthetic-shared-key",
          "synthetic-other-shared-key",
          "synthetic-pasted-token",
          "synthetic-stale-client-0123456789",
          "synthetic-stale-secret-0123456789",
          "synthetic0gateway1client2id",
          "synthetic-gateway-secret",
        ])
          expect(JSON.stringify(report)).not.toContain(value);

        const aggregate = yield* operator.aggregate(run);
        expect(aggregate).toMatchObject({
          statuses: { planned: 1 },
          blocked: [],
          staleItems: {
            byCategory: {
              "integration local_server": 1,
              "integration no_base_url": 1,
              "integration unreadable_spec": 1,
              "integration not_http": 1,
              "integration undefined_server_variable": 1,
              "tool not_http": 1,
              "tool removed_tool": 1,
              "connection local_server": 1,
              "connection missing_credential": 1,
              "connection incomplete_credential": 1,
              "connection missing_client": 1,
              "tool_policy local_server": 1,
            },
          },
        });
        expect(aggregate.staleItems.items).toHaveLength(12);
        expect(aggregate.droppedCredentials).toHaveLength(2);
        expect(aggregate.memberSecretMismatches).toHaveLength(1);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportBounded.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        // v1's database has no row for this organization, so every read of it fails: its
        // assessment fails each attempt and retries for seconds before its report says so.
        const unreadable = yield* emulators.v1Workspace([
          `unread-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        const plain = yield* emulators.v1Workspace([
          `plain-${randomUUID().slice(0, 8)}@example.test`,
        ]);
        yield* writeRows("v1-database.json", [
          row(
            "insert into organizations (id, name, slug) values ($1, 'Synthetic plain', $2)",
            plain.organization,
            `v1-${randomUUID().slice(0, 8)}`,
          ),
        ]);
        const run = v1RunId("bounded");
        const start = (organizations: readonly string[]) =>
          operator
            .start({ mode: "dry-run", runId: run, organizations, maxInFlight: 1 })
            .pipe(
              Effect.tap((response) =>
                Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
              ),
            );
        const instance = (organization: string) => `${organization}-dry-${run}`;

        // One organization at a time: the second waits for room.
        expect((yield* start([unreadable.organization, plain.organization])).body).toEqual({
          started: [
            { organization: unreadable.organization, instance: instance(unreadable.organization) },
          ],
          deferred: [plain.organization],
          skipped: [],
          next: null,
          inFlight: 1,
          errored: [],
        });
        // The first is still retrying its assessment, so a later start has no room either, and
        // does not start or count it again.
        expect((yield* start([unreadable.organization, plain.organization])).body).toEqual({
          started: [],
          deferred: [plain.organization],
          skipped: [{ organization: unreadable.organization, reason: "running" }],
          next: null,
          inFlight: 1,
          errored: [],
        });
        // The bound is the deployment's, not the run's: another run has no room either.
        const other = yield* operator.start({
          mode: "dry-run",
          runId: v1RunId("other"),
          organizations: [plain.organization],
          maxInFlight: 1,
        });
        expect(other.status, JSON.stringify(other.body)).toBe(200);
        expect(other.body).toMatchObject({
          started: [],
          deferred: [plain.organization],
          inFlight: 1,
        });

        // A step that keeps failing ends the run with a report that says so, not a pending one.
        const failed = yield* operator.waitForReport(run, unreadable.organization);
        expect(failed).toMatchObject({
          status: "failed",
          reason:
            "It could not be assessed: v1 or v2 kept failing while it was read (V1ImportUnavailable).",
        });
        expect((yield* start([plain.organization])).body).toEqual({
          started: [{ organization: plain.organization, instance: instance(plain.organization) }],
          deferred: [],
          skipped: [],
          next: null,
          inFlight: 1,
          errored: [],
        });
        expect((yield* operator.waitForReport(run, plain.organization)).status).toBe("planned");
        expect(yield* operator.aggregate(run)).toMatchObject({
          complete: true,
          organizations: 2,
          pending: [],
          errored: [],
          statuses: { failed: 1, planned: 1 },
        });
      }).pipe(Effect.provide(services)),
    ),
  );
});
