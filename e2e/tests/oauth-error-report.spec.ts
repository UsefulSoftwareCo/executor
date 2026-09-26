/** Cloud records an unusable OAuth response with safe evidence and tells the user it was tracked. */
import { expect, layer } from "@effect/vitest";
import { Effect, FileSystem, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { BaseUrl, emulatorRequest } from "../support/emulators.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { Evidence } from "../support/evidence.ts";

const App = Schema.Struct({ id: Schema.String });
const Instance = Schema.Struct({ providerBaseUrl: BaseUrl });
const Ledger = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      method: Schema.String,
      path: Schema.String,
      faulted: Schema.optional(Schema.Boolean),
    }),
  ),
});
const Batch = Schema.Struct({
  batch: Schema.Array(
    Schema.Struct({ event: Schema.String, properties: Schema.Record(Schema.String, Schema.Json) }),
  ),
});
const failureReports = (text: string) =>
  text
    .trim()
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => Schema.decodeUnknownSync(Schema.fromJsonString(Batch))(line).batch)
    .filter(
      (event) =>
        event.event === "product_operation_completed" &&
        event.properties.error_reason === "incompatible_response",
    )
    .map((event) => event.properties.error_report)
    .filter((report): report is string => typeof report === "string");

layer(HostedLive, { excludeTestServices: true })("OAuth error report", (it) => {
  it.effect(scenarios.oauthErrorReport.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          target = yield* Target,
          fs = yield* FileSystem.FileSystem;
        expect(
          target.metadata.mode,
          "This scenario requires managed Cloud with the local analytics collector",
        ).toBe("managed");
        // Cloud Workers fetch only public addresses, so the issuer is a private MCP emulator
        // instance whose registration endpoint answers 200 without a client ID.
        const issuer = (yield* emulatorRequest("https://mcp.emulators.dev", "/_emulate/instances", {
          instance: `executor-oauth-report-${randomUUID()}`,
        }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Instance)))).providerBaseUrl;
        yield* Effect.addFinalizer(() =>
          emulatorRequest(issuer, "/_emulate/reset", {}).pipe(Effect.orDie),
        );
        const prefix = `/api/organizations/${actors.organization.id}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: "Connection error report",
          files: [
            {
              path: "index.ts",
              content: `import { defineApp, defineProvider, oauth2 } from "apps";
const service=defineProvider({name:"Sample service",auth:{oauth:oauth2({discover:${JSON.stringify(`${issuer}/mcp`)}})}});
export default defineApp({accounts:{service}},async()=>({queries:{}}));`,
            },
          ],
        });
        expect(deployed.status).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        yield* browser.omitNetworkTrace;
        yield* browser.login(actors.owner);
        yield* browser.use("Use the product dark theme", (page) =>
          page.emulateMedia({ colorScheme: "dark" }),
        );
        const title = "Executor could not use the service’s response";
        yield* browser.use("Prepare the service connection", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`)
            .then(() =>
              page.getByRole("button", { name: "Add Sample service account", exact: true }).click(),
            )
            .then(() => page.getByLabel("Account name", { exact: true }).fill("Work reports")),
        );
        yield* emulatorRequest(issuer, "/_emulate/faults", {
          match: { method: "POST", pathPattern: "/register" },
          response: {
            status: 200,
            body: { client_secret: "synthetic-client-secret", redirect_uris: [] },
          },
          times: 5,
        });
        yield* browser.use("Start sign-in against the incompatible registration", (page) =>
          page.getByRole("button", { name: "Connect Sample service", exact: true }).click(),
        );
        yield* browser
          .use("Wait for the tracked registration failure", (page) =>
            page.getByRole("alert").getByText(title, { exact: true }).waitFor(),
          )
          .pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                const ledger = yield* emulatorRequest(issuer, "/_emulate/ledger").pipe(
                  Effect.flatMap(Schema.decodeUnknownEffect(Ledger)),
                );
                yield* (yield* Evidence).json("registration-requests.json", ledger);
              }).pipe(Effect.orDie),
            ),
          );
        const ledger = yield* emulatorRequest(issuer, "/_emulate/ledger").pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Ledger)),
        );
        expect(
          ledger.entries.some(
            (entry) =>
              entry.method === "POST" && entry.path.endsWith("/register") && entry.faulted === true,
          ),
          "Executor received the malformed registration response",
        ).toBe(true);
        expect(
          yield* browser.use("Cloud says the failure was tracked, with nothing to send", (page) =>
            Promise.all([
              page
                .getByRole("alert")
                .getByText("We’ve tracked this automatically and will investigate.", {
                  exact: true,
                })
                .count(),
              page.getByRole("button", { name: "Report issue", exact: true }).count(),
            ]),
          ),
        ).toEqual([1, 0]);
        yield* browser.checkpoint("OAuth-incompatible-tracked-desktop");
        const reports = yield* fs.readFileString(`${target.directory}/analytics.ndjson`).pipe(
          Effect.map(failureReports),
          Effect.repeat({
            schedule: Schedule.spaced("100 millis"),
            until: (reports) => reports.length > 0,
          }),
          Effect.timeout("10 seconds"),
        );
        const [report] = reports;
        expect(report).toContain("OAuth register stage, HTTP 200");
        expect(report).not.toContain(issuer);
        expect(report).not.toContain("emulators.dev");
        expect(report).not.toContain("Work reports");
      }),
    ),
  );
});
