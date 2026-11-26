import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import {
  acceptedToken,
  accountCheckUpstream,
  type AccountCheckAnswer,
} from "../support/account-check-upstream.ts";
import { withApps, mcpSdkVersion } from "../support/apps-release.ts";
import { scenarios } from "../test-plan.ts";

const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({
    accounts: Schema.Record(
      Schema.String,
      Schema.Struct({ provider: Schema.String, health: Schema.optional(Schema.Literal(true)) }),
    ),
  }),
});
const Check = Schema.Struct({
  status: Schema.String,
  info: Schema.Null,
  message: Schema.optionalKey(Schema.String),
});

const source = (
  origin: string,
) => `import { defineApp, defineProvider, object, router, secrets, string } from "apps";
import { mcpHealth } from "apps/mcp";

const url = ${JSON.stringify(`${origin}/mcp`)};
const headers = (account: { fields: { token: string } }) => ({
  authorization: "Bearer " + account.fields.token,
});
const checked = (name: string, timeoutMs?: number) =>
  defineProvider({
    name,
    hosts: [${JSON.stringify(new URL(origin).host)}],
    auth: { apiKey: secrets({ label: "API key", fields: object({ token: string() }) }) },
    health: (check) =>
      mcpHealth(check, {
        url,
        headers: headers(check.account),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      }),
  });
const service = checked("MCP check");
const patient = checked("Patient MCP check", 300_000);

export default defineApp({ user: { accounts: { service, patient } } }, { tools: router({}) });
`;

layer(HostedLive, { excludeTestServices: true })("MCP account health", (it) => {
  it.effect(scenarios.mcpAccountHealth.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors;
        const upstream = yield* accountCheckUpstream;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `MCP check ${randomUUID().slice(0, 8)}`,
          files: [
            { path: "index.ts", content: source(upstream.origin) },
            {
              path: "package.json",
              content: JSON.stringify({
                dependencies: withApps({ "@modelcontextprotocol/sdk": mcpSdkVersion }),
              }),
            },
          ],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const { service, patient } = app.requirements.accounts;
        expect(service?.health).toBe(true);
        expect(patient?.health).toBe(true);
        if (service === undefined || patient === undefined)
          return yield* Effect.die("Missing account requirement");

        const check = (token: string, requirement = service) =>
          Effect.gen(function* () {
            const response = yield* api.request(
              actors.owner,
              "POST",
              `${prefix}/apps/${app.id}/credential-checks`,
              { provider: requirement.provider, method: "apiKey", fields: { token } },
            );
            expect(response.status, JSON.stringify(response.body)).toBe(200);
            const result = yield* body(Check, response);
            expect(JSON.stringify(result)).not.toContain(token);
            return result;
          });

        const refusedToken = "synthetic-refused-token";
        const listed = yield* upstream.anonymousRequests;
        expect(yield* check(acceptedToken)).toEqual({ status: "healthy", info: null });
        expect(yield* upstream.anonymousRequests).toBeGreaterThan(listed);
        expect(yield* check(refusedToken)).toEqual({
          status: "credentials_rejected",
          info: null,
        });

        yield* upstream.answer({ kind: "protected" });
        const challenged = yield* upstream.anonymousRequests;
        expect(yield* check(acceptedToken)).toEqual({ status: "healthy", info: null });
        expect(yield* upstream.anonymousRequests).toBeGreaterThan(challenged);
        const rejected = yield* upstream.anonymousRequests;
        expect(yield* check(refusedToken)).toEqual({
          status: "credentials_rejected",
          info: null,
        });
        expect(yield* upstream.anonymousRequests).toBe(rejected);

        yield* upstream.answer({ kind: "open" });
        for (const token of [acceptedToken, refusedToken])
          expect(yield* check(token)).toEqual({
            status: "check_failed",
            info: null,
            message:
              "This MCP server answers without credentials, so Executor can't check this account. A refused key will show up when a tool is called.",
          });
        const undecided: ReadonlyArray<readonly [AccountCheckAnswer, string]> = [
          [
            { kind: "anonymous", failure: { kind: "status", status: 503 } },
            "The MCP server answered HTTP 503.",
          ],
          [
            { kind: "anonymous", failure: { kind: "hang" } },
            "The MCP server did not respond in time while connecting.",
          ],
        ];
        for (const [answer, reason] of undecided) {
          yield* upstream.answer(answer);
          expect(yield* check(acceptedToken), JSON.stringify(answer)).toEqual({
            status: "check_failed",
            info: null,
            message: `The MCP server accepted the credentials, but the same check without them failed, so Executor can't tell whether it requires them. ${reason}`,
          });
        }
        yield* upstream.answer({ kind: "anonymous", failure: { kind: "hang" } });
        expect(yield* check(acceptedToken, patient)).toEqual({
          status: "check_failed",
          info: null,
          message:
            "The MCP server accepted the credentials, but the same check without them failed, so Executor can't tell whether it requires them. The MCP server did not respond in time while connecting.",
        });

        const answers: ReadonlyArray<readonly [AccountCheckAnswer, string]> = [
          [
            {
              kind: "status",
              status: 403,
              headers: { "www-authenticate": 'Bearer error="insufficient_scope"' },
            },
            "forbidden",
          ],
          [{ kind: "status", status: 429 }, "upstream_unavailable"],
          [{ kind: "status", status: 503 }, "upstream_unavailable"],
        ];
        for (const [answer, status] of answers) {
          yield* upstream.answer(answer);
          expect(yield* check(acceptedToken), JSON.stringify(answer)).toEqual({
            status,
            info: null,
          });
        }

        yield* upstream.answer({ kind: "status", status: 404 });
        expect(yield* check(acceptedToken)).toEqual({
          status: "check_failed",
          info: null,
          message: "The MCP server answered HTTP 404 while connecting.",
        });
        for (const page of [{ kind: "page" }, { kind: "page", post: 405 }] as const) {
          yield* upstream.answer(page);
          expect(yield* check(acceptedToken), JSON.stringify(page)).toEqual({
            status: "check_failed",
            info: null,
            message:
              "The MCP server returned a response Executor could not use while connecting, such as an unreadable message or an address on another origin.",
          });
        }
        yield* upstream.answer({ kind: "list-error" });
        expect(yield* check(acceptedToken)).toEqual({
          status: "check_failed",
          info: null,
          message: "The request to the MCP server failed while listing its tools.",
        });

        yield* upstream.answer({ kind: "user" });
        expect(yield* check(acceptedToken)).toEqual({ status: "healthy", info: null });
      }),
    ),
  );
});
