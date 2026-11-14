/**
 * `executor login` signs the CLI in to a host's MCP resource with a device code, and the tool
 * commands then use that sign-in on the host signed in to last. `executor logout` removes both of
 * the host's sign-ins and forgets it.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Option, Schema } from "effect";
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
/** The tools sign-in the CLI saved, as far as this scenario reads it. */
const ToolsSession = Schema.fromJsonString(
  Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.String,
    resource: Schema.String,
  }),
);

/** A program whose answer appears nowhere in its source, so a result proves the host ran it. */
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

        // Before signing in, a named host has no tools credential.
        const before = yield* cli.executor(["execute", "--host", host, "--code", program]);
        expect(failedWith(before, "NotSignedIn").message).toContain(
          `executor login --host ${host}`,
        );

        const login = yield* cli.login(host, ["login"]);
        expect(login.finished.code, login.finished.stderr).toBe(0);
        // The host signed in to describes what the sign-in reaches.
        expect(login.finished.stdout).toContain(
          `Connected to ${host} as @${organization.slug}: every app, approvals in model mode.`,
        );
        // The page the CLI opened is the device page with its code.
        expect(new URL(yield* cli.openedPage).searchParams.get("user_code")).toBe(login.userCode);

        // No --host: the host signed in to last.
        ran(yield* cli.executor(["execute", "--code", program]));
        // A program from standard input, through the same sign-in.
        ran(yield* cli.executor(["execute", "--file", "-"], { input: program }));

        // The sign-in is saved in the OS credential store, for the MCP endpoint the host named:
        // on Cloud the canonical one on `mcp.`, beside the `api.` host signed in to.
        const saved = (yield* cli.storedCredential("Executor Tools", host)).pipe(
          Option.map(Schema.decodeUnknownSync(ToolsSession)),
        );
        expect(Option.map(saved, ({ resource }) => resource)).toEqual(
          Option.some(`${hosts.mcp}/mcp`),
        );
        // whoami prints the host, the endpoint and what the host says the sign-in reaches.
        const who = yield* cli.executor(["whoami"]);
        expect(who.code, who.stderr).toBe(0);
        expect(JSON.parse(who.stdout)).toEqual({
          host,
          mcp: `${hosts.mcp}/mcp`,
          organization,
          access: { kind: "all" },
          mode: "model",
          apps: false,
        });

        // An hour and a half later the access token has expired; the CLI refreshes it and saves
        // the new one, so a command at the real time still works with the refreshed session.
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
          // Compared as booleans, so a failure never prints a token.
          expect(refreshed.value.accessToken === saved.value.accessToken, "access token").toBe(
            false,
          );
          expect(refreshed.value.refreshToken === saved.value.refreshToken, "refresh token").toBe(
            false,
          );
        }
        ran(yield* cli.executor(["execute", "--code", program]));

        // The tools sign-in does not sign app commands in.
        failedWith(yield* cli.cli(["list"]), "NotSignedIn");

        // Narrowed after sign-in to selected tools, the grant reaches what it selects.
        const api = yield* Api,
          actors = yield* Actors;
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
      }),
    ),
  );

  it.effect(scenarios.cliRememberedHost.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const host = targetHosts(yield* Target).api;
        const cli = yield* appsCli;
        // `executor apps login` remembers its host too, for app commands without --host.
        const apps = yield* cli.login(host);
        expect(apps.finished.code, apps.finished.stderr).toBe(0);
        const listed = yield* cli.cli(["list"]);
        expect(listed.code, listed.stderr).toBe(0);
        Schema.decodeUnknownSync(Apps)(listed.stdout);

        const tools = yield* cli.login(host, ["login"]);
        expect(tools.finished.code, tools.finished.stderr).toBe(0);

        // EXECUTOR_HOST wins over the remembered host, and --host wins over EXECUTOR_HOST.
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
        // Both sign-ins are gone, and so is the remembered host.
        failedWith(
          yield* cli.executor(["execute", "--host", host, "--code", program]),
          "NotSignedIn",
        );
        failedWith(yield* cli.cli(["list", "--host", host]), "NotSignedIn");
        const forgotten = failedWith(yield* cli.executor(["logout"]), "NotSignedIn");
        expect(forgotten.message).toContain("No Executor host is named or signed in to");
        // Signing out again names the host and changes nothing.
        const again = yield* cli.executor(["logout", "--host", host]);
        expect(again.code, again.stderr).toBe(0);
        expect(again.stdout).toContain(`Not signed in to ${host}.`);
      }),
    ),
  );
});
