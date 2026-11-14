/**
 * `executor apps call` runs one app tool from a shell with an API key, as an import script does:
 * input from a file or stdin, the tool's value on stdout, and the host's refusals as exit codes.
 * A CLI signed in with a device code calls tools under its person's own access the same way.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appsCli } from "../support/apps-cli.ts";
import { withApps } from "../support/apps-release.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { targetHosts } from "../support/role-hosts.ts";

const files = [
  { path: "package.json", content: JSON.stringify({ dependencies: withApps() }) },
  {
    path: "index.ts",
    content: `import { array, defineApp, mutation, object, router, string } from "apps";
import { always } from "apps/operations/approval";
const Records = object({ records: array(object({ id: string(), note: string() })) });
export default defineApp({}, { tools: router({
  import: router({
    records: mutation({ input: Records }, async (_ctx, { records }) => ({
      count: records.length,
      first: records[0]?.id ?? null,
      last: records.at(-1)?.id ?? null,
      noteChars: records.reduce((total, record) => total + record.note.length, 0),
    })),
    fail: mutation({ input: object({}) }, async () => {
      throw new Error("Import rejected: duplicate id r-1");
    }),
    review: mutation({ input: object({}), approval: always() }, async () => ({ reviewed: true })),
  }),
}) });`,
  },
];

const App = Schema.Struct({ id: Schema.String, slug: Schema.String });
const Imported = Schema.fromJsonString(
  Schema.Struct({
    count: Schema.Number,
    first: Schema.NullOr(Schema.String),
    last: Schema.NullOr(Schema.String),
    noteChars: Schema.Number,
  }),
);
/** A failed command's stdout when a program reads it. */
const Failure = Schema.fromJsonString(
  Schema.Struct({
    error: Schema.Struct({
      code: Schema.String,
      status: Schema.optional(Schema.Number),
      message: Schema.String,
    }),
  }),
);
const Key = Schema.Struct({ key: Schema.RedactedFromValue(Schema.String), id: Schema.String });

const records = (count: number, note: string) => ({
  records: Array.from({ length: count }, (_, index) => ({ id: `r-${index + 1}`, note })),
});

layer(HostedLive, { excludeTestServices: true })("Apps CLI call", (it) => {
  it.effect(scenarios.appsCliCall.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const organization = actors.organization.id;
        const prefix = `/api/organizations/${organization}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `CLI call ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        /** An API key for one actor, deleted with the scope. */
        const apiKey = (actor: typeof actors.owner) =>
          Effect.gen(function* () {
            const issued = yield* api.request(actor, "POST", "/api/auth/api-key/create", {
              name: `CLI call ${randomUUID().slice(0, 8)}`,
            });
            expect(issued.status).toBe(200);
            const key = yield* body(Key, issued);
            yield* Effect.addFinalizer(() =>
              api
                .request(actor, "POST", "/api/auth/api-key/delete", { keyId: key.id })
                .pipe(Effect.ignore),
            );
            return key.key;
          });

        const owner = yield* appsCli;
        yield* owner.withAccessToken(yield* apiKey(actors.owner));
        const connection = ["--host", hosts.api, "--organization", organization];
        const call = (args: ReadonlyArray<string>, input?: string) =>
          owner.cli(["call", ...connection, "--app", app.slug, ...args], input);
        const write = (name: string, content: string) =>
          owner.fs
            .writeFileString(owner.path.join(owner.checkout, name), content)
            .pipe(Effect.as(owner.path.join(owner.checkout, name)));

        // A small input from a file, called by the app's slug and the tool's path within it.
        const small = yield* write("small.json", JSON.stringify(records(2, "hello")));
        const called = yield* call(["--tool", "import.records", "--input-file", small]);
        expect(called.code, called.stderr).toBe(0);
        expect(yield* Schema.decodeUnknownEffect(Imported)(called.stdout)).toEqual({
          count: 2,
          first: "r-1",
          last: "r-2",
          noteChars: 10,
        });

        // About 2 MB of JSON reaches the tool whole, from a file and from stdin.
        const large = JSON.stringify(records(10_000, "x".repeat(180)));
        expect(large.length).toBeGreaterThan(2_000_000);
        const largeFile = yield* write("large.json", large);
        const whole = { count: 10_000, first: "r-1", last: "r-10000", noteChars: 1_800_000 };
        const fromFile = yield* call(["--tool", "import.records", "--input-file", largeFile]);
        yield* evidence.json("large-input.json", {
          bytes: large.length,
          code: fromFile.code,
          stderr: fromFile.stderr,
        });
        expect(fromFile.code, fromFile.stderr).toBe(0);
        expect(yield* Schema.decodeUnknownEffect(Imported)(fromFile.stdout)).toEqual(whole);
        const fromStdin = yield* call(["--tool", "import.records", "--input-file", "-"], large);
        expect(fromStdin.code, fromStdin.stderr).toBe(0);
        expect(yield* Schema.decodeUnknownEffect(Imported)(fromStdin.stdout)).toEqual(whole);
        // An input over the host's 32 MiB limit is refused with its size and the limit, before the
        // app runs, instead of failing inside the runtime as an unreadable result.
        const oversized = yield* write(
          "oversized.json",
          JSON.stringify(records(190_000, "x".repeat(180))),
        );
        const tooLarge = yield* call(["--tool", "import.records", "--input-file", oversized]);
        expect(tooLarge.code).toBe(1);
        const refusedSize = (yield* Schema.decodeUnknownEffect(Failure)(tooLarge.stdout)).error;
        yield* evidence.json("oversized-input.json", refusedSize);
        expect(refusedSize).toMatchObject({ code: "InputInvalid", status: 422 });
        expect(refusedSize.message).toContain("limited to 32 MiB");
        // The same call by the app's ID, with inline input.
        const byId = yield* owner.cli([
          "call",
          ...connection,
          "--app",
          app.id,
          "--tool",
          "import.records",
          "--input",
          JSON.stringify(records(1, "abc")),
        ]);
        expect(byId.code, byId.stderr).toBe(0);
        expect((yield* Schema.decodeUnknownEffect(Imported)(byId.stdout)).count).toBe(1);

        // Input that is not one JSON object is refused before any request: the same refusal
        // comes back from a host that does not answer.
        const truncated = yield* write("truncated.json", large.slice(0, 1_000));
        const invalid = yield* call(["--tool", "import.records", "--input-file", truncated]);
        expect(invalid.code).toBe(1);
        expect(invalid.stderr).toContain("is not a JSON object. Nothing was sent.");
        expect((yield* Schema.decodeUnknownEffect(Failure)(invalid.stdout)).error.code).toBe(
          "CallInputRejected",
        );
        const offline = yield* owner.cli([
          "call",
          "--host",
          "http://127.0.0.1:9",
          "--organization",
          organization,
          "--app",
          app.slug,
          "--tool",
          "import.records",
          "--input-file",
          truncated,
        ]);
        expect(offline.code).toBe(1);
        expect((yield* Schema.decodeUnknownEffect(Failure)(offline.stdout)).error.code).toBe(
          "CallInputRejected",
        );
        const array = yield* call(["--tool", "import.records", "--input", "[1, 2]"]);
        expect(array.code).toBe(1);
        expect((yield* Schema.decodeUnknownEffect(Failure)(array.stdout)).error.code).toBe(
          "CallInputRejected",
        );

        // A tool that throws fails the command with the app's own message.
        const failed = yield* call(["--tool", "import.fail"]);
        expect(failed.code).toBe(1);
        expect(failed.stderr).toContain("Import rejected: duplicate id r-1");
        const failure = yield* Schema.decodeUnknownEffect(Failure)(failed.stdout);
        expect(failure.error.code).toBe("ToolCallFailed");
        expect(failure.error.status).toBe(502);

        // A call that needs approval does not run, and the CLI cannot approve it: exit 2.
        const review = yield* call(["--tool", "import.review"]);
        expect(review.code, review.stderr).toBe(2);
        expect((yield* Schema.decodeUnknownEffect(Failure)(review.stdout)).error.code).toBe(
          "ToolApprovalRequired",
        );

        // A member's key has no access to the owner's app: the host refuses the call.
        const member = yield* appsCli;
        yield* member.withAccessToken(yield* apiKey(actors.member));
        const refused = yield* member.cli([
          "call",
          ...connection,
          "--app",
          app.id,
          "--tool",
          "import.records",
          "--input-file",
          small,
        ]);
        yield* evidence.json("member-refused.json", refused);
        expect(refused.code).toBe(1);
        expect(refused.stdout).not.toContain("r-2");
        const forbidden = (yield* Schema.decodeUnknownEffect(Failure)(refused.stdout)).error;
        expect(forbidden).toMatchObject({ code: "OrganizationForbidden", status: 403 });
      }),
    ),
  );

  it.effect(scenarios.appsCliCallDeviceLogin.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const hosts = targetHosts(yield* Target);
        const api = yield* Api,
          actors = yield* Actors,
          evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `CLI device call ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        const path = `${prefix}/apps/${app.id}`;
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", path).pipe(Effect.orDie),
        );
        const input = JSON.stringify(records(2, "hello"));
        /** Sign one actor's CLI in with a device code, approved for the test organization. */
        const signedIn = (actor: typeof actors.owner) =>
          Effect.gen(function* () {
            const cli = yield* appsCli;
            const login = yield* cli.login(hosts.api, ["apps", "login"], undefined, actor);
            expect(login.finished.code, login.finished.stderr).toBe(0);
            return cli;
          });
        const call = (
          cli: Effect.Success<typeof appsCli>,
          target: string,
          selection: ReadonlyArray<string> = [],
        ) =>
          cli.cli([
            "call",
            "--host",
            hosts.api,
            ...selection,
            "--app",
            target,
            "--tool",
            "import.records",
            "--input",
            input,
          ]);

        // Both people approve their CLI's code at once; each approval waits for the next poll.
        const [owner, member] = yield* Effect.all(
          [signedIn(actors.owner), signedIn(actors.member)],
          { concurrency: 2 },
        );

        // The owner, who can use their own app, calls it. Sign-in prints the organization's slug,
        // so people name it by slug as often as by ID; both select the signed-in organization.
        const bySlug = ["--organization", actors.organization.slug];
        const listed = yield* owner.cli(["list", "--host", hosts.api, ...bySlug]);
        expect(listed.code, listed.stderr).toBe(0);
        expect(listed.stdout).toContain(app.id);
        for (const [label, selection] of [
          ["slug", bySlug],
          ["id", ["--organization", actors.organization.id]],
        ] as const) {
          const called = yield* call(owner, app.slug, selection);
          yield* evidence.json(`owner-device-call-by-${label}.json`, {
            code: called.code,
            stderr: called.stderr,
          });
          expect(called.code, called.stderr).toBe(0);
          expect(yield* Schema.decodeUnknownEffect(Imported)(called.stdout)).toEqual({
            count: 2,
            first: "r-1",
            last: "r-2",
            noteChars: 10,
          });
        }
        // An organization the session was not signed in to is the host's to refuse.
        const elsewhere = yield* call(owner, app.id, [
          "--organization",
          `elsewhere-${randomUUID().slice(0, 8)}`,
        ]);
        expect(elsewhere.code).toBe(1);
        expect(elsewhere.stdout).not.toContain("r-2");
        expect((yield* Schema.decodeUnknownEffect(Failure)(elsewhere.stdout)).error).toMatchObject({
          code: "OrganizationForbidden",
          status: 403,
        });

        // A member, calling without --organization, cannot use the owner's private app: the host
        // refuses the call and the tool never runs.
        const refused = yield* call(member, app.id);
        yield* evidence.json("member-device-refused.json", refused);
        expect(refused.code).toBe(1);
        expect(refused.stdout).not.toContain("r-2");
        expect((yield* Schema.decodeUnknownEffect(Failure)(refused.stdout)).error).toMatchObject({
          code: "OrganizationForbidden",
          status: 403,
        });

        // Once the owner shares the app with everyone, the member's same session may call it.
        const access = yield* body(
          Schema.Struct({ revision: Schema.String }),
          yield* api.request(actors.owner, "GET", `${path}/access`),
        );
        const shared = yield* api.request(actors.owner, "PATCH", `${path}/access`, {
          revision: access.revision,
          audience: { kind: "everyone" },
        });
        expect(shared.status).toBe(200);
        const allowed = yield* call(member, app.slug);
        yield* evidence.json("member-device-call.json", {
          code: allowed.code,
          stderr: allowed.stderr,
        });
        expect(allowed.code, allowed.stderr).toBe(0);
        expect((yield* Schema.decodeUnknownEffect(Imported)(allowed.stdout)).count).toBe(2);
      }),
    ),
  );
});
