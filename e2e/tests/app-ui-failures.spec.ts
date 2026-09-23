/** Authored failures use the real app origin, host bootstrap, and telemetry receiver. */
import { expect, layer } from "@effect/vitest";
import { Effect, Schedule, Schema } from "effect";
import { randomUUID } from "node:crypto";
import { scenarios } from "../test-plan.ts";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { openPrivateApp, waitForAppUrl } from "../support/app-pages.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Evidence, Telemetry } from "../support/evidence.ts";

const DeployedApp = Schema.Struct({ ...App.fields, activeDeployment: Schema.String });

const files = [
  {
    path: "index.ts",
    content: 'import { defineApp } from "apps"; export default defineApp({ accounts: {} }, {});',
  },
  {
    path: "package.json",
    content: JSON.stringify({ dependencies: { react: "^19.2.0", "react-dom": "^19.2.0" } }),
  },
  {
    path: "ui/index.html",
    content:
      '<!doctype html><html><head><title>Failure fixture</title></head><body><div id="root"></div><script type="module" src="./main.tsx"></script></body></html>',
  },
  {
    path: "ui/main.tsx",
    content: `import React from "react";
import { createRoot } from "react-dom/client";
const mode = location.hash.slice(1);
if (mode === "boot") throw new Error("Fixture boot failure");
function App() {
  if (mode === "render") throw new Error("Fixture render failure <unsafe>");
  return <main><h1>Working app</h1><label>Draft<input /></label><button onClick={() => { throw new Error("Fixture click failure"); }}>Fail action</button><button onClick={() => { void Promise.reject(new Error("Fixture rejected action")); }}>Reject action</button></main>;
}
createRoot(document.getElementById("root")).render(<App />);`,
  },
];

layer(HostedLive, { excludeTestServices: true })("App failure recovery", (it) => {
  it.effect(scenarios.appUiFailures.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser;
        const evidence = yield* Evidence;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Failure UI ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(response.status).toBe(200);
        const app = yield* body(DeployedApp, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
        const tracePayload = { resourceSpans: [{ scopeSpans: [{ spans: [] }] }] };
        for (const signal of ["traces", "logs"] as const) {
          expect(
            (yield* browser.use(`Unsigned ${signal} upload is rejected`, (page) =>
              page.context().request.post(`${url}/_executor/api/telemetry/${signal}`, {
                headers: { origin: new URL(url).origin },
                data:
                  signal === "traces"
                    ? tracePayload
                    : { resourceLogs: [{ scopeLogs: [{ logRecords: [] }] }] },
              }),
            )).status(),
          ).toBe(401);
        }
        yield* browser.login(actors.owner);
        yield* openPrivateApp(`${url}/#render`);
        yield* browser.use("The page shows a failure instead of remaining blank", (page) =>
          page.getByRole("dialog", { name: "This app stopped working" }).waitFor(),
        );
        yield* browser.use("Reveal the actual render error", (page) =>
          page.getByText("Error details", { exact: true }).click(),
        );
        const details = yield* browser.use("Read local diagnostics", (page) =>
          page.getByRole("textbox", { name: "Error details" }).inputValue(),
        );
        expect(details).toContain("Fixture render failure <unsafe>");
        expect(details).toMatch(/Diagnostic ID: [a-f0-9]{32}/);
        yield* browser.use("The crash report reaches the authenticated receiver", (page) =>
          page.getByRole("status").filter({ hasText: "Error report sent." }).waitFor(),
        );
        yield* evidence.json("app-crash-diagnostic.json", {
          traceId: details.match(/Diagnostic ID: ([a-f0-9]{32})/)?.[1],
          deployment: app.activeDeployment,
        });
        yield* browser.checkpoint("React render failure with local error details");
        for (const signal of ["traces", "logs"] as const) {
          expect(
            (yield* browser.use(`Authorized ${signal} upload is accepted`, (page) =>
              page.context().request.post(`${url}/_executor/api/telemetry/${signal}`, {
                headers: { origin: new URL(url).origin },
                data:
                  signal === "traces"
                    ? tracePayload
                    : { resourceLogs: [{ scopeLogs: [{ logRecords: [] }] }] },
              }),
            )).status(),
          ).toBe(202);
          expect(
            (yield* browser.use(`Cross-origin ${signal} upload stays forbidden`, (page) =>
              page.context().request.post(`${url}/_executor/api/telemetry/${signal}`, {
                headers: { origin: "https://unrelated.example.test" },
                data: {},
              }),
            )).status(),
          ).toBe(403);
        }
        yield* browser.use("A boot failure before the app client starts is visible", (page) =>
          page.goto(`${url}/#boot`),
        );
        yield* browser.use("Boot failure dialog is visible", (page) =>
          page.getByRole("dialog", { name: "This app stopped working" }).waitFor(),
        );
        yield* browser.use("Return to the working app", (page) => page.goto(`${url}/`));
        yield* browser.use("Enter an unsaved draft", (page) =>
          page.getByLabel("Draft").fill("Keep this draft"),
        );
        yield* browser.use("Trigger an unhandled rejected operation", (page) =>
          page.getByRole("button", { name: "Reject action" }).click(),
        );
        yield* browser.use("Rejected operations are visible", (page) =>
          page.getByRole("dialog", { name: "This app stopped working" }).waitFor(),
        );
        yield* browser.use("Dismiss to recover unsaved work", (page) =>
          page.getByRole("button", { name: "Close", exact: true }).click(),
        );
        expect(
          yield* browser.use("The draft survives the failure overlay", (page) =>
            page.getByLabel("Draft").inputValue(),
          ),
        ).toBe("Keep this draft");
        yield* browser.checkpoint("The failure overlay preserves unsaved work");
        yield* browser.use("Hold the next browser module request", (page) =>
          page.route(/\/_executor\/assets\/.*\.js$/, (route) => route.abort("failed"), {
            times: 1,
          }),
        );
        yield* browser.use("Reload to test a missing browser module", (page) => page.reload());
        yield* browser.use("A failed module has a usable host screen", (page) =>
          page.getByRole("dialog", { name: "This app could not load" }).waitFor(),
        );
        yield* browser.use("Reload recovers when the file is available again", (page) =>
          page.getByRole("button", { name: "Reload page" }).click(),
        );
        yield* browser.use("Working content returns", (page) =>
          page.getByRole("heading", { name: "Working app" }).waitFor(),
        );
        expect(
          yield* browser.use("No stale failure remains", (page) =>
            page.getByRole("dialog").count(),
          ),
        ).toBe(0);
        yield* browser.use("An extension error is not an app failure", (page) =>
          page.evaluate(() =>
            window.dispatchEvent(
              new ErrorEvent("error", {
                filename: "chrome-extension://fixture/content.js",
                message: "Fixture extension failure",
              }),
            ),
          ),
        );
        expect(
          yield* browser.use("Extension errors leave the app usable", (page) =>
            page.getByRole("dialog").count(),
          ),
        ).toBe(0);
        yield* browser.use("Interrupt the diagnostic upload", (page) =>
          page.route("**/_executor/api/telemetry/traces", (route) => route.abort("failed"), {
            times: 1,
          }),
        );
        yield* browser.use("An event handler fails while telemetry is unavailable", (page) =>
          page.getByRole("button", { name: "Fail action" }).click(),
        );
        yield* browser.use("Failed reporting keeps local diagnostics available", (page) =>
          page
            .getByRole("status")
            .filter({ hasText: "Could not send the error report." })
            .waitFor(),
        );
        yield* browser.use("Open the error after upload failure", (page) =>
          page.getByText("Error details", { exact: true }).click(),
        );
        expect(
          yield* browser.use("The actual action error remains readable", (page) =>
            page.getByRole("textbox", { name: "Error details" }).inputValue(),
          ),
        ).toContain("Fixture click failure");
      }),
    ),
  );

  it.effect(scenarios.appUiFailureTelemetry.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          actors = yield* Actors,
          browser = yield* Browser,
          telemetry = yield* Telemetry;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name: `Crash trace ${randomUUID().slice(0, 8)}`,
          files,
        });
        expect(response.status).toBe(200);
        const app = yield* body(DeployedApp, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        const url = yield* waitForAppUrl(actors.owner, `${prefix}/apps/${app.id}/ui`);
        yield* browser.login(actors.owner);
        yield* openPrivateApp(`${url}/#boot`);
        yield* browser.use("Open crash details", (page) =>
          // The first app visit includes the cross-origin sign-in journey.
          page.getByText("Error details", { exact: true }).click({ timeout: 60_000 }),
        );
        const details = yield* browser.use("Get the diagnostic trace ID", (page) =>
          page.getByRole("textbox", { name: "Error details" }).inputValue(),
        );
        const traceId = details.match(/Diagnostic ID: ([a-f0-9]{32})/)?.[1];
        if (traceId === undefined) return yield* Effect.die("Crash diagnostic ID missing");
        const delivered = yield* telemetry.query(traceId).pipe(
          Effect.flatMap((result) =>
            result.data.some((entry) => entry.span.operationName === "ui.app.failure")
              ? Effect.succeed(result)
              : Effect.fail(new Error("App crash trace was not delivered")),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 30 }),
        );
        const span = delivered.data.find(
          (entry) => entry.span.operationName === "ui.app.failure",
        )?.span;
        expect(span?.tags["executor.ui.failure.kind"]).toBe("runtime");
        expect(span?.tags["executor.build.id"]).toBe(app.activeDeployment);
        expect(span?.tags["exception.type"]).toBe("Error");
        expect(span?.tags["code.file.path"]).toMatch(/^\/_executor\/assets\/.*\.js$/);
        expect(Number(span?.tags["code.line.number"])).toBeGreaterThan(0);
        expect(JSON.stringify(delivered)).not.toContain("Fixture boot failure");
        yield* browser.use(
          "Close the first report and immediately report another failure",
          (page) =>
            page.getByRole("button", { name: "Close", exact: true }).evaluate((button) => {
              if (!(button instanceof HTMLButtonElement)) throw new Error("Close button missing");
              button.click();
              window.dispatchEvent(
                new ErrorEvent("error", {
                  error: new TypeError("Second private failure"),
                  message: "Second private failure",
                }),
              );
            }),
        );
        yield* browser.use("Open the second report", (page) =>
          page
            .getByRole("dialog", { name: "This app stopped working" })
            .getByText("Error details", { exact: true })
            .click(),
        );
        const second = yield* browser.use("Read the second diagnostic ID", (page) =>
          page
            .getByRole("dialog", { name: "This app stopped working" })
            .getByRole("textbox", { name: "Error details" })
            .inputValue(),
        );
        yield* browser.checkpoint("The second app error remains visible after closing the first");
        const nextId = second.match(/Diagnostic ID: ([a-f0-9]{32})/)?.[1];
        expect(nextId).not.toBe(traceId);
        if (nextId === undefined) return yield* Effect.die("Second diagnostic ID missing");
        yield* browser.checkpoint("Second error report remains visible after closing the first");
        const next = yield* telemetry.query(nextId).pipe(
          Effect.flatMap((result) =>
            result.data.some(({ span }) => span.operationName === "ui.app.failure")
              ? Effect.succeed(result)
              : Effect.fail(new Error("Second app error was not delivered")),
          ),
          Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 30 }),
        );
        expect(JSON.stringify(next)).not.toContain("Second private failure");
      }),
    ),
  );
});
