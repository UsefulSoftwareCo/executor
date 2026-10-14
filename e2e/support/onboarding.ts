import { Context, Deferred, Effect, Layer, Redacted, Schema } from "effect";
import { expect } from "@effect/vitest";
import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright";
import { Browser } from "./browser.ts";
import { holdOrganizationEntry } from "./organization-entry.ts";
import { Emulators } from "./emulators.ts";
import { Evidence } from "./evidence.ts";
import { Target, driver } from "./platform.ts";
import { targetHosts } from "./role-hosts.ts";
import { authorizeBrowserMcp } from "./mcp-oauth.ts";
import { holdQuery } from "./query-transition.ts";
import { observeLayoutShifts } from "./layout-shifts.ts";

const Organizations = Schema.Array(
  Schema.Struct({ id: Schema.String, name: Schema.String, slug: Schema.String }),
);
/** React reports a server/browser markup difference with one of these messages or codes. */
const hydrationFailure = /hydrat|Minified React error #(418|419|423|425)/i;
const ListedAgents = Schema.Array(Schema.Struct({ name: Schema.NullOr(Schema.String) }));
const AuthFailure = Schema.Struct({
  code: Schema.String.check(Schema.isPattern(/^[A-Z][A-Z_]{0,79}$/u)),
});
class OnboardingFailed extends Schema.TaggedError<OnboardingFailed>()("OnboardingFailed", {
  operation: Schema.String,
}) {
  get message() {
    return `Onboarding check failed: ${this.operation}`;
  }
}
const make = Effect.gen(function* () {
  const browser = yield* Browser,
    emulators = yield* Emulators,
    evidence = yield* Evidence,
    target = yield* Target;
  const openLogin = Effect.gen(function* () {
    yield* browser.omitNetworkTrace;
    yield* browser.use("Open Cloud sign-in", (page) => page.goto("/login"));
  });
  const chooseSocial = (provider: "google" | "github") =>
    Effect.gen(function* () {
      const submit = browser.use(`Choose ${provider} sign-in`, (page) =>
        Promise.all([
          page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.origin === targetHosts(target).browser &&
              url.pathname === "/api/auth/sign-in/social"
            );
          }),
          page
            .getByRole("button", {
              name: provider === "google" ? "Continue with Google" : "Continue with GitHub",
              exact: true,
            })
            .click(),
        ]).then(([response]) =>
          (response.status() >= 400 &&
          response.headers()["content-type"]?.includes("application/json")
            ? response.json()
            : Promise.resolve(undefined)
          ).then((failure: unknown) => ({ status: response.status(), failure })),
        ),
      );
      const response = yield* submit;
      if (response.status !== 200) {
        const failure = Schema.decodeUnknownOption(AuthFailure)(response.failure);
        return yield* new OnboardingFailed({
          operation: `${provider} sign-in returned HTTP ${response.status}${failure._tag === "Some" ? ` (${failure.value.code})` : ""}`,
        });
      }
    });
  const organizations = browser
    .use("Read teams through the public session", (page) =>
      page.evaluate(() =>
        fetch("/api/auth/organization/list").then((response) => {
          if (response.status !== 200)
            throw new Error(`Team list returned HTTP ${response.status}`);
          return response.json();
        }),
      ),
    )
    .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Organizations)));
  const emailSignIn = (email: string, mode: "signin" | "signup" = "signin") =>
    Effect.gen(function* () {
      const flow = mode === "signup" ? "Sign up" : "Sign in";
      if (mode === "signup") {
        // New visitors start from the site's primary call to action, which opens sign-up.
        yield* browser.omitNetworkTrace;
        yield* browser.use("Open the homepage", (page) => page.goto("/home"));
        yield* browser.use("Choose Get started", (page) =>
          page.getByRole("link", { name: "Get started", exact: true }).click(),
        );
        yield* browser.use("The sign-up view is ready", (page) =>
          page.getByRole("heading", { name: "Sign up", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Sign up with email or a social account");
        // The address has an @ but no domain the server accepts; the error names the address.
        yield* browser.use("Enter an email without a domain", (page) =>
          page.getByLabel("Email", { exact: true }).fill("new-user@example"),
        );
        yield* browser.use("Submit the incomplete email", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        expect(
          yield* browser.use("Read the email error", (page) =>
            page.getByRole("alert").filter({ hasText: "email" }).innerText(),
          ),
        ).toBe("Enter a valid email address, such as name@example.com.");
        yield* browser.checkpoint("Sign-up rejects an incomplete email");
      } else yield* openLogin;
      yield* browser.use("Enter the synthetic email", (page) =>
        page.getByLabel("Email", { exact: true }).fill(email),
      );
      const received = yield* emulators.received(email);
      yield* browser.use("Request a real sign-in code", (page) =>
        page.getByRole("button", { name: "Continue", exact: true }).click(),
      );
      const delivered = yield* evidence.step(
        "Read the delivered code from the mail emulator",
        emulators.mail(email, received),
      );
      // A first code creates the account, so its email says sign-up whichever view sent it.
      if (mode === "signup") expect(delivered.subject).toBe("Your Executor sign-up code");
      yield* browser.use("Enter the delivered code", (page) =>
        page
          .getByLabel(mode === "signup" ? "Sign-up code" : "Sign-in code", { exact: true })
          .fill(Redacted.value(delivered.code)),
      );
      yield* browser.use("Verify the code", (page) =>
        page.getByRole("button", { name: flow, exact: true }).click(),
      );
      yield* browser.use("Sign-in advances to enrollment or the destination", (page) =>
        page.waitForFunction(
          (origin) =>
            window.location.origin === origin &&
            (window.location.pathname !== "/login" ||
              document.querySelector("h1")?.textContent === "Create a passkey"),
          targetHosts(target).browser,
        ),
      );
    });
  const endpoint = `${targetHosts(target).mcp}/mcp`;
  const agentsPath = /^\/api\/organizations\/[^/]+\/mcp-agents$/u;
  const agentsRead = (url: URL) => agentsPath.test(url.pathname);
  const screenshotPath = /\.webp$/u;
  const claudeScreenshot = `img[alt="Claude's Add custom connector dialog with Executor entered"]`;
  const phone = { width: 390, height: 844 },
    desktop = { width: 1440, height: 960 };
  const nextStep = (page: Page) =>
    page.getByRole("button", { name: "Next: send your first prompt", exact: true });
  const setupSearch = browser.use("Read the setup URL", (page) =>
    Promise.resolve(new URL(page.url()).search),
  );
  type Shifts = Effect.Success<typeof observeLayoutShifts>;
  /** No element moved in this document, except while the viewport itself changed size. */
  const noLayoutShifts = (shifts: Shifts, name: string) =>
    Effect.gen(function* () {
      expect(yield* shifts.unstable(name)).toEqual([]);
    });
  /** Check the current step fits a phone and capture it, then return to the desktop layout. */
  const onPhone = (name: string, shifts: Shifts, scrollTo?: (page: Page) => Locator) =>
    Effect.gen(function* () {
      yield* shifts.resize(phone, `${name} on a phone`);
      if (scrollTo)
        yield* browser.use("Scroll the connection status into view", (page) =>
          scrollTo(page).scrollIntoViewIfNeeded(),
        );
      yield* fitsPhone(name);
      yield* browser.checkpoint(`${name} on a phone`);
      yield* shifts.resize(desktop, name);
    });
  const fitsPhone = (name: string) =>
    Effect.gen(function* () {
      const fits = yield* browser.use("The setup fits a phone screen", (page) =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      if (!fits) return yield* new OnboardingFailed({ operation: `${name} fits a phone screen` });
      const clear = yield* browser.use("Session controls do not cover the setup", (page) =>
        Promise.all([
          page.locator("section[aria-labelledby='agent-setup-title']").boundingBox(),
          page.getByRole("button", { name: /^Account: / }).boundingBox(),
        ]).then(
          ([setup, session]) =>
            setup !== null &&
            session !== null &&
            (session.y + session.height <= setup.y || session.y >= setup.y + setup.height),
        ),
      );
      if (!clear)
        return yield* new OnboardingFailed({ operation: `${name} keeps session controls clear` });
    });
  const allowClipboard = browser.use("Allow clipboard access in the isolated browser", (page) =>
    page.context().grantPermissions(["clipboard-read", "clipboard-write"]),
  );
  /**
   * Claude's guide is static, so it is shown and usable whatever the connection check is doing:
   * its steps, its link and the exact MCP URL, which copies as shown. No placeholder stands in for
   * any of it. Only Next waits for a new connection.
   */
  const guideReady = (reason: string) =>
    Effect.gen(function* () {
      expect(
        yield* browser.use(`Claude's guide is shown and usable ${reason}`, (page) =>
          Promise.all([
            page.getByRole("heading", { name: "Add Executor to Claude", exact: true }).isVisible(),
            page.getByRole("link", { name: "Open Claude connectors", exact: true }).isVisible(),
            page.getByText(endpoint, { exact: true }).isVisible(),
            page
              .locator("article[aria-label='Claude setup']")
              .evaluate((guide) => guide.closest("[inert], [aria-hidden='true']") === null),
            page.locator("[data-slot='skeleton']").count(),
          ]),
        ),
      ).toEqual([true, true, true, true, 0]);
      yield* browser.use(`Copy the MCP URL ${reason}`, (page) =>
        page.getByRole("button", { name: "Copy MCP URL", exact: true }).click(),
      );
      expect(
        yield* browser.use(`Read the MCP URL copied ${reason}`, (page) =>
          page.evaluate(() => navigator.clipboard.readText()),
        ),
      ).toBe(endpoint);
      expect(
        yield* browser.use(`Next is disabled ${reason}`, (page) => nextStep(page).isDisabled()),
      ).toBe(true);
    });
  /**
   * The page as the server sends it, before any script runs, without the empty comments React
   * places between adjacent pieces of text.
   */
  const serverDocument = (path: string) =>
    browser.use(`Read the server's document for ${path}`, (page) =>
      page.request
        .get(path)
        .then((response) => response.text())
        .then((html) => html.replaceAll("<!-- -->", "")),
    );
  /** The screenshot's space is laid out before its bytes arrive, then it loads. */
  const screenshotLoads = (images: Effect.Success<ReturnType<typeof holdQuery>>) =>
    Effect.gen(function* () {
      yield* images.requested;
      expect(
        yield* browser.use("The held screenshot already has its size", (page) =>
          page
            .locator(claudeScreenshot)
            .evaluate(
              (image) =>
                image instanceof HTMLImageElement &&
                !image.complete &&
                image.getBoundingClientRect().height > 100,
            ),
        ),
      ).toBe(true);
      yield* images.release;
      yield* browser.use("The screenshot loads", (page) =>
        page.waitForFunction((selector) => {
          const image = document.querySelector(selector);
          return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
        }, claudeScreenshot),
      );
    });
  /**
   * Choose Claude while the agents already connected and the guide's screenshot are both held.
   * The guide is shown and usable at once; the baseline read only decides when the connection
   * check starts, and the screenshot arrives after it.
   */
  const chooseClaude = (shifts: Shifts) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* allowClipboard;
        const baseline = yield* holdQuery(agentsPath, "continue");
        const images = yield* holdQuery(screenshotPath, "continue", { allRequests: true });
        yield* shifts.phase("Choose Claude");
        yield* browser.use("Choose Claude", (page) =>
          page.getByRole("button", { name: "Claude", exact: true }).click(),
        );
        yield* browser.use("Claude's guide replaces the choices", (page) =>
          page.getByRole("heading", { name: "Add Executor to Claude", exact: true }).waitFor(),
        );
        expect(yield* setupSearch).toBe("?assistant=claude");
        yield* baseline.requested;
        yield* shifts.phase("Claude's guide while its baseline is read");
        yield* browser.use("Setup reads the agents already connected", (page) =>
          page.getByText("Preparing Claude setup…", { exact: true }).waitFor(),
        );
        yield* guideReady("while the agents already connected are read");
        expect(
          yield* browser.use("Only the chosen assistant is shown", (page) =>
            page.getByRole("group", { name: "Choose your assistant", exact: true }).count(),
          ),
        ).toBe(0);
        yield* browser.checkpoint("Claude's guide while its baseline is read");
        yield* shifts.phase("The baseline read returns");
        yield* baseline.release;
        yield* browser.use("Setup waits for Claude", (page) =>
          page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
        );
        // Waiting for the baseline is not a step of its own: Back returns to the assistants.
        expect(yield* setupSearch).toBe("?assistant=claude");
        yield* shifts.phase("Claude's screenshot loads");
        yield* screenshotLoads(images);
        yield* shifts.phase("Waiting for Claude");
      }),
    );
  /**
   * The assistant signs in from its own tab, as a real assistant's browser window would, so agent
   * setup keeps its state. The client registers, the member approves it, and it exchanges its code
   * for tokens through the public OAuth endpoints.
   */
  const authorizeAssistant = (client: string, access: "mcp" | "api" = "mcp") =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* browser.omitNetworkTrace;
        const tab = yield* Effect.acquireRelease(
          browser.use("Open the assistant's sign-in tab", (page) => page.context().newPage()),
          (tab) =>
            driver("Close the assistant's sign-in tab", () => tab.close()).pipe(Effect.orDie),
        );
        yield* evidence.step(
          `${client} completes MCP OAuth`,
          authorizeBrowserMcp(
            tab,
            targetHosts(target).browser,
            access === "mcp"
              ? { resource: endpoint, client }
              : {
                  resource: `${targetHosts(target).api}/api`,
                  client,
                  scope: "executor offline_access",
                },
          ),
        );
        yield* browser.use("Return to agent setup", (page) => page.bringToFront());
      }),
    );
  /** The next successful connection check, read as the page received it. */
  const nextCheck = (label: string) =>
    browser
      .use(label, (page) =>
        page
          .waitForResponse(
            (response) =>
              agentsRead(new URL(response.url())) &&
              response.request().method() === "GET" &&
              response.status() === 200,
          )
          .then((response) => response.json()),
      )
      .pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ListedAgents)),
        Effect.map((agents) => agents.map((agent) => agent.name)),
      );
  /** Checked after one more read, so the listed agent has certainly been rendered. */
  const stillWaiting = (reason: string) =>
    Effect.gen(function* () {
      yield* nextCheck(`Another connection check after ${reason}`);
      expect(
        yield* browser.use(`Setup still waits for Claude: ${reason}`, (page) =>
          page.getByText("Waiting for Claude to connect…", { exact: true }).count(),
        ),
      ).toBe(1);
      expect(
        yield* browser.use(`Next stays disabled: ${reason}`, (page) => nextStep(page).isDisabled()),
      ).toBe(true);
    });
  /**
   * The shown status naming `agent`. A status the server renders streams into a hidden segment
   * until React reveals it, so only the visible copy counts.
   */
  const approvedFor = (page: Page, agent: string) =>
    page.getByText(`Approved for ${agent}`, { exact: true }).filter({ visible: true });
  const connected = (agent: string, reason: string) =>
    Effect.gen(function* () {
      yield* browser.use(`${agent} is connected ${reason}`, (page) =>
        approvedFor(page, agent).waitFor(),
      );
      expect(
        yield* browser.use(`Next is enabled ${reason}`, (page) => nextStep(page).isEnabled()),
      ).toBe(true);
    });
  /** The first prompt names the agent that connected, and the page confirms it holds a grant. */
  const promptShown = (agent: string, reason: string) =>
    Effect.gen(function* () {
      yield* browser.use(`The first prompt is shown ${reason}`, (page) =>
        page.getByRole("button", { name: "Copy starter prompt", exact: true }).waitFor(),
      );
      yield* browser.use(`The first prompt confirms ${agent} ${reason}`, (page) =>
        approvedFor(page, agent).waitFor(),
      );
      expect(yield* setupSearch).toMatch(/^\?assistant=claude&step=prompt&agent=[^&]+$/u);
    });
  /** Browser Back and Forward move between the screens the member chose, never the waits. */
  const goBack = (shifts: Shifts, name: string) =>
    Effect.gen(function* () {
      yield* shifts.phase(name);
      yield* browser.use(name, (page) => page.goBack());
    });
  const goForward = (shifts: Shifts, name: string) =>
    Effect.gen(function* () {
      yield* shifts.phase(name);
      yield* browser.use(name, (page) => page.goForward());
    });
  /**
   * Choosing an assistant replaces the choices with its guide at once, while the agents already
   * connected are read. The first prompt unlocks only for an assistant that connects over MCP after
   * that read; one connected earlier or an Executor API client does not count. Each chosen screen
   * is a history entry, and no element moves while the page updates by itself.
   */
  const connectFirstAgent = Effect.gen(function* () {
    yield* authorizeAssistant("Earlier agent");
    const shifts = yield* observeLayoutShifts;
    yield* shifts.phase("Assistants");
    yield* chooseClaude(shifts);
    // A later check that lists the earlier agent must still leave the first prompt locked.
    expect(yield* nextCheck("A connection check lists the earlier agent")).toContain(
      "Earlier agent",
    );
    yield* stillWaiting("the earlier agent");
    yield* browser.checkpoint("Claude setup waiting for its connection");
    yield* onPhone("Claude setup waiting for its connection", shifts, nextStep);

    // An Executor HTTP API client authorized now is a new grant, but not an assistant connection.
    yield* shifts.phase("An API client connects");
    yield* authorizeAssistant("Executor API client", "api");
    expect(yield* nextCheck("A connection check lists the API client")).toContain(
      "Executor API client",
    );
    yield* stillWaiting("an API client");

    yield* shifts.phase("All assistants");
    yield* browser.use("Go back to the assistants", (page) =>
      page.getByRole("link", { name: "All assistants", exact: true }).click(),
    );
    yield* browser.use("The choices return", (page) =>
      page.getByRole("heading", { name: "Connect your assistant", exact: true }).waitFor(),
    );
    expect(yield* setupSearch).toBe("");
    yield* shifts.phase("Choose Claude again");
    yield* browser.use("Choose Claude again", (page) =>
      page.getByRole("button", { name: "Claude", exact: true }).click(),
    );
    yield* browser.use("Setup waits for the new choice", (page) =>
      page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
    );

    // The assistant connects while checks fail; retrying keeps this attempt's baseline.
    yield* shifts.phase("Connection checks fail");
    yield* browser.use("Fail the connection checks", (page) =>
      page.route(agentsRead, (route) => route.abort("failed")),
    );
    yield* browser.use("A failed check is reported", (page) =>
      page.getByText("Couldn’t check the connection", { exact: true }).waitFor(),
    );
    expect(
      yield* browser.use("A failed check never unlocks Next", (page) =>
        nextStep(page).isDisabled(),
      ),
    ).toBe(true);
    yield* browser.checkpoint("A failed connection check offers a retry");
    yield* authorizeAssistant("Onboarding assistant");
    yield* shifts.phase("Retry the connection check");
    yield* browser.use("Restore the connection checks and try again", (page) =>
      page
        .unroute(agentsRead)
        .then(() => page.getByRole("button", { name: "Try again", exact: true }).click()),
    );
    yield* browser.use("The new agent is detected", (page) =>
      page.getByText("Executor is connected", { exact: true }).waitFor(),
    );
    yield* connected("Onboarding assistant", "after the retry");
    yield* browser.use("Let the page finish its transitions", (page) =>
      page.evaluate(() =>
        Promise.all(document.getAnimations().map((animation) => animation.finished)).then(
          () => undefined,
        ),
      ),
    );
    yield* browser.checkpoint("Claude connected with Next enabled");
    yield* onPhone("Claude connected with Next enabled", shifts, nextStep);

    yield* shifts.phase("Next: send your first prompt");
    yield* browser.use("Continue to the first prompt", (page) => nextStep(page).click());
    yield* browser.use("The first prompt replaces the guide", (page) =>
      page.getByRole("heading", { name: "Send your first prompt", exact: true }).waitFor(),
    );
    yield* promptShown("Onboarding assistant", "after Next");
    yield* browser.checkpoint("Send your first prompt after connecting");
    yield* onPhone("Send your first prompt after connecting", shifts);

    // Back returns to the connected guide, then to the assistants; Forward retraces both.
    yield* goBack(shifts, "Back to Claude's guide");
    expect(yield* setupSearch).toBe("?assistant=claude");
    yield* connected("Onboarding assistant", "after Back");
    yield* goBack(shifts, "Back to the assistants");
    yield* browser.use("Back shows the assistants", (page) =>
      page.getByRole("heading", { name: "Connect your assistant", exact: true }).waitFor(),
    );
    expect(yield* setupSearch).toBe("");
    yield* goForward(shifts, "Forward to Claude's guide");
    yield* connected("Onboarding assistant", "after Forward");
    yield* goForward(shifts, "Forward to the first prompt");
    yield* promptShown("Onboarding assistant", "after Forward");
    yield* noLayoutShifts(shifts, "layout-shifts-desktop.json");

    yield* browser.use("Copy the starter prompt", (page) =>
      page.getByRole("button", { name: "Copy starter prompt", exact: true }).click(),
    );
    const prompt = yield* browser.use("Read the copied starter prompt", (page) =>
      page.evaluate(() => navigator.clipboard.readText()),
    );
    if (
      !prompt.includes(endpoint) ||
      !prompt.includes(`${targetHosts(target).edge}/docs/`) ||
      !prompt.includes("help me get my first app set up")
    )
      return yield* new OnboardingFailed({
        operation: "The starter prompt includes MCP, documentation, and first-app setup",
      });
    yield* browser.use("Open the dashboard when ready", (page) =>
      page.getByRole("link", { name: "Open dashboard", exact: false }).click(),
    );
  });
  /**
   * On a phone: reloads return to the same screen and connection check, the server sends the
   * static guide and prompt, and a link to the first prompt never claims a connection. Back
   * restores the guide's scroll position, and no element moves while the page updates by itself.
   */
  const revisitAgentSetup = Effect.gen(function* () {
    const hydrationErrors: string[] = [];
    yield* browser.use("Watch for hydration failures", (page) => {
      page.on("console", (message) => {
        if (message.type() === "error" && hydrationFailure.test(message.text()))
          hydrationErrors.push(message.text());
      });
      return Promise.resolve();
    });
    yield* browser.use("Show the setup on a phone", (page) => page.setViewportSize(phone));
    const first = yield* observeLayoutShifts;
    yield* first.phase("Assistants");
    yield* chooseClaude(first);
    yield* fitsPhone("Claude setup waiting");
    yield* authorizeAssistant("Phone assistant");
    yield* first.phase("Phone assistant connects");
    yield* connected("Phone assistant", "on a phone");
    yield* browser.use("Scroll Next into view", (page) => nextStep(page).scrollIntoViewIfNeeded());
    const scrolled = yield* browser.use("Read the guide's scroll position", (page) =>
      page.evaluate(() => window.scrollY),
    );
    expect(scrolled).toBeGreaterThan(0);
    yield* first.phase("Next: send your first prompt");
    yield* browser.use("Continue to the first prompt", (page) => nextStep(page).click());
    yield* promptShown("Phone assistant", "on a phone");
    expect(
      yield* browser.use("The prompt opens at its top with its heading focused", (page) =>
        page.evaluate(() => ({
          scrollY: window.scrollY,
          focused: document.activeElement?.textContent,
        })),
      ),
    ).toEqual({ scrollY: 0, focused: "Send your first prompt" });
    yield* goBack(first, "Back to Claude's guide");
    yield* connected("Phone assistant", "after Back on a phone");
    yield* browser.use("Back restores the guide's scroll position", (page) =>
      page.waitForFunction((y) => Math.abs(window.scrollY - y) <= 1, scrolled),
    );
    yield* goForward(first, "Forward to the first prompt");
    yield* promptShown("Phone assistant", "after Forward on a phone");
    yield* noLayoutShifts(first, "layout-shifts-phone.json");

    // The prompt's URL names its agent, so the server renders the prompt and confirms the
    // member's grant for it before any script runs, and a reload shows the same screen.
    const promptUrl = yield* browser.use("Read the first prompt's URL", (page) =>
      Promise.resolve(page.url()),
    );
    const promptDocument = yield* serverDocument(promptUrl);
    expect(
      [
        "Send your first prompt",
        `Use Executor, which I connected over MCP at ${endpoint}.`,
        "Approved for Phone assistant",
      ].map((text) => promptDocument.includes(text)),
    ).toEqual([true, true, true]);
    yield* browser.use("Reload the first prompt", (page) => page.reload());
    const reloaded = yield* observeLayoutShifts;
    yield* promptShown("Phone assistant", "after a reload");
    yield* browser.checkpoint("Send your first prompt after a reload on a phone");
    yield* noLayoutShifts(reloaded, "layout-shifts-prompt-reload.json");
    yield* browser.use("Back to Claude's guide after the reload", (page) => page.goBack());
    yield* connected("Phone assistant", "after Back from the reloaded prompt");

    // The guide is in the server's document with its exact MCP URL, and the server read the
    // agents already connected before sending it: the phone assistant is one of them.
    const guideDocument = yield* serverDocument("/create/agent?assistant=claude");
    expect(
      [
        "Add Executor to Claude",
        endpoint,
        "Waiting for Claude to connect…",
        `data-slot="skeleton"`,
      ].map((text) => guideDocument.includes(text)),
    ).toEqual([true, true, true, false]);
    // The entry keeps the baseline it read when the guide was first shown, so a reload still
    // counts the phone assistant as new. Its scripts wait for the whole document, so the guide
    // hydrates with the server's read, which already lists the phone assistant, as on a slow phone.
    yield* Effect.scoped(
      Effect.gen(function* () {
        const scripts = yield* holdQuery(/\.js$/u, "continue", { allRequests: true });
        expect(
          yield* browser.use("Reload Claude's guide and receive its whole document", (page) =>
            page
              .reload({ waitUntil: "commit" })
              .then((response) =>
                response === null ? false : response.finished().then(() => true),
              ),
          ),
        ).toBe(true);
        yield* scripts.requested;
        yield* scripts.release;
      }),
    );
    const guide = yield* observeLayoutShifts;
    yield* connected("Phone assistant", "after reloading the guide");
    expect(yield* setupSearch).toBe("?assistant=claude");
    yield* noLayoutShifts(guide, "layout-shifts-guide-reload.json");

    // A link to the first prompt for an agent the member does not hold never calls it connected.
    // It opens the guide, which reads the agents already connected again.
    const forged = "/create/agent?assistant=claude&step=prompt&agent=not-a-connected-agent";
    expect((yield* serverDocument(forged)).includes("Executor is connected")).toBe(false);
    yield* Effect.scoped(
      Effect.gen(function* () {
        const baseline = yield* holdQuery(agentsPath, "continue");
        yield* browser.use("Open a link to the first prompt for another agent", (page) =>
          page.goto(forged),
        );
        const linked = yield* observeLayoutShifts;
        yield* linked.phase("Link opens the guide");
        yield* browser.use("The link opens Claude's guide in place of the prompt", (page) =>
          page.waitForURL((url) => url.search === "?assistant=claude"),
        );
        yield* baseline.requested;
        yield* guideReady("after following a link to the first prompt");
        expect(
          yield* browser.use("The linked agent is never called connected", (page) =>
            page.getByText("Executor is connected", { exact: true }).count(),
          ),
        ).toBe(0);
        yield* linked.phase("The linked guide's baseline read returns");
        yield* baseline.release;
        expect(yield* nextCheck("A connection check lists the phone assistant")).toContain(
          "Phone assistant",
        );
        yield* stillWaiting("following a link to the first prompt");
        yield* noLayoutShifts(linked, "layout-shifts-prompt-link.json");
      }),
    );
    yield* browser.use("Open a link to the first prompt without an agent", (page) =>
      page.goto("/create/agent?assistant=claude&step=prompt"),
    );
    yield* browser.use("A link without an agent shows Claude's guide", (page) =>
      page.getByRole("heading", { name: "Add Executor to Claude", exact: true }).waitFor(),
    );
    expect(
      yield* browser.use("A link without an agent shows no prompt", (page) =>
        page.getByRole("button", { name: "Copy starter prompt", exact: true }).count(),
      ),
    ).toBe(0);
    yield* browser.use("Open a link with an unknown assistant", (page) =>
      page.goto("/create/agent?assistant=unknown&step=prompt"),
    );
    yield* browser.use("Unknown setup links show the assistants", (page) =>
      page.getByRole("group", { name: "Choose your assistant", exact: true }).waitFor(),
    );
    expect(hydrationErrors).toEqual([]);
    yield* browser.use("Return to the desktop layout", (page) => page.setViewportSize(desktop));
    yield* browser.use("Skip agent setup for now", (page) =>
      page.getByRole("link", { name: "Skip for now", exact: true }).click(),
    );
  });
  return {
    chooseSocial,
    organizations,
    emailSignIn,
    freshEmail: Effect.sync(() => `onboarding-${randomUUID()}@example.test`),
    socialSignIn: (provider: "google" | "github") =>
      Effect.gen(function* () {
        const identity = yield* evidence.step(
          `Seed a fresh ${provider} identity through emulators.dev`,
          emulators.identity(provider),
        );
        yield* openLogin;
        const memberships = yield* holdOrganizationEntry;
        yield* chooseSocial(provider);
        const document = yield* browser.use(
          `Choose the identity on the ${provider} emulator`,
          (page) =>
            Promise.all([
              // The Worker resolves sign-in and opens team setup directly, rendered on the server.
              page.waitForResponse((response) => {
                const url = new URL(response.url());
                return (
                  response.request().isNavigationRequest() &&
                  url.origin === targetHosts(target).browser &&
                  url.pathname === "/create"
                );
              }),
              page.getByRole("button").filter({ hasText: identity.email }).click(),
            ]).then(([response]) =>
              response.text().then((html) => ({
                status: response.status(),
                prepared: html.includes("Create your team") && html.includes("cloud:entry-team:"),
                private: response.headers()["cache-control"]?.includes("no-store") === true,
              })),
            ),
        );
        if (document.status !== 200)
          return yield* new OnboardingFailed({ operation: "Sign-in document did not load" });
        yield* evidence.json("entry-document-check.json", document);
        if (!document.prepared || !document.private)
          return yield* new OnboardingFailed({
            operation: "Sign-in document must contain private server-prepared team setup",
          });
        yield* browser.use("Team form renders without a browser membership read", (page) =>
          page
            .getByRole("heading", { name: "Create your team", exact: true })
            .waitFor({ state: "visible" }),
        );
        yield* memberships.release;
        yield* browser.use("Complete the OAuth callback into Cloud", (page) =>
          page.waitForURL(
            (url) => url.origin === targetHosts(target).browser && url.pathname !== "/login",
          ),
        );
        yield* evidence.json("identity-provider.json", {
          provider,
          emulated: true,
          sessionInjected: false,
        });
        return identity;
      }),
    /** Sign in with Google as an address that already has an Executor account. */
    googleSignInAs: (user: {
      readonly email: string;
      readonly name: string;
      readonly picture: string;
    }) =>
      Effect.gen(function* () {
        yield* evidence.step(
          "Seed a Google profile for the existing email through emulators.dev",
          emulators.googleUser(user),
        );
        yield* openLogin;
        yield* chooseSocial("google");
        yield* browser.use("Choose the identity on the google emulator", (page) =>
          page.getByRole("button").filter({ hasText: user.email }).click(),
        );
      }),
    delayPreparation: Effect.gen(function* () {
      const arrived = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>(),
        completed = yield* Deferred.make<void, OnboardingFailed>();
      let started = false;
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(release, undefined).pipe(
          Effect.andThen(() =>
            started ? Deferred.await(completed).pipe(Effect.ignore) : Effect.void,
          ),
        ),
      );
      yield* browser.use("Hold one team preparation request at the network boundary", (page) =>
        page.route(
          "**/api/onboarding/prepare",
          (route) =>
            // oxlint-disable-next-line executor/no-manual-effect-runtime-in-tests -- Playwright route handlers must return a Promise
            Effect.runPromise(
              Effect.gen(function* () {
                started = true;
                yield* Deferred.succeed(arrived, undefined);
                yield* Deferred.await(release).pipe(Effect.timeout("60 seconds"));
                yield* driver("Send the original preparation request", () => route.continue());
              }).pipe(
                Effect.matchEffect({
                  onFailure: () =>
                    Deferred.fail(
                      completed,
                      new OnboardingFailed({
                        operation: "Continue the delayed preparation request",
                      }),
                    ),
                  onSuccess: () => Deferred.succeed(completed, undefined),
                }),
              ),
            ),
          { times: 1 },
        ),
      );
      return {
        wasRequested: Effect.sync(() => started),
        show: Effect.gen(function* () {
          yield* browser.use("The server prepared the form before its first render", (page) =>
            page.getByLabel("Team name", { exact: true }).waitFor({ state: "visible" }),
          );
          if (started)
            return yield* new OnboardingFailed({
              operation: "Setup repeated preparation in the browser",
            });
          const spinners = yield* browser.use(
            "No intermediate sign-in or preparation view is mounted",
            (page) => page.locator('.auth-pending, [aria-label="Preparing your team"]').count(),
          );
          if (spinners !== 0)
            return yield* new OnboardingFailed({
              operation: "Unexpected intermediate setup loading view",
            });
          yield* browser.checkpoint("Team form ready on first entry");
          yield* evidence.json("preparation-delay.json", {
            browserPreparationRequested: started,
            serverPrepared: true,
            responseReplaced: false,
          });
          yield* Deferred.succeed(release, undefined);
          if (started) yield* Deferred.await(completed);
        }),
        release: Deferred.succeed(release, undefined),
      };
    }),
    prepareTeam: Effect.gen(function* () {
      yield* browser.use("Team details are ready to review", (page) =>
        page.getByLabel("Team name", { exact: true }).waitFor({ state: "visible" }),
      );
      const entry = yield* browser.use("Setup stays outside the dashboard", (page) =>
        page
          .locator(".shell")
          .count()
          .then((shells) => ({ pathname: new URL(page.url()).pathname, shells })),
      );
      if (entry.pathname !== "/create" || entry.shells !== 0)
        return yield* new OnboardingFailed({
          operation: "Expected shell-free team confirmation at /create",
        });
      const suggested = yield* browser.use("Read the suggested team name", (page) =>
        page.getByLabel("Team name", { exact: true }).inputValue(),
      );
      if (!suggested.trim())
        return yield* new OnboardingFailed({ operation: "Missing team suggestion" });
      const name = `Onboarding ${randomUUID().slice(0, 8)}`;
      yield* browser.use("Edit the suggested team name", (page) =>
        page.getByLabel("Team name", { exact: true }).fill(name),
      );
      yield* browser.checkpoint("Review team details before creation");
      return name;
    }),
    suggestedTeamName: browser.use("Read the company suggestion from the real response", (page) =>
      page.getByLabel("Team name", { exact: true }).inputValue(),
    ),
    failConfirmationOnce: browser.use(
      "Interrupt one confirmation request before sending it",
      (page) =>
        page.route("**/api/onboarding/create", (route) => route.abort("failed"), { times: 1 }),
    ),
    /**
     * Create the team, then leave agent setup: `connect` completes the full assistant journey with
     * a real MCP OAuth authorization; `revisit` connects one on a phone and returns to setup through
     * history, reloads and links; `skip` goes straight to the dashboard.
     */
    confirmTeam: (name: string, agent: "connect" | "revisit" | "skip" = "skip") =>
      Effect.gen(function* () {
        yield* browser.use("Confirm team creation", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Team creation opens agent setup", (page) =>
          page.waitForURL(`${targetHosts(target).browser}/create/agent`),
        );
        const teams = yield* organizations;
        if (teams.length !== 1 || teams[0]?.name !== name)
          return yield* new OnboardingFailed({
            operation: "Confirmation must create exactly the chosen team",
          });
        yield* browser.use("The MCP handoff offers the assistants", (page) =>
          page.getByRole("heading", { name: "Connect your assistant", exact: true }).waitFor(),
        );
        yield* browser.checkpoint("Connect your assistant after team creation");
        yield* browser.use("Reload the MCP handoff", (page) => page.reload());
        yield* browser.use("Reload keeps the assistant choices open", (page) =>
          page.getByRole("group", { name: "Choose your assistant", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("The starter prompt waits for a connection", (page) =>
            page.getByRole("button", { name: "Copy starter prompt", exact: true }).count(),
          ),
        ).toBe(0);
        if (agent === "connect") yield* connectFirstAgent;
        else if (agent === "revisit") yield* revisitAgentSetup;
        else
          yield* browser.use("Skip agent setup for now", (page) =>
            page.getByRole("link", { name: "Skip for now", exact: true }).click(),
          );
        const team = teams[0];
        yield* browser.use("The new team opens Apps", (page) =>
          page.waitForURL(`${targetHosts(target).browser}/org/${team.slug}/apps`),
        );
        yield* browser.use("The confirmed team stays open", (page) =>
          page
            .getByRole("link", { name: "Add app", exact: true })
            .first()
            .waitFor({ state: "visible" }),
        );
        yield* browser.checkpoint("Team opens without a setup screen");
        yield* browser.use("The background Executor app appears without a reload", (page) =>
          page
            .getByRole("link", { name: "Open Executor", exact: true })
            .waitFor({ state: "visible", timeout: 90000 }),
        );
        yield* browser.checkpoint("Executor appears after background provisioning");
        yield* browser.use("Reload the provisioned team", (page) => page.reload());
        yield* browser.use("The installed app remains available", (page) =>
          page.getByRole("link", { name: "Open Executor", exact: true }).waitFor(),
        );
        yield* evidence.json("created-team.json", teams[0]);
        return teams[0];
      }),
    signOut: Effect.gen(function* () {
      yield* browser.use("Open the account menu", (page) =>
        page.getByRole("button", { name: /^Account: / }).click(),
      );
      yield* browser.use("Sign out of Cloud", (page) =>
        page.getByRole("menuitem", { name: "Sign out", exact: true }).click(),
      );
      // Cloud's browser origin opens sign-in for a signed-out visitor; elsewhere the public entry.
      const entry = target.metadata.target === "cloud" ? "/login" : "/";
      yield* browser.use("Return to the public entry", (page) =>
        page.waitForURL(
          (url) => url.origin === targetHosts(target).browser && url.pathname === entry,
        ),
      );
    }),
    passkey: Effect.gen(function* () {
      const session = yield* browser.use("Enable the browser's virtual authenticator", (page) =>
        page.context().newCDPSession(page),
      );
      yield* driver("Enable WebAuthn", () => session.send("WebAuthn.enable"));
      const authenticator = yield* driver("Create a virtual platform authenticator", () =>
        session.send("WebAuthn.addVirtualAuthenticator", {
          options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
          },
        }),
      ).pipe(
        Effect.flatMap(
          Schema.decodeUnknownEffect(Schema.Struct({ authenticatorId: Schema.String })),
        ),
      );
      yield* Effect.addFinalizer(() =>
        driver("Close virtual authenticator", () => session.detach()).pipe(Effect.orDie),
      );
      yield* evidence.json("authenticator.json", {
        kind: "browser-virtual-platform",
        realWebAuthn: true,
        nativePasswordManagerDialog: false,
      });
      return {
        register: Effect.gen(function* () {
          yield* browser.use("Cloud offers passkey enrollment to the new email user", (page) =>
            page
              .getByRole("heading", { name: "Create a passkey", exact: true })
              .waitFor({ state: "visible" }),
          );
          yield* browser.checkpoint("Email sign-in offers a passkey");
          yield* browser.use("Create a passkey through WebAuthn", (page) =>
            page.getByRole("button", { name: "Create a passkey", exact: true }).click(),
          );
          yield* browser.use("Passkey enrollment finishes", (page) =>
            page.waitForURL(
              (url) => url.origin === targetHosts(target).browser && url.pathname === "/create",
              { waitUntil: "domcontentloaded" },
            ),
          );
          const result = yield* driver("Read virtual authenticator registrations", () =>
            session.send("WebAuthn.getCredentials", {
              authenticatorId: authenticator.authenticatorId,
            }),
          ).pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Struct({
                  credentials: Schema.Array(Schema.Struct({ credentialId: Schema.String })),
                }),
              ),
            ),
          );
          if (result.credentials.length !== 1)
            return yield* new OnboardingFailed({ operation: "Expected one registered passkey" });
        }),
        signIn: Effect.gen(function* () {
          yield* openLogin;
          yield* browser.use("Sign in using the saved passkey", (page) =>
            page.getByRole("button", { name: "Sign in with a passkey", exact: true }).click(),
          );
          yield* browser.use("Passkey returns to the existing team", (page) =>
            page.waitForURL(
              (url) =>
                url.origin === targetHosts(target).browser &&
                /^\/org\/[^/]+\/apps$/.test(url.pathname),
            ),
          );
          yield* browser.checkpoint("Returning sign-in with the saved passkey");
        }),
      };
    }),
  };
});
/** End-to-end onboarding through browser and external emulators, with real product sessions. */
export class Onboarding extends Context.Service<Onboarding, Effect.Success<typeof make>>()(
  "e2e/Onboarding",
) {
  static readonly layer = Layer.effect(Onboarding, make).pipe(Layer.provide(Emulators.layer));
}
