/**
 * The connect form stays inside its dialog whatever an app declares: a sign-in method label as
 * long as a paragraph, an unbroken field title and a long list of hosts wrap or truncate instead of
 * widening the form, and the submit button says "Validate" rather than repeating the label. While
 * the check runs, the button keeps an accessible name and the form announces the check once. The
 * line saying where hidden values go stays short and true for any list of hosts.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Redacted, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Locator } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body } from "../support/api.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { App } from "../support/contracts.ts";
import { Target } from "../support/platform.ts";
import { scenarios } from "../test-plan.ts";
import { appsManifest } from "../support/apps-release.ts";

const products = [
  "email-reputation",
  "phone-intelligence",
  "ip-intelligence",
  "ip-geolocation",
  "company-enrichment",
  "iban-validation",
  "vat-validation",
  "exchange-rates",
  "holidays",
  "timezones",
  "scrape",
  "images",
];
/** 219 characters, as a catalog app once declared. */
const longLabel = `API key for one Abstract product (product: ${products.join(", ")})`;
const longTitle = "Product_identifier_written_as_one_unbroken_word_that_never_wraps_by_itself";

/** A provider with a paragraph for a label, an unbroken field title and twelve long hosts. */
const source = (name: string) => `
import { defineApp, defineProvider, object, plain, router, secrets, string } from "apps";
const service = defineProvider({
  name: ${JSON.stringify(name)},
  hosts: ${JSON.stringify(products.map((product) => `${product}.a-long-regional-subdomain-for-layout.example.com`))},
  auth: {
    key: secrets({
      label: ${JSON.stringify(longLabel)},
      fields: object({
        product: plain(string({ minLength: 1, title: ${JSON.stringify(longTitle)} })),
        token: string({ minLength: 1 }),
      }),
    }),
    personal: secrets({ label: "Personal access token", fields: object({ token: string() }) }),
  },
  async health() {
    throw new Error("403: the token lacks the accounts scope");
  },
});
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
`;

/** A provider with one secret field that may be sent only to `hosts`. */
const hostSource = (name: string, hosts: readonly string[]) => `
import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({
  name: ${JSON.stringify(name)},
  hosts: ${JSON.stringify(hosts)},
  auth: { key: secrets({ label: "API key", fields: object({ token: string({ minLength: 1 }) }) }) },
});
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
`;

const placeholder = "The app and your agent get a placeholder.";
/** Ten exact hosts on one registrable domain. */
const tenOnExample = products.slice(0, 10).map((product) => `${product}.example.com`);

/**
 * Host lists as deployed (Executor sorts them), and what the form's line says for each. One or two
 * hosts are named. A longer list counts the exact hosts that share a registrable domain and names
 * every other entry: hosts on other domains, each `github.io` site (a public suffix, so each is its
 * own domain), wildcards with what they match, and hosts with a port.
 */
const hostCases = [
  {
    label: "one host",
    hosts: ["api.example.com"],
    line: `Hidden values are only sent to api.example.com. ${placeholder}`,
  },
  {
    label: "two hosts",
    hosts: ["api.example.com", "uploads.example.com"],
    line: `Hidden values are only sent to api.example.com and uploads.example.com. ${placeholder}`,
  },
  {
    label: "twelve hosts on one domain",
    hosts: products.map((product) => `${product}.example.com`).sort(),
    line: `Hidden values are only sent to 12 hosts on example.com. ${placeholder} Show all`,
  },
  {
    label: "hosts on several domains",
    hosts: [
      ...tenOnExample,
      "*.example.net",
      "alpha.github.io",
      "api.example.org",
      "beta.github.io",
      "files.example.com:8443",
    ].sort(),
    line: `Hidden values are only sent to 10 hosts on example.com, *.example.net (any host directly under example.net), alpha.github.io, api.example.org, beta.github.io and files.example.com:8443. ${placeholder} Show all`,
  },
  {
    label: "a wildcard",
    hosts: ["*.example.com"],
    line: `Hidden values are only sent to *.example.com (any host directly under example.com). ${placeholder}`,
  },
] as const;

/** How the expanded list reads a declared host: wildcards say what they match. */
const listed = (host: string) =>
  host.startsWith("*.") ? `${host} (any host directly under ${host.slice(2)})` : host;

/**
 * Whether a line is true to the declared hosts: each "N hosts on D" counts exactly the declared
 * hosts without a wildcard or port whose registrable domain is D, and every declared host left out
 * of a count is named in the line.
 */
const truthful = (line: string, hosts: readonly string[]) => {
  const counts = [...line.matchAll(/(\d+) hosts on ([a-z0-9.-]+[a-z0-9])/g)].map(
    ([, count, domain]) => ({ count: Number(count), domain: domain ?? "" }),
  );
  const counted = (host: string, domain: string) =>
    !host.startsWith("*.") &&
    !host.includes(":") &&
    (host === domain || host.endsWith(`.${domain}`));
  const inCount = new Set(
    counts.flatMap(({ domain }) => hosts.filter((host) => counted(host, domain))),
  );
  return {
    counts: counts.map(
      ({ count, domain }) => count === hosts.filter((host) => counted(host, domain)).length,
    ),
    unnamed: hosts.filter((host) => !inCount.has(host) && !line.includes(host)),
  };
};

/** The local deploy route answers with the app under `app`. */
const Deployed = Schema.Struct({ app: App });

/**
 * Elements of the dialog that reach past its left or right edge, and how far its content scrolls
 * sideways. Vertical overflow is the dialog's own scrolling and is allowed.
 */
const outside = (dialog: Locator) =>
  dialog.evaluate((element) => {
    const edge = element.getBoundingClientRect();
    const sticking = [...element.querySelectorAll("*")].flatMap((child) => {
      const box = child.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) return [];
      return box.left < edge.left - 0.5 || box.right > edge.right + 0.5
        ? [`${child.tagName.toLowerCase()} "${(child.textContent ?? "").slice(0, 60)}"`]
        : [];
    });
    return { sticking, sideways: element.scrollWidth - element.clientWidth };
  });

/**
 * Each outermost live region in the dialog that holds text, with its politeness and its text, hidden
 * text included. A region inside another, such as a copy button's own feedback, is part of it.
 * `role="status"` is polite.
 */
const liveRegions = (dialog: Locator) =>
  dialog.evaluate((element) => {
    const selector = "[aria-live], [role=status], [role=alert]";
    return [...element.querySelectorAll(selector)].flatMap((region) => {
      if (region.parentElement?.closest(selector) !== null) return [];
      const walker = document.createTreeWalker(region, NodeFilter.SHOW_TEXT);
      const parts: string[] = [];
      while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? "");
      const text = parts.join(" ").replace(/\s+/g, " ").trim();
      if (text === "") return [];
      const role = region.getAttribute("role");
      const live =
        region.getAttribute("aria-live") ??
        (role === "alert" ? "assertive" : role === "status" ? "polite" : "off");
      return [{ live, text }];
    });
  });

/**
 * The open connect dialog fits at the browser's width and at a phone's, with a short submit button:
 * "Validate" for an app that checks credentials, "Connect account" for one that does not.
 */
const fitsAtBothWidths = (dialog: Locator, submit = "Validate") =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    for (const [width, height] of [
      [1280, 900],
      [390, 844],
    ] as const) {
      yield* browser.use(`Resize to ${width} pixels wide`, (page) =>
        page.setViewportSize({ width, height }),
      );
      yield* browser.checkpoint(`Connect form at ${width} pixels`);
      expect(
        yield* browser.use(`Nothing sticks out at ${width} pixels`, () => outside(dialog)),
      ).toEqual({ sticking: [], sideways: 0 });
      expect(
        yield* browser.use(`The submit button says ${submit}`, () =>
          dialog.locator("button[type=submit]").innerText(),
        ),
      ).toBe(submit);
    }
  });

layer(HostedLive, { excludeTestServices: true })("Connect form layout", (it) => {
  it.effect(scenarios.connectFormLongLabel.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const name = `Layout fixture ${randomUUID().slice(0, 8)}`;
        const deployed = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
          name,
          files: [{ path: "index.ts", content: source(name) }, appsManifest],
        });
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const app = yield* body(App, deployed);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
            Effect.map((response) => expect(response.status).toBe(200)),
            Effect.orDie,
          ),
        );

        yield* browser.login(actors.owner);
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new account", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const connect = yield* browser.use("The connection dialog opens", (page) => {
          const dialog = page.getByRole("dialog", { name: `Connect ${name}`, exact: true });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        yield* fitsAtBothWidths(connect);

        // The method menu is as wide as its field, and the long name wraps inside it.
        // An open menu hides the dialog from the accessibility tree, so measure the field first.
        const field = yield* browser.use("Measure the sign-in method field", () =>
          connect.getByRole("combobox").boundingBox(),
        );
        const [menu, listed] = yield* browser.use("Open the sign-in method menu", (page) =>
          connect
            .getByRole("combobox")
            .click()
            .then(() => page.getByRole("listbox").waitFor({ state: "visible" }))
            .then(() =>
              Promise.all([
                page.getByRole("listbox").boundingBox(),
                page.getByRole("option", { name: longLabel, exact: true }).isVisible(),
              ]),
            ),
        );
        expect(listed).toBe(true);
        expect(menu?.width).toBeLessThanOrEqual((field?.width ?? 0) + 0.5);
        yield* browser.checkpoint("The method menu wraps a long name");
        yield* browser.use("Close the menu", (page) => page.keyboard.press("Escape"));

        // While the check runs, the button keeps its name and the form's one live region says
        // "Validating…"; the result then replaces it there. The check is held until both are seen.
        let release = () => {};
        const held = new Promise<void>((resolve) => (release = resolve));
        yield* browser.use("Hold the account check", (page) =>
          page.route(
            (url) => url.pathname.endsWith("/credential-checks"),
            (route) => held.then(() => route.continue()),
          ),
        );
        yield* browser.use("Fill and validate the credentials", () =>
          connect
            .getByLabel(longTitle, { exact: true })
            .fill("email-reputation")
            .then(() => connect.getByLabel("Token", { exact: true }).fill("synthetic-layout-token"))
            .then(() => connect.getByRole("button", { name: "Validate", exact: true }).click()),
        );
        yield* browser.use("The button is named Validating… while the check runs", () =>
          connect.getByRole("button", { name: "Validating…", exact: true }).waitFor(),
        );
        // The spinner's own "Loading" name stays out of what the button announces.
        expect(
          yield* browser.use("The submit button as assistive technology reads it", () =>
            connect.locator("button[type=submit]").ariaSnapshot(),
          ),
        ).toBe('- button "Validating…" [disabled]');
        expect(
          yield* browser.use("What the form's live regions say while checking", () =>
            liveRegions(connect),
          ),
        ).toEqual([{ live: "polite", text: "Validating…" }]);
        yield* browser.checkpoint("Validating");
        const [response] = yield* browser.use("Let the check finish", (page) =>
          Promise.all([
            page.waitForResponse((response) =>
              new URL(response.url()).pathname.endsWith("/credential-checks"),
            ),
            Promise.resolve().then(release),
          ]),
        );
        expect(response.status()).toBe(200);
        expect(
          yield* browser.use("The check's result", () =>
            connect
              .locator('[data-credential-check="check_failed"]')
              .waitFor({ state: "visible" })
              .then(() =>
                connect
                  .locator('[data-credential-check="check_failed"] > div > span')
                  .first()
                  .innerText(),
              ),
          ),
        ).toBe("Couldn't verify these credentials: 403: the token lacks the accounts scope");
        const after = yield* browser.use("What the form's live regions say after the check", () =>
          liveRegions(connect),
        );
        expect(after.map(({ live }) => live)).toEqual(["polite"]);
        expect(after[0]?.text).toMatch(
          /^Couldn't verify these credentials: 403: the token lacks the accounts scope The app's check may be wrong\./,
        );
        expect(after[0]?.text).not.toContain("Validating");
        expect(
          yield* browser.use("The button is named for what it does next", () =>
            connect.getByRole("button", { name: "Continue anyway", exact: true }).count(),
          ),
        ).toBe(1);
        expect(
          yield* browser.use("Nothing sticks out after the check", () => outside(connect)),
        ).toEqual({ sticking: [], sideways: 0 });
        yield* browser.checkpoint("The check result wraps inside the dialog");
      }),
    ),
  );
  it.effect(scenarios.connectFormHostList.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const actors = yield* Actors;
        const api = yield* Api;
        const browser = yield* Browser;
        const prefix = `/api/organizations/${actors.organization.id}`;
        const run = randomUUID().slice(0, 8);
        const deployed = yield* Effect.forEach(
          hostCases,
          (hostCase) =>
            Effect.gen(function* () {
              const name = `Hosts ${hostCase.label} ${run}`;
              const response = yield* api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
                name,
                files: [
                  { path: "index.ts", content: hostSource(name, hostCase.hosts) },
                  appsManifest,
                ],
              });
              expect(response.status, JSON.stringify(response.body)).toBe(200);
              const app = yield* body(App, response);
              yield* Effect.addFinalizer(() =>
                api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(
                  Effect.map((deleted) => expect(deleted.status).toBe(200)),
                  Effect.orDie,
                ),
              );
              return { ...hostCase, name, app };
            }),
          { concurrency: "unbounded" },
        );

        yield* browser.login(actors.owner);
        for (const { label, hosts, line, name, app } of deployed) {
          yield* browser.use(`Resize to 1280 pixels wide for ${label}`, (page) =>
            page.setViewportSize({ width: 1280, height: 900 }),
          );
          yield* browser.use(`Open the accounts of the app with ${label}`, (page) =>
            page.goto(`/org/${actors.organization.slug}/apps/${app.id}?view=accounts`),
          );
          yield* browser.use(`Connect a new account for ${label}`, (page) =>
            page.getByRole("button", { name: "Connect new account", exact: true }).click(),
          );
          const connect = yield* browser.use(`The connection dialog opens for ${label}`, (page) => {
            const dialog = page.getByRole("dialog", { name: `Connect ${name}`, exact: true });
            return dialog.waitFor({ state: "visible" }).then(() => dialog);
          });
          const access = connect.locator('[data-credential-access="hidden"]');
          const read = () => access.innerText().then((text) => text.replace(/\s+/g, " ").trim());
          const said = yield* browser.use(`What the line says for ${label}`, read);
          expect(said, label).toBe(line);
          expect(truthful(said, hosts), label).toEqual({
            counts: said.match(/ hosts on /g)?.map(() => true) ?? [],
            unnamed: [],
          });
          yield* browser.checkpoint(`Hosts line for ${label}`);
          const toggle = connect.getByRole("button", { name: "Show all", exact: true });
          if (!line.endsWith("Show all")) {
            // Named hosts need no list, so there is nothing to expand.
            expect(yield* browser.use(`No list button for ${label}`, () => toggle.count())).toBe(0);
            yield* fitsAtBothWidths(connect, "Connect account");
            yield* browser.use(`Close the dialog for ${label}`, (page) =>
              page.keyboard.press("Escape"),
            );
            continue;
          }
          yield* fitsAtBothWidths(connect, "Connect account");
          yield* browser.use(`Resize back to 1280 pixels wide for ${label}`, (page) =>
            page.setViewportSize({ width: 1280, height: 900 }),
          );
          const before = yield* browser.use(`The list button before expanding, ${label}`, () =>
            Promise.all([
              toggle.getAttribute("aria-expanded"),
              toggle.getAttribute("aria-controls"),
              toggle.evaluate((button) => button.tagName === "BUTTON" && button.tabIndex >= 0),
              connect.getByRole("list", { name: "Hosts" }).count(),
            ]),
          );
          expect(before).toEqual(["false", expect.any(String), true, 0]);
          // The keyboard opens the list: Enter on the focused button.
          yield* browser.use(`Show every host with the keyboard, ${label}`, (page) =>
            toggle.focus().then(() => page.keyboard.press("Enter")),
          );
          const less = connect.getByRole("button", { name: "Show less", exact: true });
          const list = connect.getByRole("list", { name: "Hosts" });
          const after = yield* browser.use(`The expanded list for ${label}`, () =>
            list
              .waitFor({ state: "visible" })
              .then(() =>
                Promise.all([
                  less.getAttribute("aria-expanded"),
                  less.getAttribute("aria-controls"),
                  list.getAttribute("id"),
                  list.getByRole("listitem").allInnerTexts(),
                ]),
              ),
          );
          // Every declared host, in the order declared, in the list the button controls.
          expect(after).toEqual(["true", before[1], before[1], hosts.map(listed)]);
          yield* browser.checkpoint(`Every host listed for ${label}`);
          yield* fitsAtBothWidths(connect, "Connect account");
          yield* browser.use(`Hide the list again, ${label}`, (page) =>
            less.focus().then(() => page.keyboard.press("Enter")),
          );
          expect(
            yield* browser.use(`The list is hidden again for ${label}`, () =>
              list
                .waitFor({ state: "hidden" })
                .then(() => Promise.all([toggle.getAttribute("aria-expanded"), read()])),
            ),
          ).toEqual(["false", line]);
          yield* browser.use(`Close the dialog for ${label}`, (page) =>
            page.keyboard.press("Escape"),
          );
        }
      }),
    ),
  );
});

layer(TestLive, { excludeTestServices: true })("Local connect form layout", (it) => {
  it.effect(scenarios.localConnectFormLongLabel.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const api = yield* Api;
        const browser = yield* Browser;
        const target = yield* Target;
        const session = yield* api.session();
        const headers = { authorization: `Bearer ${Redacted.value(target.apiKey)}` };
        const name = `Local layout fixture ${randomUUID().slice(0, 8)}`;
        const deployed = yield* session.send(
          "POST",
          "/v1/apps/deploy",
          {
            owner: "local",
            name,
            files: [{ path: "index.ts", content: source(name) }, appsManifest],
          },
          headers,
        );
        expect(deployed.status, JSON.stringify(deployed.body)).toBe(200);
        const { app } = yield* body(Deployed, deployed);
        yield* Effect.addFinalizer(() =>
          session.send("DELETE", `/v1/apps/${app.id}`, undefined, headers).pipe(
            Effect.map((response) => expect(response.status).toBe(200)),
            Effect.orDie,
          ),
        );
        const pairing = yield* session.send("POST", "/auth/pair", undefined, headers);
        expect(pairing.status).toBe(200);
        const { url } = yield* body(Schema.Struct({ url: Schema.String }), pairing);
        yield* browser.use("Pair the local browser", (page) => page.goto(url));
        yield* browser.use("The paired inventory is visible", (page) =>
          page.getByRole("heading", { name: /^Apps/ }).waitFor({ state: "visible" }),
        );
        yield* browser.use("Open the app's accounts", (page) =>
          page.goto(`/apps/${app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new account", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const connect = yield* browser.use("The connection dialog opens", (page) => {
          const dialog = page.getByRole("dialog", { name: `Connect ${name}`, exact: true });
          return dialog.waitFor({ state: "visible" }).then(() => dialog);
        });
        yield* fitsAtBothWidths(connect);
      }),
    ),
  );
});
