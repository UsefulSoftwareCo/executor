/**
 * A failed step says what went wrong, and no secret its cause carried. The cases in
 * e2e/failure-text fail on purpose, with synthetic secrets planted in each place one can appear: a
 * revealed secret echoed in a message or a page, a URL's userinfo, query and fragment, request
 * headers and cookies, and an opaque token the harness never revealed. They run in their own
 * Vitest process, and this scenario reads the log, the Vitest results and the evidence they leave.
 */
import { expect, layer } from "@effect/vitest";
import { Config, Effect, FileSystem, Path, Schema, type PlatformError } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { TestLive, withCase } from "../support/case.ts";
import { Evidence } from "../support/evidence.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { failureTextCases, planted, shapes, webhookVariable } from "../failure-text/titles.ts";

const Results = Schema.Struct({
  testResults: Schema.Array(
    Schema.Struct({
      assertionResults: Schema.Array(
        Schema.Struct({
          title: Schema.String,
          status: Schema.String,
          failureMessages: Schema.Array(Schema.String),
        }),
      ),
    }),
  ),
});
const CaseResult = Schema.Struct({
  title: Schema.String,
  status: Schema.Literals(["passed", "failed"]),
  errors: Schema.Array(Schema.String),
});
const Steps = Schema.Array(
  Schema.Struct({
    name: Schema.String,
    status: Schema.String,
    error: Schema.optionalKey(Schema.String),
  }),
);
const PageErrors = Schema.Array(
  Schema.Struct({ kind: Schema.String, page: Schema.String, text: Schema.String }),
);

/** The evidence files a case writes as text; screenshots, videos and the trace are binary. */
const textFile = /\.(?:json|ndjson|txt|log|md)$/u;

/** Every form of a planted value a leak could take: whole, cut off, URL-encoded or base64. */
const forms = (value: string) => [
  value,
  value.slice(0, 10),
  encodeURIComponent(value),
  Buffer.from(value).toString("base64").replace(/=+$/u, ""),
  Buffer.from(value).toString("base64url"),
];
/** The names the runner passes the worker (`runSuite` in e2e/sdk/suite.ts), and Vitest's own. */
const workerVariable =
  /^(?:PATH|HOME|TMPDIR|MCP_CACHE_FIXTURE_ORIGIN|E2E_[A-Z0-9_]+|EXECUTOR_E2E_[A-Z0-9_]+|VITEST[A-Z0-9_]*|FORCE_TTY|NODE_ENV|TEST|PROD|DEV|MODE|BASE_URL|SSR)$/u;
/** Synthetic values in the runner's own environment, named as a deployed job's tokens are. */
const infrastructure = {
  CLOUDFLARE_API_TOKEN: "inf1-planted-cloudflare-token",
  NEON_API_KEY: "inf2-planted-neon-key",
  GITHUB_TOKEN: "inf3-planted-github-token",
  AWS_SECRET_ACCESS_KEY: "inf4-planted-aws-secret",
} as const;
const plantedValues: ReadonlyArray<readonly [string, string]> = [
  ...Object.entries(planted).filter(([kind]) => kind !== "splitPiece"),
  ...Object.entries(shapes).map(([kind, { value }]) => [kind, value] as const),
];

layer(TestLive, { excludeTestServices: true })("Failure text", (it) => {
  it.effect(
    scenarios.failureText.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const target = yield* Target,
            fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            evidence = yield* Evidence,
            processes = yield* ChildProcessSpawner.ChildProcessSpawner;
          const run = path.join(target.directory, "failure-text-cases");
          yield* fs.makeDirectory(run, { recursive: true, mode: 0o700 });
          yield* fs.copyFile(
            path.join(yield* Config.String("EXECUTOR_E2E_RUN"), "run.json"),
            path.join(run, "run.json"),
          );
          // The cases' whole log, as a CI job prints it.
          const log = yield* evidence.step(
            "Run the failing cases",
            processes.string(
              ChildProcess.make(
                "node",
                [
                  "node_modules/vitest/vitest.mjs",
                  "run",
                  "--config",
                  "e2e/failure-text/vitest.config.ts",
                ],
                {
                  env: { EXECUTOR_E2E_RUN: run, [webhookVariable]: shapes.webhook.value },
                  extendEnv: true,
                },
              ),
              { includeStderr: true },
            ),
          );
          yield* evidence.attach("failure-cases.log", "text/plain", log);
          const read = <S extends Schema.Codec<unknown>>(schema: S, file: string) =>
            fs
              .readFileString(file)
              .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))));
          const resultsFile = path.join(run, "results.json");
          const reported = new Map(
            (yield* read(Results, resultsFile)).testResults
              .flatMap((file) => file.assertionResults)
              .map((result) => [result.title, result]),
          );
          const folders = path.join(run, "report/evidence");
          const cases = new Map<string, string>();
          for (const name of yield* fs.readDirectory(folders)) {
            const result = yield* read(CaseResult, path.join(folders, name, "result.json"));
            cases.set(result.title, path.join(folders, name));
          }

          // No planted secret reaches the log, the Vitest results or any text evidence file.
          const outputs: { name: string; text: string }[] = [
            { name: "the cases' log", text: log },
            { name: "results.json", text: yield* fs.readFileString(resultsFile) },
          ];
          for (const folder of cases.values())
            for (const name of yield* fs.readDirectory(folder))
              if (textFile.test(name))
                outputs.push({
                  name: path.join(path.basename(folder), name),
                  text: yield* fs.readFileString(path.join(folder, name)),
                });
          for (const [kind, secret] of plantedValues)
            for (const form of forms(secret))
              for (const { name, text } of outputs)
                expect(
                  text.includes(form),
                  `${name} holds the planted ${kind} secret as ${JSON.stringify(form)}`,
                ).toBe(false);

          /**
           * The text each output reports for a case: its Vitest failure message, its result's
           * error and its failed step's error. Each must hold every expected fragment.
           */
          const reports = (title: string, step: string | undefined, fragments: string[]) =>
            Effect.gen(function* () {
              const folder = cases.get(title);
              if (folder === undefined)
                return yield* Effect.die(`The case "${title}" left no evidence`);
              const vitest = reported.get(title);
              expect(vitest?.status, title).toBe("failed");
              const result = yield* read(CaseResult, path.join(folder, "result.json"));
              expect(result.status, title).toBe("failed");
              const texts = [
                { name: "the Vitest message", text: vitest?.failureMessages.join("\n") ?? "" },
                { name: "result.json", text: result.errors.join("\n") },
                { name: "the log", text: log },
              ];
              if (step !== undefined) {
                const steps = yield* read(Steps, path.join(folder, "steps.json"));
                const failed = steps.find(({ name }) => name === step);
                expect(failed?.status, `${title}: its step`).toBe("failed");
                texts.push({ name: "steps.json", text: failed?.error ?? "" });
              }
              for (const { name, text } of texts)
                for (const fragment of fragments)
                  expect(text, `${title}: ${name}`).toContain(fragment);
              return folder;
            });

          yield* reports(failureTextCases.nodeProtocol, "POST /mcp on a kept-alive connection", [
            "Driver operation failed: POST /mcp on a kept-alive connection",
            'TypeError [ERR_INVALID_PROTOCOL]: Protocol "https:" not supported. Expected "http:"',
          ]);
          yield* reports(failureTextCases.strictMode, "Click the repeated text", [
            "Driver operation failed: Click the repeated text",
            "locator.click: Error: strict mode violation: getByText('Same') resolved to 2 elements:",
            '<p data-key="<secret>">Same</p>',
            "- waiting for getByText('Same')",
          ]);
          yield* reports(failureTextCases.timeout, "Click a button that never appears", [
            "Driver operation failed: Click a button that never appears",
            "TimeoutError: locator.click: Timeout 500ms exceeded.",
            "- waiting for getByRole('button', { name: 'Missing' })",
          ]);
          yield* reports(failureTextCases.request, "Request a refused port with credentials", [
            "apiRequestContext.get: connect ECONNREFUSED 127.0.0.1:",
            "/refused\n",
            "- authorization: <value>",
            "- cookie: <value>",
            "- x-api-key: <secret>",
          ]);
          yield* reports(failureTextCases.echoed, "Call an SDK that echoes its input", [
            "Error: Invalid token <secret> for http://upstream.test/v1; session <opaque>",
            "Caused by: Error [ECONNREFUSED]: connect ECONNREFUSED 127.0.0.1:1 while sending <secret>",
          ]);
          const pageErrors = yield* reports(failureTextCases.pageErrors, undefined, [
            "The page hydrates without errors, but the page raised 2 errors:",
            "1. Minified React error #418; visit https://react.dev/errors/418 for the full message",
            "2. Rendered <secret> into the page",
          ]);
          const consoleErrors = yield* reports(failureTextCases.consoleErrors, undefined, [
            "The page logs no errors, but the page raised 1 error:",
            "1. Console saw <secret>",
          ]);
          expect(yield* read(PageErrors, path.join(consoleErrors, "page-errors.json"))).toEqual([
            {
              kind: "console",
              page: "http://failure-text.test/console",
              text: "Console saw <secret>",
            },
          ]);
          yield* reports(failureTextCases.filled, "Fill a disabled field", [
            "TimeoutError: locator.fill: Timeout 500ms exceeded.",
            "- waiting for getByLabel('Key')",
            'fill("<value>")',
          ]);
          yield* reports(failureTextCases.straddle, "Call an SDK with a long message", [
            // The placeholder itself is cut at the limit: the secret was masked first.
            `${"x".repeat(385)} <secret`,
          ]);
          yield* reports(failureTextCases.split, "Call an SDK that echoes a token", [
            "Error: token <secret> refused",
          ]);
          yield* reports(failureTextCases.requestFailed, undefined, [
            "GET /api/auth/self-host/config failed (request) before a JSON response was read",
            "Bearer <value>",
          ]);
          yield* reports(failureTextCases.replaced, undefined, [
            "Driver operation failed: Replace a response the browser received",
            "Error: replacement rejected Bearer <value> for http://upstream.test/x",
          ]);
          yield* reports(failureTextCases.sessionCookie, "Echo the session cookie", [
            "Error: session <secret>",
          ]);
          yield* reports(failureTextCases.login, "Echo the browser's cookie", [
            "Error: cookie <secret> refused",
          ]);
          const echoed = {
            jwt: "Error: 401 for Authorization: <value>",
            signedCookie: "Error: the browser sent <secret>",
            axiom: "Error: query refused for <opaque>",
            oauthCode: "Error: Location: /api/auth/callback/github",
            base64: "Error: signature <secret> does not match",
            hex: "Error: key <secret> expired",
            digits: "Error: code <secret> expired",
            webhook: "Error: signature checked with <secret>",
          } satisfies Record<keyof typeof shapes, string>;
          for (const [shape, { title }] of Object.entries(shapes))
            yield* reports(title, `Echo a ${shape} secret`, [echoed[shape as keyof typeof shapes]]);
          // The browser keeps every page error in the evidence, whether or not a case asserts on it.
          expect(
            (yield* read(PageErrors, path.join(pageErrors, "page-errors.json"))).map(
              ({ kind, text }) => ({ kind, text }),
            ),
          ).toEqual([
            {
              kind: "page",
              text: "Error: Minified React error #418; visit https://react.dev/errors/418 for the full message",
            },
            { kind: "page", text: "Error: Rendered <secret> into the page" },
          ]);

          // A preparation failure names its request and each cause, masked, in its record and the log.
          const preparation = cases.get(failureTextCases.preparation);
          expect(reported.get(failureTextCases.preparation)?.status).toBe("passed");
          if (preparation === undefined)
            return yield* Effect.die("The preparation case left no evidence");
          const record = yield* read(
            Schema.Struct({
              unavailableOrganizations: Schema.Array(
                Schema.Struct({
                  failure: Schema.String,
                  detail: Schema.Struct({
                    method: Schema.String,
                    path: Schema.String,
                    reason: Schema.String,
                    causes: Schema.Array(Schema.String),
                  }),
                }),
              ),
            }),
            path.join(preparation, "preparation.json"),
          );
          const [organization] = record.unavailableOrganizations;
          expect(organization?.failure).toBe("RequestFailed");
          expect(organization?.detail).toMatchObject({
            method: "GET",
            path: "/api/auth/self-host/config",
            reason: "request",
          });
          expect(organization?.detail.causes.join("\n")).toContain("Bearer <value>");
          expect(log).toContain(
            'Cloud organization not ready for "A prepared organization": RequestFailed {"method":"GET"',
          );
          expect(log).toMatch(/Cloud organization not ready for .*Bearer <value>/u);

          // A passing case records nothing new: no step error and no page errors.
          const passing = cases.get(failureTextCases.passing);
          expect(reported.get(failureTextCases.passing)?.status).toBe("passed");
          if (passing === undefined) return yield* Effect.die("The passing case left no evidence");
          expect(yield* read(Steps, path.join(passing, "steps.json"))).toEqual([
            expect.objectContaining({ name: "Open a page", status: "passed" }),
          ]);
          expect(
            (yield* read(Steps, path.join(passing, "steps.json"))).some((step) => "error" in step),
          ).toBe(false);
          expect(yield* fs.exists(path.join(passing, "page-errors.json"))).toBe(false);
        }),
      ),
    120_000,
  );

  // The runner starts the Vitest worker with only the variables it lists (`runSuite` in
  // e2e/sdk/suite.ts), so a job's infrastructure tokens never enter the process whose errors are
  // printed. This scenario runs in every worker the runner starts, and records variable names only.
  it.effect(scenarios.workerEnvironment.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const evidence = yield* Evidence;
        const names = Object.keys(process.env).toSorted();
        yield* evidence.json("environment.json", names);
        expect(names.filter((name) => !workerVariable.test(name))).toEqual([]);
      }),
    ),
  );

  it.effect(
    scenarios.workerIsolation.title,
    (context) =>
      withCase(
        context,
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem,
            path = yield* Path.Path,
            evidence = yield* Evidence,
            processes = yield* ChildProcessSpawner.ChildProcessSpawner;
          // The runner's own environment holds infrastructure-style variables, as a deployed job's does.
          const log = yield* evidence.step(
            "Run the worker environment scenario with infrastructure variables set",
            processes.string(
              ChildProcess.make(
                "node",
                [
                  "e2e/run.ts",
                  "--target",
                  "self-host",
                  "--workers",
                  "1",
                  "--test-name",
                  scenarios.workerEnvironment.title,
                ],
                {
                  env: { ...infrastructure, EXECUTOR_E2E_HOST_SLOTS: "off" },
                  extendEnv: true,
                },
              ),
              { includeStderr: true },
            ),
          );
          yield* evidence.attach("nested-run.log", "text/plain", log);
          const directory = /Raw test evidence: (\S+)/u.exec(log)?.[1];
          if (directory === undefined)
            return yield* Effect.die("The nested run printed no evidence directory");
          expect(log).toContain("1 passed");
          const names: string[] = [];
          const texts: string[] = [log];
          const visit = (
            folder: string,
          ): Effect.Effect<void, PlatformError.PlatformError | Schema.SchemaError> =>
            Effect.gen(function* () {
              for (const name of yield* fs.readDirectory(folder)) {
                const file = path.join(folder, name);
                if ((yield* fs.stat(file)).type === "Directory") yield* visit(file);
                else if (name === "environment.json")
                  names.push(
                    ...(yield* fs
                      .readFileString(file)
                      .pipe(
                        Effect.flatMap(
                          Schema.decodeUnknownEffect(
                            Schema.fromJsonString(Schema.Array(Schema.String)),
                          ),
                        ),
                      )),
                  );
                if (textFile.test(name)) texts.push(yield* fs.readFileString(file));
              }
            });
          yield* visit(directory);
          expect(names, "the worker recorded its variables").toContain("EXECUTOR_E2E_RUN");
          for (const [name, value] of Object.entries(infrastructure)) {
            expect(names, "the worker's variables").not.toContain(name);
            for (const text of texts) expect(text.includes(value), name).toBe(false);
          }
        }),
      ),
    180_000,
  );
});
