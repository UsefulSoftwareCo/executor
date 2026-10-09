/** The local Tools tab runs a tool through the paired browser session, not the SDK bearer route. */
import { createProfile } from "../support/profiles.ts";
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { Api, body, type Session } from "../support/api.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { TestLive, withCase } from "../support/case.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";

/** The runner's Form and JSON tabs, apart from the schema viewer's own JSON tabs. */
const formatTab = (page: Page, name: "Form" | "JSON") =>
  page
    .getByRole("tablist", { name: "Input format", exact: true })
    .getByRole("tab", { name, exact: true });

const source = `import { defineApp, jsonSchema, mutation, query, object, string, router } from "apps";
const compose = jsonSchema({
  type: "object",
  $defs: {
    person: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  },
  properties: {
    title: { type: "string", description: "Shown as the heading" },
    count: { type: "integer" },
    urgent: { type: "boolean" },
    tone: { enum: ["friendly", "formal"] },
    tags: { type: "array", items: { type: "string" } },
    author: { $ref: "#/$defs/person" },
    note: { type: "string" },
  },
  required: ["title", "count", "urgent", "tone", "author"],
});
const pick = jsonSchema({
  type: "object",
  properties: {
    target: { anyOf: [{ type: "string" }, { type: "number" }] },
    limit: { type: "integer" },
  },
  required: ["target", "limit"],
});
const either = jsonSchema({
  anyOf: [
    { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  ],
});
export default defineApp({ accounts: {} }, async () => ({
  tools: router({
    echo: query({ input: object({ message: string() }) }, async (_, input) => {
      if (input.message === "fail") throw new Error("Synthetic tool failure");
      return { echoed: input.message };
    }),
    compose: query({ input: compose }, async (_, input) => ({ received: input })),
    pick: query({ input: pick }, async (_, input) => ({ received: input })),
    either: query({ input: either }, async (_, input) => ({ received: input })),
    guarded: mutation({ input: object({}), approval: () => "user-approval" }, async () => "ran"),
    blocked: mutation({ input: object({}), approval: () => "denied" }, async () => "ran"),
  }),
}));`;
const Draft = Schema.fromJsonString(Schema.Json);

layer(TestLive, { excludeTestServices: true })("Local tool runner", (it) => {
  it.effect(scenarios.localToolRunner.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api,
          target = yield* Target,
          browser = yield* Browser,
          session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const agent: Session = {
          ...session,
          send: (method, path, data, extra = {}) => {
            const { origin: _origin, ...rest } = extra;
            return session.send(method, path, data, { ...rest, ...headers });
          },
        };
        const response = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name: `Tool runner ${randomUUID().slice(0, 8)}`,
            files: [{ path: "index.ts", content: source }, appsManifest],
          },
          headers,
        );
        expect(response.status).toBe(200);
        const { app } = yield* body(
          Schema.Struct({ app: Schema.Struct({ id: Schema.String }) }),
          response,
        );
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(Effect.orDie),
        );
        const profile = yield* createProfile(
          agent,
          `/v1/apps/${app.id}`,
          { owner: "local", subject: "local" },
          headers,
        );
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("Local pairing completes before app navigation", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Open the tool in the Tools tab", (page) =>
          page.goto(`/apps/${app.id}?view=tools&profile=${profile.id}&tool=echo`),
        );
        yield* browser.use("The runner is ready", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("An object input opens as a form with its required field", (page) =>
            Promise.all([
              formatTab(page, "Form").getAttribute("aria-selected"),
              page.getByLabel("Message", { exact: true }).inputValue(),
              page.getByText("Running as", { exact: false }).textContent(),
            ]),
          ),
        ).toEqual(["true", "", "Running as Default"]);
        yield* browser.use("Run the tool", (page) =>
          page
            .getByLabel("Message", { exact: true })
            .fill("hello from local")
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        expect(
          yield* browser.use("The result is shown", (page) =>
            page
              .getByRole("region", { name: "Tool result", exact: true })
              .waitFor()
              .then(() =>
                page.getByRole("region", { name: "Tool result", exact: true }).textContent(),
              ),
          ),
        ).toContain("hello from local");
        yield* browser.checkpoint("Local tool result");
        yield* browser.use("Run a failing call", (page) =>
          page
            .getByLabel("Message", { exact: true })
            .fill("fail")
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        yield* browser.use("The failure is explained", (page) =>
          page.getByText("The tool failed", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The failed call keeps its input and drops the old result", (page) =>
            Promise.all([
              page.getByLabel("Message", { exact: true }).inputValue(),
              page.getByRole("region", { name: "Tool result", exact: true }).count(),
            ]),
          ),
        ).toEqual(["fail", 0]);
        yield* browser.checkpoint("Local tool failure");

        const calls: string[] = [];
        yield* browser.use("Watch tool calls", (page) =>
          Promise.resolve(
            page.on("request", (request) => {
              if (new URL(request.url()).pathname.endsWith(`/apps/${app.id}/tools/call`))
                calls.push(request.url());
            }),
          ),
        );
        yield* browser.use("Open a tool with mixed inputs", (page) =>
          page
            .getByRole("button", { name: "compose", exact: true })
            .click()
            .then(() => page.getByLabel("Title", { exact: true }).waitFor()),
        );
        expect(
          yield* browser.use("Required inputs start from the schema", (page) =>
            Promise.all([
              page.getByLabel("Title", { exact: true }).inputValue(),
              page.getByLabel("Count", { exact: true }).inputValue(),
              page.getByRole("checkbox", { name: "Urgent", exact: true }).isChecked(),
              page.getByRole("combobox", { name: "Tone", exact: true }).textContent(),
              page.getByLabel("Name", { exact: true }).inputValue(),
              page.getByLabel("Note", { exact: true }).count(),
            ]),
          ),
        ).toEqual(["", "0", false, "friendly", "", 0]);
        yield* browser.use("Run with required fields empty", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).click(),
        );
        yield* browser.use("Empty required fields are marked", (page) =>
          page.getByText("Fill in the required fields.", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Each empty required field explains itself", (page) =>
            Promise.all([
              page.getByText("Enter a value for Title.", { exact: true }).count(),
              page.getByText("Enter a value for Name.", { exact: true }).count(),
              page.getByLabel("Title", { exact: true }).getAttribute("aria-invalid"),
              page.getByRole("region", { name: "Tool result", exact: true }).count(),
            ]),
          ),
        ).toEqual([1, 1, "true", 0]);
        expect(calls).toEqual([]);
        yield* browser.checkpoint("Required fields block the run");
        yield* browser.use("Fill the form", (page) =>
          page
            .getByLabel("Title", { exact: true })
            .fill("Weekly update")
            .then(() => page.getByLabel("Count", { exact: true }).fill("3"))
            .then(() => page.getByRole("checkbox", { name: "Urgent", exact: true }).click())
            .then(() => page.getByRole("combobox", { name: "Tone", exact: true }).click())
            .then(() => page.getByRole("option", { name: "formal", exact: true }).click())
            .then(() => page.getByRole("button", { name: "+ Tags", exact: true }).click())
            .then(() => page.getByRole("button", { name: "+ Add tags item", exact: true }).click())
            .then(() => page.getByRole("textbox", { name: "Tags 1", exact: true }).fill("alpha"))
            .then(() => page.getByLabel("Name", { exact: true }).fill("Ada")),
        );
        expect(
          yield* browser.use("Filled fields clear their errors", (page) =>
            page.getByText(/^Enter a value for /).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Mixed input form");
        yield* browser.use("Switch to JSON", (page) => formatTab(page, "JSON").click());
        const filled = {
          title: "Weekly update",
          count: 3,
          urgent: true,
          tone: "formal",
          author: { name: "Ada" },
          tags: ["alpha"],
        };
        const serialized = yield* browser.use("Read the JSON draft", (page) =>
          page.getByRole("textbox", { name: "Input", exact: true }).inputValue(),
        );
        expect(Schema.decodeUnknownSync(Draft)(serialized)).toEqual(filled);
        yield* browser.use("Show the JSON draft", (page) =>
          page.getByRole("textbox", { name: "Input", exact: true }).scrollIntoViewIfNeeded(),
        );
        yield* browser.checkpoint("Mixed input JSON");
        yield* browser.use("Edit the JSON draft", (page) =>
          page
            .getByRole("textbox", { name: "Input", exact: true })
            .fill(JSON.stringify({ ...filled, count: 5, note: "from json" }, null, 2)),
        );
        yield* browser.use("Switch back to the form", (page) =>
          formatTab(page, "Form")
            .click()
            .then(() => page.getByLabel("Note", { exact: true }).waitFor()),
        );
        expect(
          yield* browser.use("The form shows the JSON edits and keeps earlier values", (page) =>
            Promise.all([
              page.getByLabel("Title", { exact: true }).inputValue(),
              page.getByLabel("Count", { exact: true }).inputValue(),
              page.getByRole("checkbox", { name: "Urgent", exact: true }).isChecked(),
              page.getByRole("combobox", { name: "Tone", exact: true }).textContent(),
              page.getByRole("textbox", { name: "Tags 1", exact: true }).inputValue(),
              page.getByLabel("Name", { exact: true }).inputValue(),
              page.getByLabel("Note", { exact: true }).inputValue(),
            ]),
          ),
        ).toEqual(["Weekly update", "5", true, "formal", "alpha", "Ada", "from json"]);
        yield* browser.use("Run the form", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).click(),
        );
        const composed = yield* browser.use("The form's value reaches the tool", (page) =>
          page
            .getByRole("region", { name: "Tool result", exact: true })
            .waitFor()
            .then(() =>
              page
                .getByRole("region", { name: "Tool result", exact: true })
                .locator("pre")
                .evaluate((pre) => {
                  // Line numbers are decoration; read only the code.
                  const copy = pre.cloneNode(true);
                  if (!(copy instanceof HTMLElement)) return "";
                  copy.querySelectorAll("[aria-hidden]").forEach((node) => node.remove());
                  return copy.textContent ?? "";
                }),
            ),
        );
        expect(Schema.decodeUnknownSync(Draft)(composed)).toEqual({
          received: { ...filled, count: 5, note: "from json" },
        });
        expect(calls).toHaveLength(1);
        const inView = (label: string, name: string) =>
          browser.use(label, (page) =>
            page.getByRole("region", { name, exact: true }).scrollIntoViewIfNeeded(),
          );
        yield* inView("Show the result", "Tool result");
        yield* browser.checkpoint("Mixed input result");
        yield* browser.use("Use a phone-sized window", (page) =>
          page.setViewportSize({ width: 390, height: 844 }),
        );
        yield* inView("Show the result on a phone", "Tool result");
        yield* browser.checkpoint("Mixed input result on a phone");
        yield* browser.use("Show the form on a phone", (page) =>
          page.getByLabel("Title", { exact: true }).scrollIntoViewIfNeeded(),
        );
        yield* browser.checkpoint("Mixed input form on a phone");
        yield* browser.use("Break the JSON draft", (page) =>
          formatTab(page, "JSON")
            .click()
            .then(() => page.getByRole("textbox", { name: "Input", exact: true }).fill("{")),
        );
        yield* browser.use("Try to return to the form", (page) => formatTab(page, "Form").click());
        expect(
          yield* browser.use("Invalid JSON keeps the JSON tab", (page) =>
            page
              .getByText("Enter valid JSON.", { exact: true })
              .waitFor()
              .then(() =>
                Promise.all([
                  formatTab(page, "JSON").getAttribute("aria-selected"),
                  page.getByRole("textbox", { name: "Input", exact: true }).inputValue(),
                ]),
              ),
          ),
        ).toEqual(["true", "{"]);
        yield* browser.checkpoint("Invalid JSON on a phone");
        yield* browser.use("Clear a required value in JSON", (page) =>
          page
            .getByRole("textbox", { name: "Input", exact: true })
            .fill(JSON.stringify({ ...filled, title: "" }, null, 2))
            .then(() => formatTab(page, "Form").click())
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        expect(
          yield* browser.use("A value cleared in JSON blocks the run", (page) =>
            page
              .getByText("Enter a value for Title.", { exact: true })
              .waitFor()
              .then(() =>
                Promise.all([
                  page.getByLabel("Title", { exact: true }).scrollIntoViewIfNeeded(),
                  page.getByLabel("Title", { exact: true }).getAttribute("aria-invalid"),
                ]),
              )
              .then(([, invalid]) => invalid),
          ),
        ).toBe("true");
        expect(calls).toHaveLength(1);
        yield* browser.checkpoint("Required fields on a phone");
        yield* browser.use("Show the JSON draft on a phone", (page) =>
          formatTab(page, "JSON")
            .click()
            .then(() =>
              page.getByRole("textbox", { name: "Input", exact: true }).scrollIntoViewIfNeeded(),
            ),
        );
        yield* browser.checkpoint("Mixed input JSON on a phone");
        yield* browser.use("Return to a wide window", (page) =>
          page.setViewportSize({ width: 1440, height: 960 }),
        );
        yield* browser.use("Open a tool with a union field", (page) =>
          page
            .getByRole("button", { name: "pick", exact: true })
            .click()
            .then(() => page.getByLabel("Target", { exact: true }).waitFor()),
        );
        yield* browser.use("Break the union field's JSON and run", (page) =>
          page
            .getByLabel("Target", { exact: true })
            .fill("{")
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        expect(
          yield* browser.use("A field that does not parse blocks the run", (page) =>
            page
              .getByText("Fix the field marked invalid.", { exact: true })
              .waitFor()
              .then(() =>
                Promise.all([
                  page.getByText("Enter valid JSON.", { exact: true }).count(),
                  page.getByLabel("Target", { exact: true }).getAttribute("aria-invalid"),
                ]),
              ),
          ),
        ).toEqual([1, "true"]);
        yield* browser.checkpoint("Invalid field blocks the run");
        yield* browser.use("Try to switch to JSON", (page) => formatTab(page, "JSON").click());
        expect(
          yield* browser.use("The form keeps the text that does not parse", (page) =>
            Promise.all([
              formatTab(page, "Form").getAttribute("aria-selected"),
              page.getByLabel("Target", { exact: true }).inputValue(),
            ]),
          ),
        ).toEqual(["true", "{"]);
        expect(calls).toHaveLength(1);
        yield* browser.use("Fix the union field and clear the required number", (page) =>
          page
            .getByLabel("Target", { exact: true })
            .fill(JSON.stringify("inbox"))
            .then(() => page.getByLabel("Limit", { exact: true }).fill(""))
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        expect(
          yield* browser.use("A cleared required number is missing, not its old value", (page) =>
            page
              .getByText("Enter a value for Limit.", { exact: true })
              .waitFor()
              .then(() =>
                Promise.all([
                  page.getByText("Fix the field marked invalid.", { exact: true }).count(),
                  page.getByLabel("Limit", { exact: true }).inputValue(),
                ]),
              ),
          ),
        ).toEqual([0, ""]);
        expect(calls).toHaveLength(1);
        yield* browser.use("Enter the number and run", (page) =>
          page
            .getByLabel("Limit", { exact: true })
            .fill("2")
            .then(() => page.getByRole("button", { name: "Run tool", exact: true }).click()),
        );
        const picked = yield* browser.use("The fixed values reach the tool", (page) =>
          page
            .getByRole("region", { name: "Tool result", exact: true })
            .waitFor()
            .then(() =>
              page.getByRole("region", { name: "Tool result", exact: true }).textContent(),
            ),
        );
        expect(picked).toContain('"target": "inbox"');
        expect(picked).toContain('"limit": 2');
        expect(calls).toHaveLength(2);
        yield* browser.use("Open a tool whose input is a union", (page) =>
          page
            .getByRole("button", { name: "either", exact: true })
            .click()
            .then(() => page.getByRole("textbox", { name: "Input", exact: true }).waitFor()),
        );
        expect(
          yield* browser.use("A union input opens as JSON without a form tab", (page) =>
            page.getByRole("tablist", { name: "Input format", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Union input uses JSON");
        yield* browser.use("Open a tool that needs approval", (page) =>
          page.getByRole("button", { name: "guarded", exact: true }).click(),
        );
        yield* browser.use("Run the tool that needs approval", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).click(),
        );
        yield* browser.use("The dashboard does not bypass approval", (page) =>
          page.getByText("Approval required", { exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The approval-gated tool shows no result", (page) =>
            page.getByRole("region", { name: "Tool result", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.use("Open a tool whose approval policy denies it", (page) =>
          page.getByRole("button", { name: "blocked", exact: true }).click(),
        );
        yield* browser.use("Run the denied tool", (page) =>
          page.getByRole("button", { name: "Run tool", exact: true }).click(),
        );
        const denied = yield* browser.use("The block is explained", (page) =>
          page
            .getByRole("alert")
            .filter({ hasText: "Blocked by the app’s approval policy" })
            .waitFor()
            .then(() =>
              Promise.all([
                page
                  .getByRole("alert")
                  .filter({ hasText: "Blocked by the app’s approval policy" })
                  .locator("p")
                  .allTextContents(),
                page.getByRole("region", { name: "Tool result", exact: true }).count(),
              ]),
            ),
        );
        // The dashboard names the tool and says how the call could be allowed, not only its tag.
        expect(denied).toEqual([
          [
            "The approval policy in the app’s code denied this call to “blocked”.",
            "Check what the app’s approval policy requires for this tool. If the call should be allowed, meet those requirements or, with the user’s agreement, change the policy and deploy it. Otherwise use a different tool.",
          ],
          0,
        ]);
        yield* browser.checkpoint("Denied tool call");
      }),
    ),
  );
});
