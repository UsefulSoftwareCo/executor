/**
 * The server-side move of a single-member Executor v1 workspace, started as an operator starts it
 * (`cloud-v1-import-run.spec.ts` covers shared workspaces and dry runs). The scenarios write
 * synthetic v1 rows into the managed Cloud's emulated v1 database, secrets into the emulated v1
 * WorkOS Vault under v1's object names, and read every result through the import's report and
 * Cloud's own API, signed in as the member, whose v2 account the import keeps.
 */
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Layer, Redacted, Ref, Schema } from "effect";
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
import { AccountLink, connectionsPath } from "../support/app-accounts.ts";
import { writeRows, type RowStatement } from "../support/cloud-rows.ts";
import { approvalMcpUpstream } from "../support/approval-mcp-upstream.ts";
import { credentialUpstream } from "../support/credential-upstream.ts";
import { largeOpenapiDocument } from "../support/large-openapi.ts";
import { graphComponents, graphDocument } from "../support/graph-openapi.ts";
import { Emulators } from "../support/emulators.ts";
import { McpClient } from "../support/mcp-client.ts";
import { Execution } from "../support/mcp-connections.ts";
import {
  type V1ForwardClaims,
  V1McpForwardSecret,
  v1ForwardBearer,
  v1McpForwardFile,
  v1ToolkitConnectionId,
} from "../support/v1-mcp-forward.ts";
import { Onboarding } from "../support/onboarding.ts";
import {
  OperatorOAuthFixture,
  operatorOAuthFile,
  v1FirstPartyCredentials,
  v1GitHubHosts,
  v1SlackScopes,
} from "../support/operator-oauth.ts";
import { Target } from "../support/platform.ts";
import { allowV1Import, v1ImportOperator, v1RunId, type V1Report } from "../support/v1-import.ts";
import { scenarios } from "../test-plan.ts";

const services = Layer.mergeAll(Onboarding.layer, Emulators.layer);

const Response = Schema.Struct({ status: Schema.Number, body: Schema.Unknown });
const ItemResult = Schema.Struct({
  status: Schema.String,
  v2Id: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  note: Schema.optionalKey(Schema.String),
  needsRepair: Schema.optionalKey(Schema.Boolean),
});
/** The inventory with the accounts the importing user linked to each app. */
const Inventory = Schema.Struct({
  apps: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  accounts: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
  links: Schema.Array(Schema.Struct({ app: Schema.String, account: Schema.String })),
});
/** The inventory with each account's provider and method, to read how it signs in again. */
const FirstPartyInventory = Schema.Struct({
  ...Inventory.fields,
  accounts: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.String,
      provider: Schema.String,
      method: Schema.String,
    }),
  ),
});
/** The operator's client a sign-in would use, when it is one. */
const SignInSetup = Schema.Struct({
  firstParty: Schema.optional(Schema.Struct({ label: Schema.String })),
});
const Tools = Schema.Struct({ items: Schema.Array(Schema.Struct({ name: Schema.String })) });
const Health = Schema.Struct({
  info: Schema.NullOr(
    Schema.Struct({
      email: Schema.optional(Schema.String),
      displayName: Schema.optional(Schema.String),
    }),
  ),
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      checkable: Schema.Boolean,
      check: Schema.NullOr(
        Schema.Struct({ status: Schema.String, message: Schema.optional(Schema.String) }),
      ),
    }),
  ),
});
const SourceFile = Schema.Struct({ path: Schema.String, content: Schema.String });
type SourceFile = typeof SourceFile.Type;
const Source = Schema.Struct({ files: Schema.Array(SourceFile) });
const Connections = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    url: Schema.String,
    policy: Schema.Struct({
      apps: Schema.Array(
        Schema.Struct({ app: Schema.String, runsAs: Schema.Unknown, tools: Schema.Unknown }),
      ),
    }),
  }),
);
const Apps = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    activeVersion: Schema.NullOr(Schema.String),
  }),
);

/**
 * The keys the synthetic API answers: its user, a Google-style disabled API, a redirect to a page
 * over plain HTTP that would pass the check, and anything else 401.
 */
const keys = {
  good: "synthetic-good-key",
  disabled: "synthetic-disabled-key",
  redirected: "synthetic-redirected-key",
  revoked: "synthetic-revoked-key",
} as const;
const checkedEmail = "checked-member@example.test";
/** The notes v2 shows for a toolkit that grants nothing and for every artifact. */
const grantsNoConnection = "It grants no connection in this workspace.";
const repairNote =
  "It is imported as app source without a version: v2 apps cannot call other apps' tools yet, so its code needs rewriting before it runs.";
/** A credential v1 kept in an MCP server's fixed headers; it must never reach generated source. */
const fixedSecret = "synthetic-fixed-secret-0123456789";
/**
 * v1's compiled names for the Compiled API's operations: the operationId split only on `.` and `/`,
 * one derived from the path when missing, and a collision told apart by the path's version.
 */
const compiledV1Names = [
  "items.getV1ItemsId",
  "items.itemsList",
  "items.v1.createItem",
  "items.v2.createItem",
];

/**
 * A synthetic API with one safe read, \`GET /v1/me\`, recording each request's path, query and key.
 * The disabled key gets Google's answer for an API that is not enabled in the client's project.
 * The redirected key is sent on to \`/landing\` over plain HTTP, which answers every request as the
 * user and records what reached it. It also serves the specification v1 stored only as its URL,
 * counting each time it is fetched.
 */
const checkedApi = Effect.gen(function* () {
  const received = yield* Ref.make<ReadonlyArray<{ path: string; key: string | undefined }>>([]);
  const landed = yield* Ref.make<ReadonlyArray<{ path: string; key: string | undefined }>>([]);
  const specFetches = yield* Ref.make(0);
  let origin = "";
  const linked = HttpRouter.add(
    "GET",
    "/openapi.json",
    Effect.gen(function* () {
      yield* Ref.update(specFetches, (count) => count + 1);
      return yield* HttpServerResponse.json(linkedDocument(origin));
    }),
  );
  const me = HttpRouter.add(
    "GET",
    "/v1/me",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const key = request.headers["x-key"];
      yield* Ref.update(received, (all) => [...all, { path: request.url, key }]);
      if (key === keys.good)
        return yield* HttpServerResponse.json({ user: { email: checkedEmail } });
      if (key === keys.redirected)
        return HttpServerResponse.empty({
          status: 302,
          headers: { location: `http://${request.headers.host}/landing` },
        });
      if (key === keys.disabled)
        return yield* HttpServerResponse.json(
          {
            error: {
              code: 403,
              status: "PERMISSION_DENIED",
              errors: [{ reason: "accessNotConfigured" }],
              details: [{ reason: "SERVICE_DISABLED" }],
            },
          },
          { status: 403 },
        );
      return yield* HttpServerResponse.json({ error: { code: 401 } }, { status: 401 });
    }),
  );
  const landing = HttpRouter.add(
    "*",
    "/landing",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* Ref.update(landed, (all) => [
        ...all,
        { path: request.url, key: request.headers["x-key"] },
      ]);
      return yield* HttpServerResponse.json({ user: { email: checkedEmail } });
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(Layer.mergeAll(me, landing, linked), {
      disableLogger: true,
      disableListenLog: true,
    }).pipe(Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 }))),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  origin = `http://127.0.0.1:${server.address.port}`;
  return {
    origin,
    received: Ref.get(received),
    landed: Ref.get(landed),
    specFetches: Ref.get(specFetches),
  };
});

/** The document behind the specification v1 stored only as its URL. */
const linkedDocument = (origin: string) => ({
  openapi: "3.0.3",
  info: { title: "Linked API", version: "1" },
  servers: [{ url: `${origin}/v1` }],
  paths: {
    "/me": {
      get: {
        operationId: "readMe",
        tags: ["profile"],
        responses: { "200": { description: "ok" } },
      },
    },
  },
});

/**
 * A document whose operations are references, as some generators write them: each names an
 * Operation Object under `components`, with its own operationId, tags and a security requirement
 * whose scheme the document declares. v1 named such an operation from its method and path.
 * One answers with a component whose name holds a space.
 */
const referencedText = JSON.stringify({
  openapi: "3.0.3",
  info: { title: "Referenced API", version: "1" },
  servers: [{ url: "https://api.example.com" }],
  security: [],
  components: {
    securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" } },
    pathItems: {
      listWidgets: {
        operationId: "listWidgets",
        tags: ["widgets"],
        security: [{ key: [] }],
        responses: { "200": { description: "ok" } },
      },
      getWidget: {
        operationId: "getWidget",
        tags: ["widgets"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            // A component whose name has a space, referenced with it percent-encoded.
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Widget%20Page" } },
            },
          },
        },
      },
    },
    schemas: { "Widget Page": { type: "object", properties: { id: { type: "string" } } } },
  },
  paths: {
    "/v1/widgets": { get: { $ref: "#/components/pathItems/listWidgets" } },
    "/v1/widgets/{id}": { get: { $ref: "#/components/pathItems/getWidget" } },
  },
});
/** v1's names for the Referenced API's operations, by method and path. */
const referencedV1Names = { "widgets.list": "/v1/widgets", "widgets.read": "/v1/widgets/{id}" };

/**
 * A workspace whose OpenAPI integration declares v1's account check (an identity read with a pinned
 * argument) and an empty base URL, a public MCP server that sends a credential in a fixed header,
 * policies v1 never applied or that match no tool v1 listed, and two OpenAPI integrations from
 * before v1 stored operations, whose tools v1 bound by compiling the document: one whose listed
 * tools the document names, and one that lists a tool it does not.
 */
const seedChecks = (organization: string, user: string, slug: string, origin: string) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const ok = { "200": { description: "ok" } };
    const compiledText = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Compiled API", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/v1/items": {
          get: { operationId: "items_list", tags: ["items"], responses: ok },
          post: { operationId: "createItem", tags: ["items"], responses: ok },
        },
        "/v2/items": { post: { operationId: "createItem", tags: ["items"], responses: ok } },
        "/v1/items/{id}": {
          get: {
            tags: ["items"],
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            responses: ok,
          },
        },
      },
    });
    const compiledHash = createHash("sha256").update(compiledText).digest("hex");
    const compiled = `compiled_${randomUUID().slice(0, 6)}`;
    const unmatched = `unmatched_${randomUUID().slice(0, 6)}`;
    // v1 merged two APIs whose operations share `POST /channels/stop`, as it did Google Calendar's
    // and Drive's, keeping the second under another document path. It stored a row only for the
    // first and found the second by compiling the document.
    const mergedText = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Merged API", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/channels/stop": {
          post: {
            operationId: "calendar.channels.stop",
            tags: ["Calendar"],
            servers: [{ url: "https://api.example.com/calendar/v3/" }],
            "x-executor-toolPath": "calendar.channels.stop",
            "x-executor-pathTemplate": "/channels/stop",
            responses: ok,
          },
        },
        "/drive.channels.stop": {
          post: {
            operationId: "drive.channels.stop",
            tags: ["Drive"],
            servers: [{ url: "https://api.example.com/drive/v3/" }],
            "x-executor-toolPath": "drive.channels.stop",
            "x-executor-pathTemplate": "/channels/stop",
            responses: ok,
          },
        },
      },
    });
    const mergedHash = createHash("sha256").update(mergedText).digest("hex");
    const merged = `merged_${randomUUID().slice(0, 6)}`;
    const referencedHash = createHash("sha256").update(referencedText).digest("hex");
    const referenced = `referenced_${randomUUID().slice(0, 6)}`;
    // v1 kept a specification given as a URL as that text, and fetched the document from it.
    const linkedText = `${origin}/openapi.json`;
    const linkedHash = createHash("sha256").update(linkedText).digest("hex");
    const linked = `linked_${randomUUID().slice(0, 6)}`;
    const document = {
      openapi: "3.0.3",
      info: { title: "Checked API", version: "1" },
      servers: [{ url: `${origin}/v1` }],
      paths: {
        "/me": {
          get: {
            operationId: "getMe",
            tags: ["me"],
            parameters: [{ name: "fields", in: "query", schema: { type: "string" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const text = JSON.stringify(document);
    const hash = createHash("sha256").update(text).digest("hex");
    const api = `checked_${randomUUID().slice(0, 6)}`;
    const mcp = `fixed_${randomUUID().slice(0, 6)}`;
    const userScope = `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;
    const items = Object.fromEntries(
      Object.keys(keys).map((name) => [name, `connection:user:${api}:${name}:token`]),
    );
    for (const [name, value] of Object.entries(keys))
      yield* emulators.v1VaultObject(vaultName(userScope, items[name] ?? ""), value);
    const tokenItem = (integration: string, connection: string) =>
      `connection:user:${integration}:${connection}:token`;
    for (const [integration, connection] of [
      [compiled, "compiled"],
      [unmatched, "unmatched"],
      [merged, "merged"],
      [referenced, "referenced"],
      [linked, "linked"],
    ] as const)
      yield* emulators.v1VaultObject(
        vaultName(userScope, tokenItem(integration, connection)),
        `synthetic-${connection}-key`,
      );
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic checked workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config, health_check, created_at) values ($1, $2, 'openapi', 'Checked API', $3::json, $4::json, now() - interval '2 days')",
        organization,
        api,
        JSON.stringify({
          specHash: hash,
          // v1 treats an empty base URL as unset and calls the document's server.
          baseUrl: "",
          authenticationTemplate: [
            {
              slug: "apikey-0",
              kind: "apikey",
              placements: [{ carrier: "header", name: "X-Key" }],
            },
          ],
        }),
        JSON.stringify({
          operation: "me.get",
          args: { fields: "email" },
          identityField: "user.email",
        }),
      ),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${hash}`,
        text,
      ),
      row(
        "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', 'op.me.get', $2::json)",
        organization,
        JSON.stringify({
          integration: api,
          toolName: "me.get",
          binding: {
            method: "get",
            pathTemplate: "/me",
            servers: [{ url: `${origin}/v1` }],
            parameters: [{ name: "fields", location: "query", required: false }],
          },
        }),
      ),
      ...Object.keys(keys).map((name, index) =>
        row(
          `insert into connection (tenant, owner, subject, integration, name, template, item_ids, created_at) values ($1, 'user', $2, $3, $4, 'apikey-0', $5::json, now() - interval '${3 - index} hours')`,
          organization,
          user,
          api,
          name,
          JSON.stringify({ token: items[name] }),
        ),
      ),
      row(
        "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'user', $2, $3, 'good', 'openapi', 'me.get')",
        organization,
        user,
        api,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config, created_at) values ($1, $2, 'mcp', 'Fixed MCP', $3::json, now() - interval '1 day')",
        organization,
        mcp,
        JSON.stringify({
          transport: "remote",
          endpoint: "https://mcp.example.com/mcp",
          remoteTransport: "auto",
          headers: { Authorization: `Bearer ${fixedSecret}`, "X-Client": "executor" },
          authenticationTemplate: [{ slug: "none", kind: "none" }],
        }),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template) values ($1, 'user', $2, $3, 'fixed', 'none')",
        organization,
        user,
        mcp,
      ),
      // v1 listed one of the server's tools under two names.
      ...[
        ["searchissues", "searchIssues"],
        ["search_issues", "searchIssues"],
      ].map(([name, upstream]) =>
        row(
          "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, 'user', $2, $3, 'fixed', 'mcp', $4, $5::json)",
          organization,
          user,
          mcp,
          name ?? "",
          JSON.stringify({ mcp: { toolName: upstream } }),
        ),
      ),
      // A connection that sent no credentials to an API whose other connections sign in.
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, created_at) values ($1, 'user', $2, $3, 'anonymous', 'none', now() - interval '1 hour')",
        organization,
        user,
        api,
      ),
      // Rules v1 never applied, and one that matches no tool v1 listed.
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', 'removed_service.*', 'block')",
        organization,
      ),
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', 'executor.code.*', 'approve')",
        organization,
      ),
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', $2, 'require_approval')",
        organization,
        `${api}.*.*.me.unlisted`,
      ),
      ...[
        [compiledHash, compiledText],
        [referencedHash, referencedText],
        [linkedHash, linkedText],
      ].map(([key, text]) =>
        row(
          "insert into blob (namespace, key, value) values ($1, $2, $3)",
          `o:${organization}/openapi`,
          `spec/${key}`,
          text ?? "",
        ),
      ),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${mergedHash}`,
        mergedText,
      ),
      row(
        "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
        organization,
        `op.${merged}.calendar.channels.stop`,
        JSON.stringify({
          integration: merged,
          toolName: "calendar.channels.stop",
          binding: {
            method: "post",
            pathTemplate: "/channels/stop",
            servers: [{ url: "https://api.example.com/calendar/v3/" }],
            parameters: [],
          },
        }),
      ),
      // No operation rows for the first two: v1 compiled the document and found each listed tool
      // by its name. The Merged API's row is above; the others bind each tool to its operation by
      // method and path.
      ...[
        {
          integration: compiled,
          name: "Compiled API",
          connection: "compiled",
          specHash: compiledHash,
          tools: compiledV1Names,
          operations: {},
        },
        // The organization revised it before v1 last listed its tools, so the tool v2 would not
        // provide is one v1 still lists, which blocks.
        {
          integration: unmatched,
          name: "Unmatched API",
          connection: "unmatched",
          specHash: compiledHash,
          tools: ["items.itemsList", "items.archive"],
          revised: { at: 1_000, listed: 2_000 },
          operations: {},
        },
        {
          integration: merged,
          name: "Merged API",
          connection: "merged",
          specHash: mergedHash,
          tools: ["calendar.channels.stop", "drive.channels.stop"],
          operations: {},
        },
        {
          integration: referenced,
          name: "Referenced API",
          connection: "referenced",
          specHash: referencedHash,
          tools: Object.keys(referencedV1Names),
          operations: referencedV1Names,
        },
        {
          integration: linked,
          name: "Linked API",
          connection: "linked",
          specHash: linkedHash,
          tools: ["profile.read"],
          operations: { "profile.read": "/me" },
        },
      ].flatMap(({ integration, name, connection, specHash, tools, operations, revised }) => [
        ...Object.entries(operations).map(([tool, path]) =>
          row(
            "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
            organization,
            `op.${integration}.${tool}`,
            JSON.stringify({
              integration,
              toolName: tool,
              binding: { method: "get", pathTemplate: path, parameters: [] },
            }),
          ),
        ),
        row(
          "insert into integration (tenant, slug, plugin_id, name, config, config_revised_at) values ($1, $2, 'openapi', $3, $4::json, nullif($5, '')::bigint)",
          organization,
          integration,
          name,
          JSON.stringify({
            specHash,
            authenticationTemplate: [
              {
                slug: "apikey-0",
                kind: "apikey",
                placements: [{ carrier: "header", name: "X-Key" }],
              },
            ],
          }),
          revised === undefined ? "" : String(revised.at),
        ),
        row(
          "insert into connection (tenant, owner, subject, integration, name, template, item_ids, tools_synced_at) values ($1, 'user', $2, $3, $4, 'apikey-0', $5::json, nullif($6, '')::bigint)",
          organization,
          user,
          integration,
          connection,
          JSON.stringify({ token: tokenItem(integration, connection) }),
          revised === undefined ? "" : String(revised.listed),
        ),
        ...tools.map((tool) =>
          row(
            "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'user', $2, $3, $4, 'openapi', $5)",
            organization,
            user,
            integration,
            connection,
            tool,
          ),
        ),
      ]),
    ]);
    return { api, mcp };
  });

/** Call Cloud's API from the signed-in page, as the dashboard does. */
const call = (
  step: string,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  payload?: unknown,
) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    return yield* browser
      .use(step, (page) =>
        page.evaluate(
          ({ method, path, payload }) =>
            fetch(path, {
              method,
              ...(payload === undefined
                ? {}
                : {
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(payload),
                  }),
            }).then((response) =>
              // A body that is not JSON is kept as text, so a failed assertion shows it.
              response.text().then((text) => {
                let body: unknown = text;
                try {
                  body = JSON.parse(text);
                } catch {}
                return { status: response.status, body };
              }),
            ),
          { method, path, payload },
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Response)));
  });
const decode = <S extends Schema.Top>(schema: S, response: typeof Response.Type) =>
  Schema.decodeUnknownEffect(schema)(response.body);

/** Sign in with Google as the v1 member; v2 keeps them on v1 until their workspace moves. */
const googleSignIn = (email: string) =>
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

type ReportItem = NonNullable<V1Report["items"]>[number];

/** An item's result as the import reports it. */
const resultOf = (item: ReportItem): typeof ItemResult.Type => ({
  status: item.status,
  ...(item.v2Id === undefined ? {} : { v2Id: item.v2Id }),
  ...(item.reason === undefined ? {} : { reason: item.reason }),
  ...(item.note === undefined ? {} : { note: item.note }),
  ...(item.needsRepair === undefined ? {} : { needsRepair: item.needsRepair }),
});

/**
 * Import a v1 organization on the server, as an operator starts it, and read each item's result
 * by `key`. The member signed in first, so their v2 account owns the new organization.
 */
const importOnServer = (
  organization: string,
  key: (item: ReportItem) => string = (item) => item.label,
) =>
  Effect.gen(function* () {
    const operator = yield* v1ImportOperator;
    yield* allowV1Import(organization);
    const run = v1RunId("import");
    const started = yield* operator.start({
      mode: "import",
      runId: run,
      organizations: [organization],
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const report = yield* operator.waitForReport(run, organization);
    const target = report.v2Organization;
    if (target === undefined)
      return yield* Effect.die(`The import moved nothing: ${report.reason ?? report.status}`);
    const items = report.items ?? [];
    const results = new Map(items.map((item) => [key(item), resultOf(item)] as const));
    return { report, target, items, results };
  });

/** The statuses of the items of a kind with a label, in the order they moved. */
const statuses = (items: readonly ReportItem[], kind: string, label: string) =>
  items.filter((item) => item.kind === kind && item.label === label).map((item) => item.status);

/** v1's Vault object name for an item id, with its 200-character rule. */
/** An imported app's deployed source files. */
const appSource = (organization: string, app: string | undefined) =>
  call(
    "Read the app's deployed source",
    "GET",
    `/api/organizations/${organization}/apps/${app}/source`,
  ).pipe(
    Effect.flatMap((response) => decode(Source, response)),
    Effect.map((source) => source.files),
  );

/** The options of each `oauth2(...)` an imported app's provider declares, which it writes as JSON. */
const oauthDeclarations = (organization: string, app: string | undefined) =>
  appSource(organization, app).pipe(
    Effect.map((files) =>
      [
        ...(files.find((file) => file.path === "provider.ts")?.content ?? "").matchAll(
          /oauth2\((\{[\s\S]*?\n\})\)/gu,
        ),
      ].flatMap(([, options]): unknown[] => (options === undefined ? [] : [JSON.parse(options)])),
    ),
  );

const vaultName = (scope: string, itemId: string) => {
  const name = `${scope}/secrets/${encodeURIComponent(itemId)}`;
  return name.length <= 200
    ? name
    : `${scope}/secrets/h~${createHash("sha256").update(itemId).digest("base64url")}`;
};

const spec = {
  openapi: "3.0.3",
  info: { title: "Synthetic widgets", version: "1" },
  servers: [{ url: "https://api.example.com/v1" }],
  security: [{ key: [] }],
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        tags: ["widgets"],
        responses: { "200": { description: "ok" } },
      },
      post: {
        operationId: "createWidget",
        tags: ["widgets"],
        requestBody: {
          content: { "application/json": { schema: { $ref: "#/components/schemas/Widget" } } },
        },
        responses: { "200": { description: "ok" } },
      },
    },
    "/widgets/{id}": {
      delete: {
        operationId: "deleteWidget",
        tags: ["widgets"],
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "204": { description: "gone" } },
      },
    },
    "/internal": {
      get: { operationId: "internal", responses: { "200": { description: "ok" } } },
    },
  },
  components: {
    schemas: { Widget: { type: "object", properties: { name: { type: "string" } } } },
    securitySchemes: { key: { type: "apiKey", in: "header", name: "X-Key" } },
  },
};

/**
 * The same document as YAML, as v1 stored specifications it fetched, with a description on
 * `deleteWidget`. A flow sequence across lines, and a kept block scalar whose only line is spaces
 * just before a shallower key, are valid YAML that only some parsers read.
 */
const specYaml = `openapi: 3.0.3
info:
  title: Synthetic widgets
  version: "1"
servers:
  - url: https://api.example.com/v1
security:
  - key: []
paths:
  /widgets:
    get:
      operationId: listWidgets
      tags: [
        widgets
        ]
      responses:
        "200":
          description: ok
    post:
      operationId: createWidget
      tags: [widgets]
      requestBody:
        content:
          application/json:
            schema:
              $ref: "#/components/schemas/Widget"
      responses:
        "200":
          description: ok
  /widgets/{id}:
    delete:
      operationId: deleteWidget
      tags: [widgets]
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "204":
          description: gone
      description: |+
${" ".repeat(8)}
  /internal:
    get:
      operationId: internal
      responses:
        "200":
          description: ok
components:
  schemas:
    Widget:
      type: object
      properties:
        name:
          type: string
  securitySchemes:
    key:
      type: apiKey
      in: header
      name: X-Key
`;

/**
 * A workspace with an OpenAPI integration (an API key and an OAuth method), a remote MCP server
 * whose v1 tool names differ from the server's, a local MCP server, and items that cannot move.
 */
const seedWorkspace = (
  organization: string,
  user: string,
  slug: string,
  format: "json" | "yaml" = "json",
) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const text = format === "json" ? JSON.stringify(spec) : specYaml;
    const hash = createHash("sha256").update(text).digest("hex");
    const widgets = `widgets_${randomUUID().slice(0, 6)}`;
    const tracker = `tracker_${randomUUID().slice(0, 6)}`;
    const userKey = `connection:user:${widgets}:main:token`;
    // Long enough that v1 stored it under its hashed name.
    const orgKey = `connection:org:${widgets}:main:${"k".repeat(160)}:token`;
    const accessKey = `oauth:user:${widgets}:signin`;
    const refreshKey = `${accessKey}:refresh`;
    const clientSecret = `oauth-client:org:${widgets}-client:secret`;
    const trackerKey = `connection:user:${tracker}:main:token`;
    const userScope = `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;
    const orgScope = `executor/org/${encodeURIComponent(organization)}`;
    for (const [name, value] of [
      [vaultName(userScope, userKey), "synthetic-user-key"],
      [vaultName(orgScope, orgKey), "synthetic-workspace-key"],
      [vaultName(userScope, accessKey), "synthetic-access-token"],
      [vaultName(userScope, refreshKey), "synthetic-refresh-token"],
      [vaultName(orgScope, clientSecret), "synthetic-client-secret"],
      [vaultName(userScope, trackerKey), "synthetic-tracker-key"],
    ] as const)
      yield* emulators.v1VaultObject(name, value);
    const openapi = {
      specHash: hash,
      authenticationTemplate: [
        { slug: "apikey-0", kind: "apikey", placements: [{ carrier: "header", name: "X-Key" }] },
        {
          slug: "oauth2",
          kind: "oauth2",
          authorizationUrl: "https://auth.example.com/authorize",
          tokenUrl: "https://auth.example.com/token",
          scopes: ["widgets"],
        },
      ],
    };
    const mcp = {
      transport: "remote",
      endpoint: "https://mcp.example.com/mcp",
      remoteTransport: "auto",
      headers: { "X-Client": "executor" },
      queryParams: { region: "eu" },
      authenticationTemplate: [
        {
          slug: "header",
          kind: "apikey",
          placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
        },
        { slug: "oauth2", kind: "oauth2" },
      ],
    };
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    const v1Names = { list: "widgets.list", create: "widgets.create", remove: "widgets.remove" };
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic v1 workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config, created_at) values ($1, $2, 'openapi', 'Widgets', $3::json, now() - interval '3 days')",
        organization,
        widgets,
        JSON.stringify(openapi),
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config, created_at) values ($1, $2, 'mcp', 'Tracker', $3::json, now() - interval '2 days')",
        organization,
        tracker,
        JSON.stringify(mcp),
      ),
      row(
        `insert into integration (tenant, slug, plugin_id, name, config) values ($1, 'local_files', 'mcp', 'Local files', '{"transport":"stdio","command":"files"}')`,
        organization,
      ),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${hash}`,
        text,
      ),
      ...Object.entries({
        [v1Names.list]: ["get", "/widgets"],
        [v1Names.create]: ["post", "/widgets"],
        [v1Names.remove]: ["delete", "/widgets/{id}"],
      }).map(([tool, [method, path]]) =>
        row(
          "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
          organization,
          `op.${tool}`,
          JSON.stringify({
            integration: widgets,
            toolName: tool,
            binding: { method, pathTemplate: path },
          }),
        ),
      ),
      // Connections, oldest first: the user's API key, the workspace's, then an OAuth sign-in.
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, created_at) values ($1, 'user', $2, $3, 'main', 'apikey-0', $4::json, now() - interval '3 days')",
        organization,
        user,
        widgets,
        JSON.stringify({ token: userKey }),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, created_at) values ($1, 'org', '', $2, 'main', 'apikey-0', $3::json, now() - interval '2 days')",
        organization,
        widgets,
        JSON.stringify({ token: orgKey }),
      ),
      row(
        "insert into oauth_client (tenant, owner, subject, slug, authorization_url, token_url, \"grant\", client_id, client_secret_item_id, token_endpoint_auth_method, origin_kind) values ($1, 'org', '', $2, 'https://auth.example.com/authorize', 'https://auth.example.com/token', 'authorization_code', 'synthetic-client', $3, 'basic', 'manual')",
        organization,
        `${widgets}-client`,
        clientSecret,
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner, refresh_item_id, expires_at, created_at) values ($1, 'user', $2, $3, 'signin', 'oauth2', $4::json, $5, 'org', $6, $7::bigint, now() - interval '1 day')",
        organization,
        user,
        widgets,
        JSON.stringify({ token: accessKey }),
        `${widgets}-client`,
        refreshKey,
        String(Date.now() + 3_600_000),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids) values ($1, 'user', $2, $3, 'main', 'header', $4::json)",
        organization,
        user,
        tracker,
        JSON.stringify({ token: trackerKey }),
      ),
      // Executor's own OAuth apps are not in v2 yet (#1186).
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner) values ($1, 'user', $2, $3, 'linear', 'oauth2', '{\"token\":\"oauth:user:linear:token\"}', 'first-party:linear', 'org')",
        organization,
        user,
        tracker,
      ),
      // What v1 last listed: v1 names per connection, and the MCP server's own names.
      ...[v1Names.list, v1Names.create, v1Names.remove].map((name) =>
        row(
          "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'user', $2, $3, 'main', 'openapi', $4)",
          organization,
          user,
          widgets,
          name,
        ),
      ),
      ...[
        // v1 lower-cased MCP names and joined other characters with `_`, numbering a name an
        // earlier tool already took.
        ["searchissues", "searchIssues"],
        ["create_issue", "create-issue"],
        ["create_issue_2", "create_issue"],
      ].map(([name, upstream]) =>
        row(
          "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, 'user', $2, $3, 'main', 'mcp', $4, $5::json)",
          organization,
          user,
          tracker,
          name ?? "",
          JSON.stringify({ mcp: { toolName: upstream } }),
        ),
      ),
      // A tool v1 listed before it stored the server's own name; v1 cannot call it.
      row(
        "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'user', $2, $3, 'main', 'mcp', 'stale_tool')",
        organization,
        user,
        tracker,
      ),
      // Policies: the workspace blocks deleting; the member approves creating without asking.
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, 'block', 'a0')",
        organization,
        `${widgets}.*.*.${v1Names.remove}`,
      ),
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'user', $2, $3, 'approve', 'a0')",
        organization,
        user,
        `${widgets}.user.main.${v1Names.create}`,
      ),
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', 'removed_service.*', 'block')",
        organization,
      ),
      // A toolkit with no rules grants nothing; it still becomes a connection.
      row(
        "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'toolkits', 'toolkits', 'tk_1', $2::json)",
        organization,
        JSON.stringify({ id: "tk_1", name: "Support", slug: "support" }),
      ),
      row(
        "insert into artifact (tenant, owner, subject, title) values ($1, 'user', $2, 'Dashboard')",
        organization,
        user,
      ),
    ]);
    return { widgets, tracker, v1Names };
  });

/**
 * A workspace with toolkits and artifacts: an MCP server that takes an API key, a public MCP server
 * with two connections, a personal toolkit over both that blocks one tool and asks before another,
 * an org toolkit that names a personal connection (which v1 never served through it), and two
 * artifacts, one with stored bindings and one saved before bindings existed.
 */
const seedToolkits = (organization: string, user: string, slug: string) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const hosted = `hosted_${randomUUID().slice(0, 6)}`;
    const open = `open_${randomUUID().slice(0, 6)}`;
    const key = `connection:user:${hosted}:main:token`;
    const userScope = `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;
    yield* emulators.v1VaultObject(vaultName(userScope, key), "synthetic-hosted-key");
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    const tool = (integration: string, connection: string, name: string) =>
      row(
        "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, 'user', $2, $3, $4, 'mcp', $5, $6::json)",
        organization,
        user,
        integration,
        connection,
        name,
        JSON.stringify({ mcp: { toolName: name } }),
      );
    const toolkitRow = (owner: "org" | "user", collection: string, data: Record<string, string>) =>
      row(
        `insert into plugin_storage (tenant, owner, subject, plugin_id, collection, key, data) values ($1, '${owner}', $2, 'toolkits', $3, $4, $5::json)`,
        organization,
        owner === "user" ? user : "",
        collection,
        data.id ?? "",
        JSON.stringify(data),
      );
    const dashboard = `function App() {
  const items = useQuery(tools.${hosted}.list_items.queryOptions({}));
  const other = useQuery(tools.missing_service("other").records.list.queryOptions({}));
  return <Card>{items.data?.length ?? 0} {other.data?.length ?? 0}</Card>;
}`;
    const legacy = `function App() {
  const found = useQuery(tools.${open}.user.first.search.queryOptions({ query: "synthetic" }));
  return <pre>{JSON.stringify(found.data)}</pre>;
}`;
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic toolkit workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config, created_at) values ($1, $2, 'mcp', 'Hosted', $3::json, now() - interval '2 days')",
        organization,
        hosted,
        JSON.stringify({
          transport: "remote",
          endpoint: "https://mcp.example.com/hosted",
          authenticationTemplate: [
            {
              slug: "header",
              kind: "apikey",
              placements: [{ carrier: "header", name: "Authorization", prefix: "Bearer " }],
            },
          ],
        }),
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config, created_at) values ($1, $2, 'mcp', 'Open', $3::json, now() - interval '1 day')",
        organization,
        open,
        JSON.stringify({
          transport: "remote",
          endpoint: "https://mcp.example.com/open",
          authenticationTemplate: [{ slug: "none", kind: "none" }],
        }),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, created_at) values ($1, 'user', $2, $3, 'main', 'header', $4::json, now() - interval '2 days')",
        organization,
        user,
        hosted,
        JSON.stringify({ token: key }),
      ),
      // Two connections of a public app: the second depends on the first.
      ...["first", "second"].map((name, index) =>
        row(
          `insert into connection (tenant, owner, subject, integration, name, template, created_at) values ($1, 'user', $2, $3, $4, 'none', now() - interval '${10 - index} hours')`,
          organization,
          user,
          open,
          name,
        ),
      ),
      ...["list_items", "create_item", "delete_item", "purge_items"].map((name) =>
        tool(hosted, "main", name),
      ),
      tool(open, "first", "search"),
      tool(open, "second", "search"),
      // The workspace blocks purging everywhere.
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, 'block', 'a0')",
        organization,
        `${hosted}.*.*.purge_items`,
      ),
      // The workspace never asks before listing, but v1 ignored that inside the toolkit.
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, 'approve', 'a1')",
        organization,
        `${hosted}.*.*.list_items`,
      ),
      toolkitRow("user", "toolkits", { id: "tk_support", name: "Support", slug: "support" }),
      toolkitRow("user", "toolkitConnections", {
        id: "tkconn_1",
        toolkitId: "tk_support",
        pattern: `${hosted}.user.main.*`,
        position: "a0",
      }),
      toolkitRow("user", "toolkitConnections", {
        id: "tkconn_2",
        toolkitId: "tk_support",
        pattern: `${open}.user.first.*`,
        position: "a1",
      }),
      toolkitRow("user", "toolkitPolicies", {
        id: "tkpol_1",
        toolkitId: "tk_support",
        pattern: `${hosted}.*.*.delete_item`,
        action: "block",
        position: "a0",
      }),
      toolkitRow("user", "toolkitPolicies", {
        id: "tkpol_2",
        toolkitId: "tk_support",
        pattern: `${hosted}.*.*.create_item`,
        action: "require_approval",
        position: "a1",
      }),
      // An org toolkit never served a personal connection's tools.
      toolkitRow("org", "toolkits", { id: "tk_shared", name: "Shared", slug: "shared" }),
      toolkitRow("org", "toolkitConnections", {
        id: "tkconn_3",
        toolkitId: "tk_shared",
        pattern: `${hosted}.user.main.*`,
        position: "a0",
      }),
      row(
        "insert into artifact (tenant, owner, subject, title, description, code, bindings) values ($1, 'user', $2, 'Dashboard', 'Synthetic dashboard', $3, $4::json)",
        organization,
        user,
        dashboard,
        JSON.stringify({
          [hosted]: { integration: hosted, owner: "user", connection: "main" },
          other: { integration: "missing_service", owner: "user", connection: "main" },
        }),
      ),
      row(
        "insert into artifact (tenant, owner, subject, title, code) values ($1, 'user', $2, 'Legacy view', $3)",
        organization,
        user,
        legacy,
      ),
    ]);
    return { hosted, open };
  });

/**
 * A workspace whose toolkits call an API: one OpenAPI integration on the loopback service with the
 * workspace's API key (`shared`) and the member's own (`mine`), an org toolkit over the workspace's
 * connection and a personal toolkit over the member's. Each key is one only that connection holds.
 */
const ledgerKeys = {
  shared: "synthetic-ledger-workspace-key",
  mine: "synthetic-ledger-member-key",
};
const seedToolkitCalls = (organization: string, user: string, slug: string, origin: string) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const ledger = `ledger_${randomUUID().slice(0, 6)}`;
    const sharedItem = `connection:org:${ledger}:shared:token`;
    const mineItem = `connection:user:${ledger}:mine:token`;
    const userScope = `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;
    const orgScope = `executor/org/${encodeURIComponent(organization)}`;
    yield* emulators.v1VaultObject(vaultName(orgScope, sharedItem), ledgerKeys.shared);
    yield* emulators.v1VaultObject(vaultName(userScope, mineItem), ledgerKeys.mine);
    const text = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic ledger", version: "1" },
      servers: [{ url: `${origin}/ledger` }],
      paths: {
        "/entries": {
          get: {
            operationId: "listEntries",
            tags: ["entries"],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const hash = createHash("sha256").update(text).digest("hex");
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    const toolkitRow = (owner: "org" | "user", collection: string, data: Record<string, string>) =>
      row(
        `insert into plugin_storage (tenant, owner, subject, plugin_id, collection, key, data) values ($1, '${owner}', $2, 'toolkits', $3, $4, $5::json)`,
        organization,
        owner === "user" ? user : "",
        collection,
        data.id ?? "",
        JSON.stringify(data),
      );
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic ledger workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Ledger', $3::json)",
        organization,
        ledger,
        JSON.stringify({
          specHash: hash,
          authenticationTemplate: [
            {
              slug: "apikey-0",
              kind: "apikey",
              placements: [{ carrier: "header", name: "X-Api-Key" }],
            },
          ],
        }),
      ),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${hash}`,
        text,
      ),
      row(
        "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
        organization,
        `op.${ledger}.entries.list`,
        JSON.stringify({
          integration: ledger,
          toolName: "entries.list",
          binding: { method: "get", pathTemplate: "/entries" },
        }),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, created_at) values ($1, 'org', '', $2, 'shared', 'apikey-0', $3::json, now() - interval '2 hours')",
        organization,
        ledger,
        JSON.stringify({ token: sharedItem }),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, created_at) values ($1, 'user', $2, $3, 'mine', 'apikey-0', $4::json, now() - interval '1 hour')",
        organization,
        user,
        ledger,
        JSON.stringify({ token: mineItem }),
      ),
      // What v1 last listed through each connection.
      row(
        "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'org', '', $2, 'shared', 'openapi', 'entries.list')",
        organization,
        ledger,
      ),
      row(
        "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name) values ($1, 'user', $2, $3, 'mine', 'openapi', 'entries.list')",
        organization,
        user,
        ledger,
      ),
      toolkitRow("org", "toolkits", { id: "tk_team", name: "Team ledger", slug: "team" }),
      toolkitRow("org", "toolkitConnections", {
        id: "tkconn_team",
        toolkitId: "tk_team",
        pattern: `${ledger}.org.shared.*`,
        position: "a0",
      }),
      toolkitRow("user", "toolkits", { id: "tk_mine", name: "My ledger", slug: "mine" }),
      toolkitRow("user", "toolkitConnections", {
        id: "tkconn_mine",
        toolkitId: "tk_mine",
        pattern: `${ledger}.user.mine.*`,
        position: "a0",
      }),
    ]);
  });

/**
 * A workspace whose connections of one integration have different rules (decision 32). Ledger, an
 * API that lists, searches and creates entries on the loopback service, has two workspace
 * connections and the member's own, each with a key only it holds: its rules block searching
 * through `bot`, allow only listing and searching through `reader`, and leave `mine` to each
 * tool's default, and an org toolkit reaches both workspace connections. Notes blocks deleting
 * through both its workspace connections; its third connection, which blocks everything, signs in
 * with a method Notes does not declare, so it cannot move. Signals, a public MCP server, stamped
 * `erase` as destructive only when one of its two connections listed it. Integrations are named
 * after `names`, so two workspaces seeded with it have the same rules.
 */
const splitKeys = {
  bot: "synthetic-split-bot-key",
  reader: "synthetic-split-reader-key",
  mine: "synthetic-split-member-key",
  alpha: "synthetic-split-alpha-key",
  beta: "synthetic-split-beta-key",
};
const seedSplitConnections = (
  organization: string,
  user: string,
  slug: string,
  origin: string,
  names: string,
) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const ledger = `ledger_${names}`;
    const notes = `notes_${names}`;
    const signals = `signals_${names}`;
    const orgScope = `executor/org/${encodeURIComponent(organization)}`;
    const userScope = `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;
    const ok = { "200": { description: "ok" } };
    const document = (title: string, base: string, paths: Record<string, unknown>) => {
      const text = JSON.stringify({
        openapi: "3.0.3",
        info: { title, version: "1" },
        servers: [{ url: `${origin}/${base}` }],
        paths,
      });
      return { text, hash: createHash("sha256").update(text).digest("hex") };
    };
    const ledgerSpec = document("Synthetic split ledger", "ledger", {
      "/entries": {
        get: { operationId: "listEntries", tags: ["entries"], responses: ok },
        post: { operationId: "createEntry", tags: ["entries"], responses: ok },
      },
      "/entries/search": {
        get: { operationId: "searchEntries", tags: ["entries"], responses: ok },
      },
    });
    const notesSpec = document("Synthetic notes", "notes", {
      "/notes": {
        get: { operationId: "listNotes", tags: ["notes"], responses: ok },
        delete: { operationId: "deleteNotes", tags: ["notes"], responses: ok },
      },
    });
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    const apiKeyConfig = (hash: string) =>
      JSON.stringify({
        specHash: hash,
        authenticationTemplate: [
          {
            slug: "apikey-0",
            kind: "apikey",
            placements: [{ carrier: "header", name: "X-Api-Key" }],
          },
        ],
      });
    const operation = (integration: string, tool: string, method: string, path: string) =>
      row(
        "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
        organization,
        `op.${integration}.${tool}`,
        JSON.stringify({
          integration,
          toolName: tool,
          binding: { method, pathTemplate: path },
        }),
      );
    /** A connection's row, and the Vault object of its key when it holds one. */
    const connection = (
      integration: string,
      owner: "org" | "user",
      name: string,
      template: string,
      key?: string,
    ) => {
      const item = `connection:${owner}:${integration}:${name}:token`;
      return {
        vault:
          key === undefined
            ? undefined
            : { name: vaultName(owner === "org" ? orgScope : userScope, item), key },
        row: row(
          "insert into connection (tenant, owner, subject, integration, name, template, item_ids) values ($1, $2, $3, $4, $5, $6, $7::json)",
          organization,
          owner,
          owner === "user" ? user : "",
          integration,
          name,
          template,
          JSON.stringify(key === undefined ? {} : { token: item }),
        ),
      };
    };
    const tool = (
      integration: string,
      plugin: "openapi" | "mcp",
      owner: "org" | "user",
      name: string,
      toolName: string,
      annotations: Record<string, unknown> = {},
    ) =>
      row(
        "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, $2, $3, $4, $5, $6, $7, $8::json)",
        organization,
        owner,
        owner === "user" ? user : "",
        integration,
        name,
        plugin,
        toolName,
        JSON.stringify(annotations),
      );
    const rule = (pattern: string, action: string, position: string) =>
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, $3, $4)",
        organization,
        pattern,
        action,
        position,
      );
    const toolkitRow = (collection: string, data: Record<string, string>) =>
      row(
        "insert into plugin_storage (tenant, owner, subject, plugin_id, collection, key, data) values ($1, 'org', '', 'toolkits', $2, $3, $4::json)",
        organization,
        collection,
        data.id ?? "",
        JSON.stringify(data),
      );
    const ledgerConnections = [
      connection(ledger, "org", "bot", "apikey-0", splitKeys.bot),
      connection(ledger, "org", "reader", "apikey-0", splitKeys.reader),
      connection(ledger, "user", "mine", "apikey-0", splitKeys.mine),
    ];
    const notesConnections = [
      connection(notes, "org", "alpha", "apikey-0", splitKeys.alpha),
      connection(notes, "org", "beta", "apikey-0", splitKeys.beta),
    ];
    for (const { vault } of [...ledgerConnections, ...notesConnections])
      if (vault !== undefined) yield* emulators.v1VaultObject(vault.name, vault.key);
    const ledgerTools = ["entries.list", "entries.search", "entries.create"];
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic split connections workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Ledger', $3::json)",
        organization,
        ledger,
        apiKeyConfig(ledgerSpec.hash),
      ),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${ledgerSpec.hash}`,
        ledgerSpec.text,
      ),
      operation(ledger, "entries.list", "get", "/entries"),
      operation(ledger, "entries.search", "get", "/entries/search"),
      operation(ledger, "entries.create", "post", "/entries"),
      ...ledgerConnections.map((entry) => entry.row),
      // What v1 last listed through each connection: every operation.
      ...(
        [
          ["org", "bot"],
          ["org", "reader"],
          ["user", "mine"],
        ] as const
      ).flatMap(([owner, name]) =>
        ledgerTools.map((toolName) => tool(ledger, "openapi", owner, name, toolName)),
      ),
      rule(`${ledger}.org.bot.entries.search`, "block", "a0"),
      rule(`${ledger}.org.reader.entries.list`, "approve", "a1"),
      rule(`${ledger}.org.reader.entries.search`, "approve", "a2"),
      rule(`${ledger}.org.reader.*`, "block", "a3"),
      toolkitRow("toolkits", { id: "tk_split", name: "Ledger team", slug: "ledger-team" }),
      toolkitRow("toolkitConnections", {
        id: "tkconn_split",
        toolkitId: "tk_split",
        pattern: `${ledger}.org.*.*`,
        position: "a0",
      }),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Notes', $3::json)",
        organization,
        notes,
        apiKeyConfig(notesSpec.hash),
      ),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${notesSpec.hash}`,
        notesSpec.text,
      ),
      operation(notes, "notes.list", "get", "/notes"),
      operation(notes, "notes.delete", "delete", "/notes"),
      ...notesConnections.map((entry) => entry.row),
      // A connection that signs in with a method Notes does not declare and never listed tools.
      connection(notes, "org", "gamma", "apikey-9").row,
      ...["alpha", "beta"].flatMap((name) =>
        ["notes.list", "notes.delete"].map((toolName) =>
          tool(notes, "openapi", "org", name, toolName),
        ),
      ),
      rule(`${notes}.org.*.notes.delete`, "block", "b0"),
      rule(`${notes}.org.gamma.*`, "block", "b1"),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'mcp', 'Signals', $3::json)",
        organization,
        signals,
        JSON.stringify({
          transport: "remote",
          endpoint: `${origin}/mcp`,
          authenticationTemplate: [{ slug: "none", kind: "none" }],
        }),
      ),
      ...["east", "west"].flatMap((name) => [
        connection(signals, "org", name, "none").row,
        tool(signals, "mcp", "org", name, "read", { mcp: { toolName: "read" } }),
        // Only `east` listed `erase` after the server marked it destructive.
        tool(signals, "mcp", "org", name, "erase", {
          ...(name === "east" ? { requiresApproval: true } : {}),
          mcp: { toolName: "erase" },
        }),
      ]),
    ]);
  });

/**
 * A workspace whose public MCP server dropped a tool's destructive hint after v1 last listed it:
 * v1 stamped `unhinted` as needing approval and asks from that stamp, while the server lists it
 * without a hint now. v1 allowed `safe`, which it never stamped, and `read`, which it stamped but a
 * workspace policy approves. A toolkit grants the first two.
 */
const seedStampedApprovals = (organization: string, slug: string, origin: string) =>
  Effect.gen(function* () {
    const server = `approvals_${randomUUID().slice(0, 6)}`;
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    const tool = (name: string, stamped: boolean) =>
      row(
        "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, 'org', '', $2, 'open', 'mcp', $3, $4::json)",
        organization,
        server,
        name,
        JSON.stringify({ ...(stamped ? { requiresApproval: true } : {}), mcp: { toolName: name } }),
      );
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
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic approvals workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'mcp', 'Approvals', $3::json)",
        organization,
        server,
        JSON.stringify({
          transport: "remote",
          endpoint: `${origin}/mcp`,
          authenticationTemplate: [{ slug: "none", kind: "none" }],
        }),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template) values ($1, 'org', '', $2, 'open', 'none')",
        organization,
        server,
      ),
      tool("unhinted", true),
      tool("safe", false),
      tool("read", true),
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, 'approve', 'a0')",
        organization,
        `${server}.*.*.read`,
      ),
      toolkitRow("toolkits", { id: "tk_ops", name: "Ops", slug: "ops" }),
      toolkitRow("toolkitConnections", {
        id: "tkconn_ops",
        toolkitId: "tk_ops",
        pattern: `${server}.org.open.*`,
        position: "a0",
      }),
      // The toolkit leaves `read` out. Had it served `read`, v1 would have asked there from the
      // stamp, ignoring the workspace's approve, and the app would ask for every caller.
      toolkitRow("toolkitPolicies", {
        id: "tkpol_ops",
        toolkitId: "tk_ops",
        pattern: `${server}.*.*.read`,
        action: "block",
        position: "a1",
      }),
    ]);
  });

/**
 * A workspace whose public MCP server lists tools v1 never listed: v1 last listed only `read`,
 * which a rule approves. A rule blocks `unhinted` by name and a catch-all rule asks before every
 * other tool, so once the server listed them v1 would have blocked `unhinted` and asked before
 * `safe`, which the server does not mark destructive. A public API's one read operation, which v1
 * compiled but never listed, is under a catch-all rule that asks before every tool.
 */
const seedUnlistedRules = (organization: string, slug: string, origin: string) =>
  Effect.gen(function* () {
    const server = `unlisted_${randomUUID().slice(0, 6)}`;
    const api = `status_${randomUUID().slice(0, 6)}`;
    const text = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic status", version: "1" },
      servers: [{ url: `${origin}/public` }],
      paths: {
        "/health": {
          get: {
            operationId: "health",
            tags: ["status"],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const hash = createHash("sha256").update(text).digest("hex");
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    const rule = (pattern: string, action: string, position: string) =>
      row(
        "insert into tool_policy (tenant, owner, subject, pattern, action, position) values ($1, 'org', '', $2, $3, $4)",
        organization,
        pattern,
        action,
        position,
      );
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic unlisted tools workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'mcp', 'Unlisted', $3::json)",
        organization,
        server,
        JSON.stringify({
          transport: "remote",
          endpoint: `${origin}/mcp`,
          authenticationTemplate: [{ slug: "none", kind: "none" }],
        }),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template) values ($1, 'org', '', $2, 'open', 'none')",
        organization,
        server,
      ),
      row(
        "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, 'org', '', $2, 'open', 'mcp', 'read', $3::json)",
        organization,
        server,
        JSON.stringify({ mcp: { toolName: "read" } }),
      ),
      rule(`${server}.*.*.read`, "approve", "a0"),
      rule(`${server}.org.open.unhinted`, "block", "a1"),
      rule(`${server}.*`, "require_approval", "a2"),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Status', $3::json)",
        organization,
        api,
        JSON.stringify({ specHash: hash, authenticationTemplate: [] }),
      ),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${hash}`,
        text,
      ),
      row(
        "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
        organization,
        `op.${api}.status.health`,
        JSON.stringify({
          integration: api,
          toolName: "status.health",
          binding: { method: "get", pathTemplate: "/health" },
        }),
      ),
      rule(`${api}.*`, "require_approval", "a3"),
    ]);
  });

/**
 * Two host names of one synthetic service, under one registrable domain, for the loopback
 * service's port. `*.localhost` resolves to loopback.
 */
const serviceHosts = (port: number) => ({
  api: `api.synthetic-service.localhost:${port}`,
  uploads: `uploads.synthetic-service.localhost:${port}`,
});

/**
 * OpenAPI integrations whose requests depend on how v1 read them, against a loopback service
 * that records what it receives: a YAML specification with a repeated key, operations that name
 * their own server, a webhook, a method without a name, a public API, one whose operations call
 * two hosts of one service, one whose operations call two services with an account, one on two
 * HTTPS hosts of one service whose account check picks a server variable that turns it to plain
 * HTTP, one whose operation names a server that uses the document server's variable without
 * declaring it, one whose two document servers declare that variable differently, and one whose
 * server uses a variable no server declares.
 */
const seedRequests = (organization: string, user: string, slug: string, origin: string) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const suffix = randomUUID().slice(0, 6);
    const keyItem = `connection:user:requests_${suffix}:main:token`;
    const uploadsKeyItem = `connection:user:uploads_${suffix}:main:token`;
    const mixedKeyItem = `connection:user:mixed_${suffix}:main:token`;
    const splitKeyItem = `connection:user:split_${suffix}:main:token`;
    const downgradedKeyItem = `connection:user:downgraded_${suffix}:main:token`;
    const regionalKeyItem = `connection:user:regional_${suffix}:main:token`;
    const layeredKeyItem = `connection:user:layered_${suffix}:main:token`;
    const userScope = `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;
    yield* emulators.v1VaultObject(vaultName(userScope, keyItem), "synthetic-requests-key");
    yield* emulators.v1VaultObject(vaultName(userScope, uploadsKeyItem), "synthetic-uploads-key");
    yield* emulators.v1VaultObject(vaultName(userScope, mixedKeyItem), "synthetic-mixed-key");
    yield* emulators.v1VaultObject(vaultName(userScope, splitKeyItem), "synthetic-split-key");
    yield* emulators.v1VaultObject(
      vaultName(userScope, downgradedKeyItem),
      "synthetic-downgraded-key",
    );
    yield* emulators.v1VaultObject(vaultName(userScope, regionalKeyItem), "synthetic-regional-key");
    yield* emulators.v1VaultObject(vaultName(userScope, layeredKeyItem), "synthetic-layered-key");
    const hosts = serviceHosts(Number(new URL(origin).port));
    // js-yaml, which v1 parsed with, keeps the last of a repeated key.
    const requests = [
      "openapi: 3.1.0",
      "info:",
      "  title: Synthetic requests",
      "  version: '1'",
      "  description: first",
      "  description: second",
      "servers:",
      `  - url: ${origin}/root`,
      "paths:",
      "  /items:",
      "    get:",
      "      operationId: listItems",
      "      tags: [items]",
      "      servers:",
      `        - url: ${origin}/v2`,
      "      responses:",
      "        '200':",
      "          description: ok",
      "  /ping:",
      "    get:",
      "      operationId: ping",
      "      tags: [items]",
      "      responses:",
      "        '200':",
      "          description: ok",
      "webhooks:",
      "  itemCreated:",
      "    post:",
      "      requestBody:",
      "        content:",
      "          application/json:",
      "            schema:",
      "              $ref: '#/components/schemas/Event'",
      "      responses:",
      "        '200':",
      "          description: ok",
      "components:",
      "  schemas:",
      "    Event:",
      "      type: object",
      "",
    ].join("\n");
    const document = (title: string, paths: Record<string, unknown>) =>
      JSON.stringify({
        openapi: "3.0.3",
        info: { title, version: "1" },
        servers: [{ url: `${origin}/public` }],
        paths,
      });
    const ok = { "200": { description: "ok" } };
    const status = document("Synthetic status", {
      "/health": { get: { operationId: "health", tags: ["status"], responses: ok } },
    });
    const split = document("Synthetic split", {
      "/a": { get: { operationId: "a", tags: ["split"], responses: ok } },
      "/b": {
        get: {
          operationId: "b",
          tags: ["split"],
          servers: [{ url: "https://other.example.com" }],
          responses: ok,
        },
      },
    });
    // Google's APIs, each on its own host under `googleapis.com`, which the public suffix list
    // keeps apart.
    const google = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic Google", version: "1" },
      servers: [{ url: "https://gmail.googleapis.com" }],
      paths: {
        "/gmail/v1/users/me/messages": {
          get: { operationId: "list", tags: ["messages"], responses: ok },
        },
        "/v4/spreadsheets": {
          get: {
            operationId: "get",
            tags: ["sheets"],
            servers: [{ url: "https://sheets.googleapis.com" }],
            responses: ok,
          },
        },
      },
    });
    // Like GitHub's API and upload hosts: v1 sent the account's key to both.
    const uploads = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic uploads", version: "1" },
      servers: [{ url: `http://${hosts.api}/api` }],
      paths: {
        "/repos": { get: { operationId: "get", tags: ["repos"], responses: ok } },
        "/assets": {
          get: {
            operationId: "upload",
            tags: ["assets"],
            servers: [{ url: `http://${hosts.uploads}/uploads` }],
            responses: ok,
          },
        },
      },
    });
    // One service's hosts, one of them on plain HTTP: v1 sent the key to both, but the account's
    // credentials would cross the network unencrypted.
    const mixed = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic mixed", version: "1" },
      servers: [{ url: "https://api.mixed.example.com/api" }],
      paths: {
        "/repos": { get: { operationId: "get", tags: ["repos"], responses: ok } },
        "/assets": {
          get: {
            operationId: "upload",
            tags: ["assets"],
            servers: [{ url: "http://uploads.mixed.example.com/uploads" }],
            responses: ok,
          },
        },
      },
    });
    // One service's two HTTPS hosts, whose account check picks the upload server with its scheme
    // variable set to plain HTTP.
    const downgraded = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic downgraded", version: "1" },
      servers: [{ url: "https://api.downgraded.example.com/api" }],
      paths: {
        "/repos": { get: { operationId: "get", tags: ["repos"], responses: ok } },
        "/assets": {
          get: {
            operationId: "upload",
            tags: ["assets"],
            servers: [
              {
                url: "{scheme}://uploads.downgraded.example.com/uploads",
                variables: { scheme: { default: "https", enum: ["https", "http"] } },
              },
            ],
            responses: ok,
          },
        },
      },
    });
    // Like Sentry's API: the document's server declares a region variable, and one operation names
    // the same server URL without declaring it, so the operation uses the document's default.
    const regionalServer = `http://{region}.synthetic-service.localhost:${new URL(origin).port}/regional`;
    const regional = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic regional", version: "1" },
      servers: [
        {
          url: regionalServer,
          variables: { region: { default: "api", enum: ["api", "uploads"] } },
        },
      ],
      paths: {
        "/items": { get: { operationId: "list", tags: ["items"], responses: ok } },
        "/models": {
          get: {
            operationId: "models",
            tags: ["items"],
            servers: [{ url: regionalServer }],
            responses: ok,
          },
        },
      },
    });
    // Two document servers declare the region with different defaults, and the first has no URL.
    // An operation's server that omits the declaration takes the first document server's, as the
    // app's router does, even though that server's empty URL is never called.
    const layeredServer = `http://{region}.synthetic-service.localhost:${new URL(origin).port}/layered`;
    const layered = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic layered", version: "1" },
      servers: [
        { url: "", variables: { region: { default: "api" } } },
        { url: layeredServer, variables: { region: { default: "uploads" } } },
      ],
      paths: {
        "/items": {
          get: {
            operationId: "list",
            tags: ["items"],
            servers: [{ url: layeredServer }],
            responses: ok,
          },
        },
      },
    });
    // No server declares the variable, so no host can be named.
    const unresolved = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic unresolved", version: "1" },
      servers: [{ url: "https://{tenant}.unresolved.example.com/api" }],
      paths: { "/items": { get: { operationId: "list", tags: ["items"], responses: ok } } },
    });
    // Like a vendor specification fetched from its schema URL: no server at any level, and the
    // integration names no base URL, so v1 sent the bare path and reached no API.
    const serverless = JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Synthetic serverless", version: "1" },
      paths: { "/api/items/": { get: { operationId: "list", tags: ["items"], responses: ok } } },
    });
    // A relative server names no host either.
    const relative = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic relative", version: "1" },
      servers: [{ url: "/" }],
      paths: { "/api/items/": { get: { operationId: "list", tags: ["items"], responses: ok } } },
    });
    const downgradedServer = {
      url: "{scheme}://uploads.downgraded.example.com/uploads",
      variables: { scheme: { default: "https" } },
    };
    const integrations: ReadonlyArray<{
      readonly slug: string;
      readonly name: string;
      readonly text: string;
      readonly template: ReadonlyArray<unknown>;
      readonly operations: Record<string, readonly [string, string]>;
      readonly servers?: Record<string, ReadonlyArray<unknown>>;
      readonly healthCheck?: unknown;
      readonly specUrl?: string;
    }> = [
      {
        slug: `requests_${suffix}`,
        name: "Requests",
        text: requests,
        template: [
          { slug: "", kind: "apikey", placements: [{ carrier: "header", name: "X-Api-Key" }] },
        ],
        operations: { "items.list": ["get", "/items"], "items.ping": ["get", "/ping"] },
      },
      {
        slug: `status_${suffix}`,
        name: "Status",
        text: status,
        template: [],
        operations: { "status.health": ["get", "/health"] },
      },
      {
        slug: `split_${suffix}`,
        name: "Split",
        text: split,
        template: [
          { slug: "", kind: "apikey", placements: [{ carrier: "header", name: "X-Api-Key" }] },
        ],
        operations: { "split.a": ["get", "/a"], "split.b": ["get", "/b"] },
      },
      {
        slug: `google_${suffix}`,
        name: "Google APIs",
        text: google,
        template: [],
        operations: {
          "messages.list": ["get", "/gmail/v1/users/me/messages"],
          "sheets.get": ["get", "/v4/spreadsheets"],
        },
      },
      {
        slug: `uploads_${suffix}`,
        name: "Uploads",
        text: uploads,
        template: [
          { slug: "", kind: "apikey", placements: [{ carrier: "header", name: "X-Api-Key" }] },
        ],
        operations: { "repos.get": ["get", "/repos"], "assets.upload": ["get", "/assets"] },
      },
      {
        slug: `mixed_${suffix}`,
        name: "Mixed",
        text: mixed,
        template: [
          { slug: "", kind: "apikey", placements: [{ carrier: "header", name: "X-Api-Key" }] },
        ],
        operations: { "repos.get": ["get", "/repos"], "assets.upload": ["get", "/assets"] },
      },
      {
        slug: `downgraded_${suffix}`,
        name: "Downgraded",
        text: downgraded,
        template: [
          { slug: "", kind: "apikey", placements: [{ carrier: "header", name: "X-Api-Key" }] },
        ],
        operations: { "repos.get": ["get", "/repos"], "assets.upload": ["get", "/assets"] },
        servers: { "assets.upload": [downgradedServer] },
        healthCheck: {
          operation: "assets.upload",
          args: { server: { url: downgradedServer.url, variables: { scheme: "http" } } },
        },
      },
      {
        slug: `regional_${suffix}`,
        name: "Regional",
        text: regional,
        template: [
          { slug: "", kind: "apikey", placements: [{ carrier: "header", name: "X-Api-Key" }] },
        ],
        operations: { "items.list": ["get", "/items"], "items.models": ["get", "/models"] },
      },
      {
        slug: `layered_${suffix}`,
        name: "Layered",
        text: layered,
        template: [
          { slug: "", kind: "apikey", placements: [{ carrier: "header", name: "X-Api-Key" }] },
        ],
        operations: { "items.list": ["get", "/items"] },
      },
      {
        slug: `unresolved_${suffix}`,
        name: "Unresolved",
        text: unresolved,
        template: [],
        operations: { "items.list": ["get", "/items"] },
      },
      {
        slug: `serverless_${suffix}`,
        name: "Serverless",
        text: serverless,
        template: [
          { slug: "", kind: "apikey", placements: [{ carrier: "header", name: "X-Api-Key" }] },
        ],
        operations: { "items.list": ["get", "/api/items/"] },
        // A schema URL can carry a key in its host, path or query, so the reason never names it.
        specUrl:
          "https://synthetic-host-secret.app.serverless.example.com/api/synthetic-path-secret/schema/?token=synthetic-schema-token",
      },
      {
        slug: `relative_${suffix}`,
        name: "Relative",
        text: relative,
        template: [],
        operations: { "items.list": ["get", "/api/items/"] },
        specUrl: "https://app.relative.example.com/api/schema/",
      },
    ];
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic requests workspace",
        slug,
      ),
      ...integrations.flatMap((integration) => {
        const hash = createHash("sha256").update(integration.text).digest("hex");
        return [
          row(
            "insert into integration (tenant, slug, plugin_id, name, config, health_check) values ($1, $2, 'openapi', $3, $4::json, nullif($5, '')::json)",
            organization,
            integration.slug,
            integration.name,
            JSON.stringify({
              specHash: hash,
              ...(integration.specUrl === undefined ? {} : { specUrl: integration.specUrl }),
              authenticationTemplate: integration.template,
            }),
            integration.healthCheck === undefined ? "" : JSON.stringify(integration.healthCheck),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${hash}`,
            integration.text,
          ),
          ...Object.entries(integration.operations).map(([tool, [method, path]]) =>
            row(
              "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
              organization,
              `op.${integration.slug}.${tool}`,
              JSON.stringify({
                integration: integration.slug,
                toolName: tool,
                binding: {
                  method,
                  pathTemplate: path,
                  ...(integration.servers?.[tool] === undefined
                    ? {}
                    : { servers: integration.servers[tool], parameters: [] }),
                },
              }),
            ),
          ),
        ];
      }),
      // v1 accepted a method without a slug.
      ...[
        [`requests_${suffix}`, keyItem],
        [`uploads_${suffix}`, uploadsKeyItem],
        [`mixed_${suffix}`, mixedKeyItem],
        [`split_${suffix}`, splitKeyItem],
        [`downgraded_${suffix}`, downgradedKeyItem],
        [`regional_${suffix}`, regionalKeyItem],
        [`layered_${suffix}`, layeredKeyItem],
      ].map(([integration, item]) =>
        row(
          "insert into connection (tenant, owner, subject, integration, name, template, item_ids) values ($1, 'user', $2, $3, 'main', '', $4::json)",
          organization,
          user,
          integration ?? "",
          JSON.stringify({ token: item }),
        ),
      ),
    ]);
  });

/** A workspace with only a public API, which imports completely. */
const seedPublic = (organization: string, slug: string, origin: string) =>
  Effect.gen(function* () {
    const text = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic status", version: "1" },
      servers: [{ url: `${origin}/public` }],
      paths: {
        "/health": {
          get: {
            operationId: "health",
            tags: ["status"],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const hash = createHash("sha256").update(text).digest("hex");
    const integration = `status_${randomUUID().slice(0, 6)}`;
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic complete workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Status', $3::json)",
        organization,
        integration,
        JSON.stringify({ specHash: hash, authenticationTemplate: [] }),
      ),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${hash}`,
        text,
      ),
      row(
        "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
        organization,
        `op.${integration}.status.health`,
        JSON.stringify({
          integration,
          toolName: "status.health",
          binding: { method: "get", pathTemplate: "/health" },
        }),
      ),
    ]);
  });

/**
 * A synthetic OAuth service: two token endpoints, as two v1 clients named, that renew any refresh
 * token, and an API (`GET /api/me`) that answers only the renewed access token. It records each
 * token request's path, client authentication and form, and each API request's authorization.
 * Behind a gateway (`GET /gated/me`), it records the token and the gateway's and client's
 * credential headers each request brought.
 */
const oauthService = Effect.gen(function* () {
  const renewedToken = "synthetic-renewed-access-token";
  const tokens = yield* Ref.make<
    ReadonlyArray<{ path: string; authorization: string | undefined; form: URLSearchParams }>
  >([]);
  const calls = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
  const gated = yield* Ref.make<ReadonlyArray<Readonly<Record<string, string | undefined>>>>([]);
  const token = Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const form = new URLSearchParams(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
    yield* Ref.update(tokens, (all) => [
      ...all,
      {
        path: new URL(request.url, "http://service").pathname,
        authorization: request.headers.authorization,
        form,
      },
    ]);
    return yield* HttpServerResponse.json({
      access_token: renewedToken,
      token_type: "Bearer",
      expires_in: 3600,
    });
  });
  const routes = Layer.mergeAll(
    HttpRouter.add("POST", "/token", token),
    HttpRouter.add("POST", "/other/token", token),
    HttpRouter.add(
      "GET",
      "/api/me",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Ref.update(calls, (all) => [...all, request.headers.authorization]);
        return request.headers.authorization === `Bearer ${renewedToken}`
          ? yield* HttpServerResponse.json({ email: "mail-member@example.test" })
          : yield* HttpServerResponse.json({ error: "unauthenticated" }, { status: 401 });
      }),
    ),
    HttpRouter.add(
      "GET",
      "/gated/me",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        yield* Ref.update(gated, (all) => [
          ...all,
          Object.fromEntries(
            [
              "authorization",
              "cf-access-client-id",
              "cf-access-client-secret",
              "client_id",
              "client_secret",
            ].map((name) => [name, request.headers[name]] as const),
          ),
        ]);
        return yield* HttpServerResponse.json({ email: "gated-member@example.test" });
      }),
    ),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    renewedToken,
    tokens: Ref.get(tokens),
    calls: Ref.get(calls),
    gated: Ref.get(gated),
  };
});

/** A request's query or form, as the ordered parameters a server reads. */
type Parameters = ReadonlyArray<readonly [string, string]>;

/**
 * A synthetic authorization server at any path. `GET …/authorize` records the parameters the
 * browser brought and returns to their `redirect_uri` with a code; `POST …/token` records the form
 * and issues a token.
 */
const signInService = Effect.gen(function* () {
  const authorizations = yield* Ref.make<ReadonlyArray<{ path: string; query: Parameters }>>([]);
  const tokens = yield* Ref.make<ReadonlyArray<{ path: string; form: Parameters }>>([]);
  const routes = HttpRouter.add(
    "*",
    "/*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = new URL(request.url, "http://sign-in");
      if (request.method === "GET" && url.pathname.endsWith("/authorize")) {
        yield* Ref.update(authorizations, (all) => [
          ...all,
          { path: url.pathname, query: [...url.searchParams] },
        ]);
        const callback = URL.parse(url.searchParams.get("redirect_uri") ?? "");
        if (callback === null) return HttpServerResponse.empty({ status: 400 });
        callback.searchParams.set("code", "synthetic-code");
        callback.searchParams.set("state", url.searchParams.get("state") ?? "");
        return HttpServerResponse.redirect(callback.href, { status: 302 });
      }
      if (request.method === "POST" && url.pathname.endsWith("/token")) {
        const form = new URLSearchParams(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
        yield* Ref.update(tokens, (all) => [...all, { path: url.pathname, form: [...form] }]);
        return yield* HttpServerResponse.json({
          access_token: "synthetic-reconnected-access",
          refresh_token: "synthetic-reconnected-refresh",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return HttpServerResponse.empty({ status: 404 });
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
    ),
  );
  const server = yield* HttpServer.HttpServer.pipe(Effect.provideContext(services));
  if (!("port" in server.address)) return yield* Effect.die("Fixture must listen on TCP");
  return {
    origin: `http://127.0.0.1:${server.address.port}`,
    authorizations: Ref.get(authorizations),
    tokens: Ref.get(tokens),
  };
});

/** Each parameter by name, and how many times the request named each one. */
const parameterRecord = (parameters: Parameters) => ({
  values: Object.fromEntries(parameters),
  names: parameters.map(([name]) => name).toSorted(),
});

/**
 * An OpenAPI integration whose OAuth method, like v1's Outlook preset, declares no authorization
 * URL, endpoints and scopes no client uses, and a second method under the same slug. Each connection signed in through its own v1 client:
 * `renewed` through a confidential client with a resource, with granted scopes and an expired
 * token; `second` through a public client at other endpoints; `untrusted` recorded a token
 * endpoint v1 no longer trusted.
 *
 * Two more OAuth APIs send fixed credentials beside the token. `Gated mail` sits behind a
 * gateway that takes its own client ID and secret, which v2 keeps in a second account. `Pasted
 * mail` sends its OAuth client's own ID and secret as headers, which its sign-in already sends.
 */
const seedRenewal = (
  organization: string,
  user: string,
  slug: string,
  origin: string,
  // Another organization's seed gives the same integrations and OAuth clients the same names.
  suffix = randomUUID().slice(0, 6),
) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const mail = `mail_${suffix}`;
    const userScope = `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;
    const orgScope = `executor/org/${encodeURIComponent(organization)}`;
    const access = (name: string) => `oauth:user:${mail}:${name}`;
    const refresh = (name: string) => `${access(name)}:refresh`;
    const secret = `oauth-client:org:${mail}-confidential:secret`;
    for (const name of ["renewed", "second", "untrusted"]) {
      yield* emulators.v1VaultObject(
        vaultName(userScope, access(name)),
        `synthetic-${name}-access`,
      );
      yield* emulators.v1VaultObject(
        vaultName(userScope, refresh(name)),
        `synthetic-${name}-refresh`,
      );
    }
    yield* emulators.v1VaultObject(vaultName(orgScope, secret), "synthetic-confidential-secret");
    const gated = `gated_${suffix}`;
    const pasted = `pasted_${suffix}`;
    const pastedSecret = `oauth-client:org:${pasted}:secret`;
    yield* emulators.v1VaultObject(vaultName(userScope, access("gated")), "synthetic-gated-access");
    yield* emulators.v1VaultObject(
      vaultName(userScope, access("pasted")),
      "synthetic-pasted-access",
    );
    yield* emulators.v1VaultObject(
      vaultName(orgScope, pastedSecret),
      "synthetic-pasted-secret-0123456789",
    );
    const document = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic mail", version: "1" },
      servers: [{ url: `${origin}/api` }],
      paths: {
        "/me": {
          get: { operationId: "me", tags: ["mail"], responses: { "200": { description: "ok" } } },
        },
      },
    });
    const hash = createHash("sha256").update(document).digest("hex");
    const gatedDocument = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "Synthetic gated mail", version: "1" },
      servers: [{ url: `${origin}/gated` }],
      paths: {
        "/me": {
          get: { operationId: "me", tags: ["mail"], responses: { "200": { description: "ok" } } },
        },
      },
    });
    const gatedHash = createHash("sha256").update(gatedDocument).digest("hex");
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    /** An OAuth API behind the gated document, whose configuration sends fixed headers. */
    const fixedApi = (slug: string, name: string, headers: Record<string, string>) => [
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', $3, $4::json)",
        organization,
        slug,
        name,
        JSON.stringify({
          specHash: gatedHash,
          headers,
          authenticationTemplate: [
            { slug: "oauth2", kind: "oauth2", authorizationUrl: "", tokenUrl: "", scopes: [] },
          ],
        }),
      ),
      row(
        "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
        organization,
        `op.${slug}.mail.me`,
        JSON.stringify({
          integration: slug,
          toolName: "mail.me",
          binding: { method: "get", pathTemplate: "/me" },
        }),
      ),
    ];
    const client = (
      name: string,
      authorize: string,
      token: string,
      resource: string | null,
      secretItem: string | null,
    ) =>
      row(
        "insert into oauth_client (tenant, owner, subject, slug, authorization_url, token_url, \"grant\", client_id, client_secret_item_id, token_endpoint_auth_method, resource, origin_kind) values ($1, 'org', '', $2, $3, $4, 'authorization_code', $5, nullif($6, ''), 'basic', nullif($7, ''), 'manual')",
        organization,
        `${mail}-${name}`,
        authorize,
        token,
        `synthetic-${name}-client`,
        secretItem ?? "",
        resource ?? "",
      );
    const connection = (
      name: string,
      clientName: string,
      expiresAt: number,
      scope: string | null,
      tokenUrl: string | null,
    ) =>
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner, refresh_item_id, expires_at, oauth_scope, oauth_token_url) values ($1, 'user', $2, $3, $4, 'oauth2', $5::json, $6, 'org', $7, $8::bigint, nullif($9, ''), nullif($10, ''))",
        organization,
        user,
        mail,
        name,
        JSON.stringify({ token: access(name) }),
        `${mail}-${clientName}`,
        refresh(name),
        String(expiresAt),
        scope ?? "",
        tokenUrl ?? "",
      );
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic mail workspace",
        slug,
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', 'Mail', $3::json)",
        organization,
        mail,
        JSON.stringify({
          specHash: hash,
          authenticationTemplate: [
            {
              slug: "oauth2",
              kind: "oauth2",
              authorizationUrl: "",
              tokenUrl: "https://method.example.com/token",
              scopes: ["method.scope"],
            },
            // A specification with both OAuth flows gave v1 two methods under one slug; v1 used
            // the first.
            { slug: "oauth2", kind: "oauth2", authorizationUrl: "", tokenUrl: "", scopes: [] },
          ],
        }),
      ),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${hash}`,
        document,
      ),
      row(
        "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
        organization,
        `op.${mail}.mail.me`,
        JSON.stringify({
          integration: mail,
          toolName: "mail.me",
          binding: { method: "get", pathTemplate: "/me" },
        }),
      ),
      client("confidential", `${origin}/authorize`, `${origin}/token`, `${origin}/api`, secret),
      client("public", `${origin}/other/authorize`, `${origin}/other/token`, null, null),
      // Expired, so the first call renews it.
      connection(
        "renewed",
        "confidential",
        Date.now() - 60_000,
        "mail.read  offline_access",
        `${origin}/token`,
      ),
      connection("second", "public", Date.now() + 3_600_000, null, null),
      row(
        "insert into blob (namespace, key, value) values ($1, $2, $3)",
        `o:${organization}/openapi`,
        `spec/${gatedHash}`,
        gatedDocument,
      ),
      ...fixedApi(gated, "Gated mail", {
        "CF-Access-Client-Id": "synthetic0gateway1client2id.access",
        "CF-Access-Client-Secret": "synthetic-gateway-secret-0123456789",
      }),
      ...fixedApi(pasted, "Pasted mail", {
        CLIENT_ID: "synthetic-pasted-client-0123456789",
        CLIENT_SECRET: "synthetic-pasted-secret-0123456789",
      }),
      row(
        "insert into oauth_client (tenant, owner, subject, slug, authorization_url, token_url, \"grant\", client_id, client_secret_item_id, token_endpoint_auth_method, resource, origin_kind) values ($1, 'org', '', $2, $3, $4, 'authorization_code', $5, $6, 'body', null, 'manual')",
        organization,
        pasted,
        `${origin}/authorize`,
        `${origin}/token`,
        "synthetic-pasted-client-0123456789",
        pastedSecret,
      ),
      ...[
        [gated, "gated", `${mail}-public`],
        [pasted, "pasted", pasted],
      ].map(([integration, name, oauthClient]) =>
        row(
          "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner, expires_at) values ($1, 'user', $2, $3, $4, 'oauth2', $5::json, $6, 'org', $7::bigint)",
          organization,
          user,
          integration ?? "",
          name ?? "",
          JSON.stringify({ token: access(name ?? "") }),
          oauthClient ?? "",
          String(Date.now() + 3_600_000),
        ),
      ),
      connection(
        "untrusted",
        "confidential",
        Date.now() + 3_600_000,
        null,
        "https://elsewhere.example.com/token",
      ),
    ]);
  });

/**
 * The loopback service behind the clients v1's first-party connections move to
 * (`v1FirstPartyClients`), on the port this Cloud's operator settings name. Each client's token
 * endpoint renews any refresh token, Slack's under `authed_user` with its scopes comma-separated.
 * Each API answers only its client's renewed access token: Google's and GitHub's OpenAPI
 * operations, Slack's MCP server, and an MCP server shaped as GitHub's, which names the GitHub
 * client's endpoints under its own issuer path and advertises scopes the client does not allow.
 * Each MCP server challenges any other request with its resource metadata, on whichever host the
 * request named. The two GitHub-shaped clients that send tokens to `v1GitHubHosts` each have an
 * API and an upload path. It records each token request's client, path and form, and each API
 * request's host, path and authorization.
 */
const firstPartyService = (port: number) =>
  Effect.gen(function* () {
    const origin = `http://127.0.0.1:${port}`;
    const renewed = (client: string) => `synthetic-renewed-${client}-token`;
    const tokens = yield* Ref.make<ReadonlyArray<{ path: string; form: URLSearchParams }>>([]);
    const calls = yield* Ref.make<
      ReadonlyArray<{ host?: string; path: string; authorization?: string }>
    >([]);
    const recordCall = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, origin).pathname;
      const { authorization, host } = request.headers;
      yield* Ref.update(calls, (all) => [
        ...all,
        {
          ...(host === undefined ? {} : { host }),
          path,
          ...(authorization === undefined ? {} : { authorization }),
        },
      ]);
      return authorization;
    });
    type Client = "google" | "github" | "slack" | "github-both" | "github-api";
    const token = (client: Client) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const form = new URLSearchParams(yield* request.text.pipe(Effect.orElseSucceed(() => "")));
        yield* Ref.update(tokens, (all) => [...all, { path: `/${client}/token`, form }]);
        const issued = { access_token: renewed(client), token_type: "Bearer", expires_in: 3600 };
        return yield* HttpServerResponse.json(
          client === "slack"
            ? {
                ok: true,
                authed_user: {
                  ...issued,
                  refresh_token: "synthetic-rotated-slack-refresh",
                  scope: v1SlackScopes.join(","),
                },
              }
            : client === "google"
              ? { ...issued, scope: form.get("scope") ?? "" }
              : issued,
        );
      });
    /** An API that answers `accepted`, by default its client's renewed access token. */
    const api = (client: Exclude<Client, "slack">, body: object, accepted = renewed(client)) =>
      Effect.gen(function* () {
        const authorization = yield* recordCall;
        return authorization === `Bearer ${accepted}`
          ? yield* HttpServerResponse.json(body)
          : yield* HttpServerResponse.json({ error: "unauthenticated" }, { status: 401 });
      });
    /** This service's origin under the host the request named. */
    const requested = Effect.map(
      HttpServerRequest.HttpServerRequest,
      (request) => `http://${request.headers.host ?? new URL(origin).host}`,
    );
    const challenge = (client: "slack" | "github") =>
      Effect.map(requested, (at) =>
        HttpServerResponse.empty({
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${at}/.well-known/oauth-protected-resource/${client}/mcp"`,
          },
        }),
      );
    const mcp = (client: "slack" | "github") =>
      Effect.gen(function* () {
        const authorization = yield* recordCall;
        if (authorization !== `Bearer ${renewed(client)}`) return yield* challenge(client);
        const request = yield* HttpServerRequest.HttpServerRequest;
        const message = yield* request.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                id: Schema.optional(Schema.Union([Schema.Number, Schema.String])),
                method: Schema.String,
              }),
            ),
          ),
          Effect.orDie,
        );
        if (message.id === undefined) return HttpServerResponse.empty({ status: 202 });
        const result =
          message.method === "initialize"
            ? {
                protocolVersion: "2025-03-26",
                capabilities: { tools: {} },
                serverInfo: { name: `synthetic-${client}-mcp`, version: "1" },
              }
            : message.method === "tools/list"
              ? {
                  tools: [
                    {
                      name: "whoami",
                      description: "The signed-in user.",
                      inputSchema: { type: "object", properties: {} },
                      annotations: { readOnlyHint: true },
                    },
                  ],
                }
              : message.method === "tools/call"
                ? { content: [{ type: "text", text: `synthetic-${client}-member` }] }
                : undefined;
        return yield* HttpServerResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          ...(result === undefined
            ? { error: { code: -32601, message: "Method not found" } }
            : { result }),
        });
      });
    const mcpGet = (client: "slack" | "github") =>
      Effect.gen(function* () {
        const authorization = yield* recordCall;
        return authorization === `Bearer ${renewed(client)}`
          ? HttpServerResponse.empty({ status: 405 })
          : yield* challenge(client);
      });
    const routes = Layer.mergeAll(
      HttpRouter.add("POST", "/google/token", token("google")),
      HttpRouter.add("POST", "/github/token", token("github")),
      HttpRouter.add("POST", "/slack/token", token("slack")),
      // These accounts have not expired, so their APIs answer the access token v1 stored.
      ...(
        [
          ["github-both", "synthetic-both-access"],
          ["github-api", "synthetic-apionly-access"],
        ] as const
      ).flatMap(([client, accepted]) => [
        HttpRouter.add("POST", `/${client}/token`, token(client)),
        HttpRouter.add(
          "GET",
          `/${client}/api/user`,
          api(client, { login: "synthetic-member" }, accepted),
        ),
        HttpRouter.add(
          "GET",
          `/${client}/uploads/asset`,
          api(client, { uploaded: true }, accepted),
        ),
      ]),
      HttpRouter.add(
        "GET",
        "/google/api/me",
        api("google", { email: "google-member@example.test" }),
      ),
      HttpRouter.add("GET", "/github/api/user", api("github", { login: "synthetic-member" })),
      HttpRouter.add("POST", "/slack/mcp", mcp("slack")),
      HttpRouter.add("GET", "/slack/mcp", mcpGet("slack")),
      HttpRouter.add("POST", "/github/mcp", mcp("github")),
      HttpRouter.add("GET", "/github/mcp", mcpGet("github")),
      // GitHub's MCP server at a sibling path, whose challenge still names the metadata of the
      // resource at `/github/mcp`, which a sign-in here cannot use.
      HttpRouter.add("POST", "/github/mcp-moved", mcp("github")),
      HttpRouter.add("GET", "/github/mcp-moved", mcpGet("github")),
      // As GitHub's MCP server: its authorization server is the GitHub client's, under an issuer
      // path (GitHub's is `https://github.com/login/oauth`), and it advertises scopes a GitHub App,
      // which has none, never asks for.
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource/github/mcp",
        Effect.map(requested, (at) =>
          HttpServerResponse.jsonUnsafe({
            resource: `${at}/github/mcp`,
            authorization_servers: [`${origin}/github/login/oauth`],
            scopes_supported: ["repo", "read:org", "gist"],
            bearer_methods_supported: ["header"],
          }),
        ),
      ),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-authorization-server/github/login/oauth",
        HttpServerResponse.json({
          issuer: `${origin}/github/login/oauth`,
          authorization_endpoint: `${origin}/github/authorize`,
          token_endpoint: `${origin}/github/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["offline_access"],
        }),
      ),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-protected-resource/slack/mcp",
        HttpServerResponse.json({
          resource: `${origin}/slack/mcp`,
          authorization_servers: [origin],
          scopes_supported: [...v1SlackScopes, "admin"],
        }),
      ),
      HttpRouter.add(
        "GET",
        "/.well-known/oauth-authorization-server",
        HttpServerResponse.json({
          issuer: origin,
          authorization_endpoint: `${origin}/slack/authorize`,
          token_endpoint: `${origin}/slack/token`,
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["client_secret_post"],
          scopes_supported: [...v1SlackScopes, "admin"],
        }),
      ),
    );
    yield* Layer.build(
      HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port })),
      ),
    );
    return { origin, renewed, tokens: Ref.get(tokens), calls: Ref.get(calls) };
  });

/**
 * A workspace whose connections signed in through Executor's own apps, as v1 stored them: no
 * `oauth_client` row, `first-party:<name>` in their `oauth_client`. Google's and GitHub's are
 * OpenAPI integrations whose methods declare endpoints and scopes the apps never used; Slack's and
 * `github-mcp`'s are MCP servers, the latter shaped as GitHub's, which v1 signed in with its GitHub
 * App. `google`, `github`, `slack` and `github-mcp` have expired, so they renew by their first
 * calls; the rest have not.
 * `beyond` was granted a scope the Google client does not allow, `elsewhere` and `mcp-elsewhere`
 * call a host the GitHub client's tokens never reach, and `notion` signed in through an app v2
 * does not offer. `wrong-server` signed in with the GitHub App to Slack's MCP server, whose
 * authorization server is not GitHub's, and `moved` to an MCP server whose resource metadata names
 * another resource, so neither sign-in can be carried over.
 * `both` and `apionly` use APIs on two hosts of one service, like GitHub's API and upload hosts:
 * `both`'s client sends its tokens to both, and `apionly`'s to the API host only.
 */
const seedFirstParty = (organization: string, user: string, slug: string, origin: string) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const suffix = randomUUID().slice(0, 6);
    const slugs = {
      google: `google_${suffix}`,
      github: `github_${suffix}`,
      elsewhere: `elsewhere_${suffix}`,
      slack: `slack_${suffix}`,
      both: `both_${suffix}`,
      apiOnly: `apionly_${suffix}`,
      githubMcp: `github_mcp_${suffix}`,
      mcpElsewhere: `mcp_elsewhere_${suffix}`,
      wrongServer: `wrong_server_${suffix}`,
      moved: `moved_${suffix}`,
    };
    const githubHosts = v1GitHubHosts(origin);
    const userScope = `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;
    const access = (integration: string, name: string) => `oauth:user:${integration}:${name}`;
    const connections = [
      {
        name: "google",
        integration: slugs.google,
        client: "v1-google",
        scope: "openid synthetic.read",
      },
      {
        name: "beyond",
        integration: slugs.google,
        client: "v1-google",
        scope: "openid synthetic.admin",
      },
      { name: "notion", integration: slugs.google, client: "notion", scope: "" },
      { name: "github", integration: slugs.github, client: "v1-github", scope: "" },
      { name: "elsewhere", integration: slugs.elsewhere, client: "v1-github", scope: "" },
      // Not expired, so no renewal of theirs, which a background job may also start, can
      // interleave with the others' renewals.
      { name: "both", integration: slugs.both, client: "v1-github-both", scope: "", live: true },
      {
        name: "apionly",
        integration: slugs.apiOnly,
        client: "v1-github-api",
        scope: "",
        live: true,
      },
      {
        name: "slack",
        integration: slugs.slack,
        client: "v1-slack",
        scope: v1SlackScopes.join(" "),
      },
      { name: "github-mcp", integration: slugs.githubMcp, client: "v1-github", scope: "" },
      { name: "mcp-elsewhere", integration: slugs.mcpElsewhere, client: "v1-github", scope: "" },
      { name: "wrong-server", integration: slugs.wrongServer, client: "v1-github", scope: "" },
      { name: "moved", integration: slugs.moved, client: "v1-github", scope: "" },
    ];
    for (const connection of connections) {
      const item = access(connection.integration, connection.name);
      yield* emulators.v1VaultObject(
        vaultName(userScope, item),
        `synthetic-${connection.name}-access`,
      );
      yield* emulators.v1VaultObject(
        vaultName(userScope, `${item}:refresh`),
        `synthetic-${connection.name}-refresh`,
      );
    }
    const document = (
      title: string,
      server: string,
      tag: string,
      path: string,
      id: string,
      upload?: string,
    ) =>
      JSON.stringify({
        openapi: "3.0.3",
        info: { title, version: "1" },
        servers: [{ url: server }],
        paths: {
          [path]: {
            get: { operationId: id, tags: [tag], responses: { "200": { description: "ok" } } },
          },
          // An operation on the service's upload host, as GitHub's release asset upload is.
          ...(upload === undefined
            ? {}
            : {
                "/asset": {
                  get: {
                    operationId: "asset",
                    tags: [tag],
                    servers: [{ url: upload }],
                    responses: { "200": { description: "ok" } },
                  },
                },
              }),
        },
      });
    // v1 asked GitHub's app for no scopes, whatever the method declared.
    const githubMethod = {
      authorizationUrl: "https://github.example.com/login/oauth/authorize",
      tokenUrl: "https://github.example.com/login/oauth/access_token",
      scopes: ["repo", "user"],
    };
    const apis = [
      {
        slug: slugs.google,
        name: "Synthetic Google",
        text: document("Synthetic Google", `${origin}/google/api`, "google", "/me", "me"),
        operations: [{ tool: "google.me", path: "/me" }],
        // The endpoints and scopes of v1's catalog method, which its own app replaced.
        method: {
          authorizationUrl: "https://accounts.example.com/o/oauth2/v2/auth",
          tokenUrl: "https://accounts.example.com/token",
          scopes: ["openid", "synthetic.read"],
        },
      },
      ...[
        { slug: slugs.github, name: "Synthetic GitHub", server: `${origin}/github/api` },
        {
          slug: slugs.elsewhere,
          name: "GitHub elsewhere",
          // The same service under another host name, which the client does not pin.
          server: `${origin.replace("127.0.0.1", "localhost")}/github/api`,
        },
      ].map((api) => ({
        slug: api.slug,
        name: api.name,
        text: document(api.name, api.server, "github", "/user", "user"),
        operations: [{ tool: "github.user", path: "/user" }],
        method: githubMethod,
      })),
      ...[
        { slug: slugs.both, name: "GitHub two hosts", client: "github-both" },
        { slug: slugs.apiOnly, name: "GitHub one host", client: "github-api" },
      ].map((api) => ({
        slug: api.slug,
        name: api.name,
        text: document(
          api.name,
          `http://${githubHosts.api}/${api.client}/api`,
          "github",
          "/user",
          "user",
          `http://${githubHosts.uploads}/${api.client}/uploads`,
        ),
        operations: [
          { tool: "github.user", path: "/user" },
          { tool: "github.asset", path: "/asset" },
        ],
        method: githubMethod,
      })),
    ];
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic first-party workspace",
        slug,
      ),
      ...apis.flatMap((api) => {
        const hash = createHash("sha256").update(api.text).digest("hex");
        return [
          row(
            "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', $3, $4::json)",
            organization,
            api.slug,
            api.name,
            JSON.stringify({
              specHash: hash,
              authenticationTemplate: [{ slug: "oauth2", kind: "oauth2", ...api.method }],
            }),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${hash}`,
            api.text,
          ),
          ...api.operations.map((operation) =>
            row(
              "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
              organization,
              `op.${api.slug}.${operation.tool}`,
              JSON.stringify({
                integration: api.slug,
                toolName: operation.tool,
                binding: { method: "get", pathTemplate: operation.path },
              }),
            ),
          ),
        ];
      }),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'mcp', 'Synthetic Slack', $3::json)",
        organization,
        slugs.slack,
        JSON.stringify({
          transport: "remote",
          endpoint: `${origin}/slack/mcp`,
          remoteTransport: "auto",
          authenticationTemplate: [{ slug: "oauth2", kind: "oauth2" }],
        }),
      ),
      row(
        "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, 'user', $2, $3, 'slack', 'mcp', 'whoami', $4::json)",
        organization,
        user,
        slugs.slack,
        JSON.stringify({ mcp: { toolName: "whoami" } }),
      ),
      // GitHub's MCP server, and the same server under another host name, which the GitHub
      // client does not pin.
      ...[
        {
          slug: slugs.githubMcp,
          name: "Synthetic GitHub MCP",
          connection: "github-mcp",
          endpoint: `${origin}/github/mcp`,
        },
        {
          slug: slugs.mcpElsewhere,
          name: "GitHub MCP elsewhere",
          connection: "mcp-elsewhere",
          endpoint: `${origin.replace("127.0.0.1", "localhost")}/github/mcp`,
        },
        {
          slug: slugs.wrongServer,
          name: "GitHub MCP on Slack's server",
          connection: "wrong-server",
          endpoint: `${origin}/slack/mcp`,
        },
        {
          slug: slugs.moved,
          name: "GitHub MCP moved",
          connection: "moved",
          endpoint: `${origin}/github/mcp-moved`,
        },
      ].flatMap((server) => [
        row(
          "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'mcp', $3, $4::json)",
          organization,
          server.slug,
          server.name,
          JSON.stringify({
            transport: "remote",
            endpoint: server.endpoint,
            remoteTransport: "auto",
            authenticationTemplate: [{ slug: "oauth2", kind: "oauth2" }],
          }),
        ),
        row(
          "insert into tool (tenant, owner, subject, integration, connection, plugin_id, name, annotations) values ($1, 'user', $2, $3, $4, 'mcp', 'whoami', $5::json)",
          organization,
          user,
          server.slug,
          server.connection,
          JSON.stringify({ mcp: { toolName: "whoami" } }),
        ),
      ]),
      ...connections.map((connection) => {
        const item = access(connection.integration, connection.name);
        return row(
          "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, refresh_item_id, expires_at, oauth_scope) values ($1, 'user', $2, $3, $4, 'oauth2', $5::json, $6, $7, $8::bigint, nullif($9, ''))",
          organization,
          user,
          connection.integration,
          connection.name,
          JSON.stringify({ token: item }),
          `first-party:${connection.client}`,
          `${item}:refresh`,
          // Expired, so the first call renews it, unless it is live for another day.
          String("live" in connection ? Date.now() + 86_400_000 : Date.now() - 60_000),
          connection.scope,
        );
      }),
    ]);
  });

/** Text with Latin-1, punctuation, symbols and an emoji: everything an API's prose uses. */
const wideText = "Returns the service’s “health” — café → ✅ or 🔴.";

/** A display name and base URL path beyond Latin-1, which a JavaScript string stores two bytes wide. */
const wideName = "Kanji 日本 API";
const widePath = "/public/日本";

/**
 * An 81-byte YAML specification whose `version` is indented deeper than its sibling `title`. Its
 * title holds a literal U+FFFD, which is valid UTF-8.
 */
const unreadableYaml = `openapi: 3.0.3
info:
  title: Synthetic \uFFFD unreadable
   version: "1"
paths: {}
`;

/** The API every synthetic Graph operation calls. */
const graphOrigin = "https://graph.example.invalid";

/**
 * Four Microsoft Graph presets as v1 added them, each with v1's rows for the operations it kept.
 * `Graph Mail` and `Graph Calendar` keep areas of one Graph-shaped document of about 15 MB, which
 * v1 stored once for both. `Graph Tasks` keeps an area of a small one whose first area's detail
 * schema, which that area's operations reach, is indented deeper than its sibling title. v1 never
 * stored a Graph preset's document as JSON, as `Graph Files`'s is.
 */
const seedGraph = (organization: string, slug: string) =>
  Effect.gen(function* () {
    const shared = graphDocument(graphOrigin, 2500);
    const small = graphDocument(graphOrigin, 2);
    const misindented = "       type: object";
    const broken = small.text.replace(
      "    synthetic.area0.detail:\n      title: detail\n",
      `    synthetic.area0.detail:\n      title: detail\n${misindented}\n`,
    );
    const presets = [
      {
        slug: "microsoft_mail",
        name: "Graph Mail",
        text: shared.text,
        areas: shared.areas.slice(0, 10),
      },
      {
        slug: "microsoft_calendar",
        name: "Graph Calendar",
        text: shared.text,
        areas: shared.areas.slice(10, 15),
      },
      {
        slug: "microsoft_tasks",
        name: "Graph Tasks",
        text: broken,
        areas: small.areas.slice(0, 1),
      },
      {
        slug: "microsoft_files",
        name: "Graph Files",
        text: JSON.stringify({
          openapi: "3.0.4",
          info: { title: "Graph", version: "1" },
          paths: {},
        }),
        areas: small.areas.slice(1),
      },
    ];
    const hash = (text: string) => createHash("sha256").update(text).digest("hex");
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic Graph workspace",
        slug,
      ),
      ...[...new Set(presets.map((preset) => preset.text))].map((text) =>
        row(
          "insert into blob (namespace, key, value) values ($1, $2, $3)",
          `o:${organization}/openapi`,
          `spec/${hash(text)}`,
          text,
        ),
      ),
      ...presets.flatMap((preset) => [
        row(
          "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', $3, $4::json)",
          organization,
          preset.slug,
          preset.name,
          JSON.stringify({
            specHash: hash(preset.text),
            specFormat: "microsoft-graph",
            family: "microsoft",
            sourceUrl: `${graphOrigin}/openapi.yaml#preset=${preset.slug}`,
            authenticationTemplate: [],
          }),
        ),
        ...preset.areas.flatMap((area) =>
          area.operations.map(([tool, method, path]) =>
            row(
              "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
              organization,
              `op.${preset.slug}.${tool}`,
              JSON.stringify({
                integration: preset.slug,
                toolName: tool,
                binding: { method, pathTemplate: path },
              }),
            ),
          ),
        ),
      ]),
    ]);
    return {
      presets,
      broken: {
        line: broken.split("\n").indexOf(misindented) + 1,
        bytes: new TextEncoder().encode(broken).length,
      },
    };
  });

/**
 * Four OpenAPI integrations and a GraphQL one. `Typography`'s document describes its one public
 * operation in `wideText`. `Kanji 日本 API` has a document as large as the largest imported vendor
 * API's, a base URL whose path goes beyond Latin-1 and an API key the user saved in v1. `Scoped`
 * signs in through a v1 client whose authorization URL sets `scope` itself, which v2's OAuth
 * declarations keep to the host. `Unreadable`'s stored specification is YAML no parser reads.
 * `Synthetic GraphQL` is shaped like a Linear GraphQL integration: an OAuth method that names no
 * endpoints and no scopes, so each connection signs in at its own client with the scopes that
 * client's authorization URL sets, and an API key sent bare in `Authorization`. `main`'s client asks
 * for comma-separated scopes, `tabbed`'s for a scope holding a tab, `blank`'s for an empty scope,
 * `doubled`'s for two scopes two spaces apart, `nonced`'s also sets `nonce`, `repeated`'s sets
 * `scope` twice and `targeted`'s sets a `resource` its client does not name; `key` holds the API
 * key. Every client signs in at `signIn`.
 */
const seedBuilds = (
  organization: string,
  user: string,
  slug: string,
  origin: string,
  signIn: string,
) =>
  Effect.gen(function* () {
    const emulators = yield* Emulators;
    const suffix = randomUUID().slice(0, 6);
    const typography = `typography_${suffix}`;
    const kanji = `kanji_${suffix}`;
    const scoped = `scoped_${suffix}`;
    const unreadable = `unreadable_${suffix}`;
    const graphql = `graphql_${suffix}`;
    const userScope = `executor/user/${encodeURIComponent(organization)}/${encodeURIComponent(user)}`;
    const key = `connection:user:${kanji}:main:token`;
    yield* emulators.v1VaultObject(vaultName(userScope, key), "synthetic-kanji-key");
    const access = `oauth:user:${scoped}:main`;
    yield* emulators.v1VaultObject(vaultName(userScope, access), "synthetic-scoped-access");
    yield* emulators.v1VaultObject(
      vaultName(userScope, `${access}:refresh`),
      "synthetic-scoped-refresh",
    );
    const graphqlAccess = `oauth:user:${graphql}:main`;
    const graphqlNonced = `oauth:user:${graphql}:nonced`;
    const graphqlKey = `connection:user:${graphql}:key:token`;
    for (const [item, value] of [
      [graphqlAccess, "synthetic-graphql-access"],
      [`${graphqlAccess}:refresh`, "synthetic-graphql-refresh"],
      [graphqlNonced, "synthetic-graphql-nonced-access"],
      [graphqlKey, "synthetic-graphql-key"],
      ...["tabbed", "repeated", "blank", "doubled", "targeted"].map(
        (name) => [`oauth:user:${graphql}:${name}`, `synthetic-graphql-${name}-access`] as const,
      ),
    ] as const)
      yield* emulators.v1VaultObject(vaultName(userScope, item), value);
    const document = (title: string, tag: string, path: string, description: string) =>
      JSON.stringify({
        openapi: "3.0.3",
        info: { title, version: "1" },
        servers: [{ url: `${origin}/public` }],
        paths: {
          [path]: {
            get: {
              operationId: "health",
              tags: [tag],
              description,
              responses: { "200": { description: "ok" } },
            },
          },
        },
      });
    const large = largeOpenapiDocument(origin, 1000, wideText);
    const integrations: ReadonlyArray<{
      readonly slug: string;
      readonly name: string;
      readonly text: string;
      readonly config: Readonly<Record<string, string>>;
      readonly template: ReadonlyArray<unknown>;
      /** Each v1 tool: its name, method and path. */
      readonly operations: ReadonlyArray<readonly [string, string, string]>;
    }> = [
      {
        slug: typography,
        name: "Typography",
        text: document("Synthetic typography", "typography", "/health", wideText),
        config: {},
        template: [],
        operations: [["typography.health", "get", "/health"]],
      },
      {
        slug: kanji,
        name: wideName,
        text: JSON.stringify(large),
        config: { baseUrl: `${origin}${widePath}` },
        template: [
          {
            slug: "apikey-0",
            kind: "apikey",
            placements: [{ carrier: "header", name: "X-Api-Key" }],
          },
        ],
        // v1 listed every operation, so the app keeps the whole document.
        operations: Object.entries(large.paths).flatMap(([path, item]) =>
          Object.entries(item).map(([method, operation]) => [
            path === "/health" ? "service.health" : `large.${String(operation.operationId)}`,
            method,
            path,
          ]),
        ),
      },
      {
        slug: scoped,
        name: "Scoped",
        text: document("Synthetic scoped", "scoped", "/me", "ok"),
        config: {},
        template: [
          {
            slug: "oauth2",
            kind: "oauth2",
            authorizationUrl: `${signIn}/authorize?scope=everything%20profile`,
            tokenUrl: `${signIn}/token`,
            scopes: [],
          },
        ],
        operations: [["scoped.health", "get", "/me"]],
      },
      {
        slug: unreadable,
        name: "Unreadable",
        text: unreadableYaml,
        config: {},
        template: [],
        operations: [["unreadable.health", "get", "/health"]],
      },
    ];
    const row = (sql: string, ...params: string[]): RowStatement => ({ sql, params });
    yield* writeRows("v1-database.json", [
      row(
        "insert into organizations (id, name, slug) values ($1, $2, $3)",
        organization,
        "Synthetic builds workspace",
        slug,
      ),
      ...integrations.flatMap((integration) => {
        const hash = createHash("sha256").update(integration.text).digest("hex");
        return [
          row(
            "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'openapi', $3, $4::json)",
            organization,
            integration.slug,
            integration.name,
            JSON.stringify({
              specHash: hash,
              ...integration.config,
              authenticationTemplate: integration.template,
            }),
          ),
          row(
            "insert into blob (namespace, key, value) values ($1, $2, $3)",
            `o:${organization}/openapi`,
            `spec/${hash}`,
            integration.text,
          ),
          ...integration.operations.map(([tool, method, path]) =>
            row(
              "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'openapi', 'operation', $2, $3::json)",
              organization,
              `op.${integration.slug}.${tool}`,
              JSON.stringify({
                integration: integration.slug,
                toolName: tool,
                binding: { method, pathTemplate: path },
              }),
            ),
          ),
        ];
      }),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids) values ($1, 'user', $2, $3, 'main', 'apikey-0', $4::json)",
        organization,
        user,
        kanji,
        JSON.stringify({ token: key }),
      ),
      row(
        "insert into oauth_client (tenant, owner, subject, slug, authorization_url, token_url, \"grant\", client_id, token_endpoint_auth_method, origin_kind) values ($1, 'org', '', $2, $3, $4, 'authorization_code', 'synthetic-scoped-client', 'basic', 'manual')",
        organization,
        `${scoped}-client`,
        `${signIn}/authorize?scope=everything%20profile`,
        `${signIn}/token`,
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner, refresh_item_id, expires_at) values ($1, 'user', $2, $3, 'main', 'oauth2', $4::json, $5, 'org', $6, $7::bigint)",
        organization,
        user,
        scoped,
        JSON.stringify({ token: access }),
        `${scoped}-client`,
        `${access}:refresh`,
        String(Date.now() + 3_600_000),
      ),
      row(
        "insert into integration (tenant, slug, plugin_id, name, config) values ($1, $2, 'graphql', $3, $4::json)",
        organization,
        graphql,
        "Synthetic GraphQL",
        JSON.stringify({
          endpoint: `${origin}/graphql`,
          name: "Synthetic GraphQL",
          authenticationTemplate: [
            { kind: "oauth2", slug: "oauth2" },
            {
              slug: "apiKey",
              kind: "apikey",
              label: "Synthetic API key",
              placements: [{ carrier: "header", name: "Authorization" }],
            },
          ],
        }),
      ),
      row(
        "insert into oauth_client (tenant, owner, subject, slug, authorization_url, token_url, \"grant\", client_id, origin_kind) values ($1, 'org', '', 'graphql-oauth', $2, $3, 'authorization_code', 'synthetic-graphql-client', 'manual')",
        organization,
        `${signIn}/oauth/authorize?scope=read,write`,
        `${signIn}/oauth/token`,
      ),
      row(
        "insert into oauth_client (tenant, owner, subject, slug, authorization_url, token_url, \"grant\", client_id, origin_kind) values ($1, 'user', $2, 'graphql-oauth', $3, $4, 'authorization_code', 'synthetic-graphql-nonced-client', 'manual')",
        organization,
        user,
        `${signIn}/oauth/authorize?scope=read&nonce=synthetic`,
        `${signIn}/oauth/token`,
      ),
      ...(
        [
          ["tabbed", "scope=read%09write"],
          ["repeated", "scope=read&scope=write"],
          ["blank", "scope="],
          ["doubled", "scope=read%20%20write"],
          ["targeted", `scope=read&resource=${encodeURIComponent(`${signIn}/graphql`)}`],
        ] as const
      ).flatMap(([name, query]) => [
        row(
          "insert into oauth_client (tenant, owner, subject, slug, authorization_url, token_url, \"grant\", client_id, origin_kind) values ($1, 'user', $2, $3, $4, $5, 'authorization_code', $6, 'manual')",
          organization,
          user,
          `graphql-${name}`,
          `${signIn}/oauth/authorize?${query}`,
          `${signIn}/oauth/token`,
          `synthetic-graphql-${name}-client`,
        ),
        row(
          "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner) values ($1, 'user', $2, $3, $4, 'oauth2', $5::json, $6, 'user')",
          organization,
          user,
          graphql,
          name,
          JSON.stringify({ token: `oauth:user:${graphql}:${name}` }),
          `graphql-${name}`,
        ),
      ]),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner, refresh_item_id, expires_at, oauth_scope) values ($1, 'user', $2, $3, 'main', 'oauth2', $4::json, 'graphql-oauth', 'org', $5, $6::bigint, 'read,write')",
        organization,
        user,
        graphql,
        JSON.stringify({ token: graphqlAccess }),
        `${graphqlAccess}:refresh`,
        String(Date.now() + 3_600_000),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner) values ($1, 'user', $2, $3, 'nonced', 'oauth2', $4::json, 'graphql-oauth', 'user')",
        organization,
        user,
        graphql,
        JSON.stringify({ token: graphqlNonced }),
      ),
      row(
        "insert into connection (tenant, owner, subject, integration, name, template, item_ids) values ($1, 'user', $2, $3, 'key', 'apiKey', $4::json)",
        organization,
        user,
        graphql,
        JSON.stringify({ token: graphqlKey }),
      ),
    ]);
  });

/** A workspace with one rule for a removed integration and one toolkit that grants nothing. */
const seedPlainWorkspace = (organization: string, slug: string) =>
  writeRows("v1-database.json", [
    {
      sql: "insert into organizations (id, name, slug) values ($1, $2, $3)",
      params: [organization, "Synthetic plain workspace", slug],
    },
    {
      sql: "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', 'removed_service.*', 'block')",
      params: [organization],
    },
    {
      sql: "insert into plugin_storage (tenant, plugin_id, collection, key, data) values ($1, 'toolkits', 'toolkits', 'tk_1', $2::json)",
      params: [organization, JSON.stringify({ id: "tk_1", name: "Support", slug: "support" })],
    },
  ]);

layer(TestLive, { excludeTestServices: true })("Cloud v1 import", (it) => {
  it.effect(scenarios.v1ImportRun.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        const slug = `v1-${randomUUID().slice(0, 8)}`;
        const seeded = yield* seedWorkspace(own.organization, own.user, slug);
        // v1 keeps its own metadata on the organization; an import does not change v1.
        yield* emulators.setV1OrganizationMetadata(own.organization, { v1_setting: "synthetic" });
        yield* googleSignIn(identity.email);

        const { report, target, items } = yield* importOnServer(own.organization);
        expect(target.slug).toBe(slug);
        // A sign-in v2 does not offer cannot move, so the organization does not convert;
        // everything else moved. v1 Cloud never ran a local MCP server, so it is skipped.
        expect(report.status).toBe("failed");
        expect(statuses(items, "integration", "Widgets")).toEqual(["imported"]);
        expect(statuses(items, "integration", "Tracker")).toEqual(["imported"]);
        expect(items.find((item) => item.label === "Local files")).toMatchObject({
          status: "skipped",
          reason: "Local (stdio) MCP servers do not run in Executor Cloud.",
        });
        expect(statuses(items, "connection", "main")).toEqual(["imported", "imported", "imported"]);
        expect(statuses(items, "connection", "signin")).toEqual(["imported"]);
        expect(statuses(items, "connection", "linear")).toEqual(["failed"]);
        expect(items.find((item) => item.label === "linear")?.reason).toContain("Executor's own");
        expect(statuses(items, "tool_policy", `${seeded.widgets}.*.*.widgets.remove`)).toEqual([
          "imported",
        ]);
        // A rule for a removed integration never applied in v1: nothing to import, not a failure.
        expect(items.find((item) => item.label === "removed_service.*")).toMatchObject({
          status: "skipped",
          reason: "Its integration no longer exists in v1.",
        });
        expect(items.find((item) => item.label === "Support")).toMatchObject({
          status: "imported",
          note: grantsNoConnection,
        });
        expect(items.find((item) => item.label === "Dashboard")).toMatchObject({
          status: "imported",
          needsRepair: true,
        });
        // The report holds no secret.
        for (const value of [
          "synthetic-user-key",
          "synthetic-workspace-key",
          "synthetic-access-token",
          "synthetic-refresh-token",
          "synthetic-client-secret",
          "synthetic-tracker-key",
        ])
          expect(JSON.stringify(report)).not.toContain(value);
        // Nothing is written to v1: no freeze, no moved notice.
        expect(yield* emulators.v1OrganizationMetadata(own.organization)).toEqual({
          v1_setting: "synthetic",
        });

        const inventory = yield* call(
          "Read the new organization",
          "GET",
          `/api/organizations/${target.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(Inventory, response)));
        // The member approved creating through their own `main` connection only, so each Widgets
        // connection is its own app (decision 33): the workspace's `main` says so beside the
        // member's.
        const appOf = (name: string) => inventory.apps.find((app) => app.name === name);
        expect(inventory.apps.map((app) => app.name)).toEqual(
          expect.arrayContaining([
            "Widgets (main)",
            "Widgets (main, workspace)",
            "Widgets (signin)",
            "Tracker",
          ]),
        );
        expect(appOf("Widgets")).toBeUndefined();
        // The personal connection keeps its name; the workspace's is suffixed. Team setup adds
        // the Executor app's own account beside them.
        expect(
          inventory.accounts
            .map((account) => account.label)
            .filter((label) => label !== "Your Executor access")
            .sort(),
        ).toEqual(["main", "main", "main (workspace)", "signin"]);
        // The member's own Widgets connections are linked for them to their app's many()
        // `service` requirement; the workspace's is linked for everyone to its app's `workspace`
        // requirement.
        for (const [name, scope, links] of [
          ["Widgets (main)", "user", [["service", "main"]]],
          ["Widgets (main)", "app", []],
          ["Widgets (signin)", "user", [["service", "signin"]]],
          ["Widgets (signin)", "app", []],
          ["Widgets (main, workspace)", "user", []],
          ["Widgets (main, workspace)", "app", [["workspace", "main (workspace)"]]],
        ] as const) {
          const listed = yield* call(
            `List ${name}'s ${scope} links`,
            "GET",
            `/api/organizations/${target.id}/apps/${appOf(name)?.id}/accounts/${scope}`,
          );
          expect(listed.status, JSON.stringify(listed.body)).toBe(200);
          expect(
            (yield* decode(Schema.Array(AccountLink), listed)).map((link) => [
              link.requirement,
              link.account.label,
            ]),
            `${name} ${scope}`,
          ).toEqual(links);
        }

        // Tools keep v1's names; the blocked one is left out of every app, and only the member's
        // `main` app creates without asking.
        for (const name of ["Widgets (main)", "Widgets (main, workspace)", "Widgets (signin)"]) {
          const widgetTools = yield* call(
            `List ${name}'s tools`,
            "GET",
            `/api/organizations/${target.id}/apps/${appOf(name)?.id}/tools`,
          );
          expect(widgetTools.status, JSON.stringify(widgetTools.body)).toBe(200);
          const tools = yield* decode(Tools, widgetTools);
          expect(tools.items.map((tool) => tool.name).sort(), name).toEqual([
            "widgets.create",
            "widgets.list",
          ]);
          const rules = (yield* appSource(target.id, appOf(name)?.id)).find(
            (file) => file.path === "tools.ts",
          )?.content;
          if (name === "Widgets (main)") expect(rules).toContain('"widgets.create": "never"');
          else expect(rules, name).not.toContain('"widgets.create": "never"');
        }
      }).pipe(Effect.provide(services)),
    ),
  );
  it.effect(scenarios.v1ImportChecks.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const upstream = yield* checkedApi;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        const seeded = yield* seedChecks(
          own.organization,
          own.user,
          `v1-${randomUUID().slice(0, 8)}`,
          upstream.origin,
        );
        yield* googleSignIn(identity.email);

        const { target, results } = yield* importOnServer(own.organization);
        // Rules v1 never applied have nothing to import; they are not failures.
        expect(results.get("executor.code.*")).toEqual({
          status: "skipped",
          reason: "It applies to v1's built-in tools, which v2 does not have.",
        });
        expect(results.get("Checked API")?.status, results.get("Checked API")?.reason).toBe(
          "imported",
        );
        expect(results.get("Fixed MCP")?.status, results.get("Fixed MCP")?.reason).toBe("imported");
        expect(results.get("Compiled API")?.status, results.get("Compiled API")?.reason).toBe(
          "imported",
        );
        // Two operations that share a template keep their own tools: the stored row is the first
        // one's, and the second keeps the tool v1 compiled for it.
        expect(results.get("Merged API")?.status, results.get("Merged API")?.reason).toBe(
          "imported",
        );
        for (const name of ["Referenced API", "Linked API"])
          expect(results.get(name)?.status, results.get(name)?.reason).toBe("imported");
        // v1 stored the Linked API's specification as its URL; the import fetched it once.
        expect(yield* upstream.specFetches).toBe(1);
        // A tool v1 listed that the document does not name fails the integration by name.
        expect(results.get("Unmatched API")).toMatchObject({
          status: "failed",
          reason: "v2 would not provide 1 of its v1 tools: items.archive.",
        });
        for (const name of [...Object.keys(keys), "fixed", "anonymous"])
          expect(results.get(name)?.status, results.get(name)?.reason).toBe("imported");
        // The tool v1 listed twice is imported once, under its lower snake case name.
        expect(results.get("Fixed MCP")?.note).toBe(
          "v1 listed a tool under two names; search_issues is now searchissues.",
        );
        expect(results.get("removed_service.*")).toEqual({
          status: "skipped",
          reason: "Its integration no longer exists in v1.",
        });
        expect(results.get("executor.code.*")?.status).toBe("skipped");
        // A rule that matches no tool v1 listed still moves, and says so.
        expect(results.get(`${seeded.api}.*.*.me.unlisted`)).toMatchObject({
          status: "imported",
          note: "It matches no tool v1 last listed for its integration.",
        });

        const inventory = yield* call(
          "Read the new organization",
          "GET",
          `/api/organizations/${target.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(Inventory, response)));
        const appId = (name: string) => inventory.apps.find((app) => app.name === name)?.id;
        const accountId = (label: string) =>
          inventory.accounts.find((account) => account.label === label)?.id;

        // The fixed credential is the MCP account's field; only the non-credential header stays in
        // the app's source.
        expect(accountId("fixed")).toBeDefined();
        // The connection without credentials is an account of the app's "No credentials" method.
        expect(accountId("anonymous")).toBeDefined();

        // Without stored operations, the tools v1 listed keep the names v1 compiled for them.
        const compiledApp = appId("Compiled API");
        expect(inventory.links.some((link) => link.app === compiledApp)).toBe(true);
        const compiledTools = yield* call(
          "List the compiled API's tools",
          "GET",
          `/api/organizations/${target.id}/apps/${compiledApp}/tools`,
        );
        expect(compiledTools.status, JSON.stringify(compiledTools.body)).toBe(200);
        expect((yield* decode(Tools, compiledTools)).items.map((tool) => tool.name).sort()).toEqual(
          compiledV1Names,
        );
        // Operations that are references, and the operations of a specification v1 stored as its
        // URL, keep v1's names.
        for (const [name, expected] of [
          ["Referenced API", Object.keys(referencedV1Names)],
          ["Linked API", ["profile.read"]],
        ] as const) {
          const listed = yield* call(
            `List the ${name}'s tools`,
            "GET",
            `/api/organizations/${target.id}/apps/${appId(name)}/tools`,
          );
          expect(listed.status, JSON.stringify(listed.body)).toBe(200);
          expect((yield* decode(Tools, listed)).items.map((tool) => tool.name).sort()).toEqual(
            expected,
          );
        }
        const source = yield* call(
          "Read the MCP app's deployed source",
          "GET",
          `/api/organizations/${target.id}/apps/${appId("Fixed MCP")}/source`,
        );
        expect(source.status, JSON.stringify(source.body)).toBe(200);
        const files = (yield* decode(Source, source)).files;
        const written = JSON.stringify(files);
        expect(written).not.toContain(fixedSecret);
        expect(written).toContain("X-Client");
        expect(files.find((file) => file.path === "provider.ts")?.content).toContain(
          '"fixed header Authorization"',
        );

        // v1's check: its request and identity field for a working key, Google's disabled-API 403
        // as a missing permission rather than a refused sign-in, a refused key, and a redirect, which
        // fails the check without sending the key on to the plain HTTP page it names.
        const check = (label: string) =>
          call(
            `Check the ${label} account`,
            "POST",
            `/api/organizations/${target.id}/accounts/${accountId(label)}/health`,
          ).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
            ),
            Effect.flatMap((response) => decode(Health, response)),
          );
        const checked = appId("Checked API");
        const verdict = (health: typeof Health.Type) =>
          health.apps.find((app) => app.app === checked);
        const good = yield* check("good");
        expect(verdict(good)).toMatchObject({ checkable: true, check: { status: "healthy" } });
        expect(good.info?.email).toBe(checkedEmail);
        expect(verdict(yield* check("disabled"))?.check?.status).toBe("forbidden");
        expect(verdict(yield* check("revoked"))?.check?.status).toBe("credentials_rejected");
        expect(verdict(yield* check("redirected"))?.check).toMatchObject({
          status: "check_failed",
          message:
            "The service redirected the check (HTTP 302); an account's credentials never follow a redirect.",
        });
        expect(yield* upstream.received).toEqual(
          [keys.good, keys.disabled, keys.revoked, keys.redirected].map((key) => ({
            path: "/v1/me?fields=email",
            key,
          })),
        );
        expect(yield* upstream.landed).toEqual([]);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportToolkits.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        const seeded = yield* seedToolkits(
          own.organization,
          own.user,
          `v1-${randomUUID().slice(0, 8)}`,
        );
        yield* googleSignIn(identity.email);

        const { target, results } = yield* importOnServer(own.organization);
        for (const name of ["Hosted", "Open", "main", "first", "second"])
          expect(results.get(name)?.status, results.get(name)?.reason).toBe("imported");

        // The personal toolkit: its granted tools and accounts, without the tool it blocked; the
        // tool the workspace blocks is not in the app, so the toolkit cannot select it.
        const support = results.get("Support");
        expect(support).toMatchObject({
          status: "imported",
          note: "1 tool v1 allowed only through this toolkit is blocked in the workspace, so it is left out: Hosted purge_items.",
        });
        expect(results.get("Shared")).toMatchObject({
          status: "imported",
          note: grantsNoConnection,
        });
        const inventory = yield* call(
          "Read the new organization",
          "GET",
          `/api/organizations/${target.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(Inventory, response)));
        const appId = (name: string) => inventory.apps.find((app) => app.name === name)?.id;
        const connections = yield* call(
          "List the scoped MCP connections",
          "GET",
          `/api/organizations/${target.id}/mcp-connections`,
        ).pipe(Effect.flatMap((response) => decode(Connections, response)));
        const scoped = connections.find((connection) => connection.id === support?.v2Id);
        expect(scoped?.name).toBe("Support");
        expect(scoped?.url).toContain(`connection=${support?.v2Id}`);
        expect([...(scoped?.policy.apps ?? [])].sort((a, b) => (a.app < b.app ? -1 : 1))).toEqual(
          [
            {
              app: appId("Hosted"),
              // The connection's result is the account it linked, which the grant targets.
              runsAs: [{ kind: "account", id: results.get("main")?.v2Id }],
              tools: { kind: "selected", names: ["create_item", "list_items"] },
            },
            {
              app: appId("Open"),
              runsAs: [{ kind: "app" }],
              tools: { kind: "selected", names: ["search"] },
            },
          ].sort((a, b) => ((a.app ?? "") < (b.app ?? "") ? -1 : 1)),
        );
        expect(
          connections.find((connection) => connection.id === results.get("Shared")?.v2Id)?.policy
            .apps,
        ).toEqual([]);

        // The toolkit asked before creating, so the app asks every caller.
        const source = yield* call(
          "Read the MCP app's deployed source",
          "GET",
          `/api/organizations/${target.id}/apps/${appId("Hosted")}/source`,
        ).pipe(Effect.flatMap((response) => decode(Source, response)));
        const rules = source.files.find((file) => file.path === "tools.ts")?.content ?? "";
        expect(rules).toContain('"create_item": "always"');
        expect(rules).not.toContain('"delete_item"');
        // The toolkit granted listing without a rule of its own, so v1 used the tool's default there;
        // the workspace's approval does not become `never`, and the app keeps the default.
        expect(rules).not.toContain('"list_items"');

        // Artifacts become apps with source and no version, and say what needs repair.
        const dashboard = results.get("Dashboard");
        expect(dashboard).toEqual({
          status: "imported",
          v2Id: expect.any(String),
          needsRepair: true,
          note: `${repairNote} Its calls map to ${seeded.hosted} → Hosted (main). other: Its integration no longer exists in v1.`,
        });
        expect(results.get("Legacy view")).toMatchObject({
          status: "imported",
          needsRepair: true,
          note: `${repairNote} Its calls map to ${seeded.open}.user.first → Open (first).`,
        });
        const apps = yield* call(
          "List the apps",
          "GET",
          `/api/organizations/${target.id}/apps`,
        ).pipe(Effect.flatMap((response) => decode(Apps, response)));
        expect(apps.find((app) => app.id === dashboard?.v2Id)).toMatchObject({
          name: "Dashboard",
          activeVersion: null,
        });
        // Its package files are not read here: managed local Cloud has no Git storage for app
        // source, and the v1 import runs only there.
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportMcpForward.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          fs = yield* FileSystem.FileSystem,
          target = yield* Target,
          mcp = yield* McpClient;
        const { secret } = yield* fs
          .readFileString(`${target.directory}/${v1McpForwardFile}`)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(V1McpForwardSecret))),
          );
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        const stranger = yield* emulators.v1Workspace([
          (yield* emulators.identity("google")).email,
        ]);
        const seeded = yield* seedWorkspace(
          own.organization,
          own.user,
          `v1-${randomUUID().slice(0, 8)}`,
        );
        // A toolkit over the user's Widgets account that blocks creating.
        const toolkitRow = (collection: string, data: Record<string, string>) =>
          ({
            sql: `insert into plugin_storage (tenant, owner, subject, plugin_id, collection, key, data) values ($1, 'user', $2, 'toolkits', $3, $4, $5::json)`,
            params: [own.organization, own.user, collection, data.id ?? "", JSON.stringify(data)],
          }) satisfies RowStatement;
        yield* writeRows("v1-database.json", [
          toolkitRow("toolkits", { id: "tk_forward", name: "Forwarded", slug: "forwarded" }),
          toolkitRow("toolkitConnections", {
            id: "tkconn_forward",
            toolkitId: "tk_forward",
            pattern: `${seeded.widgets}.user.main.*`,
            position: "a0",
          }),
          toolkitRow("toolkitPolicies", {
            id: "tkpol_forward",
            toolkitId: "tk_forward",
            pattern: `${seeded.widgets}.*.*.${seeded.v1Names.create}`,
            action: "block",
            position: "a0",
          }),
        ]);
        yield* googleSignIn(identity.email);

        const { report, target: imported, items } = yield* importOnServer(own.organization);
        // This workspace has an item that cannot move, so verification fails: the import does not
        // cut it over, and v1 keeps it frozen for a person to fix and restart or roll back.
        expect(items.some((item) => item.status === "failed")).toBe(true);
        expect(report.verification?.passed).toBe(false);
        expect(report.cutover).toBe(false);
        const flag = yield* writeRows("v1-database.json", [
          {
            sql: "select state from org_moved_to_v2 where org_id = $1",
            params: [own.organization],
          },
        ]);
        expect(flag).toEqual([[{ state: "moving" }]]);
        // v2 accepts what v1 forwards from the import map alone; v1 forwards only once moved.
        const forwarded = items.find(
          (item) => item.kind === "toolkit" && item.label === "Forwarded",
        );
        expect(forwarded?.status).toBe("imported");
        if (forwarded === undefined)
          return yield* Effect.die("The import has no Forwarded toolkit");
        // v1 names a toolkit by its row; the connection id it computes for the caller is the id of
        // the caller's own copy.
        const row = forwarded.id;
        const connection = v1ToolkitConnectionId(imported.id, row, own.user);
        expect(forwarded.v2Id).toBe(connection);

        /** A bearer as v1 signs it for one request; each is distinct and lives a few minutes. */
        let minted = 0;
        const sign = (claims: Partial<V1ForwardClaims> = {}, signedWith = secret) =>
          Redacted.make(
            v1ForwardBearer(signedWith, {
              account: own.user,
              organization: own.organization,
              exp: Math.floor(Date.now() / 1000) + 300 + minted++,
              ...claims,
            }),
          );
        const toolkit = { toolkit: row, connection };

        const run = (
          client: Effect.Success<ReturnType<McpClient["Service"]["connect"]>>,
          operation: string,
          code: string,
        ) =>
          client
            .use(operation, (client, signal) =>
              client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
            )
            .pipe(
              Effect.flatMap((result) =>
                Schema.decodeUnknownEffect(Execution)(result.structuredContent),
              ),
            );
        const Found = Schema.Struct({
          items: Schema.Array(Schema.Struct({ path: Schema.String })),
        });
        const search = (
          client: Effect.Success<ReturnType<McpClient["Service"]["connect"]>>,
          query: string,
        ) =>
          run(
            client,
            `Search for ${query}`,
            `return await tools.search({query: ${JSON.stringify(query)}, limit: 50})`,
          ).pipe(
            Effect.flatMap((done) => Schema.decodeUnknownEffect(Found)(done.execution.value)),
            Effect.map((found) => found.items.map((item) => item.path)),
          );

        // The account and organization alone reach every imported app, with a new bearer for each
        // request of the one session.
        const before = minted;
        const workspace = yield* mcp.connect(() => sign(), "forwarded-workspace");
        const listed = yield* workspace.use(
          "List the forwarded session's tools",
          (client, signal) => client.listTools(undefined, { signal }),
        );
        expect(listed.tools.map((tool) => tool.name)).toContain("execute");
        const everything = yield* search(workspace, "widgets");
        const has = (paths: readonly string[], name: string) =>
          paths.some((path) => path.endsWith(name));
        expect(has(everything, seeded.v1Names.list)).toBe(true);
        expect(has(everything, seeded.v1Names.create)).toBe(true);
        // Initialize, its notification, the listing and a search each signed their own bearer.
        expect(minted - before).toBeGreaterThanOrEqual(4);

        // A toolkit's bearer and URL reach only what the caller's copy of the toolkit grants.
        const scoped = yield* mcp.connect(() => sign(toolkit), "forwarded-toolkit", {
          connection,
        });
        const granted = yield* search(scoped, "widgets");
        // The listing tool, and not the tool the toolkit blocks.
        expect(granted).toHaveLength(1);
        expect(has(granted, seeded.v1Names.list)).toBe(true);
        expect(has(granted, seeded.v1Names.create)).toBe(false);

        /** The status of one initialize request carrying this bearer, at this URL query. */
        const initialize = (bearer: Redacted.Redacted<string>, query = "") =>
          Effect.scoped(
            Effect.gen(function* () {
              const http = yield* HttpClient.HttpClient;
              const request = HttpClientRequest.post(`${target.metadata.origin}/mcp${query}`).pipe(
                HttpClientRequest.setHeaders({
                  accept: "application/json, text/event-stream",
                  authorization: `Bearer ${Redacted.value(bearer)}`,
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
                    clientInfo: { name: "forwarded-refusal", version: "1" },
                  },
                }),
              );
              yield* response.text;
              return response.status;
            }),
          ).pipe(Effect.provide(FetchHttpClient.layer));
        const now = Math.floor(Date.now() / 1000);
        const toolkitQuery = `?connection=${connection}`;
        expect(yield* initialize(sign())).toBe(200);
        // v1 vouches for no one else, and a signature or lifetime v1 did not give is refused.
        expect(yield* initialize(sign({}, "x".repeat(64)))).toBe(401);
        expect(yield* initialize(sign({ exp: now - 10 }))).toBe(401);
        expect(yield* initialize(sign({ exp: now + 3_600 }))).toBe(401);
        expect(yield* initialize(sign({ toolkit: row }), toolkitQuery)).toBe(401);
        // A valid bearer for an account or organization the import never mapped.
        expect(yield* initialize(sign({ account: stranger.user }))).toBe(403);
        expect(yield* initialize(sign({ organization: stranger.organization }))).toBe(403);
        // A toolkit connection that is not the caller's copy: another member's, or another row's.
        const otherMember = v1ToolkitConnectionId(imported.id, row, stranger.user);
        expect(
          yield* initialize(
            sign({ toolkit: row, connection: otherMember }),
            `?connection=${otherMember}`,
          ),
        ).toBe(403);
        const otherRow = v1ToolkitConnectionId(imported.id, "tk_other", own.user);
        expect(
          yield* initialize(
            sign({ toolkit: "tk_other", connection: otherRow }),
            `?connection=${otherRow}`,
          ),
        ).toBe(403);
        expect(yield* initialize(sign(toolkit), toolkitQuery)).toBe(200);
      }).pipe(Effect.provide(Layer.mergeAll(services, McpClient.layer))),
    ),
  );

  it.effect(
    scenarios.v1ImportOptInToolkits.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const emulators = yield* Emulators,
            fs = yield* FileSystem.FileSystem,
            target = yield* Target,
            mcp = yield* McpClient;
          const upstream = yield* credentialUpstream;
          const { secret } = yield* fs
            .readFileString(`${target.directory}/${v1McpForwardFile}`)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(V1McpForwardSecret))),
            );
          const identity = yield* emulators.identity("google");
          // The opt-in import copied the organization to v2 while v1 kept serving it. The copy is
          // made by importing a twin organization and handing its import map to this one.
          const twin = yield* emulators.v1Workspace([identity.email]);
          yield* seedToolkitCalls(
            twin.organization,
            twin.user,
            `v1-${randomUUID().slice(0, 8)}`,
            upstream.origin,
          );
          yield* googleSignIn(identity.email);
          const copied = yield* importOnServer(twin.organization);
          const organization = copied.target.id;
          const own = yield* emulators.v1Workspace([identity.email]);
          yield* seedToolkitCalls(
            own.organization,
            own.user,
            `v1-${randomUUID().slice(0, 8)}`,
            upstream.origin,
          );
          const [pairs = []] = yield* writeRows("v1-database.json", [
            {
              sql: `select twin.row_id as twin, own.row_id as own, twin.key from (
                  select row_id, 'integration:' || name as key from integration where tenant = $1
                  union all select row_id, 'connection:' || name from connection where tenant = $1
                  union all select row_id, 'toolkit:' || (data->>'name') from plugin_storage
                    where tenant = $1 and plugin_id = 'toolkits' and collection = 'toolkits'
                ) twin join (
                  select row_id, 'integration:' || name as key from integration where tenant = $2
                  union all select row_id, 'connection:' || name from connection where tenant = $2
                  union all select row_id, 'toolkit:' || (data->>'name') from plugin_storage
                    where tenant = $2 and plugin_id = 'toolkits' and collection = 'toolkits'
                ) own using (key)`,
              params: [twin.organization, own.organization],
            },
          ]);
          const matched = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ twin: Schema.String, own: Schema.String, key: Schema.String }),
            ),
          )(pairs);
          const rowOf = (name: string) =>
            matched.find((pair) => pair.key === `toolkit:${name}`) ?? { twin: "", own: "" };
          const team = rowOf("Team ledger");
          const mine = rowOf("My ledger");
          // The opt-in import keyed each toolkit's one copy by the toolkit alone, with an id from the
          // toolkit and the organization.
          const optInId = (row: string) =>
            `v1-${createHash("sha256")
              .update(JSON.stringify([organization, row]))
              .digest("hex")
              .slice(0, 40)}`;
          yield* writeRows("sso-database.json", [
            ...[team, mine].flatMap((row) => [
              {
                sql: `update "mcpConnection" set id = $2 where id = $1`,
                params: [
                  v1ToolkitConnectionId(organization, row.twin, twin.user),
                  optInId(row.own),
                ],
              },
              {
                sql: "update private_v1_import_map set v1_id = $2, v2_id = $3 where v1_kind = 'toolkit' and v1_id = $1",
                params: [`${row.twin}:${twin.user}`, row.own, optInId(row.own)],
              },
            ]),
            ...[
              ...matched.filter((pair) => !pair.key.startsWith("toolkit:")),
              { twin: twin.organization, own: own.organization },
            ].map((pair) => ({
              sql: "update private_v1_import_map set v1_id = $2 where v1_org_id = $3 and v1_id = $1",
              params: [pair.twin, pair.own, twin.organization],
            })),
            {
              sql: "update private_v1_import_map set v1_org_id = $2 where v1_org_id = $1",
              params: [twin.organization, own.organization],
            },
          ]);
          const listConnections = (step: string) =>
            call(step, "GET", `/api/organizations/${organization}/mcp-connections`).pipe(
              Effect.flatMap((response) => decode(Connections, response)),
            );
          // The member renames their own toolkit's copy in v2.
          const before = yield* listConnections("List the opt-in copies");
          const renamed = yield* call(
            "Rename a toolkit copy in v2",
            "PUT",
            `/api/organizations/${organization}/mcp-connections/${optInId(mine.own)}`,
            {
              name: "Renamed in v2",
              apps: before.find((connection) => connection.id === optInId(mine.own))?.policy.apps,
            },
          );
          expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

          // The move updates the copy the member kept and keeps the one they changed; neither gets
          // a second copy.
          const moved = yield* importOnServer(own.organization);
          expect(moved.target).toEqual(copied.target);
          expect(moved.report.cutover).toBe(true);
          expect(moved.results.get("Team ledger")).toMatchObject({
            status: "imported",
            v2Id: optInId(team.own),
          });
          expect(moved.results.get("My ledger")).toMatchObject({
            status: "imported",
            v2Id: optInId(mine.own),
            note: "Kept as its users changed it in v2 after an earlier run imported it.",
          });
          const after = yield* listConnections("List the moved copies");
          expect(after.map((connection) => [connection.id, connection.name]).sort()).toEqual(
            [
              [optInId(team.own), "Team ledger"],
              [optInId(mine.own), "Renamed in v2"],
            ].sort(),
          );

          // v1 forwards each toolkit's URL with the id the import gives a copy now; the request runs
          // under the member's own copy.
          let minted = 0;
          const sign = (claims: Partial<V1ForwardClaims>) =>
            Redacted.make(
              v1ForwardBearer(secret, {
                account: own.user,
                organization: own.organization,
                exp: Math.floor(Date.now() / 1000) + 300 + minted++,
                ...claims,
              }),
            );
          for (const row of [team.own, mine.own]) {
            const connection = v1ToolkitConnectionId(organization, row, own.user);
            const client = yield* mcp.connect(
              () => sign({ toolkit: row, connection }),
              `opt-in-${row}`,
              { connection },
            );
            const searched = yield* client
              .use(`Search through the copy of ${row}`, (client, signal) =>
                client.callTool(
                  {
                    name: "execute",
                    arguments: { code: `return await tools.search({query: "entries", limit: 50})` },
                  },
                  undefined,
                  { signal },
                ),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                ),
                Effect.flatMap((done) =>
                  Schema.decodeUnknownEffect(
                    Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
                  )(done.execution.value),
                ),
              );
            expect(searched.items.map((item) => item.path)).toHaveLength(1);
          }
        }).pipe(Effect.provide(Layer.mergeAll(services, McpClient.layer))),
      ),
    // It copies a twin organization and moves this one: two runs of the import.
    { timeout: 180_000 },
  );

  it.effect(scenarios.v1ImportToolkitCalls.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators,
          fs = yield* FileSystem.FileSystem,
          target = yield* Target,
          mcp = yield* McpClient;
        const upstream = yield* credentialUpstream;
        const { secret } = yield* fs
          .readFileString(`${target.directory}/${v1McpForwardFile}`)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(V1McpForwardSecret))),
          );
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        yield* seedToolkitCalls(
          own.organization,
          own.user,
          `v1-${randomUUID().slice(0, 8)}`,
          upstream.origin,
        );
        // The service answers only the two keys, each where v1 sent it.
        yield* upstream.issue(
          Object.values(ledgerKeys).map((value) => ({ in: "header", name: "x-api-key", value })),
        );
        yield* googleSignIn(identity.email);

        const { report, target: imported, results } = yield* importOnServer(own.organization);
        for (const name of ["Ledger", "shared", "mine", "Team ledger", "My ledger"])
          expect(results.get(name)?.status, results.get(name)?.reason).toBe("imported");
        expect(report.cutover).toBe(true);
        const inventory = yield* call(
          "Read the new organization",
          "GET",
          `/api/organizations/${imported.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(Inventory, response)));
        const app = inventory.apps.find((candidate) => candidate.name === "Ledger")?.id;
        const connections = yield* call(
          "List the scoped MCP connections",
          "GET",
          `/api/organizations/${imported.id}/mcp-connections`,
        ).pipe(Effect.flatMap((response) => decode(Connections, response)));
        const policyOf = (toolkit: string) =>
          connections.find((connection) => connection.id === results.get(toolkit)?.v2Id)?.policy
            .apps;
        // The workspace's account is linked to the app for everyone, so the org toolkit's copy runs
        // as the app; the member's toolkit runs as their own account.
        expect(policyOf("Team ledger")).toEqual([
          { app, runsAs: [{ kind: "app" }], tools: { kind: "selected", names: ["entries.list"] } },
        ]);
        expect(policyOf("My ledger")).toEqual([
          {
            app,
            runsAs: [{ kind: "account", id: results.get("mine")?.v2Id }],
            tools: { kind: "selected", names: ["entries.list"] },
          },
        ]);

        let minted = 0;
        const sign = (claims: Partial<V1ForwardClaims>) =>
          Redacted.make(
            v1ForwardBearer(secret, {
              account: own.user,
              organization: own.organization,
              exp: Math.floor(Date.now() / 1000) + 300 + minted++,
              ...claims,
            }),
          );
        const Found = Schema.Struct({
          items: Schema.Array(Schema.Struct({ path: Schema.String })),
        });
        // Through the v1 URL of each toolkit, as v1 forwards it to the caller's own copy: search
        // finds the tool, and calling it with the connection's account reaches the service with
        // that connection's key.
        for (const [toolkit, connection, key] of [
          ["Team ledger", "shared", ledgerKeys.shared],
          ["My ledger", "mine", ledgerKeys.mine],
        ] as const) {
          const row = report.items?.find(
            (item) => item.kind === "toolkit" && item.label === toolkit,
          )?.id;
          if (row === undefined) return yield* Effect.die(`The import has no ${toolkit} toolkit`);
          const copy = v1ToolkitConnectionId(imported.id, row, own.user);
          expect(results.get(toolkit)?.v2Id).toBe(copy);
          const client = yield* mcp.connect(
            () => sign({ toolkit: row, connection: copy }),
            `toolkit-${connection}`,
            { connection: copy },
          );
          const run = (operation: string, code: string) =>
            client
              .use(operation, (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                ),
              );
          const searched = yield* run(
            `Search ${toolkit}`,
            `return await tools.search({query: "entries", limit: 50})`,
          );
          expect(searched.execution.ok, JSON.stringify(searched)).toBe(true);
          const paths = (yield* Schema.decodeUnknownEffect(Found)(searched.execution.value)).items
            .map((item) => item.path)
            .filter((path) => path.endsWith("entries.list"));
          expect(paths, JSON.stringify(searched)).toHaveLength(1);
          const [path] = paths;
          const callWith = (operation: string, account: string | undefined) =>
            run(
              operation,
              `return await ${(path ?? "")
                .split(".")
                .map((part, index) => (index === 0 ? part : `[${JSON.stringify(part)}]`))
                .join("")}(${JSON.stringify({ accountId: account, input: {} })})`,
            );
          const called = yield* callWith(
            `Call entries.list through ${toolkit}`,
            results.get(connection)?.v2Id,
          );
          expect(called.execution.ok, JSON.stringify(called)).toBe(true);
          const received = yield* upstream.received;
          expect(received.at(-1)?.url).toBe("/ledger/entries");
          expect(received.at(-1)?.headers["x-api-key"]).toBe(key);
          // The org toolkit's copy grants no member's own account: a call with one is refused
          // before it reaches the service. App accounts follow app access, so the personal copy
          // is not narrowed away from the workspace's account.
          if (connection === "shared") {
            const crossed = yield* callWith(
              `Call entries.list through ${toolkit} as mine`,
              results.get("mine")?.v2Id,
            );
            expect(crossed.execution.ok, JSON.stringify(crossed)).toBe(false);
            expect(yield* upstream.received).toHaveLength(received.length);
          }
        }
      }).pipe(Effect.provide(Layer.mergeAll(services, McpClient.layer))),
    ),
  );

  it.effect(
    scenarios.v1ImportSplitConnections.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const emulators = yield* Emulators,
            fs = yield* FileSystem.FileSystem,
            target = yield* Target,
            mcp = yield* McpClient;
          const operator = yield* v1ImportOperator;
          const upstream = yield* credentialUpstream;
          const { secret } = yield* fs
            .readFileString(`${target.directory}/${v1McpForwardFile}`)
            .pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(V1McpForwardSecret))),
            );
          const identity = yield* emulators.identity("google");
          // The first run imports a twin workspace; handing its import map to this one makes this
          // one's import run again over what the first made, as a restarted import does.
          const twin = yield* emulators.v1Workspace([identity.email]);
          const names = randomUUID().slice(0, 6);
          yield* seedSplitConnections(
            twin.organization,
            twin.user,
            `v1-${randomUUID().slice(0, 8)}`,
            upstream.origin,
            names,
          );
          // The service answers only the connections' keys, each where v1 sent it.
          yield* upstream.issue(
            Object.values(splitKeys).map((value) => ({ in: "header", name: "x-api-key", value })),
          );
          yield* googleSignIn(identity.email);
          const appsOf = (report: V1Report, label: string) =>
            [
              ...(report.splitIntegrations?.find((split) => split.label === label)?.apps ?? []),
            ].sort((a, b) => (a.label < b.label ? -1 : 1));

          // The dry run plans Ledger as an app per connection, each with its own rules. Notes,
          // whose moving connections share their rules, and Signals, whose connections differ only
          // in when they listed a tool, stay one app each.
          const dry = v1RunId("split-dry");
          const started = yield* operator.start({
            mode: "dry-run",
            runId: dry,
            organizations: [twin.organization],
          });
          expect(started.status, JSON.stringify(started.body)).toBe(200);
          const planned = yield* operator.waitForReport(dry, twin.organization);
          expect(planned.status, planned.reason ?? "").toBe("planned");
          expect(planned.splitIntegrations?.map((split) => split.label)).toEqual(["Ledger"]);
          expect(
            appsOf(planned, "Ledger").map(({ label, owner, name, status, rules }) => ({
              label,
              owner,
              name,
              status,
              rules,
            })),
          ).toEqual([
            {
              label: "bot",
              owner: "org",
              name: "Ledger (bot)",
              status: "planned",
              rules: { omitted: 1, always: 0, never: 0, otherwise: null },
            },
            {
              label: "mine",
              owner: "user",
              name: "Ledger (mine)",
              status: "planned",
              rules: { omitted: 0, always: 0, never: 0, otherwise: null },
            },
            {
              label: "reader",
              owner: "org",
              name: "Ledger (reader)",
              status: "planned",
              rules: { omitted: 1, always: 0, never: 0, otherwise: null },
            },
          ]);
          expect(planned.counts.v2.apps).toBe(5);

          const first = yield* importOnServer(twin.organization);
          const imported = first.target;
          expect(first.report.cutover, first.report.reason ?? "").toBe(true);
          for (const label of ["Ledger", "Notes", "Signals"])
            expect(statuses(first.items, "integration", label), label).toEqual(["imported"]);
          for (const label of ["bot", "reader", "mine", "alpha", "beta", "east", "west"])
            expect(statuses(first.items, "connection", label), label).toEqual(["imported"]);
          // The connection that cannot move counts for no app's rules.
          expect(statuses(first.items, "connection", "gamma")).toEqual(["skipped"]);
          const ledgerApps = appsOf(first.report, "Ledger");
          expect(ledgerApps.map((app) => [app.name, app.status])).toEqual([
            ["Ledger (bot)", "imported"],
            ["Ledger (mine)", "imported"],
            ["Ledger (reader)", "imported"],
          ]);

          const SlugInventory = Schema.Struct({
            ...Inventory.fields,
            apps: Schema.Array(
              Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }),
            ),
          });
          const readInventory = (step: string) =>
            call(step, "GET", `/api/organizations/${imported.id}/inventory`).pipe(
              Effect.flatMap((response) => decode(SlugInventory, response)),
            );
          const seededApps = /^(Ledger|Notes|Signals)\b/u;
          const seededAccounts = ["bot", "reader", "mine", "alpha", "beta"];
          const before = yield* readInventory("Read the organization after the first run");
          const appList = (inventory: typeof before) =>
            inventory.apps
              .filter((app) => seededApps.test(app.name))
              .map((app) => [app.name, app.id])
              .sort();
          expect(appList(before).map(([name]) => name)).toEqual([
            "Ledger (bot)",
            "Ledger (mine)",
            "Ledger (reader)",
            "Notes",
            "Signals",
          ]);
          const appOf = (name: string) => before.apps.find((app) => app.name === name);
          const accountOf = (label: string) =>
            before.accounts.find((account) => account.label === label)?.id;
          expect(ledgerApps.map((app) => app.v2Id)).toEqual(
            ["Ledger (bot)", "Ledger (mine)", "Ledger (reader)"].map((name) => appOf(name)?.id),
          );
          // Each app has exactly its connection's account: a workspace connection's linked for
          // everyone, the member's for them. Notes keeps both of its own.
          const linked = (name: string) =>
            Effect.gen(function* () {
              const scopes: Record<string, unknown> = {};
              for (const scope of ["app", "user"] as const) {
                const links = yield* call(
                  `List ${name}'s ${scope} links`,
                  "GET",
                  `/api/organizations/${imported.id}/apps/${appOf(name)?.id}/accounts/${scope}`,
                );
                expect(links.status, JSON.stringify(links.body)).toBe(200);
                scopes[scope] = (yield* decode(Schema.Array(AccountLink), links))
                  .map((link) => [link.requirement, link.account.label])
                  .sort();
              }
              return scopes;
            });
          expect(yield* linked("Ledger (bot)")).toEqual({ app: [["workspace", "bot"]], user: [] });
          expect(yield* linked("Ledger (reader)")).toEqual({
            app: [["workspace", "reader"]],
            user: [],
          });
          expect(yield* linked("Ledger (mine)")).toEqual({ app: [], user: [["service", "mine"]] });
          expect(yield* linked("Notes")).toEqual({
            app: [
              ["workspace", "alpha"],
              ["workspace", "beta"],
            ],
            user: [],
          });
          // The member's connection was theirs alone in v1, so its app is private to them.
          for (const [name, audience] of [
            ["Ledger (bot)", "everyone"],
            ["Ledger (reader)", "everyone"],
            ["Ledger (mine)", "private"],
          ] as const) {
            const access = yield* call(
              `Read ${name}'s access`,
              "GET",
              `/api/organizations/${imported.id}/apps/${appOf(name)?.id}/access`,
            );
            expect(access.status, JSON.stringify(access.body)).toBe(200);
            expect(access.body, name).toMatchObject({ audience: { kind: audience } });
          }

          // Each app has the tools v1 gave its connection alone.
          const toolsOf = (name: string) =>
            call(
              `List ${name}'s tools`,
              "GET",
              `/api/organizations/${imported.id}/apps/${appOf(name)?.id}/tools`,
            ).pipe(
              Effect.flatMap((response) => decode(Tools, response)),
              Effect.map((tools) => tools.items.map((tool) => tool.name).sort()),
            );
          expect(yield* toolsOf("Ledger (bot)")).toEqual(["entries.create", "entries.list"]);
          expect(yield* toolsOf("Ledger (reader)")).toEqual(["entries.list", "entries.search"]);
          expect(yield* toolsOf("Ledger (mine)")).toEqual([
            "entries.create",
            "entries.list",
            "entries.search",
          ]);
          expect(yield* toolsOf("Notes")).toEqual(["notes.list"]);
          const signals = (yield* appSource(imported.id, appOf("Signals")?.id)).find(
            (file) => file.path === "tools.ts",
          );
          expect(signals?.content).toContain('"erase": "always"');

          // Each call runs with its connection's own key, under its connection's rules.
          for (const [name, account, tool, kind, outcome, path] of [
            ["Ledger (reader)", "reader", "entries.search", "query", 200, "/ledger/entries/search"],
            ["Ledger (bot)", "bot", "entries.list", "query", 200, "/ledger/entries"],
            ["Ledger (mine)", "mine", "entries.search", "query", 200, "/ledger/entries/search"],
            ["Ledger (bot)", "bot", "entries.create", "mutation", 409, null],
            ["Ledger (bot)", "bot", "entries.search", "query", 404, null],
          ] as const) {
            const sent = yield* upstream.received;
            const result = yield* call(
              `Call ${tool} on ${name}`,
              "POST",
              `/api/organizations/${imported.id}/apps/${appOf(name)?.id}/tools/call`,
              { tool, kind, input: { accountId: accountOf(account), input: {} } },
            );
            expect(result.status, `${name} ${tool}: ${JSON.stringify(result.body)}`).toBe(outcome);
            const received = yield* upstream.received;
            if (path === null) {
              expect(result.body).toMatchObject({
                _tag: outcome === 409 ? "ToolApprovalRequired" : "ToolNotFound",
              });
              expect(received).toHaveLength(sent.length);
            } else {
              expect(received.at(-1)?.url).toBe(path);
              expect(received.at(-1)?.headers["x-api-key"]).toBe(splitKeys[account]);
            }
          }

          // The org toolkit over both workspace connections selects both of their apps, each with
          // the tools granted through its connection.
          const listConnections = (step: string) =>
            call(step, "GET", `/api/organizations/${imported.id}/mcp-connections`).pipe(
              Effect.flatMap((response) => decode(Connections, response)),
            );
          const byApp = (
            a: { readonly app: string | undefined },
            b: { readonly app: string | undefined },
          ) => ((a.app ?? "") < (b.app ?? "") ? -1 : 1);
          const copies = yield* listConnections("List the toolkit's copies");
          expect(copies).toHaveLength(1);
          expect([...(copies[0]?.policy.apps ?? [])].sort(byApp)).toEqual(
            [
              {
                app: appOf("Ledger (bot)")?.id,
                runsAs: [{ kind: "app" }],
                tools: { kind: "selected", names: ["entries.create", "entries.list"] },
              },
              {
                app: appOf("Ledger (reader)")?.id,
                runsAs: [{ kind: "app" }],
                tools: { kind: "selected", names: ["entries.list", "entries.search"] },
              },
            ].sort(byApp),
          );

          // This workspace takes over the twin's import map, matched by name, and its own import
          // runs over it: it updates every app, account and toolkit copy the first run made and
          // creates none.
          const own = yield* emulators.v1Workspace([identity.email]);
          yield* seedSplitConnections(
            own.organization,
            own.user,
            `v1-${randomUUID().slice(0, 8)}`,
            upstream.origin,
            names,
          );
          const [pairs = []] = yield* writeRows("v1-database.json", [
            {
              sql: `select twin.row_id as twin, own.row_id as own, twin.key from (
                  select row_id, 'integration:' || name as key from integration where tenant = $1
                  union all select row_id, 'connection:' || name from connection where tenant = $1
                  union all select row_id, 'tool_policy:' || pattern from tool_policy where tenant = $1
                  union all select row_id, 'toolkit:' || (data->>'name') from plugin_storage
                    where tenant = $1 and plugin_id = 'toolkits' and collection = 'toolkits'
                ) twin join (
                  select row_id, 'integration:' || name as key from integration where tenant = $2
                  union all select row_id, 'connection:' || name from connection where tenant = $2
                  union all select row_id, 'tool_policy:' || pattern from tool_policy where tenant = $2
                  union all select row_id, 'toolkit:' || (data->>'name') from plugin_storage
                    where tenant = $2 and plugin_id = 'toolkits' and collection = 'toolkits'
                ) own using (key)`,
              params: [twin.organization, own.organization],
            },
          ]);
          const matched = yield* Schema.decodeUnknownEffect(
            Schema.Array(
              Schema.Struct({ twin: Schema.String, own: Schema.String, key: Schema.String }),
            ),
          )(pairs);
          const toolkitRow = matched.find((pair) => pair.key === "toolkit:Ledger team");
          if (toolkitRow === undefined) return yield* Effect.die("The twin has no toolkit");
          // The member's toolkit copy keeps the id v1 computes for this workspace's toolkit.
          const copy = v1ToolkitConnectionId(imported.id, toolkitRow.own, own.user);
          yield* writeRows("sso-database.json", [
            {
              sql: `update "mcpConnection" set id = $2 where id = $1`,
              params: [v1ToolkitConnectionId(imported.id, toolkitRow.twin, twin.user), copy],
            },
            {
              sql: "update private_v1_import_map set v1_id = $2, v2_id = $3 where v1_kind = 'toolkit' and v1_id = $1",
              params: [`${toolkitRow.twin}:${twin.user}`, `${toolkitRow.own}:${own.user}`, copy],
            },
            ...[
              ...matched.filter((pair) => pair !== toolkitRow),
              { twin: twin.organization, own: own.organization },
            ].map((pair) => ({
              sql: "update private_v1_import_map set v1_id = $2 where v1_org_id = $3 and v1_id = $1",
              params: [pair.twin, pair.own, twin.organization],
            })),
            {
              sql: "update private_v1_import_map set v1_org_id = $2 where v1_org_id = $1",
              params: [twin.organization, own.organization],
            },
          ]);
          const second = yield* importOnServer(own.organization);
          expect(second.target).toEqual(imported);
          expect(second.report.cutover, second.report.reason ?? "").toBe(true);
          expect(appsOf(second.report, "Ledger").map((app) => [app.name, app.v2Id])).toEqual(
            ledgerApps.map((app) => [app.name, app.v2Id]),
          );
          for (const label of ["Notes", "Signals"])
            expect(second.results.get(label)?.v2Id, label).toBe(appOf(label)?.id);
          const after = yield* readInventory("Read the organization after the second run");
          expect(appList(after)).toEqual(appList(before));
          const accountIds = (inventory: typeof before) =>
            inventory.accounts
              .filter((account) => seededAccounts.includes(account.label))
              .map((account) => account.id)
              .sort();
          expect(accountIds(after)).toEqual(accountIds(before));
          expect(accountIds(after)).toHaveLength(seededAccounts.length);
          const recopied = yield* listConnections("List the toolkit's copies again");
          expect(recopied.map((connection) => connection.id)).toEqual([copy]);
          expect([...(recopied[0]?.policy.apps ?? [])].sort(byApp)).toEqual(
            [...(copies[0]?.policy.apps ?? [])].sort(byApp),
          );

          // v1 forwards the toolkit's URL to the member's copy: v1's tools through each
          // connection reach that connection's app, with its key.
          const toolkit = second.items.find(
            (item) => item.kind === "toolkit" && item.label === "Ledger team",
          );
          expect(toolkit).toMatchObject({ id: toolkitRow.own, status: "imported", v2Id: copy });
          let minted = 0;
          const client = yield* mcp.connect(
            () =>
              Redacted.make(
                v1ForwardBearer(secret, {
                  account: own.user,
                  organization: own.organization,
                  exp: Math.floor(Date.now() / 1000) + 300 + minted++,
                  toolkit: toolkitRow.own,
                  connection: copy,
                }),
              ),
            "toolkit-split",
            { connection: copy },
          );
          const run = (operation: string, code: string) =>
            client
              .use(operation, (client, signal) =>
                client.callTool({ name: "execute", arguments: { code } }, undefined, { signal }),
              )
              .pipe(
                Effect.flatMap((result) =>
                  Schema.decodeUnknownEffect(Execution)(result.structuredContent),
                ),
              );
          const searched = yield* run(
            "Search the forwarded toolkit",
            `return await tools.search({query: "entries", limit: 50})`,
          );
          expect(searched.execution.ok, JSON.stringify(searched)).toBe(true);
          const slugOf = (name: string) => appOf(name)?.slug ?? "";
          expect(
            (yield* Schema.decodeUnknownEffect(
              Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
            )(searched.execution.value)).items
              .map((item) => item.path)
              .sort(),
          ).toEqual(
            [
              ["Ledger (bot)", "entries.create"],
              ["Ledger (bot)", "entries.list"],
              ["Ledger (reader)", "entries.list"],
              ["Ledger (reader)", "entries.search"],
            ]
              .map(([name, tool]) => `tools[${JSON.stringify(slugOf(name ?? ""))}].${tool}`)
              .sort(),
          );
          const callThrough = (name: string, tool: string, account: string) =>
            run(
              `Call ${tool} on ${name} through the toolkit`,
              `return await tools[${JSON.stringify(slugOf(name))}]${tool
                .split(".")
                .map((part) => `[${JSON.stringify(part)}]`)
                .join("")}(${JSON.stringify({ accountId: accountOf(account), input: {} })})`,
            );
          const searchedReader = yield* callThrough("Ledger (reader)", "entries.search", "reader");
          expect(searchedReader.execution.ok, JSON.stringify(searchedReader)).toBe(true);
          const received = yield* upstream.received;
          expect(received.at(-1)?.url).toBe("/ledger/entries/search");
          expect(received.at(-1)?.headers["x-api-key"]).toBe(splitKeys.reader);
          // `bot` has no search in v1, so its app has none to call.
          const searchedBot = yield* callThrough("Ledger (bot)", "entries.search", "bot");
          expect(searchedBot.execution.ok, JSON.stringify(searchedBot)).toBe(false);
          expect(yield* upstream.received).toHaveLength(received.length);
        }).pipe(Effect.provide(Layer.mergeAll(services, McpClient.layer))),
      ),
    // A dry run and two imports.
    { timeout: 240_000 },
  );

  it.effect(scenarios.v1ImportStampedApprovals.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const upstream = yield* approvalMcpUpstream;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        yield* seedStampedApprovals(
          own.organization,
          `v1-${randomUUID().slice(0, 8)}`,
          upstream.origin,
        );
        yield* googleSignIn(identity.email);

        const { target: imported, results } = yield* importOnServer(own.organization);
        for (const name of ["Approvals", "Ops"])
          expect(results.get(name)?.status, results.get(name)?.reason).toBe("imported");
        const app = results.get("Approvals")?.v2Id;
        // v1's stamp becomes the app's own rule, so the app asks whatever the server says now.
        // A tool v1 allowed gets no rule, and a policy's approve stays the app's `never`.
        const tools = (yield* appSource(imported.id, app)).find((file) => file.path === "tools.ts");
        expect(tools?.content).toContain('"unhinted": "always"');
        expect(tools?.content).toContain('"read": "never"');
        expect(tools?.content).not.toContain('"safe"');

        // Called as the member, the stamped tool waits for approval and never reaches the server;
        // the tools v1 allowed run.
        for (const [tool, kind, asks] of [
          ["unhinted", "mutation", true],
          ["safe", "mutation", false],
          ["read", "query", false],
        ] as const) {
          const before = yield* upstream.calls;
          const result = yield* call(
            `Call ${tool}`,
            "POST",
            `/api/organizations/${imported.id}/apps/${app}/tools/call`,
            { tool, kind, input: {} },
          );
          if (asks) {
            expect(result.status, `${tool}: ${JSON.stringify(result.body)}`).toBe(409);
            expect(result.body).toMatchObject({ _tag: "ToolApprovalRequired" });
            expect(yield* upstream.calls, tool).toEqual(before);
          } else {
            expect(result.status, `${tool}: ${JSON.stringify(result.body)}`).toBe(200);
            expect(yield* upstream.calls, tool).toEqual([...before, tool]);
          }
        }
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportUnlistedRules.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const upstream = yield* approvalMcpUpstream;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        yield* seedUnlistedRules(
          own.organization,
          `v1-${randomUUID().slice(0, 8)}`,
          upstream.origin,
        );
        yield* googleSignIn(identity.email);

        const { target: imported, results } = yield* importOnServer(own.organization);
        expect(results.get("Unlisted")?.status, results.get("Unlisted")?.reason).toBe("imported");
        const app = results.get("Unlisted")?.v2Id;
        const tools = (yield* appSource(imported.id, app)).find((file) => file.path === "tools.ts");
        expect(tools?.content).toContain('"read": "never"');
        expect(tools?.content).toMatch(/const omitted = new Set<string>\(\[\s*"unhinted"\s*\]\)/u);

        // As the member: the tool v1 approved runs, the one its rule blocks by name is not there,
        // and every tool no rule names waits for approval without reaching the server, even one
        // the server does not mark destructive.
        for (const [tool, kind, outcome] of [
          ["read", "query", 200],
          ["unhinted", "mutation", 404],
          ["safe", "mutation", 409],
          ["erase", "mutation", 409],
        ] as const) {
          const before = yield* upstream.calls;
          const result = yield* call(
            `Call ${tool}`,
            "POST",
            `/api/organizations/${imported.id}/apps/${app}/tools/call`,
            { tool, kind, input: {} },
          );
          expect(result.status, `${tool}: ${JSON.stringify(result.body)}`).toBe(outcome);
          if (outcome === 404) expect(result.body).toMatchObject({ _tag: "ToolNotFound" });
          if (outcome === 409) expect(result.body).toMatchObject({ _tag: "ToolApprovalRequired" });
          expect(yield* upstream.calls, tool).toEqual(outcome === 200 ? [...before, tool] : before);
        }

        // The API's read operation, which v1 compiled but never listed, asks as v1's rule says
        // rather than running as a read.
        expect(results.get("Status")?.status, results.get("Status")?.reason).toBe("imported");
        const status = results.get("Status")?.v2Id;
        const health = yield* call(
          "Call status.health",
          "POST",
          `/api/organizations/${imported.id}/apps/${status}/tools/call`,
          { tool: "status.health", kind: "query", input: {} },
        );
        expect(health.status, JSON.stringify(health.body)).toBe(409);
        expect(health.body).toMatchObject({ _tag: "ToolApprovalRequired" });

        // The repair names what the rules decide for tools v1 did not list, and finds the
        // import's own apps already hold it.
        const repaired = yield* operator.repair(own.organization, false);
        expect(repaired.status, JSON.stringify(repaired.body)).toBe(200);
        expect(repaired.body).toMatchObject({
          apps: expect.arrayContaining([
            expect.objectContaining({
              app,
              always: [],
              unlisted: { omitted: ["unhinted"], always: [], otherwise: "always" },
              decision: "unchanged",
              files: [],
            }),
            expect.objectContaining({
              app: status,
              always: [],
              unlisted: { omitted: [], always: ["status.health"], otherwise: null },
              decision: "unchanged",
              files: [],
            }),
          ]),
        });
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportRepair.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const upstream = yield* approvalMcpUpstream;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        yield* seedStampedApprovals(
          own.organization,
          `v1-${randomUUID().slice(0, 8)}`,
          upstream.origin,
        );
        yield* googleSignIn(identity.email);
        const { target: imported, results } = yield* importOnServer(own.organization);
        expect(results.get("Approvals")?.status, results.get("Approvals")?.reason).toBe("imported");
        const app = results.get("Approvals")?.v2Id;
        const appPath = `/api/organizations/${imported.id}/apps/${app}`;
        const callTool = (tool: string) =>
          call(`Call ${tool}`, "POST", `${appPath}/tools/call`, {
            tool,
            kind: "mutation",
            input: {},
          });
        const deploy = (step: string, files: readonly SourceFile[]) =>
          call(step, "POST", `${appPath}/deploy`, { files }).pipe(
            Effect.tap((response) =>
              Effect.sync(() => expect(response.status, JSON.stringify(response.body)).toBe(200)),
            ),
          );
        // The app's files by path: the repair keeps every file and replaces the ones it changes.
        const deployed = appSource(imported.id, app).pipe(
          Effect.map((files) => files.toSorted((a, b) => a.path.localeCompare(b.path))),
        );
        const withTools = (files: readonly SourceFile[], edit: (content: string) => string) =>
          files.map((file) =>
            file.path === "tools.ts" ? { ...file, content: edit(file.content) } : file,
          );

        const withIndex = (files: readonly SourceFile[], edit: (content: string) => string) =>
          files.map((file) =>
            file.path === "index.ts" ? { ...file, content: edit(file.content) } : file,
          );
        const asks = (tool: string) =>
          callTool(tool).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                expect(result.status, `${tool} runs: ${JSON.stringify(result.body)}`).toBe(409);
                expect(result.body).toMatchObject({ _tag: "ToolApprovalRequired" });
              }),
            ),
          );
        const runs = (tool: string) =>
          callTool(tool).pipe(
            Effect.tap((result) =>
              Effect.sync(() =>
                expect(result.status, `${tool} asks: ${JSON.stringify(result.body)}`).toBe(200),
              ),
            ),
          );

        // Make the app what an import before the fix left: no rule for the tool v1 stamped, so it
        // runs because the server no longer marks it destructive.
        const files = yield* deployed;
        const earlier = withTools(files, (content) =>
          content.replace(/\n {2}"unhinted": "always",|,\n {2}"unhinted": "always"/u, ""),
        );
        expect(earlier).not.toEqual(files);
        yield* deploy("Deploy the earlier importer's source", earlier);
        yield* runs("unhinted");

        // Planning the earlier importer's app names the change and writes nothing.
        const planned = yield* operator.repair(own.organization, false);
        expect(planned.status, JSON.stringify(planned.body)).toBe(200);
        expect(planned.body).toMatchObject({
          status: "planned",
          applied: false,
          apps: [
            {
              app,
              always: ["unhinted"],
              decision: "deploy",
              source: "generated",
              files: ["tools.ts"],
            },
          ],
        });
        expect(yield* deployed).toEqual(earlier);
        yield* runs("unhinted");

        // Applying deploys the app with v1's stamp as its rule: the import's own source again.
        const applied = yield* operator.repair(own.organization, true);
        expect(applied.status, JSON.stringify(applied.body)).toBe(200);
        expect(applied.body).toMatchObject({
          status: "repaired",
          applied: true,
          apps: [{ app, decision: "deploy", files: ["tools.ts"] }],
        });
        expect(yield* deployed).toEqual(files);
        yield* asks("unhinted");
        yield* runs("safe");

        // An app an earlier importer wrote, whose files the importer no longer generates, is
        // still the import's own: it gets the importer's source now.
        const older = withIndex(earlier, (content) => `// An earlier importer.\n${content}`);
        yield* deploy("Deploy an earlier importer's source", older);
        yield* writeRows("sso-database.json", [
          {
            sql: "update private_v1_import_map set updated_at = now() where v1_kind = 'integration' and v2_id = $1",
            params: [app ?? ""],
          },
        ]);
        yield* runs("unhinted");
        const regenerated = yield* operator.repair(own.organization, true);
        expect(regenerated.body).toMatchObject({
          apps: [
            {
              app,
              decision: "deploy",
              source: "generated",
              files: ["index.ts", "tools.ts"],
            },
          ],
        });
        expect(yield* deployed).toEqual(files);
        yield* asks("unhinted");

        // An app whose users changed its approvals in v2 keeps them, even where they ask less than
        // v1 did: here they turned every approval off.
        const relaxed = withIndex(files, (content) =>
          content
            .replace(
              'import { always } from "apps/operations/approval"',
              'import { always, never } from "apps/operations/approval"',
            )
            .replace(
              "(tool, name) => approval(name) ?? (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined)",
              "() => never()",
            ),
        );
        expect(relaxed.find((file) => file.path === "index.ts")?.content).toContain(
          "() => never()",
        );
        expect(relaxed).not.toEqual(files);
        yield* deploy("Turn every approval off in v2", relaxed);
        for (const tool of ["unhinted", "erase", "safe"]) yield* runs(tool);
        const kept = yield* operator.repair(own.organization, true);
        expect(kept.body).toMatchObject({
          status: "repaired",
          apps: [{ app, always: ["unhinted"], decision: "kept", source: "edited" }],
        });
        expect(yield* deployed).toEqual(relaxed);
        for (const tool of ["unhinted", "erase", "safe"]) yield* runs(tool);

        // So does code that sets no approvals of its own any more.
        const bare = withIndex(files, (content) =>
          content
            .replace("withApprovals(renameTools(", "renameTools(")
            .replace(
              ", (tool, name) => approval(name) ?? (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined))",
              "",
            ),
        );
        expect(bare.find((file) => file.path === "index.ts")?.content).not.toContain(
          "withApprovals(",
        );
        yield* deploy("Drop the app's approvals in v2", bare);
        const dropped = yield* operator.repair(own.organization, true);
        expect(dropped.body).toMatchObject({
          apps: [{ app, decision: "kept", source: "edited" }],
        });
        expect(yield* deployed).toEqual(bare);
        for (const tool of ["unhinted", "erase", "safe"]) yield* runs(tool);

        // An app its users changed in v2 beside its approvals keeps their code, and gets v1's
        // approvals beneath it, laid out differently or not: here the earlier importer's app, whose
        // stamped tool runs.
        const activeVersion = call(
          "List the apps",
          "GET",
          `/api/organizations/${imported.id}/apps`,
        ).pipe(
          Effect.flatMap((response) => decode(Apps, response)),
          Effect.map((apps) => apps.find((found) => found.id === app)?.activeVersion),
        );
        const changed = withIndex(earlier, (content) =>
          `// Changed in v2.\n${content}`.replace(
            "(tool, name) => approval(name) ?? (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined)",
            "(tool, name) =>\n  // The app's own rule.\n  (approval(name) ?? (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined))",
          ),
        );
        expect(changed.find((file) => file.path === "index.ts")?.content).toContain(
          "// The app's own rule.",
        );
        yield* deploy("Change the earlier importer's app in v2", changed);
        const users = yield* activeVersion;
        yield* runs("unhinted");
        const plannedEdit = yield* operator.repair(own.organization, false);
        expect(plannedEdit.body).toMatchObject({
          apps: [
            {
              app,
              always: ["unhinted"],
              decision: "deploy",
              source: "edited",
              files: ["index.ts", "v1-approvals.ts"],
            },
          ],
        });
        expect(yield* deployed).toEqual(changed);
        const layered = yield* operator.repair(own.organization, true);
        expect(layered.body).toMatchObject({
          status: "repaired",
          apps: [{ app, decision: "deploy", source: "edited" }],
        });
        const after = yield* deployed;
        const index = after.find((file) => file.path === "index.ts");
        expect(index?.content).toContain('import { withApprovals } from "./v1-approvals.ts"');
        expect(index?.content).toContain("// The app's own rule.");
        expect(
          after.filter((file) => file.path !== "index.ts" && file.path !== "v1-approvals.ts"),
        ).toEqual(changed.filter((file) => file.path !== "index.ts"));
        // v1 asked before the tool it stamped; the tool it ran without asking still runs.
        yield* asks("unhinted");
        yield* asks("erase");
        yield* runs("safe");
        const repaired = yield* activeVersion;
        expect(repaired).not.toBe(users);

        // A second repair finds nothing left to change.
        const again = yield* operator.repair(own.organization, false);
        expect(again.body).toMatchObject({
          apps: [{ app, decision: "unchanged", source: "edited", files: [] }],
        });

        // The restore runs the version a repair replaced again, and only while the app still runs
        // the repair's version.
        const stale = yield* operator.restore(own.organization, {
          app: app ?? "",
          version: users ?? "",
          expected: users ?? "",
        });
        expect(stale.status, JSON.stringify(stale.body)).toBe(409);
        expect(stale.body).toMatchObject({ status: "changed", active: repaired });
        expect(yield* activeVersion).toBe(repaired);
        const unknown = yield* operator.restore(own.organization, {
          app: `app_${randomUUID()}`,
          version: users ?? "",
          expected: repaired ?? "",
        });
        expect(unknown.status, JSON.stringify(unknown.body)).toBe(409);
        expect(unknown.body).toMatchObject({ status: "not_found" });
        const restored = yield* operator.restore(own.organization, {
          app: app ?? "",
          version: users ?? "",
          expected: repaired ?? "",
        });
        expect(restored.status, JSON.stringify(restored.body)).toBe(200);
        expect(restored.body).toMatchObject({ app, version: users, status: "restored" });
        expect(yield* activeVersion).toBe(users);
        expect(yield* deployed).toEqual(changed);
        yield* runs("unhinted");
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportRequests.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const upstream = yield* credentialUpstream;
        const hosts = serviceHosts(upstream.port);
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        yield* seedRequests(
          own.organization,
          own.user,
          `v1-${randomUUID().slice(0, 8)}`,
          upstream.origin,
        );
        const complete = yield* emulators.v1Workspace([identity.email]);
        yield* seedPublic(complete.organization, `v1-${randomUUID().slice(0, 8)}`, upstream.origin);
        yield* googleSignIn(identity.email);

        // Each item by its label and, for an account, its app.
        const { target, results } = yield* importOnServer(own.organization, (item) =>
          item.context === null ? item.label : `${item.label} · ${item.context}`,
        );
        for (const name of [
          "Requests",
          "Status",
          "Uploads",
          // Google's API hosts, which the public suffix list keeps apart.
          "Google APIs",
          "Downgraded",
          "Regional",
          "Layered",
          // v1 sent an integration's credentials to every server its operations named, whatever
          // services they belong to, and the app does too.
          "Split",
          "main · Requests",
          "main · Uploads",
          "main · Split",
          "main · Downgraded",
          "main · Regional",
          "main · Layered",
        ])
          expect(results.get(name)?.status, results.get(name)?.reason).toBe("imported");
        // An account's credentials go to several hosts only over HTTPS; the loopback `Uploads`
        // above is the local exception the outbound also makes.
        expect(results.get("Mixed")).toMatchObject({
          status: "failed",
          reason:
            "Its operations call uploads.mixed.example.com over plain HTTP, and an imported app sends an account's credentials to more than one host only over HTTPS.",
        });
        // A server URL whose variable no server declares names no host, and v1 never resolved
        // it either, so it is skipped.
        expect(results.get("Unresolved")).toMatchObject({
          status: "skipped",
          reason: "Its server URL uses {tenant}, which no server defines, so v1 never resolved it.",
        });
        // With no server URL, or only a relative one, and no base URL, v1 sent the bare path and
        // reached no API, whatever URL it fetched the specification from, so it is skipped. The
        // reason never names any part of the specification's URL, whose host, path or query can
        // carry a key.
        const serverlessReason =
          "Its specification names no server URL and the integration sets no base URL, so v1 had no host to send its requests to either. Its v2 app needs an absolute API base URL.";
        for (const part of [
          "synthetic-host-secret",
          "serverless.example.com",
          "synthetic-path-secret",
          "synthetic-schema-token",
        ]) {
          expect(JSON.stringify(results.get("Serverless"))).not.toContain(part);
        }
        expect(JSON.stringify(results.get("Relative"))).not.toContain("relative.example.com");
        expect(results.get("Serverless")).toMatchObject({
          status: "skipped",
          reason: serverlessReason,
        });
        expect(results.get("Relative")).toMatchObject({
          status: "skipped",
          reason:
            "Its server URL is not absolute and the integration sets no base URL, so v1 had no host to send its requests to either. Its v2 app needs an absolute API base URL.",
        });
        expect(results.get("main · Mixed")).toMatchObject({
          status: "failed",
          reason: "Its integration was not imported.",
        });

        const inventory = yield* call(
          "Read the new organization",
          "GET",
          `/api/organizations/${target.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(Inventory, response)));
        const appId = (name: string) => inventory.apps.find((app) => app.name === name)?.id;
        // Each app has the one account imported for it linked; account tools take its id.
        const accountOf = (name: string) =>
          inventory.links.find((link) => link.app === appId(name))?.account;
        const account = accountOf("Requests");
        expect(account).toBeDefined();
        const send = (step: string, app: string | undefined, tool: string, accountId?: string) =>
          call(step, "POST", `/api/organizations/${target.id}/apps/${app}/tools/call`, {
            tool,
            kind: "query",
            input: accountId === undefined ? {} : { accountId, input: {} },
          });
        // Each operation goes to its own server, with the key from the method v1 left unnamed.
        for (const [tool, path] of [
          ["items.list", "/v2/items"],
          ["items.ping", "/root/ping"],
        ] as const) {
          const sent = yield* send(`Call ${tool}`, appId("Requests"), tool, account);
          expect(sent.status, JSON.stringify(sent.body)).toBe(200);
          const received = (yield* upstream.received).at(-1);
          expect(received?.url).toBe(path);
          expect(received?.headers["x-api-key"]).toBe("synthetic-requests-key");
        }
        // A public API's app loads and calls it without an account.
        const health = yield* send("Call the public API", appId("Status"), "status.health");
        expect(health.status, JSON.stringify(health.body)).toBe(200);
        const received = (yield* upstream.received).at(-1);
        expect(received?.url).toBe("/public/health");
        expect(received?.headers["x-api-key"]).toBeUndefined();

        // An API on two hosts of one service declares both for the account's credentials, keeps
        // v1's tool names, and sends each operation to its own host with the account's key.
        const source = yield* call(
          "Read the two-host app's source",
          "GET",
          `/api/organizations/${target.id}/apps/${appId("Uploads")}/source`,
        );
        expect(source.status, JSON.stringify(source.body)).toBe(200);
        const provider = (yield* decode(Source, source)).files.find(
          (file) => file.path === "provider.ts",
        )?.content;
        expect(provider).toContain(
          `hosts: [${JSON.stringify(hosts.api)}, ${JSON.stringify(hosts.uploads)}]`,
        );
        expect(provider).not.toContain("synthetic-uploads-key");
        const uploadsAccount = accountOf("Uploads");
        expect(uploadsAccount).toBeDefined();
        expect(uploadsAccount).not.toBe(account);
        const listed = yield* call(
          "List the two-host app's tools",
          "GET",
          `/api/organizations/${target.id}/apps/${appId("Uploads")}/tools`,
        );
        expect(listed.status, JSON.stringify(listed.body)).toBe(200);
        expect((yield* decode(Tools, listed)).items.map((tool) => tool.name).sort()).toEqual([
          "assets.upload",
          "repos.get",
        ]);
        for (const [tool, host, path] of [
          ["repos.get", hosts.api, "/api/repos"],
          ["assets.upload", hosts.uploads, "/uploads/assets"],
        ] as const) {
          const sent = yield* call(
            `Call ${tool} on ${host}`,
            "POST",
            `/api/organizations/${target.id}/apps/${appId("Uploads")}/tools/call`,
            { tool, kind: "query", input: { accountId: uploadsAccount, input: {} } },
          );
          expect(sent.status, JSON.stringify(sent.body)).toBe(200);
          const reached = (yield* upstream.received).at(-1);
          expect(reached?.host).toBe(host);
          expect(reached?.url).toBe(path);
          expect(reached?.headers["x-api-key"]).toBe("synthetic-uploads-key");
        }

        // An API whose operations call two services declares both hosts for the account's
        // credentials, and sends them to the operation's own.
        const splitSource = yield* call(
          "Read the two-service app's source",
          "GET",
          `/api/organizations/${target.id}/apps/${appId("Split")}/source`,
        );
        expect(splitSource.status, JSON.stringify(splitSource.body)).toBe(200);
        expect(
          (yield* decode(Source, splitSource)).files.find((file) => file.path === "provider.ts")
            ?.content,
        ).toContain(`hosts: ["127.0.0.1:${upstream.port}", "other.example.com"]`);
        const splitSent = yield* send(
          "Call the two-service split.a",
          appId("Split"),
          "split.a",
          accountOf("Split"),
        );
        expect(splitSent.status, JSON.stringify(splitSent.body)).toBe(200);
        const splitReached = (yield* upstream.received).at(-1);
        expect(splitReached?.url).toBe("/public/a");
        expect(splitReached?.headers["x-api-key"]).toBe("synthetic-split-key");

        // An operation's server that uses the document server's variable without declaring it takes
        // the document's default, so the app sends every operation to one host with the key.
        const regionalSource = yield* call(
          "Read the regional app's source",
          "GET",
          `/api/organizations/${target.id}/apps/${appId("Regional")}/source`,
        );
        expect(regionalSource.status, JSON.stringify(regionalSource.body)).toBe(200);
        const regionalProvider = (yield* decode(Source, regionalSource)).files.find(
          (file) => file.path === "provider.ts",
        )?.content;
        expect(regionalProvider).toContain(`hosts: [${JSON.stringify(hosts.api)}]`);
        expect(regionalProvider).not.toContain("{region}");
        for (const [tool, path] of [
          ["items.list", "/regional/items"],
          ["items.models", "/regional/models"],
        ] as const) {
          const sent = yield* call(
            `Call the regional ${tool}`,
            "POST",
            `/api/organizations/${target.id}/apps/${appId("Regional")}/tools/call`,
            {
              tool,
              kind: "query",
              input: { accountId: accountOf("Regional"), input: {} },
            },
          );
          expect(sent.status, JSON.stringify(sent.body)).toBe(200);
          const reached = (yield* upstream.received).at(-1);
          expect(reached?.host).toBe(hosts.api);
          expect(reached?.url).toBe(path);
          expect(reached?.headers["x-api-key"]).toBe("synthetic-regional-key");
        }

        // With two document servers, the operation's server takes the first one's declaration,
        // whose URL is empty, not the second's: the app names and calls only that host.
        const layeredSource = yield* call(
          "Read the layered app's source",
          "GET",
          `/api/organizations/${target.id}/apps/${appId("Layered")}/source`,
        );
        expect(layeredSource.status, JSON.stringify(layeredSource.body)).toBe(200);
        const layeredProvider = (yield* decode(Source, layeredSource)).files.find(
          (file) => file.path === "provider.ts",
        )?.content;
        expect(layeredProvider).toContain(`hosts: [${JSON.stringify(hosts.api)}]`);
        expect(layeredProvider).not.toContain(hosts.uploads);
        const layeredSent = yield* call(
          "Call the layered items.list",
          "POST",
          `/api/organizations/${target.id}/apps/${appId("Layered")}/tools/call`,
          {
            tool: "items.list",
            kind: "query",
            input: { accountId: accountOf("Layered"), input: {} },
          },
        );
        expect(layeredSent.status, JSON.stringify(layeredSent.body)).toBe(200);
        const layeredReached = (yield* upstream.received).at(-1);
        expect(layeredReached?.host).toBe(hosts.api);
        expect(layeredReached?.url).toBe("/layered/items");
        expect(layeredReached?.headers["x-api-key"]).toBe("synthetic-layered-key");

        // An account check whose server variable turns one of the app's HTTPS hosts to plain HTTP
        // would carry the account's key there, so the app is imported without it: its provider
        // names no check and no HTTP URL, and the account has nothing to check.
        const downgradedSource = yield* call(
          "Read the downgraded check's app source",
          "GET",
          `/api/organizations/${target.id}/apps/${appId("Downgraded")}/source`,
        );
        expect(downgradedSource.status, JSON.stringify(downgradedSource.body)).toBe(200);
        const downgradedProvider = (yield* decode(Source, downgradedSource)).files.find(
          (file) => file.path === "provider.ts",
        )?.content;
        expect(downgradedProvider).toContain(
          'hosts: ["api.downgraded.example.com", "uploads.downgraded.example.com"]',
        );
        expect(downgradedProvider).not.toContain("http://uploads.downgraded.example.com");
        expect(downgradedProvider).not.toContain("checkAccount");
        expect(downgradedProvider).not.toContain("synthetic-downgraded-key");
        const downgradedHealth = yield* call(
          "Check the downgraded account",
          "POST",
          `/api/organizations/${target.id}/accounts/${accountOf("Downgraded")}/health`,
        );
        expect(downgradedHealth.status, JSON.stringify(downgradedHealth.body)).toBe(200);
        expect(
          (yield* decode(Health, downgradedHealth)).apps.find(
            (app) => app.app === appId("Downgraded"),
          ),
        ).toMatchObject({ checkable: false, check: null });

        // A workspace whose every item moves converts; one with a failed item does not.
        const moved = yield* importOnServer(complete.organization);
        expect(moved.report.status, moved.report.reason ?? "").toBe("imported");
        expect(moved.target.id).not.toBe(target.id);
      }).pipe(Effect.provide(services)),
    ),
  );
  it.effect(scenarios.v1ImportOAuthRenewal.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const service = yield* oauthService;
        const { origin } = service;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        yield* seedRenewal(own.organization, own.user, `v1-${randomUUID().slice(0, 8)}`, origin);
        yield* googleSignIn(identity.email);

        const { target, results } = yield* importOnServer(own.organization);
        // v1 made a connection whose recorded token endpoint it no longer trusted reconnect.
        // It moves without its account, for its owner to connect again in v2.
        expect(results.get("untrusted")).toEqual({
          status: "skipped",
          reason:
            "v1 no longer trusted the token endpoint its sign-in recorded. Reconnect it in v2.",
        });
        // The method declares no authorization URL, yet the app builds: it signs in at each client's.
        for (const name of ["Mail", "renewed", "second"])
          expect(results.get(name)?.status, results.get(name)?.reason).toBe("imported");

        const inventory = yield* call(
          "Read the new organization",
          "GET",
          `/api/organizations/${target.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(Inventory, response)));
        const app = inventory.apps.find((entry) => entry.name === "Mail")?.id;
        expect(app).toBeDefined();
        // A reconnect signs in where v1 did: each connection's client, never the method's endpoints.
        const source = yield* call(
          "Read the mail app's deployed source",
          "GET",
          `/api/organizations/${target.id}/apps/${app}/source`,
        );
        expect(source.status, JSON.stringify(source.body)).toBe(200);
        const written = JSON.stringify((yield* decode(Source, source)).files);
        for (const url of [
          `${origin}/authorize`,
          `${origin}/token`,
          `${origin}/other/authorize`,
          `${origin}/other/token`,
        ])
          expect(written).toContain(JSON.stringify(url).slice(1, -1));
        expect(written).not.toContain("method.example.com");

        // The expired account renews on its first call, as v1 refreshed it.
        const account = inventory.accounts.find((entry) => entry.label === "renewed")?.id;
        expect(inventory.links.some((link) => link.app === app && link.account === account)).toBe(
          true,
        );
        const sent = yield* call(
          "Call the mail API as the renewed account",
          "POST",
          `/api/organizations/${target.id}/apps/${app}/tools/call`,
          {
            tool: "mail.me",
            kind: "query",
            input: { accountId: account, input: {} },
          },
        );
        expect(sent.status, JSON.stringify(sent.body)).toBe(200);
        expect(yield* service.calls).toEqual([`Bearer ${service.renewedToken}`]);
        const tokens = yield* service.tokens;
        expect(tokens.map((request) => request.path)).toEqual(["/token"]);
        const renewal = tokens[0];
        expect(renewal?.authorization).toBe(
          `Basic ${Buffer.from("synthetic-confidential-client:synthetic-confidential-secret").toString("base64")}`,
        );
        expect(Object.fromEntries(renewal?.form ?? [])).toEqual({
          grant_type: "refresh_token",
          refresh_token: "synthetic-renewed-refresh",
          scope: "mail.read offline_access",
          resource: `${origin}/api`,
        });

        // An OAuth integration's fixed credentials go in a second account, linked for everyone,
        // and every call sends them with the connection's token, as v1 did.
        for (const name of ["Gated mail", "gated", "Pasted mail", "pasted"])
          expect(results.get(name)?.status, results.get(name)?.reason).toBe("imported");
        const gatedApp = inventory.apps.find((entry) => entry.name === "Gated mail")?.id;
        const gatedAccount = inventory.accounts.find((entry) => entry.label === "gated")?.id;
        const fixedAccount = inventory.accounts.find(
          (entry) => entry.label === "Gated mail fixed credentials",
        )?.id;
        expect(fixedAccount).toBeDefined();
        // The member's link is their own account; the fixed account is linked for everyone, and
        // the call below sends its values.
        expect(inventory.links.filter((link) => link.app === gatedApp)).toEqual([
          { app: gatedApp, account: gatedAccount },
        ]);
        const gatedSource = yield* call(
          "Read the gated app's deployed source",
          "GET",
          `/api/organizations/${target.id}/apps/${gatedApp}/source`,
        );
        expect(gatedSource.status, JSON.stringify(gatedSource.body)).toBe(200);
        const gatedFiles = JSON.stringify((yield* decode(Source, gatedSource)).files);
        expect(gatedFiles).toContain("fixedProvider");
        expect(gatedFiles).not.toContain("synthetic0gateway1client2id");
        expect(gatedFiles).not.toContain("synthetic-gateway-secret");
        const gatedSent = yield* call(
          "Call the gated API as the gated account",
          "POST",
          `/api/organizations/${target.id}/apps/${gatedApp}/tools/call`,
          { tool: "mail.me", kind: "query", input: { accountId: gatedAccount, input: {} } },
        );
        expect(gatedSent.status, JSON.stringify(gatedSent.body)).toBe(200);
        expect((yield* service.gated).at(-1)).toEqual({
          authorization: "Bearer synthetic-gated-access",
          "cf-access-client-id": "synthetic0gateway1client2id.access",
          "cf-access-client-secret": "synthetic-gateway-secret-0123456789",
          client_id: undefined,
          client_secret: undefined,
        });

        // Fixed headers that repeat the connection's own OAuth client ID and secret are left out
        // and reported: the sign-in already sends them, and the app takes no second account.
        expect(results.get("Pasted mail")?.note).toBe(
          "Its fixed header CLIENT_ID, header CLIENT_SECRET repeated its OAuth client's own credentials, so they are not sent.",
        );
        const pastedApp = inventory.apps.find((entry) => entry.name === "Pasted mail")?.id;
        const pastedAccount = inventory.accounts.find((entry) => entry.label === "pasted")?.id;
        expect(inventory.links.filter((link) => link.app === pastedApp)).toEqual([
          { app: pastedApp, account: pastedAccount },
        ]);
        const pastedSent = yield* call(
          "Call the pasted API as the pasted account",
          "POST",
          `/api/organizations/${target.id}/apps/${pastedApp}/tools/call`,
          { tool: "mail.me", kind: "query", input: { accountId: pastedAccount, input: {} } },
        );
        expect(pastedSent.status, JSON.stringify(pastedSent.body)).toBe(200);
        expect((yield* service.gated).at(-1)).toEqual({
          authorization: "Bearer synthetic-pasted-access",
          "cf-access-client-id": undefined,
          "cf-access-client-secret": undefined,
          client_id: undefined,
          client_secret: undefined,
        });
        expect(yield* service.tokens).toHaveLength(1);
      }).pipe(Effect.provide(services)),
    ),
  );

  /**
   * v1 reads an organization's connections in creation order, then by row ID. A seed creates them
   * at once with random row IDs, so the copied organization and its own are put in the same order,
   * as one organization's rows always are.
   */
  const orderConnections = (organization: string) =>
    writeRows("v1-database.json", [
      {
        sql: `update connection c set created_at = timestamptz '2026-01-01' + (
            select count(*) from connection o where o.tenant = c.tenant and o.name < c.name
          ) * interval '1 second' where c.tenant = $1`,
        params: [organization],
      },
    ]);

  it.effect(
    scenarios.v1ImportCopiedMove.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const emulators = yield* Emulators;
          const operator = yield* v1ImportOperator;
          const service = yield* oauthService;
          const identity = yield* emulators.identity("google");
          // The opt-in import copied an organization to v2 while v1 kept serving it: imported, with
          // no import instance and not moved. The copy is made by importing a twin organization
          // and handing its import map to this one, whose rows match the twin's by name.
          const twin = yield* emulators.v1Workspace([identity.email]);
          const copySlug = `v1-${randomUUID().slice(0, 8)}`;
          const names = randomUUID().slice(0, 6);
          yield* seedRenewal(twin.organization, twin.user, copySlug, service.origin, names);
          // The copy also got a connection its v1 organization no longer has when it moves.
          yield* writeRows("v1-database.json", [
            {
              sql: `insert into connection (tenant, owner, subject, integration, name, template, item_ids, oauth_client, oauth_client_owner, refresh_item_id, expires_at, oauth_scope, oauth_token_url)
                select tenant, owner, subject, integration, 'spare', template, item_ids, oauth_client, oauth_client_owner, refresh_item_id, expires_at, oauth_scope, oauth_token_url
                from connection where tenant = $1 and name = 'second'`,
              params: [twin.organization],
            },
          ]);
          yield* orderConnections(twin.organization);
          yield* googleSignIn(identity.email);
          const target = (yield* importOnServer(twin.organization)).target;
          expect(target.slug).toBe(copySlug);
          const own = yield* emulators.v1Workspace([identity.email]);
          const slug = `v1-${randomUUID().slice(0, 8)}`;
          yield* seedRenewal(own.organization, own.user, slug, service.origin, names);
          yield* orderConnections(own.organization);
          const [pairs = []] = yield* writeRows("v1-database.json", [
            {
              sql: `select twin.row_id as twin, own.row_id as own from (
                  select row_id, 'integration:' || name as key from integration where tenant = $1
                  union all select row_id, 'connection:' || name from connection where tenant = $1
                  union all select row_id, 'tool_policy:' || pattern from tool_policy where tenant = $1
                ) twin join (
                  select row_id, 'integration:' || name as key from integration where tenant = $2
                  union all select row_id, 'connection:' || name from connection where tenant = $2
                  union all select row_id, 'tool_policy:' || pattern from tool_policy where tenant = $2
                ) own using (key)`,
              params: [twin.organization, own.organization],
            },
          ]);
          const matched = yield* Schema.decodeUnknownEffect(
            Schema.Array(Schema.Struct({ twin: Schema.String, own: Schema.String })),
          )(pairs);
          yield* writeRows("sso-database.json", [
            ...[...matched, { twin: twin.organization, own: own.organization }].map((pair) => ({
              sql: "update private_v1_import_map set v1_id = $2 where v1_org_id = $3 and v1_id = $1",
              params: [pair.twin, pair.own, twin.organization],
            })),
            {
              sql: "update private_v1_import_map set v1_org_id = $2 where v1_org_id = $1",
              params: [twin.organization, own.organization],
            },
          ]);
          const inventory = yield* call(
            "Read the copied organization",
            "GET",
            `/api/organizations/${target.id}/inventory`,
          ).pipe(Effect.flatMap((response) => decode(Inventory, response)));
          const accountOf = (label: string) =>
            inventory.accounts.find((entry) => entry.label === label)?.id;
          const callMail = (step: string, label: string) =>
            call(step, "POST", `/api/organizations/${target.id}/apps/${appOf("Mail")}/tools/call`, {
              tool: "mail.me",
              kind: "query",
              input: { accountId: accountOf(label), input: {} },
            });
          const appOf = (name: string) => inventory.apps.find((entry) => entry.name === name)?.id;
          const expectMail = (step: string, label: string) =>
            callMail(step, label).pipe(
              Effect.map((sent) => expect(sent.status, JSON.stringify(sent.body)).toBe(200)),
            );

          // v2 renews the expired account on its first call.
          yield* expectMail("Call the mail API as the renewed account", "renewed");
          expect(yield* service.tokens).toHaveLength(1);

          // v1 renews the second account later, and the service rotates its refresh token: v1 now
          // holds the only tokens that work, which expire after the ones copied to v2.
          const rotated = randomUUID().slice(0, 8);
          const userScope = `executor/user/${encodeURIComponent(own.organization)}/${encodeURIComponent(own.user)}`;
          yield* emulators.v1VaultObject(
            vaultName(userScope, `oauth:user:rotated${rotated}:second`),
            service.renewedToken,
          );
          yield* emulators.v1VaultObject(
            vaultName(userScope, `oauth:user:rotated${rotated}:second:refresh`),
            "synthetic-second-rotated-refresh",
          );
          yield* writeRows("v1-database.json", [
            {
              sql: "update connection set item_ids = $2::json, refresh_item_id = $3, expires_at = $4::bigint where tenant = $1 and name = 'second'",
              params: [
                own.organization,
                JSON.stringify({ token: `oauth:user:rotated${rotated}:second` }),
                `oauth:user:rotated${rotated}:second:refresh`,
                String(Date.now() + 7_200_000),
              ],
            },
          ]);
          // A member changes an imported app in v2, and its integration changes in v1.
          const gated = appOf("Gated mail");
          const edited = (yield* appSource(target.id, gated)).map((file) =>
            file.path === "index.ts"
              ? { ...file, content: `${file.content}\n// edited in v2\n` }
              : file,
          );
          const redeployed = yield* call(
            "Deploy a member's version of the gated app",
            "POST",
            `/api/organizations/${target.id}/apps/${gated}/deploy`,
            { files: edited },
          );
          expect(redeployed.status, JSON.stringify(redeployed.body)).toBe(200);
          yield* writeRows("v1-database.json", [
            {
              sql: "insert into tool_policy (tenant, owner, subject, pattern, action) values ($1, 'org', '', 'removed_service.*', 'block')",
              params: [own.organization],
            },
            // The member removes in v1 the connection that could not move.
            {
              sql: "delete from connection where tenant = $1 and name = 'untrusted'",
              params: [own.organization],
            },
            // They rename the mail integration, which gives its app another provider.
            {
              sql: "update integration set name = 'Team mail' where tenant = $1 and name = 'Mail'",
              params: [own.organization],
            },
          ]);
          // In v2 they remove an app and two accounts, and add a teammate.
          expect(accountOf("spare")).toBeDefined();
          for (const [step, path] of [
            ["Remove the pasted app in v2", `apps/${appOf("Pasted mail")}`],
            ["Remove the pasted account in v2", `accounts/${accountOf("pasted")}`],
            ["Remove the spare account in v2", `accounts/${accountOf("spare")}`],
          ] as const) {
            const removed = yield* call(step, "DELETE", `/api/organizations/${target.id}/${path}`);
            expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300);
          }
          const teammate = randomUUID();
          yield* writeRows("sso-database.json", [
            {
              sql: `insert into "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") values ($1, 'Teammate', $2, true, now(), now())`,
              params: [teammate, `teammate-${teammate.slice(0, 8)}@example.test`],
            },
            {
              sql: `insert into member (id, "organizationId", "userId", role, "createdAt") values ($1, $2, $3, 'member', now())`,
              params: [randomUUID(), target.id, teammate],
            },
          ]);

          // The dry run reports the copy's slug, which the move keeps.
          const dryRun = v1RunId("copied-dry-run");
          const checked = yield* operator.start({
            mode: "dry-run",
            runId: dryRun,
            organizations: [own.organization],
          });
          expect(checked.status, JSON.stringify(checked.body)).toBe(200);
          expect((yield* operator.waitForReport(dryRun, own.organization)).slug).toEqual({
            v1: slug,
            v2: copySlug,
            changed: true,
          });

          const moved = yield* importOnServer(own.organization);
          expect(moved.report.cutover, JSON.stringify(moved.report.verification)).toBe(true);
          expect(moved.target).toEqual(target);
          // What the member removed in v2 stays removed.
          const removedInV2 = {
            status: "skipped",
            reason: "Its users removed it in v2 after an earlier run imported it.",
          };
          expect(moved.results.get("Pasted mail")).toEqual(removedInV2);
          expect(moved.results.get("pasted")).toMatchObject(removedInV2);
          // The second account takes v1's newer tokens; the renewed one keeps v2's own renewal. Both
          // move to the renamed app's provider, so calls can still select them.
          const followed = "Moved to its app's new sign-in methods.";
          expect(moved.results.get("second")).toMatchObject({
            status: "imported",
            note: `Took v1's newer sign-in. ${followed}`,
          });
          expect(moved.results.get("renewed")?.note).toBe(followed);
          // The spare account, removed in v2 and its connection in v1, is neither moved nor verified.
          expect(moved.results.has("spare")).toBe(false);
          yield* expectMail("Call the mail API as the second account", "second");
          yield* expectMail("Call the mail API as the renewed account again", "renewed");
          expect((yield* service.calls).slice(-2)).toEqual([
            `Bearer ${service.renewedToken}`,
            `Bearer ${service.renewedToken}`,
          ]);
          expect(yield* service.tokens).toHaveLength(1);
          // The member's version of the gated app stands; the others follow v1's change.
          expect(moved.results.get("Gated mail")).toMatchObject({
            status: "imported",
            note: "Kept as its users changed it in v2 after an earlier run imported it.",
          });
          expect(
            (yield* appSource(target.id, gated)).find((file) => file.path === "index.ts")?.content,
          ).toContain("// edited in v2");
        }).pipe(Effect.provide(services)),
      ),
    // It copies the organization, checks it again and moves it: three runs of the import.
    { timeout: 180_000 },
  );

  it.effect(scenarios.v1ImportFirstParty.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const target = yield* Target;
        const fs = yield* FileSystem.FileSystem;
        // This local Cloud started with the clients v1's first-party connections move to, whose
        // service is on a port it reserved; start the service there.
        const operator = yield* fs
          .readFileString(`${target.directory}/${operatorOAuthFile}`)
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(OperatorOAuthFixture))),
          );
        const service = yield* firstPartyService(operator.v1Port);
        const { origin } = service;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        yield* seedFirstParty(own.organization, own.user, `v1-${randomUUID().slice(0, 8)}`, origin);
        yield* googleSignIn(identity.email);

        // The dry run names every connection whose account the import would leave out, with the
        // reason the import gives. Each moves without its account, for its owner to connect again,
        // except one through a first-party client v2 does not offer, which blocks the organization.
        const importer = yield* v1ImportOperator;
        const dry = v1RunId("first-party-dry");
        const started = yield* importer.start({
          mode: "dry-run",
          runId: dry,
          organizations: [own.organization],
        });
        expect(started.status, JSON.stringify(started.body)).toBe(200);
        const planned = yield* importer.waitForReport(dry, own.organization);
        expect(planned.status).toBe("blocked");
        expect(planned.integrationFailures).toEqual([]);
        expect(planned.vaultFailures).toEqual([]);
        expect(planned.staleItems).toEqual([]);
        expect(
          planned.connectionFailures.flatMap((failure) =>
            failure.reconnect === true ? [] : failure.connections.map((c) => c.label),
          ),
        ).toEqual(["notion"]);
        const predicted = Object.fromEntries(
          planned.connectionFailures.flatMap((failure) =>
            failure.connections.map((connection) => [connection.label, failure.reason] as const),
          ),
        );
        const githubHosts = v1GitHubHosts(origin);
        const elsewhere = `Executor v2's own V1-github app sends its tokens only to ${new URL(origin).host}, and its integration calls none of them. Reconnect it in v2.`;
        expect(predicted).toEqual({
          notion:
            "It signed in through Executor's own Notion app, which Executor v2 does not offer yet. Reconnect it in v2.",
          beyond:
            "It was granted permissions Executor v2's own V1-google app does not allow. Reconnect it in v2.",
          // The GitHub client's tokens go only to its pinned host, which neither this API nor
          // this MCP server is on.
          elsewhere,
          "mcp-elsewhere": elsewhere,
          // A client whose tokens reach only one of an API's two hosts would leave the other's
          // calls refused, so the account is not imported, and the reason names that host.
          apionly: `Executor v2's own V1-github-api app sends its tokens only to ${githubHosts.api}, and its integration also calls ${githubHosts.uploads}, where its calls would be refused. Reconnect it in v2.`,
          // Slack's MCP server names Slack's authorization server, not the GitHub client's.
          "wrong-server":
            "Its integration does not sign in where Executor v2's own V1-github app does. Reconnect it in v2.",
          // Its resource metadata names the resource at `/github/mcp`, not this server.
          moved: "Its sign-in could not be carried over to v2. Reconnect it in v2.",
        });

        const { target: organization, results, items } = yield* importOnServer(own.organization);
        // The import leaves out exactly the accounts its dry run did, for the same reasons, and
        // imports every other connection.
        const connections = items.filter((item) => item.kind === "connection");
        expect(connections).toHaveLength(12);
        expect(
          Object.fromEntries(
            connections
              .filter((item) => item.status !== "imported")
              .map((item) => [item.label, resultOf(item)] as const),
          ),
        ).toEqual(
          Object.fromEntries(
            Object.entries(predicted).map(([label, reason]) => [
              label,
              { status: label === "notion" ? "failed" : "skipped", reason },
            ]),
          ),
        );
        for (const name of [
          "Synthetic Google",
          "Synthetic GitHub",
          "GitHub elsewhere",
          "Synthetic Slack",
          "GitHub two hosts",
          "GitHub one host",
          "Synthetic GitHub MCP",
          "GitHub MCP elsewhere",
          "GitHub MCP on Slack's server",
          "GitHub MCP moved",
          "google",
          "github",
          "slack",
          "both",
          "github-mcp",
        ])
          expect(results.get(name)?.status, results.get(name)?.reason).toBe("imported");

        const inventory = yield* call(
          "Read the new organization",
          "GET",
          `/api/organizations/${organization.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(FirstPartyInventory, response)));
        const appOf = (name: string) => inventory.apps.find((entry) => entry.name === name)?.id;
        const accountOf = (label: string) =>
          inventory.accounts.find((entry) => entry.label === label);
        expect(accountOf("apionly")).toBeUndefined();

        // The apps sign in at the operator clients' endpoints, never the methods' own, so a
        // reconnect of each account offers its client.
        for (const [name, client] of [
          ["Synthetic Google", "google"],
          ["Synthetic GitHub", "github"],
        ] as const) {
          const source = yield* call(
            `Read the ${name} app's deployed source`,
            "GET",
            `/api/organizations/${organization.id}/apps/${appOf(name)}/source`,
          );
          expect(source.status, JSON.stringify(source.body)).toBe(200);
          const written = JSON.stringify((yield* decode(Source, source)).files);
          for (const url of [`${origin}/${client}/authorize`, `${origin}/${client}/token`])
            expect(written).toContain(JSON.stringify(url).slice(1, -1));
          expect(written).not.toContain(".example.com");
        }
        // GitHub's MCP server names the GitHub client's endpoints itself, and its app asks for no
        // scopes, as v1 asked the GitHub App for none, so a reconnect offers that client too.
        for (const [label, client] of [
          ["google", "Executor for Synthetic Google"],
          ["github", "Executor for Synthetic GitHub"],
          ["github-mcp", "Executor for Synthetic GitHub"],
        ] as const) {
          const account = accountOf(label);
          if (account === undefined) return yield* Effect.die(`No ${label} account`);
          const setup = yield* call(
            `Read how the ${label} account signs in again`,
            "GET",
            `/api/organizations/${organization.id}/providers/${account.provider}/oauth/${account.method}/setup`,
          );
          expect(setup.status, JSON.stringify(setup.body)).toBe(200);
          expect((yield* decode(SignInSetup, setup)).firstParty).toEqual({ label: client });
        }

        // Each account's expired token renews with the operator's client, asking again for the
        // scopes v1 recorded, and its call carries the renewed token. The renewal happens on the
        // first call, or before it when Cloud's minute schedule reconciles the account's link,
        // so each account's renewal is found by the refresh token v1 held rather than its position
        // or its client's path, which the GitHub and GitHub MCP accounts share. Renewals of one
        // grant are serialized and the renewed token outlives the test, so each renews once.
        const callAs = (label: string, app: string, tool: string) =>
          Effect.gen(function* () {
            const account = accountOf(label)?.id;
            expect(
              inventory.links.some((link) => link.app === appOf(app) && link.account === account),
              label,
            ).toBe(true);
            const sent = yield* call(
              `Call ${tool} as the ${label} account`,
              "POST",
              `/api/organizations/${organization.id}/apps/${appOf(app)}/tools/call`,
              {
                tool,
                kind: "query",
                input: { accountId: account, input: {} },
              },
            );
            expect(sent.status, JSON.stringify(sent.body)).toBe(200);
          });
        const credentials = (client: keyof typeof v1FirstPartyCredentials) => ({
          client_id: v1FirstPartyCredentials[client].clientId,
          client_secret: v1FirstPartyCredentials[client].secret,
        });
        const renewals = Effect.map(service.tokens, (all) =>
          all.map((request) => ({ path: request.path, form: Object.fromEntries(request.form) })),
        );
        const lastCall = Effect.map(service.calls, (all) => {
          const last = all.at(-1);
          if (last === undefined) return undefined;
          const { host: _host, ...call } = last;
          return call;
        });
        // The one renewal each expired account makes, by the refresh token v1 held.
        const expected: Record<string, { path: string; form: Record<string, string> }> = {
          "synthetic-google-refresh": {
            path: "/google/token",
            form: {
              grant_type: "refresh_token",
              refresh_token: "synthetic-google-refresh",
              scope: "openid synthetic.read",
              ...credentials("v1-google"),
            },
          },
          // v1 recorded no scopes for the GitHub App, so its renewal asks for none.
          "synthetic-github-refresh": {
            path: "/github/token",
            form: {
              grant_type: "refresh_token",
              refresh_token: "synthetic-github-refresh",
              ...credentials("v1-github"),
            },
          },
          // The unlisted Slack client renews the grant it holds, with its own resource.
          "synthetic-slack-refresh": {
            path: "/slack/token",
            form: {
              grant_type: "refresh_token",
              refresh_token: "synthetic-slack-refresh",
              scope: v1SlackScopes.join(" "),
              resource: `${origin}/slack`,
              ...credentials("v1-slack"),
            },
          },
          // The GitHub MCP account renews with the GitHub client at its own token endpoint,
          // asking for no scopes and sending no resource.
          "synthetic-github-mcp-refresh": {
            path: "/github/token",
            form: {
              grant_type: "refresh_token",
              refresh_token: "synthetic-github-mcp-refresh",
              ...credentials("v1-github"),
            },
          },
        };
        const renewedWith = (refresh: string) =>
          Effect.gen(function* () {
            const own = (yield* renewals).filter((entry) => entry.form.refresh_token === refresh);
            expect(own, refresh).toEqual([expected[refresh]]);
          });

        yield* callAs("google", "Synthetic Google", "google.me");
        yield* renewedWith("synthetic-google-refresh");
        expect(yield* lastCall).toEqual({
          path: "/google/api/me",
          authorization: `Bearer ${service.renewed("google")}`,
        });

        yield* callAs("github", "Synthetic GitHub", "github.user");
        yield* renewedWith("synthetic-github-refresh");
        expect(yield* lastCall).toEqual({
          path: "/github/api/user",
          authorization: `Bearer ${service.renewed("github")}`,
        });

        // The Slack account reads the user's token from `authed_user`. Slack's MCP server
        // answers only it.
        yield* callAs("slack", "Synthetic Slack", "whoami");
        yield* renewedWith("synthetic-slack-refresh");
        expect(yield* lastCall).toEqual({
          path: "/slack/mcp",
          authorization: `Bearer ${service.renewed("slack")}`,
        });

        // The GitHub MCP account's tool call carries the GitHub client's renewed token to the
        // MCP server.
        yield* callAs("github-mcp", "Synthetic GitHub MCP", "whoami");
        yield* renewedWith("synthetic-github-mcp-refresh");
        expect(yield* lastCall).toEqual({
          path: "/github/mcp",
          authorization: `Bearer ${service.renewed("github")}`,
        });
        // One renewal each, and none for the accounts that have not expired.
        expect(yield* renewals).toHaveLength(Object.keys(expected).length);

        // A client whose tokens go to both of an API's hosts places its managed token on the
        // calls to each host.
        yield* callAs("both", "GitHub two hosts", "github.user");
        yield* callAs("both", "GitHub two hosts", "github.asset");
        expect(
          (yield* service.calls).filter((entry) => entry.path.startsWith("/github-both/")),
        ).toEqual([
          {
            host: githubHosts.api,
            path: "/github-both/api/user",
            authorization: "Bearer synthetic-both-access",
          },
          {
            host: githubHosts.uploads,
            path: "/github-both/uploads/asset",
            authorization: "Bearer synthetic-both-access",
          },
        ]);
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportBuilds.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const upstream = yield* credentialUpstream;
        const signIn = yield* signInService;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        yield* seedBuilds(
          own.organization,
          own.user,
          `v1-${randomUUID().slice(0, 8)}`,
          upstream.origin,
          signIn.origin,
        );
        yield* googleSignIn(identity.email);

        const { target, results } = yield* importOnServer(
          own.organization,
          (item) =>
            `${item.kind}:${item.label}${item.context === null ? "" : ` · ${item.context}`}`,
        );
        // A connection whose v1 authorization request a v2 sign-in method cannot send as v1 sent
        // it is refused, while its integration still imports: `nonce`, which v2 cannot send; a
        // repeated `scope`, which v2 would join into one; and a `resource` v1 sent only to the
        // authorization endpoint, which v2 would also send when exchanging and refreshing tokens.
        for (const [label, reason] of [
          [
            "nonced",
            "Its OAuth client's authorization URL sets nonce, which an Executor v2 sign-in method cannot send. Reconnect it in v2.",
          ],
          [
            "repeated",
            "Its OAuth client's authorization URL sets scope more than once, which an Executor v2 sign-in method cannot send as v1 did. Reconnect it in v2.",
          ],
          [
            "targeted",
            "Its OAuth client's authorization URL sets resource, which v1 sent only when signing in and an Executor v2 sign-in method would also send when exchanging and refreshing tokens. Reconnect it in v2.",
          ],
        ] as const)
          expect(results.get(`connection:${label} · Synthetic GraphQL`), label).toEqual({
            status: "skipped",
            reason,
          });

        // The document is ASCII JSON: each character beyond ASCII is a `\u` escape, and the
        // document reads as v1's.
        const typography = results.get("integration:Typography");
        expect(typography?.status, typography?.reason).toBe("imported");
        const source = yield* call(
          "Read the Typography app's source",
          "GET",
          `/api/organizations/${target.id}/apps/${typography?.v2Id}/source`,
        ).pipe(Effect.flatMap((response) => decode(Source, response)));
        const configuration = source.files.find((file) => file.path === "openapi.json")?.content;
        if (configuration === undefined) return yield* Effect.die("The app has no openapi.json");
        expect(configuration).not.toMatch(/[\u0080-\uffff]/);
        expect(configuration).toContain("\\u2019");
        expect(
          Schema.decodeUnknownSync(
            Schema.Struct({
              source: Schema.Struct({
                document: Schema.Struct({
                  paths: Schema.Struct({
                    "/health": Schema.Struct({
                      get: Schema.Struct({ description: Schema.String }),
                    }),
                  }),
                }),
              }),
            }),
          )(JSON.parse(configuration)).source.document.paths["/health"].get.description,
        ).toBe(wideText);
        const health = yield* call(
          "Call the Typography API",
          "POST",
          `/api/organizations/${target.id}/apps/${typography?.v2Id}/tools/call`,
          { tool: "typography.health", kind: "query", input: {} },
        );
        expect(health.status, JSON.stringify(health.body)).toBe(200);
        expect((yield* upstream.received).at(-1)?.url).toBe("/public/health");

        // A large app whose name and base URL go beyond Latin-1 writes its whole document file in
        // ASCII, reads back the same base URL, keeps its name in its provider, builds and calls
        // the API with the key saved in v1.
        const kanji = results.get(`integration:${wideName}`);
        expect(kanji?.status, kanji?.reason).toBe("imported");
        expect(results.get(`connection:main · ${wideName}`)?.status).toBe("imported");
        const kanjiSource = yield* call(
          "Read the large app's source",
          "GET",
          `/api/organizations/${target.id}/apps/${kanji?.v2Id}/source`,
        ).pipe(Effect.flatMap((response) => decode(Source, response)));
        const kanjiConfiguration = kanjiSource.files.find(
          (file) => file.path === "openapi.json",
        )?.content;
        if (kanjiConfiguration === undefined)
          return yield* Effect.die("The large app has no openapi.json");
        expect(kanjiConfiguration.length).toBeGreaterThan(13_600_000);
        expect(kanjiConfiguration).not.toMatch(/[\u0080-\uffff]/);
        expect(
          Schema.decodeUnknownSync(Schema.Struct({ baseUrl: Schema.String }))(
            JSON.parse(kanjiConfiguration),
          ).baseUrl,
        ).toBe(`${upstream.origin}${widePath}`);
        expect(kanjiSource.files.find((file) => file.path === "provider.ts")?.content).toContain(
          JSON.stringify(wideName),
        );
        const inventory = yield* call(
          "Read the new organization",
          "GET",
          `/api/organizations/${target.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(Inventory, response)));
        const account = inventory.links.find((link) => link.app === kanji?.v2Id)?.account;
        expect(account).toBeDefined();
        const kanjiHealth = yield* call(
          "Call the large API",
          "POST",
          `/api/organizations/${target.id}/apps/${kanji?.v2Id}/tools/call`,
          {
            tool: "service.health",
            kind: "query",
            input: { accountId: account, input: {} },
          },
        );
        expect(kanjiHealth.status, JSON.stringify(kanjiHealth.body)).toBe(200);
        const received = (yield* upstream.received).at(-1);
        expect(received?.url).toBe(`${encodeURI(widePath)}/health`);
        expect(received?.headers["x-api-key"]).toBe("synthetic-kanji-key");

        // A v1 client whose authorization URL sets `scope` signs in with those scopes, which a v2
        // declaration leaves to the host, at the URL without it.
        const scoped = results.get("integration:Scoped");
        expect(scoped?.status, scoped?.reason).toBe("imported");
        expect(results.get("connection:main · Scoped")?.status).toBe("imported");
        expect(yield* oauthDeclarations(target.id, scoped?.v2Id)).toEqual([
          {
            authorizationUrl: `${signIn.origin}/authorize`,
            tokenUrl: `${signIn.origin}/token`,
            scopes: ["everything", "profile"],
          },
        ]);

        // A GraphQL integration whose OAuth method names no endpoints signs each connection in at
        // its client's, asking for the scope the client's URL asked for exactly as v1 sent it:
        // comma-separated scopes as one value, a tab kept inside its value, an empty scope as one
        // empty value and two spaces as an empty value between two others. Its bare API key
        // imports beside it.
        const linear = results.get("integration:Synthetic GraphQL");
        expect(linear?.status, linear?.reason).toBe("imported");
        for (const name of ["main", "tabbed", "blank", "doubled", "key"])
          expect(results.get(`connection:${name} · Synthetic GraphQL`)?.status).toBe("imported");
        const linearDeclarations = yield* oauthDeclarations(target.id, linear?.v2Id);
        expect(linearDeclarations).toHaveLength(4);
        expect(linearDeclarations).toEqual(
          expect.arrayContaining(
            [["read,write"], ["read\twrite"], [""], ["read", "", "write"]].map((scopes) => ({
              authorizationUrl: `${signIn.origin}/oauth/authorize`,
              tokenUrl: `${signIn.origin}/oauth/token`,
              scopes,
            })),
          ),
        );

        // Reconnecting an imported account sends the authorization request v1 sent, with only the
        // host's own parameters added, and exchanges its code with nothing v1 did not send.
        const signInInventory = yield* call(
          "Read the imported organization's accounts",
          "GET",
          `/api/organizations/${target.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(FirstPartyInventory, response)));
        const reconnect = (app: string | undefined, label: string) =>
          Effect.gen(function* () {
            const appPath = `/api/organizations/${target.id}/apps/${app}`;
            const links = yield* call(
              `List the importer's links of the ${label} account's app`,
              "GET",
              `${appPath}/accounts/user`,
            ).pipe(Effect.flatMap((response) => decode(Schema.Array(AccountLink), response)));
            const [selected] = links.flatMap((link) => {
              const account = signInInventory.accounts.find(
                (entry) => entry.id === link.account.id && entry.label === label,
              );
              return account === undefined ? [] : [{ requirement: link.requirement, account }];
            });
            if (selected === undefined) return yield* Effect.die(`No ${label} account`);
            const connection = yield* call(
              `Reconnect the ${label} account`,
              "POST",
              connectionsPath(appPath, "user", selected.requirement),
              { account: selected.account.id },
            );
            expect(connection.status, JSON.stringify(connection.body)).toBe(200);
            const { id } = yield* decode(Schema.Struct({ id: Schema.String }), connection);
            const started = yield* call(
              `Start the ${label} account's sign-in`,
              "POST",
              `/api/organizations/${target.id}/connections/${id}/oauth/start`,
              { method: selected.account.method },
            );
            expect(started.status, JSON.stringify(started.body)).toBe(200);
            const { authorizationUrl } = yield* decode(
              Schema.Struct({ authorizationUrl: Schema.String }),
              started,
            );
            const consent = yield* HttpClient.get(authorizationUrl).pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
            );
            expect(consent.status).toBe(302);
            const callbackUrl = consent.headers.location;
            if (callbackUrl === undefined) return yield* Effect.die("The sign-in did not return");
            const completed = yield* call(
              `Complete the ${label} account's sign-in`,
              "POST",
              `/api/organizations/${target.id}/connections/${id}/oauth/complete`,
              { callbackUrl },
            );
            expect(completed.status, JSON.stringify(completed.body)).toBe(200);
            const authorization = (yield* signIn.authorizations).at(-1);
            const token = (yield* signIn.tokens).at(-1);
            const redirect = new URL(authorizationUrl).searchParams.get("redirect_uri");
            return { authorization, token, redirect };
          });
        for (const [app, label, prefix, client, scope] of [
          [scoped?.v2Id, "main", "", "synthetic-scoped-client", "everything profile"],
          [linear?.v2Id, "main", "/oauth", "synthetic-graphql-client", "read,write"],
          [linear?.v2Id, "tabbed", "/oauth", "synthetic-graphql-tabbed-client", "read\twrite"],
          [linear?.v2Id, "blank", "/oauth", "synthetic-graphql-blank-client", ""],
          [linear?.v2Id, "doubled", "/oauth", "synthetic-graphql-doubled-client", "read  write"],
        ] as const) {
          const { authorization, token, redirect } = yield* reconnect(app, label);
          expect(authorization?.path, label).toBe(`${prefix}/authorize`);
          expect(parameterRecord(authorization?.query ?? []), label).toEqual({
            values: {
              response_type: "code",
              client_id: client,
              redirect_uri: redirect,
              state: expect.any(String),
              code_challenge: expect.any(String),
              code_challenge_method: "S256",
              scope,
            },
            names: [
              "client_id",
              "code_challenge",
              "code_challenge_method",
              "redirect_uri",
              "response_type",
              "scope",
              "state",
            ],
          });
          expect(token?.path, label).toBe(`${prefix}/token`);
          expect(parameterRecord(token?.form ?? []), label).toEqual({
            values: {
              grant_type: "authorization_code",
              code: "synthetic-code",
              redirect_uri: redirect,
              code_verifier: expect.any(String),
              client_id: client,
            },
            names: ["client_id", "code", "code_verifier", "grant_type", "redirect_uri"],
          });
        }
        const graphqlProvider = (yield* appSource(target.id, linear?.v2Id)).find(
          (file) => file.path === "provider.ts",
        )?.content;
        expect(graphqlProvider).toContain('["Authorization"]: account.fields["token"]');

        // A stored specification that cannot be read says why and where, without its contents. v1
        // could not read it either, so it is skipped.
        expect(results.get("integration:Unreadable")).toMatchObject({
          status: "skipped",
          reason:
            "v1's stored specification could not be read: it is not JSON, and as YAML, bad indentation of a mapping entry at line 4, column 11 (81 bytes).",
        });
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportMicrosoftGraph.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        const seeded = yield* seedGraph(own.organization, `v1-${randomUUID().slice(0, 8)}`);
        yield* googleSignIn(identity.email);

        const { target, results } = yield* importOnServer(own.organization);
        const inventory = yield* call(
          "Read the new organization",
          "GET",
          `/api/organizations/${target.id}/inventory`,
        ).pipe(Effect.flatMap((response) => decode(Inventory, response)));
        // Each preset's app has exactly the operations v1 kept for it, under v1's names, and of the
        // shared document only the components they reach: none of the areas it left out, no
        // examples, no security schemes and no security requirements.
        for (const preset of seeded.presets.slice(0, 2)) {
          const result = results.get(preset.name);
          expect(result?.status, result?.reason).toBe("imported");
          const app = inventory.apps.find((entry) => entry.name === preset.name)?.id;
          const operations = preset.areas.flatMap((area) => area.operations);
          const listed = yield* call(
            `List the ${preset.name} app's tools`,
            "GET",
            `/api/organizations/${target.id}/apps/${app}/tools`,
          );
          expect(listed.status, JSON.stringify(listed.body)).toBe(200);
          expect((yield* decode(Tools, listed)).items.map((tool) => tool.name).sort()).toEqual(
            operations.map(([tool]) => tool).sort(),
          );
          const configuration = (yield* appSource(target.id, app)).find(
            (file) => file.path === "openapi.json",
          )?.content;
          if (configuration === undefined)
            return yield* Effect.die(`The ${preset.name} app has no openapi.json`);
          const { document } = Schema.decodeUnknownSync(
            Schema.fromJsonString(
              Schema.Struct({
                source: Schema.Struct({
                  document: Schema.Record(Schema.String, Schema.Unknown),
                }),
              }),
            ),
          )(configuration).source;
          expect(Object.keys(document)).toEqual([
            "openapi",
            "info",
            "servers",
            "paths",
            "components",
            "tags",
          ]);
          const Sections = Schema.Record(
            Schema.String,
            Schema.Record(Schema.String, Schema.Unknown),
          );
          const paths = Schema.decodeUnknownSync(Sections)(document.paths);
          expect(
            Object.entries(paths)
              .flatMap(([path, item]) =>
                Object.keys(item)
                  .filter((key) => key !== "description" && key !== "parameters")
                  .map((method) => `${method} ${path}`),
              )
              .sort(),
          ).toEqual(operations.map(([, method, path]) => `${method} ${path}`).sort());
          const components = Schema.decodeUnknownSync(Sections)(document.components);
          expect(
            Object.fromEntries(
              Object.entries(components).map(([section, entries]) => [
                section,
                Object.keys(entries).sort(),
              ]),
            ),
          ).toEqual(graphComponents(preset.areas));
        }
        // An entry the preset's cut reaches cannot be parsed, so v1 could not read it either; the
        // reason names the line and column of the document, as for a document parsed whole.
        expect(results.get("Graph Tasks")).toMatchObject({
          status: "skipped",
          reason: `v1's stored specification could not be read: as YAML, bad indentation of a mapping entry at line ${seeded.broken.line}, column 12 (${seeded.broken.bytes} bytes).`,
        });
        expect(results.get("Graph Files")).toMatchObject({
          status: "failed",
          reason:
            "v1's stored Microsoft Graph specification is not block YAML the import can read one entry at a time, as v1 read it: line 1 holds no key it can read.",
        });
      }).pipe(Effect.provide(services)),
    ),
  );

  it.effect(scenarios.v1ImportPlanOutage.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const emulators = yield* Emulators;
        const operator = yield* v1ImportOperator;
        const identity = yield* emulators.identity("google");
        const own = yield* emulators.v1Workspace([identity.email]);
        yield* seedPlainWorkspace(own.organization, `v1-${randomUUID().slice(0, 8)}`);

        const armed: string[] = [];
        yield* Effect.gen(function* () {
          // A plan read that never answers in time, then one that fails: the read is retried and
          // the organization is still assessed.
          for (const fault of [{ status: 200, delayMs: 12_000 }, { status: 502 }])
            armed.push(yield* emulators.failAutumnReads("customers.get", { ...fault, times: 1 }));
          const run = v1RunId("outage");
          const started = yield* operator.start({
            mode: "dry-run",
            runId: run,
            organizations: [own.organization],
          });
          expect(started.status, JSON.stringify(started.body)).toBe(200);
          const report = yield* operator.waitForReport(run, own.organization);
          expect(report.status).toBe("planned");
          expect(report.flags.paidPlans).toEqual([]);
          const faults = yield* emulators.autumnFaults;
          for (const id of armed) expect(faults.has(id)).toBe(false);
        }).pipe(
          // The import's later scenarios read plans on this emulator too.
          Effect.ensuring(
            Effect.forEach(armed, emulators.clearAutumnFault, { discard: true }).pipe(Effect.orDie),
          ),
        );
      }).pipe(Effect.provide(services)),
    ),
  );
});
