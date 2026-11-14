import { expect, layer } from "@effect/vitest";
import { Clock, Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App, Resource } from "../support/contracts.ts";
import { holdQuery } from "../support/query-transition.ts";
import { providerErrorUpstream, providerSecretMarker } from "../support/provider-error-upstream.ts";
import { authoredAppFiles } from "../support/authored-templates.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";
import { connectionsPath } from "../support/app-accounts.ts";

const Failure = Schema.Struct({
  _tag: Schema.Literal("AppProviderFailed"),
  message: Schema.String,
  reason: Schema.String,
  status: Schema.Number,
  phase: Schema.optional(Schema.String),
  upstream: Schema.optional(
    Schema.Struct({
      code: Schema.Union([Schema.String, Schema.Number]),
      message: Schema.optional(Schema.String),
    }),
  ),
  account: Schema.optional(
    Schema.Struct({ id: Schema.String, label: Schema.String, provider: Schema.String }),
  ),
});

/** A listing whose routers report what could not be listed beside the tools that could. */
const Listing = Schema.Struct({
  items: Schema.Array(Schema.Struct({ name: Schema.String, inputSchema: Schema.Unknown })),
  routers: Schema.Array(
    Schema.Struct({
      path: Schema.String,
      title: Schema.optional(Schema.String),
      error: Schema.optional(
        Schema.Struct({
          _tag: Schema.String,
          reason: Schema.optional(Schema.String),
          status: Schema.optional(Schema.Number),
          accountId: Schema.optional(Schema.String),
          phase: Schema.optional(Schema.String),
          upstream: Schema.optional(Schema.Unknown),
        }),
      ),
    }),
  ),
});

type Kind = "graphql" | "mcp" | "openapi" | "custom";

const providerErrors = (kind: Kind) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors,
      browser = yield* Browser;
    const upstream = yield* providerErrorUpstream;
    const prefix = `/api/organizations/${actors.organization.id}`;
    yield* upstream.configure(undefined);
    const created =
      kind === "custom"
        ? yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: "Custom provider errors",
            files: [
              {
                path: "index.ts",
                content: `import { defineApp, defineProvider, secrets, object, string, query, ProviderError, router } from "apps";
const provider = defineProvider({ name: "Custom service", auth: { apiKey: secrets({ label: "API key", fields: object({ token: string() }) }) } });
export default defineApp({ user: { accounts: { service: provider.many() } } }, async ({ user: { accounts }, signal }) => {
  const account = accounts.service[1];
  if (!account) return { tools: router({}) };
  async function read(phase) {
    const response = await fetch(${JSON.stringify(upstream.origin)} + "/custom/" + phase, { signal, headers: { Authorization: "Bearer " + account.fields.token } });
    if (response.ok) return { ok: true };
    const detail = await response.json();
    if (response.status === 400) throw new Error(detail.message);
    throw Object.assign(new ProviderError({ reason: "unauthorized", status: response.status, accountId: response.status === 402 ? "acc_unselected" : account.id }), { message: detail.message, title: "Forged title", account: { label: "Forged account" } });
  }
  await read("discover");
  return { tools: router({
   identity: query({ input: object({}) }, async () => read("call")),
 }) };
});`,
              },
              appsManifest,
            ],
          })
        : yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
            name: `${kind} provider errors`,
            files: authoredAppFiles(kind, upstream.origin, "apiKey", `${kind} provider errors`),
          });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const app = yield* body(App, created),
      path = `${prefix}/apps/${app.id}`;
    // This diagnostic app explicitly refreshes on every evaluation so discovery
    // failures remain observable after its GraphQL catalog has been cached.
    if (kind === "graphql") {
      const source = yield* body(
        Schema.Struct({
          files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
        }),
        yield* api.request(actors.owner, "GET", `${path}/source`),
      );
      expect(source.files.find((file) => file.path === "index.ts")?.content).toContain(
        "graphqlRouter({",
      );
      const updated = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
        files: source.files.map((file) =>
          file.path === "index.ts"
            ? {
                ...file,
                content: file.content.replace(
                  "graphqlRouter({",
                  "graphqlRouter({ revalidate: true,",
                ),
              }
            : file,
        ),
      });
      expect(updated.status).toBe(200);
    }
    const accounts: string[] = [];
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* upstream.configure(undefined);
        yield* api.request(actors.owner, "DELETE", path);
        for (const account of accounts)
          yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account}`);
      }).pipe(Effect.orDie),
    );
    // Connecting from the app links each account; the account array uses every linked one.
    const connect = (label: string) =>
      Effect.gen(function* () {
        const connection = yield* body(
          Resource,
          yield* api.request(actors.owner, "POST", connectionsPath(path, "user", "service"), {}),
        );
        const saved = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection.id}/submit`,
          { method: "apiKey", label, fields: { token: `synthetic-${label}` } },
        );
        expect(saved.status, JSON.stringify(saved.body)).toBe(200);
        accounts.push((yield* body(Resource, saved)).id);
      });
    for (const label of ["work", "personal"]) yield* connect(label);
    const affected = accounts[1];
    if (affected === undefined) return yield* Effect.die("Missing second account");
    const tool =
      kind === "graphql"
        ? "query_identity"
        : kind === "openapi"
          ? "identity.getIdentity"
          : "identity";
    const catalog = () => api.request(actors.owner, "GET", `${path}/tools`);
    // The dashboard's index reads the same kept listing as the catalog.
    const index = () => api.request(actors.owner, "GET", `${path}/tools/index`);
    const call = () =>
      api.request(actors.owner, "POST", `${path}/tools/call`, {
        tool,
        // Every template's identity operation is a read.
        kind: "query",
        input:
          kind === "custom"
            ? {}
            : { accountId: affected, input: kind === "mcp" ? { value: "personal" } : {} },
      });
    const assertFailure = (
      response: Effect.Success<ReturnType<typeof catalog>>,
      reason: string,
      status: number,
      phase?: string,
    ) =>
      Effect.gen(function* () {
        expect(response.status, `${kind}: ${JSON.stringify(response.body)}`).toBe(502);
        const parsed = yield* body(Failure, response);
        expect(parsed).toMatchObject({
          reason,
          status,
          account: { id: affected, label: "personal" },
          ...(phase === undefined ? {} : { phase }),
        });
        expect(JSON.stringify(response.body)).not.toMatch(
          new RegExp(`${providerSecretMarker}|Forged|stack|synthetic-personal`),
        );
        return parsed;
      });
    // A service states why it refused in its Bearer challenge, as when a saved sign-in belongs
    // to another organization. Callers see that error with the account's credential replaced.
    const challenge = {
      "www-authenticate":
        'Bearer realm="example", error="invalid_token", error_description="Token synthetic-personal belongs to another organization"',
    };
    const expectStated = (failure: typeof Failure.Type, phase: string) => {
      expect(failure.upstream).toEqual({
        code: "invalid_token",
        message: "Token [redacted] belongs to another organization",
      });
      expect(failure.message).toContain(phase);
      expect(failure.message).toContain(
        'invalid_token: "Token [redacted] belongs to another organization"',
      );
    };
    // Listing evaluates the app; an MCP server's own session setup is named more precisely.
    const listing = kind === "mcp" ? "connect" : "discover";
    if (kind !== "openapi") {
      // A slow rejection, as a cold app start or a distant service makes it. Executor
      // remembers slow listing failures for MCP discovery, but a caller that waits for
      // the listing, such as the dashboard, must see the recovered service on its next read.
      // The custom app raises its own ProviderError, which states nothing.
      yield* upstream.configure({
        status: 401,
        delayMs: 1_500,
        ...(kind === "custom" ? {} : { headers: challenge }),
      });
      if (kind === "mcp") {
        // Each linked account is its own MCP session. The refused account's error is reported
        // on the app's router, and the other account's tools stay listed. Like a failure, that
        // listing is not kept, so the next read finds the account recovered.
        const response = yield* catalog();
        expect(response.status, `${kind}: ${JSON.stringify(response.body)}`).toBe(200);
        const partial = yield* body(Listing, response);
        expect(partial.items.map((item) => item.name)).toEqual([tool]);
        expect(partial.routers).toEqual([
          {
            path: "",
            title: "accounts",
            error: {
              _tag: "ProviderError",
              reason: "unauthorized",
              status: 401,
              accountId: affected,
              phase: listing,
              upstream: {
                code: "invalid_token",
                message: "Token [redacted] belongs to another organization",
              },
            },
          },
        ]);
        expect(JSON.stringify(response.body)).not.toMatch(
          new RegExp(`${providerSecretMarker}|synthetic-personal`),
        );
      } else {
        const listed = yield* assertFailure(yield* catalog(), "unauthorized", 401, listing);
        if (kind !== "custom") expectStated(listed, "while listing its tools");
      }
      // Lazy MCP sources do not discover tools when listing unrelated webhooks.
      const setup = yield* api.request(actors.owner, "GET", `${path}/webhook-definitions`);
      expect(setup.status, JSON.stringify(setup.body)).toBe(kind === "mcp" ? 200 : 502);
      if (kind === "mcp") expect(setup.body).toEqual([]);
    }
    yield* upstream.configure({ status: 401, phase: "call" });
    const recovered = yield* catalog();
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    const whole = yield* body(Listing, recovered);
    expect(whole.routers.filter((router) => router.error !== undefined)).toEqual([]);
    // The recovered account can be selected again.
    if (kind === "mcp") expect(JSON.stringify(whole.items[0]?.inputSchema)).toContain(affected);
    yield* assertFailure(yield* call(), "unauthorized", 401, "call");
    if (kind === "mcp") {
      yield* upstream.configure({ status: 401, phase: "call", headers: challenge });
      expectStated(
        yield* assertFailure(yield* call(), "unauthorized", 401, "call"),
        "while calling a tool",
      );
    }
    if (kind !== "custom") {
      for (const [status, headers, reason] of [
        [403, {}, "rejected"],
        [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
        [403, { "www-authenticate": 'Bearer error="insufficient_scope"' }, "forbidden"],
        [429, {}, "rate_limited"],
        [520, {}, "unavailable"],
      ] as const) {
        yield* upstream.configure({ status, headers, phase: "call" });
        yield* assertFailure(yield* call(), reason, status);
      }
    }
    if (kind === "openapi") {
      // A bare 403 does not say why the service refused. When its body states an error in a
      // nested error object, that error goes with the rejection, the account's credential replaced.
      for (const [code, message] of [
        [403, "User-rate limit exceeded. Token synthetic-personal"],
        ["Authorization_RequestDenied", "Insufficient privileges for synthetic-personal"],
      ] as const) {
        yield* upstream.configure({
          status: 403,
          body: { error: { code, message, errors: [{ reason: "detail" }] } },
          phase: "call",
        });
        const failure = yield* assertFailure(yield* call(), "rejected", 403, "call");
        const redacted = message.replace("synthetic-personal", "[redacted]");
        expect(failure.upstream).toEqual({ code, message: redacted });
        expect(failure.message).toContain(`${code}: "${redacted}"`);
      }
    }
    if (kind === "custom") {
      yield* upstream.configure({ status: 402 });
      // This factory fetches its upstream without the app cache, so nothing tells Executor
      // that its listing changed: the catalog and the index both reuse the listing evaluated
      // above within its window.
      const kept = yield* catalog();
      expect(kept.status, JSON.stringify(kept.body)).toBe(200);
      expect(kept.body).toMatchObject({ items: [{ name: "identity" }] });
      const keptIndex = yield* index();
      expect(keptIndex.status, JSON.stringify(keptIndex.body)).toBe(200);
      expect(keptIndex.body).toMatchObject({ items: [{ name: "identity" }] });
      // Linking another account changes the account set, which has no kept listing, so its
      // first read evaluates the app and reports the new failure. A failed evaluation is not
      // kept for the index: the next read evaluates again and reports whatever the service says.
      yield* connect("spare");
      const forged = yield* body(Failure, yield* index());
      expect(forged.account).toBeUndefined();
      yield* upstream.configure({ status: 400 });
      const unknown = yield* index();
      // An app that throws its own Error with a message chose to show it to its caller.
      expect(unknown.body).toMatchObject({
        _tag: "AppEvaluationFailed",
        failure: { source: "app", errorName: "Error", message: providerSecretMarker },
      });
      yield* upstream.configure({ status: 400, phase: "call" });
      const unknownCall = yield* call();
      expect(unknownCall.body).toMatchObject({
        _tag: "ToolCallFailed",
        failure: { source: "app", errorName: "Error", message: providerSecretMarker },
      });
    }
    if (kind !== "graphql") return;
    for (const [code, reason] of [
      ["UNAUTHENTICATED", "unauthorized"],
      ["FORBIDDEN", "forbidden"],
      ["RATE_LIMITED", "rate_limited"],
    ] as const) {
      yield* upstream.configure({ status: 200, code });
      yield* assertFailure(yield* catalog(), reason, 200);
    }
    // Saving the affected account's webhook source sets it up again; the rejected credential
    // leaves it waiting for the account to be repaired.
    yield* upstream.configure({ status: 401 });
    const configured = yield* api.request(
      actors.owner,
      "PUT",
      `${path}/webhook-sources/${affected}/config`,
      { config: {} },
    );
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    const deadline = (yield* Clock.currentTimeMillis) + 40_000;
    for (;;) {
      const result = (yield* body(
        Schema.Array(
          Schema.Struct({
            account: Schema.String,
            status: Schema.String,
            failure: Schema.NullOr(Schema.String),
          }),
        ),
        yield* api.request(actors.owner, "GET", `${path}/webhook-sources`),
      )).find((source) => source.account === affected);
      if (result?.status === "needs-setup") {
        expect(result.failure).toBe("accounts");
        break;
      }
      expect(yield* Clock.currentTimeMillis).toBeLessThan(deadline);
      yield* Effect.sleep("200 millis");
    }
    yield* browser.login(actors.owner);
    const url = `/org/${actors.organization.slug}/apps/${app.id}?view=tools`;
    yield* browser.use("Open authentication failure", (page) =>
      page
        .goto(url)
        .then(() => page.getByRole("heading", { name: "Authentication failed" }).waitFor()),
    );
    expect(
      yield* browser.use("Account is named", (page) => page.getByRole("alert").textContent()),
    ).toContain("personal");
    expect(
      yield* browser.use("No blind auth retry", (page) =>
        page.getByRole("button", { name: "Try again", exact: true }).count(),
      ),
    ).toBe(0);
    yield* browser.checkpoint("Authentication error names the account and recovery");
    yield* browser.use("Mobile error", (page) => page.setViewportSize({ width: 390, height: 844 }));
    yield* browser.checkpoint("Authentication recovery on mobile");
    yield* browser.use("Manage the affected account", (page) =>
      page
        .getByRole("link", { name: "Manage account" })
        .click()
        .then(() =>
          page.waitForURL(
            (url) =>
              url.pathname.endsWith("/accounts") && url.searchParams.get("account") === affected,
          ),
        ),
    );
    yield* browser.use("Restore desktop", (page) =>
      page.setViewportSize({ width: 1365, height: 900 }),
    );
    yield* upstream.configure({ status: 429 });
    yield* browser.use("Open rate limit", (page) =>
      page
        .goto(url)
        .then(() => page.getByRole("heading", { name: "Service rate limit reached" }).waitFor()),
    );
    expect(
      yield* browser.use("Rate limit does not request credential repair", (page) =>
        page.getByRole("link", { name: "Manage account" }).count(),
      ),
    ).toBe(0);
    const held = yield* holdQuery(
      new RegExp(`/api/organizations/[^/]+/apps/${app.id}/tools/index$`),
      "continue",
    );
    yield* browser.use("Retry discovery", (page) =>
      page.getByRole("button", { name: "Try again", exact: true }).click(),
    );
    yield* held.requested;
    expect(
      yield* browser.use("Retry keeps the error visible", (page) =>
        page.getByRole("heading", { name: "Service rate limit reached" }).count(),
      ),
    ).toBe(1);
    expect(
      yield* browser.use("Duplicate retry disabled", (page) =>
        page.getByRole("button", { name: "Checking…", exact: true }).isDisabled(),
      ),
    ).toBe(true);
    yield* upstream.configure(undefined);
    yield* held.release;
    yield* browser.use("Discovery recovers", (page) =>
      page.getByText(tool, { exact: true }).first().waitFor(),
    );
    expect((yield* call()).status).toBe(200);
    yield* browser.use("Open the tool runner", (page) =>
      page
        .getByText(tool, { exact: true })
        .first()
        .click()
        .then(() => page.getByRole("button", { name: "Run tool", exact: true }).waitFor()),
    );
    const input = JSON.stringify({ accountId: affected, input: {} });
    // The accounts share one schema, so the runner opens on the form; the call is entered as JSON.
    yield* browser.use("Enter tool input", (page) =>
      page
        .getByRole("tablist", { name: "Input format", exact: true })
        .getByRole("tab", { name: "JSON", exact: true })
        .click()
        .then(() => page.getByLabel("Input", { exact: true }).fill(input)),
    );
    yield* upstream.configure({ status: 401, phase: "call" });
    yield* browser.use("Run the failing tool", (page) =>
      page
        .getByRole("button", { name: "Run tool", exact: true })
        .click()
        .then(() => page.getByRole("heading", { name: "Authentication failed" }).waitFor()),
    );
    expect(
      yield* browser.use("Call failure retains input", (page) =>
        page.getByLabel("Input", { exact: true }).inputValue(),
      ),
    ).toBe(input);
    expect(
      yield* browser.use("Call offers the same account recovery", (page) =>
        page.getByRole("link", { name: "Manage account" }).getAttribute("href"),
      ),
    ).toContain(affected);
    yield* browser.use("Bring call recovery into view", (page) =>
      page
        .getByRole("alert", { name: "Authentication failed", exact: true })
        .scrollIntoViewIfNeeded(),
    );
    yield* browser.checkpoint("Tool call shows authentication recovery and preserves input");
  });

layer(HostedLive, { excludeTestServices: true })("Provider errors", (it) => {
  it.effect(scenarios.providerErrorsGraphql.title, (context) =>
    withHostedCase(context, providerErrors("graphql")),
  );
  it.effect(scenarios.providerErrorsMcp.title, (context) =>
    withHostedCase(context, providerErrors("mcp")),
  );
  it.effect(scenarios.providerErrorsOpenapi.title, (context) =>
    withHostedCase(context, providerErrors("openapi")),
  );
  it.effect(scenarios.providerErrorsCustom.title, (context) =>
    withHostedCase(context, providerErrors("custom")),
  );
});
