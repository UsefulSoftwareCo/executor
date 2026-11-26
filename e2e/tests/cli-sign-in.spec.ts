import { expect, layer } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { Actors } from "../support/actors.ts";
import { Api } from "../support/api.ts";
import { appsCli, type Finished } from "../support/apps-cli.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { clientGrantId, scenarioOrganization } from "../support/mcp-connections.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";
import { scenarios } from "../test-plan.ts";

const Completed = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Literal("completed"),
    execution: Schema.Struct({ ok: Schema.Literal(true), value: Schema.Unknown }),
  }),
);
const Failure = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.String, message: Schema.String }) }),
);
const Apps = Schema.fromJsonString(Schema.Array(Schema.Struct({ id: Schema.String })));
const ToolsSession = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    resource: Schema.String,
  }),
);

const program = "return [6 * 7, 'cli-' + 'signed-in'].join(':')";
const answer = "42:cli-signed-in";

const ran = (result: Finished) => {
  expect(result.code, result.stderr).toBe(0);
  expect(Schema.decodeUnknownSync(Completed)(result.stdout).execution.value).toBe(answer);
};
const failedWith = (result: Finished, code: string) => {
  expect(result.code, result.stdout).toBe(1);
  const failure = Schema.decodeUnknownSync(Failure)(result.stdout).error;
  expect(failure.code, failure.message).toBe(code);
  return failure;
};

layer(HostedLive, { excludeTestServices: true })("CLI sign-in", (it) => {
  it.effect(scenarios.cliToolsLogin.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const host = hosts.api;
        const cli = yield* appsCli;
        const organization = yield* scenarioOrganization;

        const before = yield* cli.executor(["execute", "--host", host, "--code", program]);
        expect(failedWith(before, "NotSignedIn").message).toContain(
          `executor login --host ${host}`,
        );

        const login = yield* cli.login(host, ["login"]);
        expect(login.finished.code, login.finished.stderr).toBe(0);
        expect(login.finished.stdout).toContain(
          `Connected to ${host} as @${organization.slug}: every app, approvals in model mode.`,
        );
        expect(new URL(yield* cli.openedPage).searchParams.get("user_code")).toBe(login.userCode);

        ran(yield* cli.executor(["execute", "--code", program]));
        ran(yield* cli.executor(["execute", "--file", "-"], { input: program }));

        const saved = (yield* cli.storedCredential("Executor Tools", host)).pipe(
          Option.map(Schema.decodeUnknownSync(ToolsSession)),
        );
        expect(Option.map(saved, ({ resource }) => resource)).toEqual(
          Option.some(`${hosts.mcp}/mcp`),
        );
        const who = yield* cli.executor(["whoami"]);
        expect(who.code, who.stderr).toBe(0);
        expect(JSON.parse(who.stdout)).toEqual({
          host,
          mcp: `${hosts.mcp}/mcp`,
          organization,
          access: { kind: "all" },
          mode: "model",
        });

        ran(
          yield* cli.executor(["execute", "--code", program], {
            extra: { EXECUTOR_ENVIRONMENT: "e2e", EXECUTOR_TEST_CLOCK_OFFSET_MS: "5400000" },
          }),
        );
        const refreshed = (yield* cli.storedCredential("Executor Tools", host)).pipe(
          Option.map(Schema.decodeUnknownSync(ToolsSession)),
        );
        expect(Option.isSome(refreshed) && Option.isSome(saved)).toBe(true);
        if (Option.isSome(refreshed) && Option.isSome(saved)) {
          expect(refreshed.value.accessToken === saved.value.accessToken, "access token").toBe(
            false,
          );
          expect(refreshed.value.refreshToken === saved.value.refreshToken, "refresh token").toBe(
            false,
          );
        }
        ran(yield* cli.executor(["execute", "--code", program]));

        const api = yield* Api,
          actors = yield* Actors,
          http = yield* HttpClient.HttpClient;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const source = yield* cli.fs.makeTempDirectoryScoped({ prefix: "executor-one-sign-in-" });
        yield* cli.fs.writeFileString(
          cli.path.join(source, "index.ts"),
          'export default "one sign-in";',
        );
        const created = yield* cli.cli(["create", "--name", "One sign-in", "--files", source]);
        expect(created.code, created.stderr).toBe(0);
        const app = Schema.decodeUnknownSync(
          Schema.fromJsonString(Schema.Struct({ id: Schema.String })),
        )(created.stdout);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const listed = yield* cli.cli(["list"]);
        expect(listed.code, listed.stderr).toBe(0);
        expect(Schema.decodeUnknownSync(Apps)(listed.stdout).map((item) => item.id)).toContain(
          app.id,
        );

        const current = (yield* cli.storedCredential("Executor Tools", host)).pipe(
          Option.map(Schema.decodeUnknownSync(ToolsSession)),
        );
        const statusOf = (path: string) =>
          Option.match(current, {
            onNone: () => Effect.succeed(0),
            onSome: ({ accessToken }) =>
              http
                .execute(
                  HttpClientRequest.get(`${host}${path}`).pipe(
                    HttpClientRequest.bearerToken(accessToken),
                  ),
                )
                .pipe(
                  Effect.map((response) => response.status),
                  Effect.orDie,
                ),
          });
        const unrelated = yield* cli.executor(["apps", "credential", "get"], {
          input: `protocol=https\nhost=git.example.test\npath=git/${actors.organization.id}/app.git\n\n`,
        });
        expect(unrelated.code, unrelated.stderr).toBe(0);
        expect(unrelated.stdout, "no credential and nothing else for another Git host").toBe("");
        expect(unrelated.stderr).toBe("");

        expect(yield* statusOf("/api/context")).toBe(200);
        expect(yield* statusOf(`${prefix}/apps`)).toBe(200);
        expect(yield* statusOf(`${prefix}/inventory`)).toBe(401);

        const narrowed = yield* api.request(actors.owner, "POST", "/api/auth/mcp/grants/narrow", {
          id: yield* clientGrantId(actors.owner, login.clientId),
          policy: { kind: "tools", apps: [], approval: "client" },
        });
        expect(narrowed.status, JSON.stringify(narrowed.body)).toBe(200);
        const selected = yield* cli.executor(["whoami"]);
        expect(selected.code, selected.stderr).toBe(0);
        expect(JSON.parse(selected.stdout)).toMatchObject({
          access: { kind: "tools", apps: 0 },
          mode: "model",
        });
        const refused = failedWith(
          yield* cli.cli(["create", "--name", "Narrowed", "--files", source]),
          "OrganizationForbidden",
        );
        expect(refused.message).toContain("run executor login again and choose All apps");
      }),
    ),
  );

  it.effect(scenarios.cliRememberedHost.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const host = targetHosts(yield* Target).api;
        const cli = yield* appsCli;
        const signedIn = yield* cli.login(host);
        expect(signedIn.finished.code, signedIn.finished.stderr).toBe(0);
        const listed = yield* cli.cli(["list"]);
        expect(listed.code, listed.stderr).toBe(0);
        Schema.decodeUnknownSync(Apps)(listed.stdout);

        const elsewhere = { EXECUTOR_HOST: "http://127.0.0.1:9" };
        failedWith(
          yield* cli.executor(["execute", "--code", program], { extra: elsewhere }),
          "NotSignedIn",
        );
        ran(
          yield* cli.executor(["execute", "--host", host, "--code", program], {
            extra: elsewhere,
          }),
        );

        const out = yield* cli.executor(["logout"]);
        expect(out.code, out.stderr).toBe(0);
        expect(out.stdout).toContain(`Signed out of ${host}.`);
        failedWith(
          yield* cli.executor(["execute", "--host", host, "--code", program]),
          "NotSignedIn",
        );
        expect(
          failedWith(yield* cli.cli(["list", "--host", host]), "NotSignedIn").message,
        ).toContain("Run executor login,");
        const signedOut = yield* cli.executor(["apps", "credential", "get"], {
          input: `protocol=${new URL(host).protocol.slice(0, -1)}\nhost=${new URL(host).host}\npath=git/organization/app.git\n\n`,
        });
        expect(signedOut.stdout, "Git reads this as its credential protocol").toBe("");
        expect(signedOut.stderr).toContain("Not signed in to this host for app commands.");
        const forgotten = failedWith(yield* cli.executor(["logout"]), "NotSignedIn");
        expect(forgotten.message).toContain("No Executor host is named or signed in to");
        const again = yield* cli.executor(["logout", "--host", host]);
        expect(again.code, again.stderr).toBe(0);
        expect(again.stdout).toContain(`Not signed in to ${host}.`);
      }),
    ),
  );
});
