/** Dynamic skill freshness through the real app compiler, runtime, HTTP, MCP and browser. */
import { expect, layer } from "@effect/vitest";
import { Effect, Layer, Redacted, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { App, Resource } from "../support/contracts.ts";
import { Browser } from "../support/browser.ts";
import { McpClient } from "../support/mcp-client.ts";
import { McpOAuth } from "../support/mcp-oauth.ts";
import { skillUpstream } from "../support/skill-upstream.ts";
import { createProfile, selectProfileAccounts } from "../support/profiles.ts";
import { appsManifest } from "../support/apps-release.ts";

const Bundle = Schema.Struct({
  deployment: Schema.String,
  revision: Schema.String,
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      files: Schema.Array(Schema.Struct({ path: Schema.String, content: Schema.String })),
    }),
  ),
});
const SetupStatus = Schema.Struct({ status: Schema.String });

/**
 * An app reading skills from a private GitHub repository with its selected account's token. App
 * code holds a handle; the outbound network substitutes the token for the provider's hosts.
 */
const privateSkillsApp = (options: {
  readonly provider: string;
  readonly hosts: readonly string[];
  readonly upstream: string;
  readonly repo: string;
}) => `import { defineApp, defineProvider, dynamicSkills, secrets, object, string } from "apps";
import { githubSkills } from "apps/skills";
const github = defineProvider({
  name: ${JSON.stringify(options.provider)},
  hosts: ${JSON.stringify(options.hosts)},
  auth: { token: secrets({ label: "Token", fields: object({ token: string() }) }) },
});
export default defineApp({ accounts: { github } }, async (ctx) => ({
  dynamicSkills: dynamicSkills({ list: () => githubSkills({
    repo: ${JSON.stringify(options.repo)}, path: "skills", cache: ctx.cache, signal: ctx.signal,
    account: ctx.accounts.github, token: ctx.accounts.github.fields.token,
    fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return ctx.fetch(${JSON.stringify(options.upstream)} + "/github" + url.pathname + url.search, init);
    },
  }) }),
}));`;

layer(HostedLive, { excludeTestServices: true })("Dynamic skills", (it) => {
  it.effect(scenarios.dynamicSkills.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const upstream = yield* skillUpstream;
        const mcp = yield* McpClient,
          oauth = yield* McpOAuth;
        const prefix = `/api/organizations/${actors.organization.id}/apps`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/deploy`, {
          name: `Dynamic skills ${randomUUID().slice(0, 8)}`,
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, dynamicSkills, query, object, router } from "apps";
import { githubSkills, wellKnownSkills } from "apps/skills";
export default defineApp({ accounts: {} }, async (ctx) => ({
  tools: router({ ping: query({ input: object({}) }, async () => "pong") }),
  dynamicSkills: dynamicSkills({ list: async () => [
    ...await wellKnownSkills({ url: ${JSON.stringify(upstream.url)}, fetch: ctx.fetch, signal: ctx.signal }),
    ...await githubSkills({ repo: "synthetic/skills", path: "skills", signal: ctx.signal, fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return ctx.fetch(${JSON.stringify(upstream.url)} + "/github" + url.pathname + url.search, init);
    } }),
  ] }),
}));`,
            },
            {
              path: "skills/packaged-guide/SKILL.md",
              content:
                "---\nname: packaged-guide\ndescription: Packaged instructions.\n---\n# Packaged guide",
            },
            { path: "skills/packaged-guide/references/example.md", content: "Pinned reference" },
            appsManifest,
          ],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/${app.id}`).pipe(Effect.orDie),
        );
        const base = `${prefix}/${app.id}`;
        const profile = yield* createProfile(actors.owner, base);
        const tools = yield* api.request(
          actors.owner,
          "GET",
          `${base}/tools?profile=${profile.id}`,
        );
        expect(tools.status).toBe(200);
        const ping = yield* api.request(actors.owner, "POST", `${base}/tools/call`, {
          profile: profile.id,
          tool: "ping",
          kind: "query",
          input: {},
        });
        expect(ping.status).toBe(200);
        expect(ping.body).toBe("pong");
        expect(yield* upstream.requests).toEqual([]);
        const firstResponse = yield* api.request(actors.owner, "GET", `${base}/skill-bundle`);
        expect(
          firstResponse.status,
          JSON.stringify({ response: firstResponse.body, requests: yield* upstream.requests }),
        ).toBe(200);
        const first = yield* body(Bundle, firstResponse);
        expect(first.skills.map((skill) => skill.name)).toEqual([
          "github-guide",
          "packaged-guide",
          "remote-guide",
        ]);
        expect(
          first.skills
            .filter((skill) => skill.name !== "packaged-guide")
            .every((skill) => skill.files.some((file) => file.content.includes("Reference 1"))),
        ).toBe(true);
        const firstCommit = yield* upstream.commit;
        expect(
          (yield* upstream.requests).some((path) =>
            path.includes(`/synthetic/skills/${firstCommit}/skills/`),
          ),
        ).toBe(true);
        yield* browser.login(actors.owner);
        const grant = yield* oauth.authorize;
        const client = yield* mcp.connect(
          Redacted.make(Redacted.value(grant.tokens).access_token),
          "dynamic-skills",
        );
        const mcpRead = (revision?: string) =>
          client.use("Read current remote skill through MCP", (client, signal) =>
            client.callTool(
              {
                name: "skills",
                arguments: {
                  app: app.slug,
                  name: "remote-guide",
                  ...(revision === undefined ? {} : { revision }),
                },
              },
              undefined,
              { signal },
            ),
          );
        const firstMcp = yield* mcpRead();
        expect(firstMcp.isError).not.toBe(true);
        expect(firstMcp.structuredContent).toMatchObject({
          revision: first.revision,
          content: expect.stringContaining("Guide 1"),
        });
        yield* upstream.publish(2);
        const secondResponse = yield* api.request(actors.owner, "GET", `${base}/skill-bundle`);
        expect(secondResponse.status).toBe(200);
        const second = yield* body(Bundle, secondResponse);
        expect(second.deployment).toBe(first.deployment);
        expect(second.revision).not.toBe(first.revision);
        expect(second.skills.find((skill) => skill.name === "packaged-guide")).toEqual(
          first.skills.find((skill) => skill.name === "packaged-guide"),
        );
        expect((yield* mcpRead(first.revision)).isError).toBe(true);
        expect((yield* mcpRead()).structuredContent).toMatchObject({
          revision: second.revision,
          content: expect.stringContaining("Guide 2"),
        });
        expect(
          second.skills
            .filter((skill) => skill.name !== "packaged-guide")
            .every((skill) => skill.files.some((file) => file.content.includes("Reference 2"))),
        ).toBe(true);
        expect(
          (yield* api.request(
            actors.owner,
            "GET",
            `${base}/skills/remote-guide?revision=${first.revision}&file=references/example.md`,
          )).status,
        ).toBe(409);
        const pinned = yield* api.request(
          actors.owner,
          "GET",
          `${base}/skills/remote-guide?revision=${second.revision}&file=references/example.md`,
        );
        expect(pinned.status).toBe(200);
        expect((yield* body(Schema.Struct({ content: Schema.String }), pinned)).content).toBe(
          "# Reference 2",
        );
        for (const malformed of ["github", "well-known"] as const) {
          yield* upstream.publish(3, { malformed });
          expect((yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status).toBe(
            502,
          );
        }
        yield* upstream.publish(3, { broken: true });
        expect((yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status).toBe(502);
        yield* upstream.publish(3, { traversal: true });
        expect((yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status).toBe(502);
        for (const fileFailure of ["oversized", "encoding", "redirect"] as const) {
          yield* upstream.publish(3, { fileFailure });
          expect(
            (yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status,
            fileFailure,
          ).toBe(502);
        }
        expect((yield* upstream.requests).some((path) => path.includes("private.txt"))).toBe(false);
        yield* upstream.publish(3);
        expect((yield* api.request(actors.owner, "GET", `${base}/skill-bundle`)).status).toBe(200);
        const anonymous = yield* api.session();
        expect((yield* api.request(anonymous, "GET", `${base}/skill-bundle`)).status).toBe(401);
        yield* browser.login(actors.owner);
        yield* browser.use("Read dynamic app instructions", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=skills`),
        );
        yield* browser.use("Select the remote skill's instructions", (page) =>
          page
            .getByRole("group", { name: "remote-guide", exact: true })
            .getByRole("button", { name: "Instructions", exact: true })
            .click(),
        );
        yield* browser.use("Latest instructions are visible", (page) =>
          page.getByRole("heading", { name: "Guide 3", exact: true }).waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Skills refreshed without redeploying the app");
      }).pipe(Effect.provide(Layer.mergeAll(McpClient.layer, McpOAuth.layer))),
    ),
  );

  it.effect(scenarios.privateGithubSkills.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const upstream = yield* skillUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const provider = `GitHub ${randomUUID().slice(0, 8)}`;
        const token = `synthetic-github-token-${randomUUID()}`;
        yield* upstream.requireToken(token);
        const deploy = (hosts: readonly string[], repo = "synthetic/skills") =>
          Effect.gen(function* () {
            const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
              name: `Private skills ${randomUUID().slice(0, 8)}`,
              files: [
                {
                  path: "index.ts",
                  content: privateSkillsApp({ provider, hosts, upstream: upstream.url, repo }),
                },
                appsManifest,
              ],
            });
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const app = yield* body(App, response);
            yield* Effect.addFinalizer(() =>
              api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
            );
            return `${prefix}/apps/${app.id}`;
          });
        /** Wait until background profile setup has resolved the profile's accounts. */
        const settled = (path: string, profile: string) =>
          api.request(actors.owner, "GET", `${path}/profiles/${profile}`).pipe(
            Effect.flatMap((response) => body(SetupStatus, response)),
            Effect.flatMap((current) =>
              current.status !== "pending"
                ? Effect.void
                : Effect.fail(new Error("Profile setup has not finished")),
            ),
            Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 100 }),
          );
        /** Connect a GitHub account with this token through a fresh profile. */
        const connect = (path: string, label: string, value: string) =>
          Effect.gen(function* () {
            const profile = yield* createProfile(actors.owner, path);
            const pending = yield* api.request(actors.owner, "POST", `${path}/connections`, {
              requirement: "github",
              profile: profile.id,
            });
            expect(pending.status, JSON.stringify(pending.body)).toBe(200);
            const saved = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/connections/${(yield* body(Resource, pending)).id}/submit`,
              { method: "token", label, fields: { token: value } },
            );
            expect(saved.status, JSON.stringify(saved.body)).toBe(200);
            const account = (yield* body(Resource, saved)).id;
            yield* Effect.addFinalizer(() =>
              api
                .request(actors.owner, "DELETE", `${prefix}/accounts/${account}`)
                .pipe(Effect.orDie),
            );
            yield* settled(path, profile.id);
            return { profile: profile.id, account };
          });
        const read = (path: string, profile: string) =>
          api.request(actors.owner, "GET", `${path}/skill-bundle?profile=${profile}`);

        const host = new URL(upstream.url).host;
        const path = yield* deploy([host]);
        const reader = yield* connect(path, "Reader", token);
        const readable = yield* read(path, reader.profile);
        expect(
          readable.status,
          JSON.stringify({ response: readable.body, credentials: yield* upstream.credentials }),
        ).toBe(200);
        expect((yield* body(Bundle, readable)).skills).toMatchObject([
          {
            name: "github-guide",
            files: expect.arrayContaining([
              { path: "references/example.md", content: "# Reference 1" },
            ]),
          },
        ]);
        // Every request carried the real token, substituted outside app code: git as a Basic
        // password and raw files as a token.
        const sent = yield* upstream.credentials;
        expect(sent.length).toBeGreaterThan(2);
        for (const { path, authorization } of sent)
          expect(authorization, path).toBe(
            path.endsWith(".git/git-upload-pack")
              ? `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`
              : `token ${token}`,
          );

        // Another account of the same app does not read the first account's cached catalog; its
        // rejected token is reported against that account.
        const outsider = yield* connect(path, "Outsider", `synthetic-revoked-${randomUUID()}`);
        const rejected = yield* read(path, outsider.profile);
        expect(rejected.status, JSON.stringify(rejected.body)).toBe(502);
        expect(rejected.body).toMatchObject({
          _tag: "AppProviderFailed",
          reason: "unauthorized",
          status: 401,
          account: { id: outsider.account, label: "Outsider" },
        });

        // GitHub answers 404 with a token for a repository the token cannot read, as for one that
        // does not exist: the copy says it is not available with the token, and claims neither.
        const absentPath = yield* deploy([host], "synthetic/absent-skills");
        const absentReader = yield* connect(absentPath, "Reader", token);
        const absent = yield* read(absentPath, absentReader.profile);
        expect(absent.status, JSON.stringify(absent.body)).toBe(502);
        expect(absent.body).toMatchObject({
          _tag: "AppEvaluationFailed",
          skills: {
            reason: "request",
            status: 404,
            message:
              "GitHub repository synthetic/absent-skills is not available with the account's token (HTTP 404). Check the repository name and that the token can read it.",
          },
          recovery: {
            action:
              "Check the address or repository the app’s skill source names, and that any account it reads with can access it.",
          },
        });

        // An app whose provider allows only GitHub's own hosts cannot send this account's token
        // elsewhere, and says which hosts the read needs.
        const before = (yield* upstream.credentials).length;
        const elsewhere = yield* deploy(["github.com", "raw.githubusercontent.com"]);
        const selected = yield* createProfile(actors.owner, elsewhere);
        const selection = yield* selectProfileAccounts(actors.owner, elsewhere, selected.id, {
          github: reader.account,
        });
        expect(selection.status, JSON.stringify(selection.body)).toBe(200);
        yield* settled(elsewhere, selected.id);
        const refused = yield* read(elsewhere, selected.id);
        expect(refused.status, JSON.stringify(refused.body)).toBe(502);
        expect(refused.body).toMatchObject({
          _tag: "AppEvaluationFailed",
          skills: {
            reason: "source",
            status: 421,
            // The loader names the host it requested, before the app's fetch redirected it here.
            message: expect.stringContaining(
              "A request with the GitHub token to github.com was refused because the account's provider does not declare that host. The provider must declare hosts github.com and raw.githubusercontent.com",
            ),
          },
          recovery: {
            action: "Check the hosts the provider of the skill loader’s account declares.",
          },
        });
        expect((yield* upstream.credentials).length).toBe(before);
      }),
    ),
  );
});
