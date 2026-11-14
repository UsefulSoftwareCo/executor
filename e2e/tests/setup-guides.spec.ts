/**
 * Apps tell people where to get credentials: each field's `title` and `description`, a secrets
 * method's `guide` and an OAuth method's `clientGuide`. The connect form renders them as Markdown,
 * and agents read them in the app's requirements. Help belongs to each app version, not to the
 * provider: the provider ID hashes the definition without it, so apps that explain one provider
 * differently share its accounts, and editing help keeps the ID and every link. Deploys refuse
 * help the form would not show safely.
 */
import { expect, layer } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright";
import { Actors } from "../support/actors.ts";
import { Api, body, type Session } from "../support/api.ts";
import { accountLinks, connectionsPath, linkAccount } from "../support/app-accounts.ts";
import { appsManifest } from "../support/apps-release.ts";
import { Browser } from "../support/browser.ts";
import { HostedLive, TestLive, withCase, withHostedCase } from "../support/case.ts";
import { localAgent, pairLocalBrowser } from "../support/local-links.ts";
import { nameConnectedAccount } from "../support/name-account.ts";
import { oauthSetupIssuer } from "../support/oauth-setup-issuer.ts";
import { formOrder } from "../support/oauth-client-form.ts";
import { scenarios } from "../test-plan.ts";

const Field = Schema.Struct({
  title: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
const Method = Schema.Struct({
  guide: Schema.optional(Schema.String),
  clientGuide: Schema.optional(Schema.String),
  fields: Schema.optional(Schema.Struct({ properties: Schema.Record(Schema.String, Field) })),
});
const Definition = Schema.Struct({ auth: Schema.Record(Schema.String, Method) });
const Requirement = Schema.Struct({ provider: Schema.String, definition: Schema.Json });
const App = Schema.Struct({
  id: Schema.String,
  requirements: Schema.Struct({ accounts: Schema.Struct({ service: Requirement }) }),
});
const Redeployed = Schema.Struct({ app: App });
const Connection = Schema.Struct({
  id: Schema.String,
  provider: Schema.Struct({ id: Schema.String, definition: Schema.Json }),
});
/** A hosted connection request as created, with the link the agent gives the user. */
const HostedLink = Schema.Struct({ ...Connection.fields, url: Schema.String });
const Account = Schema.Struct({ id: Schema.String });
const StoredProvider = Schema.Struct({ id: Schema.String, definition: Schema.Json });
const Detail = Schema.Struct({ account: Account, provider: StoredProvider });
const Who = Schema.Struct({ account: Schema.String, site: Schema.String });
const BuildFailed = Schema.Struct({
  _tag: Schema.String,
  reason: Schema.String,
  stage: Schema.optional(Schema.String),
  message: Schema.String,
});

/** Indented as an author writes it inside a template literal; the declaration stores it dedented. */
const indentedGuide = (who: string) => `
        Sign in to the help desk as ${who} first.

        1. Open [Team settings](https://tickets.example.com/settings/team).
        2. Turn on **API access**.
      `;
const guideOf = (who: string) =>
  [
    `Sign in to the help desk as ${who} first.`,
    "",
    "1. Open [Team settings](https://tickets.example.com/settings/team).",
    "2. Turn on **API access**.",
  ].join("\n");
/** How the connect form shows `guideOf(who)`. */
const shownGuide = (who: string) =>
  `Sign in to the help desk as ${who} first.\n\nOpen Team settings.\nTurn on API access.`;
const siteHelp = "The part before `.tickets.example.com` in your help desk URL.";
const indentedTokenHelp = `
          Create one under [API tokens](https://tickets.example.com/settings/tokens).
          Starts with \`tkt_\`.
        `;
const tokenHelp =
  "Create one under [API tokens](https://tickets.example.com/settings/tokens).\nStarts with `tkt_`.";
const indentedQueueHelp = `
          Ask a lead which queue takes **billing** tickets.
        `;
const queueHelp = "Ask a lead which queue takes **billing** tickets.";
const clientHelp =
  "Create a client under [Developer settings](https://tickets.example.com/settings/clients) and choose **Web application**.";

interface FieldHelp {
  readonly title?: string;
  readonly description?: string;
}
interface Help {
  readonly guide?: string;
  readonly site?: FieldHelp;
  readonly token?: FieldHelp;
  /** Adds an optional port field; an optional field's help sits in its schema's `anyOf`. */
  readonly port?: FieldHelp;
  /**
   * Adds an optional `routing` object with this help on its `queue`: help nested below a field,
   * which the form never shows but the provider must still leave out.
   */
  readonly queue?: FieldHelp;
}
/** The full help one app writes for the help desk. */
const adminHelp: Help = {
  guide: indentedGuide("an admin"),
  site: { title: "Site", description: siteHelp },
  token: { title: "API token", description: indentedTokenHelp },
};

/**
 * A help desk API key provider named `name`, with the help an app writes for it. Its `who` query
 * reads the linked account, so a call proves the account still fills the requirement.
 */
const keySource = (name: string, help: Help) => {
  const options = (field: FieldHelp | undefined) =>
    field === undefined ? "" : JSON.stringify(field);
  return `import { defineApp, defineProvider, ${help.port === undefined ? "" : "number, "}object, plain, query, router, secrets, string } from "apps";
const service = defineProvider({
  name: ${JSON.stringify(name)},
  auth: {
    apiKey: secrets({
      label: "API token",
      ${help.guide === undefined ? "" : `guide: ${JSON.stringify(help.guide)},`}
      fields: object({
        site: plain(string(${options(help.site)})),
        token: string(${options(help.token)}),
        ${help.port === undefined ? "" : `port: number(${options(help.port)}).optional(),`}
        ${help.queue === undefined ? "" : `routing: object({ queue: string(${options(help.queue)}) }).optional(),`}
      }),
    }),
  },
});
export const who = query({ input: object({}) }, async (ctx) => ({
  account: ctx.user.accounts.service.id,
  site: ctx.user.accounts.service.fields.site,
}));
export default defineApp({ user: { accounts: { service } } }, { tools: router({ who }) });`;
};

/** An OAuth provider; `discover` names an issuer, else its declared endpoints are used. */
const oauthSource = (name: string, clientGuide: string, discover?: string) =>
  `import { defineApp, defineProvider, oauth2, router } from "apps";
const service = defineProvider({
  name: ${JSON.stringify(name)},
  auth: {
    oauth: oauth2({
      ${
        discover === undefined
          ? `authorizationUrl: "https://auth.tickets.example.com/authorize",
      tokenUrl: "https://auth.tickets.example.com/token",
      scopes: ["tickets:read"],`
          : `discover: ${JSON.stringify(discover)},`
      }
      clientGuide: ${JSON.stringify(clientGuide)},
    }),
  },
});
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));`;

/** A name no other scenario uses: provider rows are shared across the instance. */
const uniqueName = (label: string) => `${label} ${randomUUID().slice(0, 8)}`;

/** The apiKey method's help in a provider definition: its guide and each field's title and description. */
const helpOf = (definition: Schema.Json) =>
  Effect.map(Schema.decodeUnknownEffect(Definition)(definition), ({ auth }) => {
    const method = auth["apiKey"];
    return {
      guide: method?.guide,
      site: method?.fields?.properties["site"],
      token: method?.fields?.properties["token"],
    };
  });

const Routing = Schema.Struct({
  auth: Schema.Struct({
    apiKey: Schema.Struct({
      fields: Schema.Struct({
        properties: Schema.Struct({
          routing: Schema.Struct({
            anyOf: Schema.Tuple([
              Schema.Struct({ properties: Schema.Struct({ queue: Field }) }),
              Schema.Unknown,
            ]),
          }),
        }),
      }),
    }),
  }),
});
/** The help on `routing.queue`, in the optional `routing` field's object member. */
const queueHelpOf = (definition: Schema.Json) =>
  Effect.map(
    Schema.decodeUnknownEffect(Routing)(definition),
    ({ auth }) => auth.apiKey.fields.properties.routing.anyOf[0].properties.queue,
  );

/**
 * Each input of a form with the text of its label and of the element its `aria-describedby`
 * names, and whether that description sits outside the label.
 */
const describedInputs = (form: Locator) =>
  form.locator("input").evaluateAll((inputs: HTMLInputElement[]) =>
    inputs.map((input) => {
      const label = input.labels?.[0] ?? null;
      const id = input.getAttribute("aria-describedby");
      const description = id === null ? null : document.getElementById(id);
      return {
        label: label?.textContent ?? null,
        description: description?.textContent ?? null,
        outsideLabel: description !== null && label !== null && !label.contains(description),
      };
    }),
  );

/** Wait for the open dialog's animations, so a checkpoint shows it as people see it. */
const settled = (page: Page) =>
  page
    .getByRole("dialog")
    .evaluate((dialog) =>
      Promise.all(dialog.getAnimations({ subtree: true }).map((animation) => animation.finished)),
    );

/** The element that describes a field's input. */
const descriptionOf = (form: Locator, input: Locator) =>
  input
    .getAttribute("aria-describedby")
    .then((id) => form.locator(`[id=${JSON.stringify(id ?? "")}]`));

layer(HostedLive, { excludeTestServices: true })("Setup help", (it) => {
  /** Deploy apps for the owner, deleting each when the scenario ends. */
  const hostedApps = Effect.gen(function* () {
    const api = yield* Api,
      actors = yield* Actors;
    const prefix = `/api/organizations/${actors.organization.id}`;
    const send = (name: string, content: string) =>
      api.request(actors.owner, "POST", `${prefix}/apps/deploy`, {
        name: uniqueName(name),
        files: [{ path: "index.ts", content }, appsManifest],
      });
    const deploy = (name: string, content: string) =>
      Effect.gen(function* () {
        const response = yield* send(name, content);
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        const app = yield* body(App, response);
        yield* Effect.addFinalizer(() =>
          api.request(actors.owner, "DELETE", `${prefix}/apps/${app.id}`).pipe(Effect.orDie),
        );
        return { app, path: `${prefix}/apps/${app.id}` };
      });
    const redeploy = (path: string, content: string) =>
      Effect.gen(function* () {
        const response = yield* api.request(actors.owner, "POST", `${path}/deploy`, {
          files: [{ path: "index.ts", content }, appsManifest],
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return (yield* body(Redeployed, response)).app;
      });
    /** Ask for a connection to the app's `service` requirement, as an agent does. */
    const connection = (path: string, input: { readonly account?: string }) =>
      Effect.gen(function* () {
        const response = yield* api.request(
          actors.owner,
          "POST",
          connectionsPath(path, "user", "service"),
          input,
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return yield* body(HostedLink, response);
      });
    const submit = (connection: string, token: string) =>
      Effect.gen(function* () {
        const response = yield* api.request(
          actors.owner,
          "POST",
          `${prefix}/connections/${connection}/submit`,
          { method: "apiKey", fields: { site: "billing", token } },
        );
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return yield* body(Account, response);
      });
    const who = (path: string) =>
      Effect.gen(function* () {
        const response = yield* api.request(actors.owner, "POST", `${path}/tools/call`, {
          tool: "who",
          kind: "query",
          input: {},
        });
        expect(response.status, JSON.stringify(response.body)).toBe(200);
        return yield* body(Who, response);
      });
    return { api, actors, prefix, send, deploy, redeploy, connection, submit, who };
  });

  it.effect(scenarios.setupHelpRefused.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { send, deploy } = yield* hostedApps;
        const name = uniqueName("Refused desk");
        const refusal =
          "App build failed: setup help must be Markdown with absolute https links and no HTML or images.";
        /** The build failure a deploy of `content` reports. */
        const refused = (content: string) =>
          Effect.gen(function* () {
            const response = yield* send("Refused help", content);
            expect(response.status, JSON.stringify(response.body)).toBe(422);
            return yield* body(BuildFailed, response);
          });
        const cases: ReadonlyArray<readonly [Help, string]> = [
          [
            { guide: "Open [settings](http://tickets.example.com/settings)." },
            `method "apiKey" guide has a link whose address does not start with https://.`,
          ],
          [
            { token: { description: "Paste the <b>whole</b> token." } },
            `method "apiKey" field "token" description contains raw HTML; write Markdown instead.`,
          ],
          [
            { guide: "![Where the token is](https://tickets.example.com/shot.png)" },
            `method "apiKey" guide contains an image; images are not shown, so link to the page instead.`,
          ],
          [
            { guide: "a".repeat(4001) },
            `method "apiKey" guide is 4,001 characters; the limit is 4,000.`,
          ],
          [
            { site: { description: "b".repeat(1001) } },
            `method "apiKey" field "site" description is 1,001 characters; the limit is 1,000.`,
          ],
          [
            { port: { description: "Only for [old servers](http://tickets.example.com/old)." } },
            `method "apiKey" field "port" description has a link whose address does not start with https://.`,
          ],
          // The form links only an address written as https://, so this one would not open.
          [
            { guide: "Open [settings](https:tickets.example.com/settings)." },
            `method "apiKey" guide has a link whose address does not start with https://.`,
          ],
        ];
        const failures = yield* Effect.forEach(cases, ([help]) => refused(keySource(name, help)), {
          concurrency: 3,
        });
        // Each failure names the requirement, the provider, the method and the field.
        expect(failures).toEqual(
          cases.map(([, problem]) => ({
            _tag: "VersionBuildFailed",
            reason: "Invalid setup help",
            stage: "declaration",
            message: `${refusal} Requirement "service" (provider "${name}") ${problem}`,
          })),
        );
        const oauthName = uniqueName("Refused OAuth desk");
        expect(yield* refused(oauthSource(oauthName, "<i>Ask an admin.</i>"))).toEqual({
          _tag: "VersionBuildFailed",
          reason: "Invalid setup help",
          stage: "declaration",
          message: `${refusal} Requirement "service" (provider "${oauthName}") method "oauth" clientGuide contains raw HTML; write Markdown instead.`,
        });

        // Help at the limits deploys, and so does an email address written as text: GFM reads it
        // as a mailto link, but the form shows it as the address.
        yield* deploy(
          "Help at the limits",
          keySource(name, {
            guide: "a".repeat(4000),
            site: { description: "b".repeat(1000) },
            token: { description: "Ask ops@tickets.example.com for one." },
          }),
        );
      }),
    ),
  );

  it.effect(scenarios.setupHelpIdentity.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, redeploy, connection, submit, who } =
          yield* hostedApps;
        const name = uniqueName("Help desk");
        // Three apps declare the same provider: one not explaining it, as apps did before setup
        // help, then one explaining it fully and one another way, each also on a field nested in
        // another. Each deploy writes the shared provider row, so the last carries help it must
        // leave out.
        const plain = yield* deploy("Plain desk", keySource(name, { queue: {} }));
        const admins = yield* deploy(
          "Admin desk",
          keySource(name, {
            ...adminHelp,
            queue: { title: "Queue", description: indentedQueueHelp },
          }),
        );
        const agents = yield* deploy(
          "Agent desk",
          keySource(name, {
            guide: indentedGuide("a support agent"),
            queue: { description: "Use the support queue." },
          }),
        );
        const provider = plain.app.requirements.accounts.service.provider;
        expect(provider).toMatch(/^prv_/);
        expect(
          [admins, agents].map(({ app }) => app.requirements.accounts.service.provider),
        ).toEqual([provider, provider]);

        // Agents read each app's own help, dedented, in its requirements.
        const requirementHelp = (app: typeof App.Type) =>
          helpOf(app.requirements.accounts.service.definition);
        expect(yield* requirementHelp(admins.app)).toEqual({
          guide: guideOf("an admin"),
          site: { title: "Site", description: siteHelp },
          token: { title: "API token", description: tokenHelp },
        });
        expect(yield* requirementHelp(agents.app)).toEqual({
          guide: guideOf("a support agent"),
          site: {},
          token: {},
        });
        expect(yield* requirementHelp(plain.app)).toEqual({
          guide: undefined,
          site: {},
          token: {},
        });
        // So is help nested below a field, dedented too.
        expect(
          yield* Effect.forEach([admins, agents, plain], ({ app }) =>
            queueHelpOf(app.requirements.accounts.service.definition),
          ),
        ).toEqual([
          { title: "Queue", description: queueHelp },
          { description: "Use the support queue." },
          {},
        ]);

        // An agent's connection read carries the app's help.
        const pending = yield* connection(admins.path, {});
        expect(pending.provider.id).toBe(provider);
        expect((yield* helpOf(pending.provider.definition)).guide).toBe(guideOf("an admin"));
        const account = yield* submit(pending.id, "tkt_synthetic_owned");
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );

        // The provider row every app shares holds the definition without any app's help.
        const stored = Effect.gen(function* () {
          const response = yield* api.request(
            actors.owner,
            "GET",
            `${prefix}/accounts/${account.id}`,
          );
          expect(response.status, JSON.stringify(response.body)).toBe(200);
          return (yield* body(Detail, response)).provider;
        });
        expect(yield* stored).toEqual({
          id: provider,
          definition: plain.app.requirements.accounts.service.definition,
        });

        // The other apps use the same account.
        for (const { path } of [agents, plain])
          yield* linkAccount(actors.owner, path, "service", account.id);
        const everyApp = [admins, agents, plain];
        const linked = Effect.forEach(everyApp, ({ path }) => accountLinks(actors.owner, path));
        const calls = Effect.forEach(everyApp, ({ path }) => who(path));
        const served = { account: account.id, site: "billing" };
        expect(yield* calls).toEqual([served, served, served]);

        // Editing the help redeploys with the same provider, links and account.
        const edited = yield* redeploy(
          admins.path,
          keySource(name, {
            guide: "Ask the desk owner for a token.",
            token: { title: "API token", description: "Starts with `tkt_live_`." },
            queue: { description: "Billing tickets go to the billing queue." },
          }),
        );
        expect(edited.requirements.accounts.service.provider).toBe(provider);
        expect(yield* requirementHelp(edited)).toEqual({
          guide: "Ask the desk owner for a token.",
          site: {},
          token: { title: "API token", description: "Starts with `tkt_live_`." },
        });
        expect(yield* linked).toEqual(everyApp.map(() => [["service", account.id]]));
        expect(yield* calls).toEqual([served, served, served]);
        expect(yield* stored).toEqual({
          id: provider,
          definition: plain.app.requirements.accounts.service.definition,
        });

        // A reconnect after the edit replaces the credentials of the same account.
        const reconnect = yield* connection(admins.path, { account: account.id });
        const reconnected = yield* submit(reconnect.id, "tkt_synthetic_rotated");
        expect(reconnected).toEqual({ id: account.id });
        expect(yield* who(admins.path)).toEqual(served);
      }),
    ),
  );

  it.effect(scenarios.setupHelpForm.title, (context) =>
    withHostedCase(
      context,
      Effect.gen(function* () {
        const { api, actors, prefix, deploy, connection } = yield* hostedApps;
        const browser = yield* Browser;
        const issuer = yield* oauthSetupIssuer;
        // The service registers no clients, so the person connecting enters one.
        yield* issuer.configure({ registration: false });
        const name = uniqueName("Help desk");
        const admins = yield* deploy("Admin desk", keySource(name, adminHelp));
        const agents = yield* deploy(
          "Agent desk",
          keySource(name, { guide: indentedGuide("a support agent") }),
        );
        const oauthName = uniqueName("OAuth desk");
        const oauth = yield* deploy(
          "OAuth desk",
          oauthSource(oauthName, clientHelp, `${issuer.origin}/mcp`),
        );
        const link = yield* connection(admins.path, {});
        yield* browser.login(actors.owner);
        yield* browser.use("Open the agent's connection link", (page) =>
          page.goto(new URL(link.url).pathname),
        );
        const form = yield* browser.use("The connect form opens", (page) => {
          const dialog = page.getByRole("dialog", { name: `Connect ${name}`, exact: true });
          return dialog
            .getByRole("region", { name: "Setup guide", exact: true })
            .waitFor()
            .then(() => dialog);
        });
        const guideRegion = form.getByRole("region", { name: "Setup guide", exact: true });
        const site = form.getByLabel("Site", { exact: true });
        const token = form.getByLabel("API token", { exact: true });
        const shown = yield* browser.use("Read the guide and field help", () =>
          Promise.all([
            guideRegion.innerText(),
            guideRegion
              .getByRole("link", { name: "Team settings", exact: true })
              .getAttribute("href"),
            // The link to where the token comes from is in the token field's own help.
            descriptionOf(form, token).then((help) =>
              help.getByRole("link", { name: "API tokens", exact: true }).getAttribute("href"),
            ),
            describedInputs(form),
            form.getByText("Get these credentials from your", { exact: false }).count(),
          ]),
        );
        expect(shown).toEqual([
          shownGuide("an admin"),
          "https://tickets.example.com/settings/team",
          "https://tickets.example.com/settings/tokens",
          // Each label is the field's title; its description is under the input, outside the label.
          [
            {
              label: "Site",
              description: "The part before .tickets.example.com in your help desk URL.",
              outsideLabel: true,
            },
            {
              label: "API token",
              description: "Create one under API tokens.\nStarts with tkt_.",
              outsideLabel: true,
            },
          ],
          // The app's guide replaces the generic line.
          0,
        ]);
        // The guide comes first, then each field above its description.
        const order = yield* browser.use("Read the form's order", () =>
          Promise.all([descriptionOf(form, site), descriptionOf(form, token)]).then(
            ([siteHelp, tokenHelp]) =>
              formOrder({
                guide: guideRegion,
                site,
                siteHelp,
                token,
                tokenHelp,
              }),
          ),
        );
        expect(order).toEqual(["guide", "site", "siteHelp", "token", "tokenHelp"]);
        yield* browser.use("The dialog settles", settled);
        yield* browser.checkpoint("Connect form with the app's guide and field help");

        // The described fields connect an account.
        const submitted = yield* browser.use("Connect the account", (page) =>
          site
            .fill("billing")
            .then(() => token.fill("tkt_synthetic_named"))
            .then(() =>
              Promise.all([
                page.waitForResponse(
                  (response) =>
                    response.request().method() === "POST" &&
                    /\/connections\/[^/]+\/submit$/.test(new URL(response.url()).pathname),
                ),
                form.getByRole("button", { name: "Connect account", exact: true }).click(),
              ]),
            )
            .then(([response]) => response.json() as Promise<unknown>),
        );
        const account = yield* Schema.decodeUnknownEffect(Account)(submitted);
        yield* Effect.addFinalizer(() =>
          api
            .request(actors.owner, "DELETE", `${prefix}/accounts/${account.id}`)
            .pipe(Effect.orDie),
        );
        yield* browser.use("Keep the account's name", (page) => nameConnectedAccount(page));

        // Another app explains the same provider its own way.
        yield* browser.use("Open the other app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${agents.app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new account for it", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const other = yield* browser.use("Its form shows its own guide", (page) => {
          const dialog = page.getByRole("dialog", { name: `Connect ${name}`, exact: true });
          const guide = dialog.getByRole("region", { name: "Setup guide", exact: true });
          return guide
            .waitFor()
            .then(() => Promise.all([guide.innerText(), describedInputs(dialog)]));
        });
        expect(other).toEqual([
          shownGuide("a support agent"),
          [
            { label: "Site", description: null, outsideLabel: false },
            { label: "Token", description: null, outsideLabel: false },
          ],
        ]);
        yield* browser.use("Close the other dialog", (page) => page.keyboard.press("Escape"));

        // OAuth client entry shows the app's client guide after Executor's steps and redirect URL.
        yield* browser.use("Open the OAuth app's accounts", (page) =>
          page.goto(`/org/${actors.organization.slug}/apps/${oauth.app.id}?view=accounts`),
        );
        yield* browser.use("Connect a new OAuth account", (page) =>
          page.getByRole("button", { name: "Connect new account", exact: true }).click(),
        );
        const client = yield* browser.use("Client entry shows the client guide", (page) => {
          const dialog = page.getByRole("dialog", { name: `Connect ${oauthName}`, exact: true });
          const guide = dialog.getByRole("region", { name: "OAuth client guide", exact: true });
          return guide.waitFor().then(() =>
            Promise.all([
              guide.innerText(),
              guide
                .getByRole("link", { name: "Developer settings", exact: true })
                .getAttribute("href"),
              formOrder({
                guidance: dialog.getByText("Executor can’t set up sign-in"),
                redirect: dialog.getByText("Redirect URL", { exact: true }),
                clientGuide: guide,
                clientId: dialog.getByLabel("Client ID", { exact: true }),
              }),
            ]),
          );
        });
        expect(client).toEqual([
          "Create a client under Developer settings and choose Web application.",
          "https://tickets.example.com/settings/clients",
          ["guidance", "redirect", "clientGuide", "clientId"],
        ]);
        yield* browser.use("The OAuth dialog settles", settled);
        yield* browser.checkpoint("OAuth client entry with the app's client guide");
      }),
    ),
  );
});

const Deployed = Schema.Struct({ app: Schema.Struct({ id: Schema.String }) });
const LocalLink = Schema.Struct({ connection: Schema.String, url: Schema.String });

layer(TestLive, { excludeTestServices: true })("Local setup help", (it) => {
  /** Deploy a local app through the agent API, deleting it when the scenario ends. */
  const deployLocal = (agent: Session, name: string, content: string) =>
    Effect.gen(function* () {
      const response = yield* agent.send("POST", "/v1/apps/deploy", {
        owner: "local",
        name: uniqueName(name),
        files: [{ path: "index.ts", content }, appsManifest],
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const { app } = yield* body(Deployed, response);
      yield* Effect.addFinalizer(() =>
        agent.send("DELETE", `/v1/apps/${app.id}`).pipe(Effect.orDie),
      );
      return app;
    });

  it.effect(scenarios.localSetupHelp.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { agent } = yield* localAgent;
        const browser = yield* Browser;
        const name = uniqueName("Help desk");
        const app = yield* deployLocal(agent, "Local desk", keySource(name, adminHelp));
        const issued = yield* agent.send("POST", "/account-connect/api/requests", {
          target: { app: app.id, requirement: "service" },
        });
        expect(issued.status, JSON.stringify(issued.body)).toBe(200);
        const link = yield* body(LocalLink, issued);
        // The agent reads the app's help before sending the link.
        const read = yield* agent
          .send("GET", `/v1/account-connections/${link.connection}`)
          .pipe(Effect.flatMap((response) => body(Connection, response)));
        expect((yield* helpOf(read.provider.definition)).guide).toBe(guideOf("an admin"));

        yield* browser.use("Open the connection link", (page) => page.goto(link.url));
        const form = yield* browser.use("The connect page opens", (page) =>
          page
            .getByRole("region", { name: "Setup guide", exact: true })
            .waitFor()
            .then(() => page.locator("main")),
        );
        const guideRegion = form.getByRole("region", { name: "Setup guide", exact: true });
        const site = form.getByLabel("Site", { exact: true });
        const token = form.getByLabel("API token", { exact: true });
        const shown = yield* browser.use("Read the guide and field help", () =>
          Promise.all([
            guideRegion.innerText(),
            describedInputs(form),
            form.getByText("Get these credentials from your", { exact: false }).count(),
            formOrder({ guide: guideRegion, site, token }),
          ]),
        );
        expect(shown).toEqual([
          shownGuide("an admin"),
          [
            {
              label: "Site",
              description: "The part before .tickets.example.com in your help desk URL.",
              outsideLabel: true,
            },
            {
              label: "API token",
              description: "Create one under API tokens.\nStarts with tkt_.",
              outsideLabel: true,
            },
          ],
          0,
          ["guide", "site", "token"],
        ]);
        yield* browser.checkpoint("Local connection link with the app's help");
        const saved = yield* browser.use("Connect the account", (page) =>
          site
            .fill("billing")
            .then(() => token.fill("tkt_synthetic_local"))
            .then(() =>
              Promise.all([
                page.waitForResponse(
                  (response) => new URL(response.url()).pathname === "/account-connect/api/submit",
                ),
                page.getByRole("button", { name: "Connect account", exact: true }).click(),
              ]),
            )
            .then(([response]) => response.json().then((data: unknown) => data)),
        );
        const account = yield* Schema.decodeUnknownEffect(Account)(saved);
        yield* Effect.addFinalizer(() =>
          agent.send("DELETE", `/v1/accounts/${account.id}`).pipe(Effect.orDie),
        );

        // Local's provider row holds the definition without the app's help.
        const providers = yield* agent
          .send("GET", "/v1/providers?owner=local")
          .pipe(Effect.flatMap((response) => body(Schema.Array(StoredProvider), response)));
        const stored = providers.filter((provider) => provider.id === read.provider.id);
        expect(yield* Effect.forEach(stored, (provider) => helpOf(provider.definition))).toEqual([
          { guide: undefined, site: {}, token: {} },
        ]);
      }),
    ),
  );

  it.effect(scenarios.localToolMarkdownImages.title, (context) =>
    withCase(
      context,
      Effect.gen(function* () {
        const { agent } = yield* localAgent;
        const browser = yield* Browser;
        const description = [
          "Draw the desk's queue.",
          "",
          "![Queue diagram](https://tickets.example.com/queue.png)",
          "",
          "See [the docs](https://tickets.example.com/docs) or [the old docs](http://tickets.example.com/docs).",
        ].join("\n");
        const app = yield* deployLocal(
          agent,
          "Markdown tools",
          `import { defineApp, object, query, router } from "apps";
export default defineApp({}, { tools: router({
  queue: query({ description: ${JSON.stringify(description)}, input: object({}) }, async () => "drawn"),
}) });`,
        );
        yield* pairLocalBrowser(agent);
        yield* browser.use("Open the tool", (page) =>
          page.goto(`/apps/${app.id}?view=tools&tool=queue`),
        );
        const rendered = yield* browser.use("Read the tool description", (page) => {
          const text = page.locator(".tool-description");
          return text
            .getByText("Draw the desk's queue.", { exact: true })
            .waitFor()
            .then(() =>
              Promise.all([
                text.locator("img").count(),
                text.getByText("Queue diagram", { exact: true }).count(),
                text
                  .getByRole("link")
                  .evaluateAll((links) => links.map((link) => link.getAttribute("href"))),
                text.getByText("the old docs", { exact: true }).count(),
              ]),
            );
        });
        // The image is its alt text; only the https link opens.
        expect(rendered).toEqual([0, 1, ["https://tickets.example.com/docs"], 1]);
      }),
    ),
  );
});
