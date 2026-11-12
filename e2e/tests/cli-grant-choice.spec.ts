/**
 * What a person chooses when they approve `executor login` holds for every CLI command: a chosen
 * connection limits `executor search` and `executor call` to its apps, browser approval links the
 * pending request to its review page for `executor resume`, and native approval reaches the MCP
 * client of `executor mcp` as an elicitation. The choice is the grant settings the device approval
 * page sends.
 */
import { expect, layer } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import { Effect, Schema } from "effect";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsCli, type Finished } from "../support/apps-cli.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { ConnectionView, scenarioOrganization } from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { stdioMcp } from "../support/stdio-mcp.ts";
import { scenarios } from "../test-plan.ts";

const Search = Schema.fromJsonString(
  Schema.Struct({ items: Schema.Array(Schema.Struct({ path: Schema.String })) }),
);
const Outcome = Schema.Struct({
  path: Schema.String,
  ok: Schema.Boolean,
  value: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.Unknown),
});
const Called = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Literal(true), value: Outcome }),
});
const Executed = Schema.Struct({
  status: Schema.Literal("completed"),
  execution: Schema.Struct({ ok: Schema.Boolean, value: Schema.optional(Schema.Unknown) }),
});
const Pending = Schema.Struct({
  status: Schema.Literal("approval-required"),
  requestId: Schema.String,
  approvalUrl: Schema.optional(Schema.String),
});

/**
 * An account-free app whose tools all mention `word` in their descriptions: `read` answers its
 * receipt and `review` waits for approval first.
 */
const deployApp = (label: string, word: string) =>
  Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const receipt = randomUUID();
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `${label} ${receipt.slice(0, 8)}`,
      files: [
        {
          path: "index.ts",
          content: `
import { defineApp, mutation, object, query, router } from "apps";
import { always } from "apps/operations/approval";
export default defineApp({}, async () => ({
  tools: router({
    read: query({ description: "Read the ${word} receipt", input: object({}) }, async () => ({ read: ${JSON.stringify(receipt)} })),
    review: mutation({ description: "Review the ${word} after approval", input: object({}), approval: always() }, async () => ({ reviewed: ${JSON.stringify(receipt)} })),
  }),
}));
`,
        },
        appsManifest,
      ],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    yield* Effect.addFinalizer(() =>
      api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
    );
    return { app, receipt };
  });

/** Every tool path `executor search` printed. */
const paths = (result: Finished) => {
  expect(result.code, result.stderr).toBe(0);
  return Schema.decodeUnknownSync(Search)(result.stdout).items.map((item) => item.path);
};
/** The one outcome `executor call <path>` printed. */
const outcome = (result: Finished) => {
  expect(result.code, result.stderr).toBe(0);
  return Schema.decodeUnknownSync(Schema.fromJsonString(Called))(result.stdout).execution.value;
};
const pathOf = (found: ReadonlyArray<string>, slug: string, tool: string) => {
  const path = found.find((item) => item.includes(slug) && item.endsWith(`.${tool}`));
  expect(path, JSON.stringify(found)).toBeDefined();
  return path ?? "";
};

layer(HostedLive, { excludeTestServices: true })("CLI grant choice", (it) => {
  it.effect(scenarios.cliChosenConnection.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const hosts = targetHosts(yield* Target);
        const host = hosts.api;
        const cli = yield* appsCli;
        const word = `w${randomUUID().slice(0, 8)}`;
        const [chosen, outside, organization] = yield* Effect.all(
          [deployApp("Chosen", word), deployApp("Outside", word), scenarioOrganization],
          { concurrency: 3 },
        );
        const created = yield* api.request(
          actors.owner,
          "POST",
          `/api/organizations/${actors.organization.id}/mcp-connections`,
          {
            id: randomUUID(),
            name: `CLI ${randomUUID().slice(0, 6)}`,
            apps: [{ app: chosen.app.id, runsAs: [{ kind: "app" }], tools: { kind: "all" } }],
          },
        );
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const connection = yield* body(ConnectionView, created);

        const login = yield* cli.login(host, ["login"], {
          access: { kind: "connection", id: connection.id },
        });
        expect(login.finished.code, login.finished.stderr).toBe(0);
        expect(login.finished.stdout).toContain(
          `Connected to ${host} as @${organization.slug}: connection ${connection.name} (1 app), approvals in model mode.`,
        );
        const who = yield* cli.executor(["whoami"]);
        expect(who.code, who.stderr).toBe(0);
        expect(JSON.parse(who.stdout)).toEqual({
          host,
          mcp: `${hosts.mcp}/mcp`,
          organization,
          access: { kind: "connection", id: connection.id, name: connection.name, apps: 1 },
          mode: "model",
          apps: false,
        });

        // Search finds only the connection's app, though both apps' tools mention the word.
        const found = paths(yield* cli.executor(["search", word]));
        const read = pathOf(found, chosen.app.slug, "read");
        expect(found.filter((path) => path.includes(outside.app.slug))).toEqual([]);
        expect(paths(yield* cli.executor(["search", "--namespace", outside.app.slug]))).toEqual([]);

        // A call to the connection's app runs; one outside it gets the host's refusal.
        expect(outcome(yield* cli.executor(["call", read]))).toMatchObject({
          ok: true,
          value: { read: chosen.receipt },
        });
        const outsidePath = read.replace(chosen.app.slug, outside.app.slug);
        const refused = outcome(yield* cli.executor(["call", outsidePath]));
        // The host hides apps outside the connection, so it answers as for a tool that is not there.
        expect(refused, JSON.stringify(refused)).toMatchObject({
          path: outsidePath,
          ok: false,
          error: { kind: "UnknownTool" },
        });
        expect(JSON.stringify(refused.error)).not.toContain(outside.receipt);
      }),
    ),
  );

  it.effect(scenarios.cliBrowserApproval.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors,
          browser = yield* Browser;
        const host = targetHosts(yield* Target).api;
        const cli = yield* appsCli;
        const word = `w${randomUUID().slice(0, 8)}`;
        const { app, receipt } = yield* deployApp("Browser", word);
        const login = yield* cli.login(host, ["login"], { mode: "browser" });
        expect(login.finished.code, login.finished.stderr).toBe(0);
        expect(login.finished.stdout).toContain("every app, approvals in browser mode.");
        const review = pathOf(
          paths(yield* cli.executor(["search", "--namespace", app.slug])),
          app.slug,
          "review",
        );

        // The call pauses with a link to its review page, and nothing has run yet.
        const paused = yield* cli.executor(["call", review]);
        expect(paused.code, paused.stderr).toBe(0);
        const pending = Schema.decodeUnknownSync(Schema.fromJsonString(Pending))(paused.stdout);
        expect(pending.approvalUrl, paused.stdout).toBeDefined();
        const url = new URL(pending.approvalUrl ?? "");

        // The person approves on that page, signed in to the browser.
        yield* browser.login(actors.owner);
        yield* browser.use("Open the review page and approve", (page) =>
          page
            .goto(`${url.pathname}${url.search}`)
            .then(() =>
              page.getByRole("heading", { name: "Review tool request", exact: true }).waitFor(),
            )
            .then(() => page.getByRole("button", { name: "Approve", exact: true }).click())
            .then(() => page.getByText("Response saved", { exact: true }).waitFor()),
        );
        yield* browser.checkpoint("Approval saved for the CLI's call");

        // resume with only the ID collects the answer given in the browser and runs the call.
        expect(outcome(yield* cli.executor(["resume", pending.requestId]))).toMatchObject({
          ok: true,
          value: { reviewed: receipt },
        });
      }),
    ),
  );

  it.effect(scenarios.cliRelayElicitation.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const host = targetHosts(yield* Target).api;
        const cli = yield* appsCli;
        const word = `w${randomUUID().slice(0, 8)}`;
        const { app, receipt } = yield* deployApp("Native", word);
        const login = yield* cli.login(host, ["login"], { mode: "native" });
        expect(login.finished.code, login.finished.stderr).toBe(0);
        expect(login.finished.stdout).toContain("every app, approvals in native mode.");

        // A real MCP client that answers elicitation starts the relay, as Claude Code would.
        const client = yield* stdioMcp({
          ...cli.command(["mcp", "--host", host]),
          elicit: () => ({ action: "accept", content: {} }),
        });
        const found = Schema.decodeUnknownSync(Search.to)(
          yield* client.call("search", { namespace: app.slug }),
        );
        const review = pathOf(
          found.items.map((item) => item.path),
          app.slug,
          "review",
        );
        // A program's approval reaches the client as an elicitation, through the relay; accepting
        // it runs the call in the same request. (A native `call` needs none: the client confirmed
        // that call itself.)
        const executed = Schema.decodeUnknownSync(Executed)(
          yield* client.call("execute", { code: `return await ${review}({})` }),
        );
        expect(executed.execution).toEqual({ ok: true, value: { reviewed: receipt } });
        expect(client.elicitations).toHaveLength(1);
        expect(client.elicitations[0]?.message).toContain("Approve review?");
      }),
    ),
  );
});
