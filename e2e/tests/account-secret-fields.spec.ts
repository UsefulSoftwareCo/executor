/**
 * A secret entered in the credential form reaches the app exactly as the user entered it. A
 * single-line input turns pasted line breaks into spaces, so a paste or drop that spans lines
 * replaces the field's value exactly and the field shows a summary without the secret's text.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Locator } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { appLinksFixture, keyProvider } from "../support/app-links.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { settleWebhookSubscriptions } from "../support/webhook-sources.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const Check = Schema.Struct({
  status: Schema.String,
  info: Schema.NullOr(Schema.Struct({ displayName: Schema.optionalKey(Schema.String) })),
  message: Schema.optionalKey(Schema.String),
});
const Checked = Schema.Struct({ fields: Schema.Struct({ privateKey: Schema.String }) });
const Saved = Schema.Struct({ id: Schema.String });
const Health = Schema.Struct({
  apps: Schema.Array(
    Schema.Struct({
      app: Schema.String,
      check: Schema.NullOr(Schema.Struct({ status: Schema.String })),
    }),
  ),
  info: Schema.NullOr(Schema.Struct({ displayName: Schema.optionalKey(Schema.String) })),
});
const Control = Schema.Struct({
  tag: Schema.String,
  type: Schema.NullOr(Schema.String),
  text: Schema.String,
  focused: Schema.Boolean,
});
const Delivered = Schema.Struct({ secret: Schema.String });

/**
 * A synthetic PEM-shaped key with every character a form or URL decoder would change: line
 * breaks, `+`, `%` escapes, `&`, `=`, a space and non-ASCII text. It is not a real key.
 */
const pasted =
  "-----BEGIN PRIVATE KEY-----\nsynthetic+key/AB+cd==\r\nnot+a%2Breal&key=x%25 é€😀+\n-----END PRIVATE KEY-----\n";

/**
 * The control of the field labelled `name`: its input, or its summary. A label's text includes the
 * summary's text, so the label can't be matched exactly.
 */
const labelled = (scope: Locator, name: string) => scope.getByLabel(name);

/**
 * Deploy an app whose key check passes only for `expected` and names each code point it received
 * otherwise, then open its connection dialog in the browser.
 */
const openConnect = (expected: string) =>
  Effect.gen(function* () {
    const actors = yield* Actors;
    const api = yield* Api;
    const browser = yield* Browser;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
      name: `Secret fields ${randomUUID().slice(0, 8)}`,
      files: [
        {
          path: "index.ts",
          content: `
import { defineApp, defineProvider, object, plain, raw, router, secrets, string } from "apps";
const expected = ${JSON.stringify(expected)};
const codes = (text: string) => [...text].map((c) => c.codePointAt(0)).join(" ");
const service = defineProvider({
  name: "Signing fixture",
  hosts: ["signing.invalid"],
  auth: {
    key: secrets({
      label: "API key",
      fields: object({ keyId: plain(string()), privateKey: raw(string()) }),
    }),
  },
  async health({ account }) {
    const received = account.fields.privateKey;
    if (received !== expected) throw new Error("received code points " + codes(received));
    return { accountInfo: { externalId: account.fields.keyId, displayName: "exact" } };
  },
});
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
`,
        },
        appsManifest,
      ],
    });
    expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
    const app = yield* body(App, deployed);
    const account: { id?: string } = {};
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        if (account.id !== undefined)
          yield* api.request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`);
        yield* api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`);
      }).pipe(Effect.orDie),
    );

    yield* browser.login(actors.owner);
    yield* browser.use("Open the app's accounts", (page) =>
      page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
    );
    yield* browser.use("Connect a new account", (page) =>
      page.getByRole("button", { name: "Connect new account", exact: true }).click(),
    );
    const connect = yield* browser.use("The connection dialog opens", (page) => {
      const dialog = page.getByRole("dialog", { name: "Connect Signing fixture", exact: true });
      return dialog.waitFor({ state: "visible" }).then(() => dialog);
    });
    yield* browser.use("Enter the key id and allow the clipboard", (page) =>
      connect
        .getByLabel("Key Id", { exact: true })
        .fill("synthetic-key-id")
        .then(() => page.context().grantPermissions(["clipboard-read", "clipboard-write"])),
    );
    return { connect, prefix, app, account };
  });

/** Copy `text` to the clipboard and paste it into `field` with a real Ctrl+V. */
const paste = (field: Locator, text: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use(`Paste ${JSON.stringify(text)}`, (page) =>
      page
        .evaluate((value) => navigator.clipboard.writeText(value), text)
        .then(() => field.focus())
        .then(() => page.keyboard.press("ControlOrMeta+V")),
    );
  });

/** Focus `field` and press `keys`. */
const press = (field: Locator, keys: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use(`Press ${keys}`, (page) =>
      field.focus().then(() => page.keyboard.press(keys)),
    );
  });

/** The element that shows `field`, its text and whether it has focus. */
const control = (field: Locator) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const read = yield* browser.use("Read the field's control", () =>
      field.evaluate((element) => ({
        tag: element.tagName.toLowerCase(),
        type: element.getAttribute("type"),
        text: element.textContent ?? "",
        focused: document.activeElement === element,
      })),
    );
    return yield* Schema.decodeUnknownEffect(Control)(read);
  });

/** A focused password input. */
const password = { tag: "input", type: "password", text: "", focused: true };
/** The focused summary of a value with `lines` lines. */
const summary = (lines: number) => ({
  tag: "output",
  type: null,
  text: `Multi-line value · ${lines} lines`,
  focused: true,
});

/** Chromium's accessibility tree for the page, which assistive software reads, as JSON. */
const accessibilityTree = Effect.gen(function* () {
  const browser = yield* Browser;
  return yield* browser.use("Read the accessibility tree", (page) =>
    page
      .context()
      .newCDPSession(page)
      .then((session) =>
        session
          .send("Accessibility.getFullAXTree")
          .then((tree) => session.detach().then(() => JSON.stringify(tree.nodes))),
      ),
  );
});

/** Drag `text` out of a scratch textarea in `scope` and drop it on `field` with the mouse. */
const drop = (scope: Locator, field: Locator, text: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use(`Drop ${JSON.stringify(text)}`, (page) => {
      const source = page.locator("#drag-source");
      return scope
        .evaluate((element, value) => {
          const area = document.createElement("textarea");
          area.id = "drag-source";
          area.value = value;
          area.style.cssText = "font: 16px monospace; padding: 0; width: 12rem; height: 4rem";
          element.append(area);
        }, text)
        .then(() => source.selectText())
        .then(() => source.dragTo(field, { sourcePosition: { x: 4, y: 8 } }))
        .then(() => source.evaluate((element) => element.remove()));
    });
  });

layer(HostedLive, { excludeTestServices: true })("Account secret fields", (it) => {
  it.effect(scenarios.accountSecretFieldsExact.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const actors = yield* Actors;
        const browser = yield* Browser;
        const { connect, prefix, app, account } = yield* openConnect(pasted);
        const field = labelled(connect, "Private Key");
        yield* paste(field, pasted);
        const checked = yield* browser
          .use("Validate the pasted key", (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  response.request().method() === "POST" &&
                  new URL(response.url()).pathname.endsWith("/credential-checks"),
              ),
              connect.getByRole("button", { name: "Validate API key", exact: true }).click(),
            ]).then(([response]) => response.json() as Promise<unknown>),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Check)));
        // The unsaved key reaches the app's check exactly as pasted: CRLF, LF and the final break.
        expect(checked).toEqual({ status: "healthy", info: { displayName: "exact" } });
        // The field shows how many lines it holds, and assistive software can't read the key.
        expect(yield* control(field)).toMatchObject({ tag: "output", text: summary(4).text });
        const tree = yield* accessibilityTree;
        expect(tree).toContain("Multi-line value · 4 lines");
        expect(tree).not.toContain("synthetic+key");
        expect(tree).not.toContain("not+a%2Breal");

        const saved = yield* browser
          .use("Save the checked key", (page) =>
            Promise.all([
              page.waitForResponse(
                (response) =>
                  response.request().method() === "POST" &&
                  new URL(response.url()).pathname.endsWith("/submit"),
              ),
              connect.getByRole("button", { name: "Continue", exact: true }).click(),
            ]).then(([response]) => response.json() as Promise<unknown>),
          )
          .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Saved)));
        account.id = saved.id;

        // The stored key reaches the app's check unchanged too.
        const response = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/accounts/${saved.id}/health`,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const health = yield* body(Health, response);
        expect(health.apps.find((entry) => entry.app === app.id)?.check?.status).toBe("healthy");
        expect(health.info?.displayName).toBe("exact");
      }),
    ),
  );

  it.effect(scenarios.accountSecretFieldsSummary.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        const { connect } = yield* openConnect(pasted);
        const field = labelled(connect, "Private Key");
        const keyId = connect.getByLabel("Key Id", { exact: true });
        const clear = connect.getByRole("button", { name: "Clear", exact: true });
        /** The key the form sends to the app's check, once the form shows the check's result. */
        const sent = browser
          .use("Validate the key", (page) =>
            Promise.all([
              page.waitForRequest(
                (request) =>
                  request.method() === "POST" &&
                  new URL(request.url()).pathname.endsWith("/credential-checks"),
              ),
              connect.getByRole("button", { name: "Validate API key", exact: true }).click(),
            ]).then(([request]) =>
              connect
                .getByRole("button", { name: /^Continue/ })
                .waitFor()
                .then((): unknown => request.postDataJSON()),
            ),
          )
          .pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Checked)),
            Effect.map((checked) => checked.fields.privateKey),
          );
        const value = browser.use("Read the field", () => field.inputValue());

        // A single-line paste goes into the password input, as on main, which shows only bullets.
        yield* paste(field, "AB+%2B&=é");
        expect(yield* control(field)).toEqual(password);
        expect(yield* accessibilityTree).not.toContain("AB+%2B");
        expect(yield* sent).toBe("AB+%2B&=é");

        // Type into another field, which puts its edit last on the page's undo stack.
        yield* press(keyId, "End");
        yield* browser.use("Type into the key id", (page) => page.keyboard.type("-2"));
        // A paste that spans lines replaces the whole value, even with the caret inside it.
        yield* press(field, "End");
        yield* press(field, "ArrowLeft");
        yield* paste(field, "synthetic+SECRET\r\nsecond-line");
        expect(yield* control(field)).toEqual(summary(2));
        const tree = yield* accessibilityTree;
        expect(tree).toContain("Multi-line value · 2 lines");
        expect(tree).not.toContain("synthetic+SECRET");
        expect(tree).not.toContain("second-line");

        // Undo, a click on the label and dragging the summary change nothing.
        yield* press(field, "ControlOrMeta+Z");
        yield* browser.use("Click the field's label", () =>
          connect.getByText("Private Key", { exact: true }).click(),
        );
        yield* browser.use("Drag the summary onto the key id and within itself", () =>
          field
            .click({ clickCount: 3 })
            .then(() => field.dragTo(keyId))
            .then(() => field.dragTo(field, { targetPosition: { x: 60, y: 8 } })),
        );
        expect(yield* control(field)).toMatchObject({ tag: "output", text: summary(2).text });
        expect(yield* browser.use("Read the key id", () => keyId.inputValue())).toBe(
          "synthetic-key-id-2",
        );
        expect(yield* sent).toBe("synthetic+SECRET\r\nsecond-line");

        // Clear goes back to the empty password input and moves focus there.
        yield* browser.use("Clear the value", () => clear.click());
        expect(yield* control(field)).toEqual(password);
        expect(yield* value).toBe("");

        // Another paste that spans lines replaces the value exactly, with the breaks at its ends,
        // into an empty input and over a single-line value alike.
        yield* paste(field, "\nEF\nGH\n");
        expect(yield* control(field)).toEqual(summary(3));
        expect(yield* sent).toBe("\nEF\nGH\n");
        yield* browser.use("Clear the value", () => clear.click());
        yield* browser.use("Type a key", (page) => page.keyboard.type("old"));
        yield* press(field, "ControlOrMeta+A");
        yield* paste(field, "\nEF\nGH\n");
        expect(yield* control(field)).toEqual(summary(3));
        expect(yield* sent).toBe("\nEF\nGH\n");

        // After Clear, a single-line paste is the input's own, as on main: Chromium drops the line
        // break at its end, into an empty input and over a value alike.
        yield* browser.use("Clear the value", () => clear.click());
        yield* paste(field, "AB\r\n");
        expect(yield* control(field)).toEqual(password);
        expect(yield* sent).toBe("AB");
        yield* press(field, "ControlOrMeta+A");
        yield* browser.use("Type a key", (page) => page.keyboard.type("old"));
        yield* press(field, "ControlOrMeta+A");
        yield* paste(field, "AB\r\n");
        expect(yield* sent).toBe("AB");

        // Dropping text that spans lines works as pasting it.
        yield* press(field, "ControlOrMeta+A");
        yield* press(field, "Delete");
        yield* drop(connect, field, "IJ\nKL");
        expect(yield* control(field)).toEqual(summary(2));
        expect(yield* sent).toBe("IJ\nKL");

        // A plain field shows its value, so a paste that spans lines stays in its text input, as on
        // main, where Chromium turns the line break into a space.
        const plain = labelled(connect, "Key Id");
        yield* press(plain, "ControlOrMeta+A");
        yield* paste(plain, "plain-ID\nplain-tail");
        expect(yield* control(plain)).toEqual({ ...password, type: "text" });
        expect(yield* browser.use("Read the key id", () => plain.inputValue())).toBe(
          "plain-ID plain-tail",
        );
      }),
    ),
  );

  it.effect(scenarios.webhookProviderSigningSecretExact.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const browser = yield* Browser;
        // The handler answers with the signing secret it was given.
        const fixture = yield* appLinksFixture([
          {
            path: "index.ts",
            content: `import { defineApp, defineProvider, secrets, query, object, string, router } from "apps";
const team = ${keyProvider("Signing secret fixture")};
const incoming = { account: { app: "team" }, config: object({}), state: object({}),
  setup: { instructions: "Paste the provider's signing secret.", signingSecret: "provider" },
  handle: async (ctx, { secret }) => Response.json({ secret }) };
export default defineApp({ app: { accounts: { team: team.many() } } },
  async () => ({ tools: router({ ping: query({ input: object({}) }, async () => "pong") }), webhooks: { incoming } }));`,
          },
        ]);
        const { api, actors, prefix, app, path, connect } = fixture;
        const team = yield* connect(actors.owner, "app", "team", "owner-team");
        const settled = (status: string) =>
          settleWebhookSubscriptions(actors.owner, path, (hooks) =>
            hooks.some((hook) => hook.sourceAccount === team && hook.status === status),
          ).pipe(
            Effect.map((hooks) => hooks.find((hook) => hook.sourceAccount === team)),
            Effect.flatMap((hook) =>
              hook === undefined ? Effect.die(new Error("Webhook missing")) : Effect.succeed(hook),
            ),
          );
        const hook = yield* settled("setup-required");
        const setupPath = `${prefix}/webhook-setup/${app.id}/${hook.id}`;
        /** A synthetic signing secret that spans lines. It is not a real secret. */
        const secret = "synthetic+signing/secret==\nsecond line%2B é\n";

        yield* browser.login(actors.owner);
        yield* browser.use("Open the webhook's setup", (page) =>
          page
            .goto(`/org/${actors.organization.slug}/webhooks/${app.id}/${hook.id}`)
            .then(() => page.getByRole("heading", { name: "Set up webhook" }).waitFor())
            .then(() => page.context().grantPermissions(["clipboard-read", "clipboard-write"])),
        );
        const field = yield* browser.use("Find the signing secret field", (page) =>
          Promise.resolve(labelled(page.locator("form"), "Provider signing secret")),
        );
        yield* paste(field, secret);
        const shown = yield* control(field);
        const finished = yield* browser.use("Finish the setup", (page) =>
          page
            .getByRole("checkbox", { name: "I added this webhook in the provider." })
            .check()
            .then(() =>
              Promise.all([
                page.waitForResponse(
                  (response) =>
                    response.request().method() === "POST" &&
                    new URL(response.url()).pathname === setupPath,
                ),
                page.getByRole("button", { name: "Finish setup", exact: true }).click(),
              ]),
            )
            .then(([response]) => response.status()),
        );
        expect(finished).toBe(200);
        const active = yield* settled("active");

        // A delivery's handler gets the signing secret exactly as pasted.
        const delivered = yield* api.request(
          yield* api.session(),
          "POST",
          new URL(active.callbackUrl).pathname,
          {},
        );
        expect(delivered.status, JSON.stringify(delivered.body)).toBe(200);
        expect(yield* body(Delivered, delivered)).toEqual({ secret });
        // The field showed a summary of the secret.
        expect(shown).toEqual(summary(2));
      }),
    ),
  );
});
