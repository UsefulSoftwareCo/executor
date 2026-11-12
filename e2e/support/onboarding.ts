import { Context, Deferred, Effect, Layer, Option, Redacted, Schema } from "effect";
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
import { appsManifest } from "./apps-release.ts";
import { connectionsPath } from "./app-accounts.ts";
import { nameConnectedAccount } from "./name-account.ts";
import type { OnboardingOrder } from "./onboarding-experiment.ts";

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
  const script = (url: URL) => url.pathname.endsWith(".js");
  const phone = { width: 390, height: 844 },
    desktop = { width: 1440, height: 960 };
  /** A small phone, where Claude's guide is taller than the screen. */
  const smallPhone = { width: 375, height: 667 };
  /**
   * A step's one forward button, by the label it shows: "Skip for now" until the step is done, then
   * its primary label. The label it hides keeps its width, so only the shown one names it.
   */
  const forward = (page: Page, name: string) => page.getByRole("link", { name, exact: true });
  const skipStep = (page: Page) => forward(page, "Skip for now");
  const nextStep = (page: Page) => forward(page, "Next: first prompt");
  /** Where the forward button sits; it keeps this box when its label changes. */
  const forwardBox = (label: string, button: (page: Page) => Locator) =>
    browser.use(`Measure ${label}`, (page) =>
      button(page)
        .boundingBox()
        .then((box) => box && { x: box.x, width: box.width, height: box.height }),
    );
  /** The forward button offers only to skip, as a quiet button, while nothing is connected. */
  const offersSkip = (reason: string) =>
    Effect.gen(function* () {
      expect(
        yield* browser.use(`Only Skip for now is offered ${reason}`, (page) =>
          Promise.all([
            skipStep(page).isVisible(),
            skipStep(page).getAttribute("data-variant"),
            nextStep(page).count(),
          ]),
        ),
      ).toEqual([true, "secondary", 0]);
    });
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
  const fitsPhone = (name: string, section = "agent-setup-title") =>
    Effect.gen(function* () {
      const fits = yield* browser.use("The setup fits a phone screen", (page) =>
        page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      );
      if (!fits) return yield* new OnboardingFailed({ operation: `${name} fits a phone screen` });
      const clear = yield* browser.use("Session controls do not cover the setup", (page) =>
        Promise.all([
          page.locator(`section[aria-labelledby='${section}']`).boundingBox(),
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
   * any of it, and the forward button offers to skip until Claude connects.
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
              .locator("[aria-label='Claude setup']")
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
      yield* offersSkip(reason);
    });
  /**
   * The page as the server sends it, before any script runs, without the empty comments React
   * places between adjacent pieces of text or the line-break opportunities inside a URL.
   */
  const serverDocument = (path: string) =>
    browser.use(`Read the server's document for ${path}`, (page) =>
      page.request
        .get(path)
        .then((response) => response.text())
        .then((html) => html.replaceAll("<!-- -->", "").replaceAll("<wbr/>", "")),
    );
  /**
   * Choose Claude while the agents already connected are held. The guide is shown and usable at
   * once; the baseline read only decides when the connection check starts.
   */
  const chooseClaude = (shifts: Shifts) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* allowClipboard;
        const baseline = yield* holdQuery(agentsPath, "continue");
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
  /**
   * The next successful connection check that lists every agent in `listing`, read as the page
   * received it. A check the page sent before an agent connected does not list it yet, and one the
   * page cancelled before its body arrived was never received.
   */
  const nextCheck = (label: string, listing: ReadonlyArray<string> = []) =>
    browser
      .use(label, (page) =>
        page
          .waitForResponse(
            (response) =>
              agentsRead(new URL(response.url())) &&
              response.request().method() === "GET" &&
              response.status() === 200 &&
              response.json().then(
                (body) =>
                  Option.exists(Schema.decodeUnknownOption(ListedAgents)(body), (agents) =>
                    listing.every((name) => agents.some((agent) => agent.name === name)),
                  ),
                () => false,
              ),
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
        yield* browser.use(`Nothing is called connected: ${reason}`, (page) =>
          page.getByText("Executor is connected", { exact: true }).count(),
        ),
      ).toBe(0);
      yield* offersSkip(`while waiting: ${reason}`);
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
        yield* browser.use(`Next replaces Skip for now ${reason}`, (page) =>
          Promise.all([
            nextStep(page).isVisible(),
            nextStep(page).getAttribute("data-variant"),
            skipStep(page).count(),
          ]),
        ),
      ).toEqual([true, "default", 0]);
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
   * The assistants also offer the MCP URL for any client, and notice one that connects by it.
   * Choosing an assistant replaces the choices with its guide at once, while the agents already
   * connected are read. A guide calls connected only an assistant that connects over MCP after
   * that read; one connected earlier or an Executor API client does not count. Each chosen screen
   * is a history entry, and no element moves while the page updates by itself.
   */
  const connectFirstAgent = Effect.gen(function* () {
    yield* allowClipboard;
    const shifts = yield* observeLayoutShifts;
    yield* shifts.phase("Assistants");
    expect(
      yield* browser.use("The assistants offer the MCP URL for any client", (page) =>
        Promise.all([
          page.getByRole("heading", { name: "Add the MCP server", exact: true }).isVisible(),
          page.getByText(endpoint, { exact: true }).isVisible(),
        ]),
      ),
    ).toEqual([true, true]);
    yield* browser.use("Copy the MCP URL from the assistants", (page) =>
      page.getByRole("button", { name: "Copy MCP URL", exact: true }).click(),
    );
    expect(
      yield* browser.use("Read the MCP URL copied from the assistants", (page) =>
        page.evaluate(() => navigator.clipboard.readText()),
      ),
    ).toBe(endpoint);
    yield* browser.use("The assistants wait for any client to connect", (page) =>
      page.getByText("Waiting for your assistant to connect…", { exact: true }).waitFor(),
    );
    yield* offersSkip("on the assistants before a connection");
    const skipOnAssistants = yield* forwardBox("Skip for now on the assistants", skipStep);
    yield* shifts.phase("Any MCP client connects");
    yield* authorizeAssistant("Earlier agent");
    yield* connected("Earlier agent", "on the assistants");
    expect(yield* forwardBox("Next on the assistants", nextStep)).toEqual(skipOnAssistants);
    yield* browser.checkpoint("Any MCP client connected from the assistants");
    yield* onPhone("Any MCP client connected from the assistants", shifts, nextStep);
    yield* chooseClaude(shifts);
    // The earlier agent connected before the guide read its baseline, and an Executor HTTP API
    // client authorized now is a new grant but not an assistant connection. A later check that
    // lists both must not call Claude connected.
    yield* shifts.phase("An API client connects");
    yield* authorizeAssistant("Executor API client", "api");
    yield* nextCheck("A connection check lists the earlier agent and the API client", [
      "Earlier agent",
      "Executor API client",
    ]);
    yield* stillWaiting("the earlier agent and an API client");
    yield* browser.checkpoint("Claude setup waiting for its connection");
    yield* onPhone("Claude setup waiting for its connection", shifts, skipStep);

    yield* shifts.phase("All assistants");
    yield* browser.use("Go back to the assistants", (page) =>
      page.getByRole("link", { name: "Different assistant", exact: true }).click(),
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
    yield* offersSkip("on Claude's guide before it connects");
    const skipOnGuide = yield* forwardBox("Skip for now on Claude's guide", skipStep);

    // The assistant connects while checks fail: a failed check never calls it connected, and
    // retrying keeps this attempt's baseline.
    yield* shifts.phase("Connection checks fail");
    yield* browser.use("Fail the connection checks", (page) =>
      page.route(agentsRead, (route) => route.abort("failed")),
    );
    yield* authorizeAssistant("Onboarding assistant");
    yield* browser.use("A failed check is reported", (page) =>
      page.getByText("Couldn’t check the connection", { exact: true }).waitFor(),
    );
    expect(
      yield* browser.use("A failed check never calls the assistant connected", (page) =>
        page.getByText("Executor is connected", { exact: true }).count(),
      ),
    ).toBe(0);
    yield* browser.checkpoint("A failed connection check offers a retry");
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
    // The button changes its label and style in place, beside the back button.
    expect(yield* forwardBox("Next on Claude's guide", nextStep)).toEqual(skipOnGuide);
    yield* browser.use("Let the page finish its transitions", (page) =>
      page.evaluate(() =>
        Promise.all(document.getAnimations().map((animation) => animation.finished)).then(
          () => undefined,
        ),
      ),
    );
    yield* browser.checkpoint("Claude connected with Next");
    yield* onPhone("Claude connected with Next", shifts, nextStep);

    yield* shifts.phase("Next: first prompt");
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
  const revisitAgentSetup = (setup: string) =>
    Effect.gen(function* () {
      const hydrationErrors: string[] = [];
      yield* browser.use("Watch for hydration failures", (page) => {
        page.on("console", (message) => {
          if (message.type() === "error" && hydrationFailure.test(message.text()))
            hydrationErrors.push(message.text());
        });
        return Promise.resolve();
      });
      const first = yield* observeLayoutShifts;
      yield* first.resize(smallPhone, "Assistants");
      yield* chooseClaude(first);
      yield* fitsPhone("Claude setup waiting");
      yield* authorizeAssistant("Phone assistant");
      yield* first.phase("Phone assistant connects");
      yield* connected("Phone assistant", "on a phone");
      // Next stays on the action bar, so scroll to the end of the guide, past its status.
      yield* browser.use("Scroll to the end of the guide", (page) =>
        page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight)),
      );
      const scrolled = yield* browser.use("Read the guide's scroll position", (page) =>
        page.evaluate(() => window.scrollY),
      );
      expect(scrolled).toBeGreaterThan(0);
      yield* first.phase("Next: first prompt");
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
      const guideDocument = yield* serverDocument(`${setup}?assistant=claude`);
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
      // The step lets them go itself: every step ends by waiting for the page to respond to input,
      // which it cannot do while its scripts are held.
      expect(
        yield* browser.use(
          "Reload Claude's guide; its scripts wait for its whole document",
          (page) => {
            let held = 0;
            const received = page.waitForEvent(
              "requestfinished",
              (request) => request.isNavigationRequest() && request.frame() === page.mainFrame(),
            );
            return page
              .route(script, (route) => {
                held += 1;
                return received.then(
                  () => route.fallback(),
                  () => route.fallback(),
                );
              })
              .then(() => Promise.all([received, page.reload()]))
              .finally(() => page.unroute(script))
              .then(() => held);
          },
        ),
      ).toBeGreaterThan(0);
      const guide = yield* observeLayoutShifts;
      yield* connected("Phone assistant", "after reloading the guide");
      expect(yield* setupSearch).toBe("?assistant=claude");
      yield* noLayoutShifts(guide, "layout-shifts-guide-reload.json");

      // A link to the first prompt for an agent the member does not hold never calls it connected.
      // It opens the guide, which reads the agents already connected again.
      const forged = `${setup}?assistant=claude&step=prompt&agent=not-a-connected-agent`;
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
      // A first prompt needs a connected agent, so a link to one without an agent opens the guide,
      // which offers to skip until Claude connects.
      yield* browser.use("Open a link to the first prompt without an agent", (page) =>
        page.goto(`${setup}?assistant=claude&step=prompt`),
      );
      yield* browser.use("A link without an agent shows Claude's guide", (page) =>
        page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
      );
      expect(
        yield* browser.use("A link without an agent shows no prompt", (page) =>
          page.getByRole("button", { name: "Copy starter prompt", exact: true }).count(),
        ),
      ).toBe(0);
      yield* offersSkip("on a phone");
      // On a phone the button fills the row beside the back button's icon.
      expect(
        yield* browser.use("Skip for now fills the row on a phone", (page) =>
          Promise.all([
            page.getByRole("link", { name: "Different assistant", exact: true }).boundingBox(),
            skipStep(page).boundingBox(),
            page.evaluate(() => document.documentElement.clientWidth),
          ]).then(([back, skip, width]) =>
            back && skip
              ? { gap: skip.x - (back.x + back.width), right: width - (skip.x + skip.width) }
              : undefined,
          ),
        ),
      ).toEqual({ gap: 8, right: 24 });
      const skipOnPhone = yield* forwardBox("Skip for now on a phone", skipStep);
      yield* browser.checkpoint("Claude setup waiting with Skip for now on a phone");
      yield* authorizeAssistant("Late assistant");
      yield* connected("Late assistant", "after a link without an agent");
      expect(yield* forwardBox("Next on a phone", nextStep)).toEqual(skipOnPhone);
      yield* browser.checkpoint("Claude connected with Next on a phone");
      yield* browser.use("Open a link with an unknown assistant", (page) =>
        page.goto(`${setup}?assistant=unknown&step=prompt`),
      );
      yield* browser.use("Unknown setup links show the assistants", (page) =>
        page.getByRole("group", { name: "Choose your assistant", exact: true }).waitFor(),
      );
      expect(hydrationErrors).toEqual([]);
      // Skipping from a guide that still waits leaves setup, as from the assistants.
      yield* browser.use("Return to the desktop layout", (page) => page.setViewportSize(desktop));
      yield* browser.use("Open Claude's guide again", (page) =>
        page.goto(`${setup}?assistant=claude`),
      );
      yield* browser.use("The guide waits for Claude", (page) =>
        page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
      );
      yield* offersSkip("on a guide opened again");
      yield* browser.use("Skip agent setup from the guide", (page) => skipStep(page).click());
    });
  const SessionUser = Schema.Struct({ user: Schema.Struct({ id: Schema.String }) });
  const sessionUserId = browser
    .use("Read the signed-in user", (page) =>
      page.evaluate(() =>
        fetch("/api/auth/get-session").then((response) => {
          if (response.status !== 200) throw new Error(`Session returned HTTP ${response.status}`);
          return response.json();
        }),
      ),
    )
    .pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(SessionUser)),
      Effect.map((session) => session.user.id),
    );
  /** A same-origin POST as the signed-in member, as the dashboard sends it. */
  const memberPost = (label: string, path: string, data: unknown) =>
    browser
      .use(label, (page) =>
        page.evaluate(
          ({ path, data }) =>
            fetch(path, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(data),
            }).then((response) => {
              if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
              return response.json();
            }),
          { path, data },
        ),
      )
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.String }))));
  /**
   * Deploy an app that takes a pasted key and connect one account to it, as the member, through
   * the hosted API. Managed Cloud lists no catalog apps, so its account step has none to connect.
   */
  const connectTracker = (organization: string) =>
    Effect.gen(function* () {
      const prefix = `/api/organizations/${organization}`;
      const app = yield* memberPost("Deploy an app that takes a key", `${prefix}/apps/deploy`, {
        name: "Onboarding tracker",
        files: [
          {
            path: "index.ts",
            content: `
import { defineApp, defineProvider, object, router, secrets, string } from "apps";
const service = defineProvider({ name: "Onboarding tracker", auth: {
  key: secrets({ label: "API key", fields: object({ token: string() }) })
} });
export default defineApp({ user: { accounts: { service } } }, async () => ({ tools: router({}) }));
`,
          },
          appsManifest,
        ],
      });
      const connection = yield* memberPost(
        "Start the tracker connection",
        connectionsPath(`${prefix}/apps/${app.id}`, "user", "service"),
        {},
      );
      yield* memberPost("Save the tracker key", `${prefix}/connections/${connection.id}/submit`, {
        method: "key",
        label: "Work key",
        fields: { token: "synthetic-onboarding-token" },
      });
    });
  /** The current setup screen at the desktop and phone sizes, then back to desktop. */
  const bothSizes = (name: string) =>
    Effect.gen(function* () {
      yield* browser.use("Use the desktop layout", (page) => page.setViewportSize(desktop));
      yield* browser.checkpoint(`${name} 1440x960`);
      yield* browser.use("Use a phone layout", (page) => page.setViewportSize(phone));
      yield* browser.checkpoint(`${name} 390x844`);
      yield* browser.use("Return to the desktop layout", (page) => page.setViewportSize(desktop));
    });
  const heading = (name: string) =>
    browser.use(`${name} is shown`, (page) =>
      page.getByRole("heading", { name, exact: true }).waitFor(),
    );
  const setupPath = browser.use("Read the setup path", (page) =>
    Promise.resolve(new URL(page.url()).pathname + new URL(page.url()).search),
  );
  /** The forward button reads `label` as the primary action, and no longer offers to skip. */
  const primaryForward = (label: string, reason: string) =>
    Effect.gen(function* () {
      expect(
        yield* browser.use(`${label} replaces Skip for now ${reason}`, (page) =>
          Promise.all([
            forward(page, label).isVisible(),
            forward(page, label).getAttribute("data-variant"),
            skipStep(page).count(),
          ]),
        ),
      ).toEqual([true, "default", 0]);
    });
  /** Choose Claude; its guide waits for it and offers to skip meanwhile. */
  const chooseWaitingClaude = Effect.gen(function* () {
    yield* browser.use("Choose Claude", (page) =>
      page.getByRole("button", { name: "Claude", exact: true }).click(),
    );
    yield* browser.use("Setup waits for Claude", (page) =>
      page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
    );
    yield* offersSkip("while Claude's guide waits");
  });
  /**
   * Connect Claude over MCP OAuth from its waiting guide, wait for the guide to call it connected,
   * and follow the forward button, which now reads `next`.
   */
  const connectClaude = (next: string) =>
    Effect.gen(function* () {
      yield* authorizeAssistant("Onboarding assistant");
      yield* browser.use("Claude is connected", (page) =>
        approvedFor(page, "Onboarding assistant").waitFor(),
      );
      yield* primaryForward(next, "once Claude connects");
      yield* browser.use(`Continue with ${next}`, (page) => forward(page, next).click());
    });
  /** The first prompt for the connected agent, naming the account connected over the API. */
  const firstPromptNamesTracker = (reason: string) =>
    Effect.gen(function* () {
      yield* promptShown("Onboarding assistant", reason);
      expect(
        yield* browser.use(`The first prompt names the tracker account ${reason}`, (page) =>
          page.getByText(/I've connected Onboarding tracker \(Work key\)\./u).count(),
        ),
      ).toBe(1);
    });
  /**
   * A required step's forward button: disabled, reading only `hint`, which names what to do. Its
   * primary `label` is not shown yet, and there is no way to skip, not even behind another control.
   */
  const waitsFor = (label: string, hint: string, reason: string) =>
    Effect.gen(function* () {
      // Counted rather than awaited, so a skippable step fails here with what it shows instead.
      expect(
        yield* browser.use(`${hint} waits, disabled, ${reason}`, (page) => {
          const button = page.getByRole("button", { name: hint, exact: true });
          return Promise.all([
            page.getByText("Skip for now", { exact: true }).filter({ visible: true }).count(),
            page.getByText(label, { exact: true }).filter({ visible: true }).count(),
            page.getByText(hint, { exact: true }).filter({ visible: true }).count(),
            button.count(),
          ]).then(([skip, labels, hints, buttons]) =>
            buttons === 1
              ? button.isDisabled().then((disabled) => ({ skip, labels, hints, buttons, disabled }))
              : { skip, labels, hints, buttons, disabled: null as boolean | null },
          );
        }),
      ).toEqual({ skip: 0, labels: 0, hints: 1, buttons: 1, disabled: true });
    });
  /** Once done, the button is the primary link reading `label`, and its hint is hidden in place. */
  const opensWith = (label: string, hint: string, reason: string) =>
    Effect.gen(function* () {
      yield* browser.use(`${label} opens ${reason}`, (page) =>
        page.getByRole("link", { name: label, exact: true }).waitFor(),
      );
      expect(
        yield* browser.use(`${label} is the primary action ${reason}`, (page) =>
          Promise.all([
            page.getByRole("link", { name: label, exact: true }).getAttribute("data-variant"),
            page.getByText(hint, { exact: true }).isVisible(),
            page.getByRole("button", { name: hint, exact: true }).count(),
            page.getByText("Skip for now", { exact: true }).filter({ visible: true }).count(),
          ]),
        ),
      ).toEqual(["default", false, 0, 0]);
    });
  /** Where the forward control sits, whichever element it is and whichever label it shows. */
  const forwardControlBox = (label: string) =>
    browser.use(`Measure ${label}`, (page) =>
      page
        .getByRole("button", { name: label, exact: true })
        .or(page.getByRole("link", { name: label, exact: true }))
        .boundingBox()
        .then((box) => box && { x: box.x, y: box.y, width: box.width, height: box.height }),
    );
  /**
   * The team's Apps sends this member to `step` instead. The server answers the address with a
   * redirect before any HTML, so no dashboard is ever rendered; the browser lands on the step.
   */
  const appsSendsTo = (slug: string, step: RegExp, reason: string) =>
    Effect.gen(function* () {
      const apps = `/org/${slug}/apps`;
      const answer = yield* browser.use(`Request the team's Apps ${reason}`, (page) =>
        page.request.get(apps, { maxRedirects: 0 }).then((response) => ({
          status: response.status(),
          location: response.headers().location ?? "",
        })),
      );
      expect(answer.status).toBe(307);
      expect(new URL(answer.location, targetHosts(target).browser).pathname).toMatch(step);
      yield* browser.use(`Open the team's Apps ${reason}`, (page) => page.goto(apps));
      yield* browser.use(`Apps returns to setup ${reason}`, (page) =>
        page.waitForURL((url) => step.test(url.pathname)),
      );
      expect(
        yield* browser.use(`No dashboard shell is shown ${reason}`, (page) =>
          page.locator(".shell").count(),
        ),
      ).toBe(0);
      return (yield* setupPath) as string;
    });
  /**
   * Leaving setup for account settings in the session menu, then following its way back to the
   * team, returns to `step` within the page. The router asks before showing the dashboard, so the
   * account page stays until the step replaces it: no dashboard page or frame appears, and the
   * Apps address, which the router enters as it starts, is replaced rather than kept in history.
   */
  const accountSettingsReturnTo = (name: string, step: RegExp) =>
    Effect.gen(function* () {
      yield* browser.use("Open the session menu on setup", (page) =>
        page.getByRole("button", { name: /^Account: / }).click(),
      );
      yield* browser.use("Open account settings", (page) =>
        page.getByRole("menuitem", { name: "Account settings", exact: true }).click(),
      );
      yield* browser.use("Account settings open", (page) =>
        page.waitForURL((url) => url.pathname === "/account/profile"),
      );
      yield* browser.use("Watch for the dashboard on the way back", (page) =>
        page.evaluate(() => {
          const flagged = () => {
            if (
              document.querySelector("h1")?.textContent?.trim() === "Apps" ||
              document.querySelector("a[href$='/approvals']") !== null
            )
              document.documentElement.dataset.dashboardShown = "true";
          };
          new MutationObserver(flagged).observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
          });
          document.documentElement.dataset.sameDocument = "true";
        }),
      );
      yield* browser.use(`Follow the way back to ${name}`, (page) =>
        page.getByRole("link", { name: `Back to ${name}`, exact: true }).click(),
      );
      yield* browser.use("The way back returns to setup", (page) =>
        page.waitForURL((url) => step.test(url.pathname)),
      );
      expect(
        yield* browser.use("The dashboard never showed on the way back", (page) =>
          page.evaluate(() => ({
            sameDocument: document.documentElement.dataset.sameDocument === "true",
            dashboardShown: document.documentElement.dataset.dashboardShown === "true",
          })),
        ),
      ).toEqual({ sameDocument: true, dashboardShown: false });
      yield* browser.use("Back from setup", (page) => page.goBack());
      yield* browser.use("Back returns to account settings, not Apps", (page) =>
        page.waitForURL((url) => url.pathname === "/account/profile"),
      );
      yield* browser.use("Forward to setup again", (page) => page.goForward());
      yield* browser.use("Forward returns to setup", (page) =>
        page.waitForURL((url) => step.test(url.pathname)),
      );
    });
  /** The required step at the desktop and phone sizes: it fits a phone with its hint shown. */
  const atBothSizes = (name: string, section: string) =>
    Effect.gen(function* () {
      yield* browser.use("Use the desktop layout", (page) => page.setViewportSize(desktop));
      yield* browser.checkpoint(`${name} 1440x960`);
      yield* browser.use("Use a phone layout", (page) => page.setViewportSize(phone));
      yield* fitsPhone(name, section);
      yield* browser.checkpoint(`${name} 390x844`);
      yield* browser.use("Return to the desktop layout", (page) => page.setViewportSize(desktop));
    });
  /** Connect one Synthetic Mail account from the account step's catalog and name it. */
  const connectMail = (label: string) =>
    Effect.gen(function* () {
      yield* browser.use("The catalog has loaded", (page) =>
        page.locator("[aria-label='Loading apps']").waitFor({ state: "detached" }),
      );
      yield* browser.use("Connect Synthetic Mail", (page) =>
        page
          .getByRole("group", { name: "Synthetic Mail", exact: true })
          .getByRole("button", { name: "Connect" })
          .click(),
      );
      yield* browser.use("The app's connection form opens", (page) =>
        page.getByRole("dialog", { name: "Connect Synthetic Mail" }).waitFor(),
      );
      yield* browser.use("Save and name the account", (page) =>
        page
          .getByRole("dialog")
          .getByRole("textbox")
          .first()
          .fill("synthetic-onboarding-mail")
          .then(() =>
            page.getByRole("dialog").getByRole("button", { name: "Connect account" }).click(),
          )
          .then(() => nameConnectedAccount(page, label)),
      );
    });
  return {
    sessionUserId,
    /**
     * Create the team as a member whose setup is required, then complete it in `order`. Neither
     * step offers to skip: each forward button waits, disabled and reading its hint, until its step is
     * done, and becomes the primary action in the same box without moving anything. Until both are
     * done the team's Apps sends the member to their current step, as a document request and from
     * within the page; finishing opens the dashboard for good.
     */
    requiredSetup: (name: string, order: OnboardingOrder) =>
      Effect.gen(function* () {
        yield* allowClipboard;
        yield* browser.use("Confirm team creation", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Team creation opens a setup step", (page) =>
          page.waitForURL(
            (url) =>
              url.origin === targetHosts(target).browser &&
              /^\/org\/[^/]+\/setup\/(accounts|assistant)$/u.test(url.pathname),
          ),
        );
        const teams = yield* organizations;
        const team = teams[0];
        if (teams.length !== 1 || team === undefined || team.name !== name)
          return yield* new OnboardingFailed({
            operation: "Confirmation must create exactly the chosen team",
          });
        const setup = `/org/${team.slug}/setup`;
        const accountsStep = new RegExp(`^${setup}/accounts$`, "u");
        const assistantStep = new RegExp(`^${setup}/assistant$`, "u");
        const accountsHint = "Connect an account to continue";
        const assistantHint = "Connect your assistant to continue";
        const continueAccounts = "Continue with 1 account";
        const label = order === "assistant_first" ? "Assistant first" : "Accounts first";
        /** Connect one account on the account step: the button opens in place, nothing moves. */
        const completeAccounts = Effect.gen(function* () {
          const catalogLoaded = browser.use("The catalog has loaded", (page) =>
            page.locator("[aria-label='Loading apps']").waitFor({ state: "detached" }),
          );
          yield* heading("Connect your accounts");
          yield* catalogLoaded;
          yield* waitsFor(continueAccounts, accountsHint, "before an account connects");
          yield* atBothSizes(`Required ${label}: Connect your accounts`, "accounts-setup-title");
          // A fresh document, so the shifts observed are this step's own, not the resizes'.
          yield* browser.use("Reload the account step", (page) => page.reload());
          yield* heading("Connect your accounts");
          yield* catalogLoaded;
          const shifts = yield* observeLayoutShifts;
          yield* shifts.phase("Connect an account");
          yield* waitsFor(continueAccounts, accountsHint, "after a reload");
          const waiting = yield* forwardControlBox(accountsHint);
          yield* connectMail("Work mail");
          yield* opensWith(continueAccounts, accountsHint, "once an account connects");
          expect(yield* forwardControlBox(continueAccounts)).toEqual(waiting);
          yield* noLayoutShifts(shifts, "required-account-step-shifts.json");
          yield* browser.checkpoint(`Required ${label}: Continue opens once an account connects`);
          yield* browser.use("Continue from the account step", (page) =>
            page.getByRole("link", { name: continueAccounts, exact: true }).click(),
          );
        });
        /**
         * Choose Claude and come back with "Different assistant", then connect Claude: the button
         * waits on the assistants and the guide alike and opens in place once Claude connects.
         */
        const completeAssistant = (next: string) =>
          Effect.gen(function* () {
            yield* heading("Connect your assistant");
            yield* waitsFor(next, assistantHint, "on the assistants");
            yield* atBothSizes(`Required ${label}: Connect your assistant`, "agent-setup-title");
            yield* browser.use("Choose Claude", (page) =>
              page.getByRole("button", { name: "Claude", exact: true }).click(),
            );
            yield* browser.use("Setup waits for Claude", (page) =>
              page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
            );
            yield* waitsFor(next, assistantHint, "on Claude's guide");
            yield* browser.use("Go back to a different assistant", (page) =>
              page.getByRole("link", { name: "Different assistant", exact: true }).click(),
            );
            yield* browser.use("The assistants are offered again", (page) =>
              page.getByRole("group", { name: "Choose your assistant", exact: true }).waitFor(),
            );
            yield* waitsFor(next, assistantHint, "back on the assistants");
            yield* browser.use("Choose Claude again", (page) =>
              page.getByRole("button", { name: "Claude", exact: true }).click(),
            );
            yield* browser.use("Setup waits for Claude again", (page) =>
              page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
            );
            yield* atBothSizes(`Required ${label}: Claude's guide waits`, "agent-setup-title");
            // The guide keeps its baseline through a reload, in the entry's history state.
            yield* browser.use("Reload Claude's guide", (page) => page.reload());
            yield* browser.use("Claude's guide waits after a reload", (page) =>
              page.getByText("Waiting for Claude to connect…", { exact: true }).waitFor(),
            );
            const shifts = yield* observeLayoutShifts;
            yield* shifts.phase("Connect Claude");
            yield* waitsFor(next, assistantHint, "while Claude's guide waits");
            const waiting = yield* forwardControlBox(assistantHint);
            yield* authorizeAssistant("Onboarding assistant");
            yield* browser.use("Claude is connected", (page) =>
              approvedFor(page, "Onboarding assistant").waitFor(),
            );
            yield* opensWith(next, assistantHint, "once Claude connects");
            expect(yield* forwardControlBox(next)).toEqual(waiting);
            yield* noLayoutShifts(shifts, "required-guide-shifts.json");
            yield* browser.checkpoint(`Required ${label}: Next opens once Claude connects`);
            yield* browser.use(`Continue with ${next}`, (page) =>
              page.getByRole("link", { name: next, exact: true }).click(),
            );
          });

        if (order === "accounts_first") {
          expect(yield* setupPath).toBe(`${setup}/accounts`);
          yield* heading("Connect your accounts");
          yield* appsSendsTo(team.slug, accountsStep, "before any step is done");
          yield* browser.checkpoint(`Required ${label}: Apps returns to the account step`);
          yield* accountSettingsReturnTo(name, accountsStep);
          yield* completeAccounts;
          yield* browser.use("Continue opens the assistants", (page) =>
            page.waitForURL((url) => assistantStep.test(url.pathname) && url.search === ""),
          );
          yield* heading("Connect your assistant");
          yield* appsSendsTo(team.slug, assistantStep, "with an account and no assistant");
          yield* browser.checkpoint(`Required ${label}: Apps returns to the assistant step`);
          yield* completeAssistant("Next: first prompt");
          yield* promptShown("Onboarding assistant", "after a required setup");
        } else {
          expect(yield* setupPath).toBe(`${setup}/assistant`);
          yield* heading("Connect your assistant");
          yield* appsSendsTo(team.slug, assistantStep, "before any step is done");
          yield* browser.checkpoint(`Required ${label}: Apps returns to the assistant step`);
          yield* accountSettingsReturnTo(name, assistantStep);
          yield* completeAssistant("Next: connect accounts");
          yield* browser.use("Next opens the account step with the agent", (page) =>
            page.waitForURL((url) => accountsStep.test(url.pathname) && url.search !== ""),
          );
          yield* heading("Connect your accounts");
          // The server names the agent connected, so the first prompt can still confirm it.
          const returned = yield* appsSendsTo(
            team.slug,
            accountsStep,
            "with an assistant and no account",
          );
          expect(returned).toMatch(
            new RegExp(`^${setup}/accounts\\?assistant=other&agent=[^&]+$`, "u"),
          );
          yield* browser.checkpoint(`Required ${label}: Apps returns to the account step`);
          // A new visit to the assistant step, as in a new tab, finds Claude done and moves on.
          yield* browser.use("Open the assistant step in a new visit", (page) =>
            page.goto(`${setup}/assistant`),
          );
          yield* heading("Connect your assistant");
          yield* opensWith(
            "Next: connect accounts",
            assistantHint,
            "in a new visit once Claude is connected",
          );
          yield* browser.use("Return to the account step", (page) => page.goto(returned));
          yield* completeAccounts;
          yield* browser.use("The first prompt is shown", (page) =>
            page.getByRole("button", { name: "Copy starter prompt", exact: true }).waitFor(),
          );
          yield* browser.use("The first prompt confirms the agent", (page) =>
            approvedFor(page, "Onboarding assistant").waitFor(),
          );
        }
        expect(
          yield* browser.use("The first prompt names the connected account", (page) =>
            page.getByText(/I've connected Synthetic Mail \(Work mail\)\./u).count(),
          ),
        ).toBe(1);
        yield* browser.use("Open the dashboard", (page) =>
          page.getByRole("link", { name: "Open dashboard", exact: true }).click(),
        );
        yield* browser.use("Setup ends at the team's Apps", (page) =>
          page.waitForURL(`${targetHosts(target).browser}/org/${team.slug}/apps`),
        );
        yield* browser.use("The dashboard is open", (page) =>
          page.getByRole("button", { name: "Add app", exact: true }).first().waitFor(),
        );
        // Finished for good: the server serves Apps itself, and a reload keeps it.
        expect(
          yield* browser.use("Request the team's Apps after setup", (page) =>
            page.request
              .get(`/org/${team.slug}/apps`, { maxRedirects: 0 })
              .then((response) => response.status()),
          ),
        ).toBe(200);
        yield* browser.use("Reload the team's Apps", (page) => page.reload());
        yield* browser.use("Apps stays open after a reload", (page) =>
          page.getByRole("button", { name: "Add app", exact: true }).first().waitFor(),
        );
        expect(yield* setupPath).toBe(`/org/${team.slug}/apps`);
        yield* browser.checkpoint(`Required ${label}: the dashboard opens after setup`);
        return team;
      }),
    /**
     * Create the team, then complete setup in the order the onboarding experiment assigned: the
     * first step renders straight after creation, reloads keep the order, the assistant's agent
     * is carried through the account step, and both orders end at the first prompt, then Apps.
     */
    setupInOrder: (name: string, order: OnboardingOrder) =>
      Effect.gen(function* () {
        yield* allowClipboard;
        // Creation returns the team's setup order, so its first step opens without reading it
        // again: the read is held throughout, and no screen without a step shows meanwhile.
        const opened = yield* Effect.scoped(
          Effect.gen(function* () {
            const sequence = yield* holdQuery(/^\/api\/organizations\/[^/]+\/setup$/u, "continue", {
              allRequests: true,
            });
            yield* browser.use("Watch for a setup screen without a step", (page) =>
              page.evaluate(() => {
                const blank = () => {
                  const main = document.querySelector("main");
                  if (main !== null && main.querySelector("h1") === null)
                    document.documentElement.dataset.blankSetup ??= `${location.pathname} ${main.innerText.replaceAll("\n", " | ").slice(0, 120)}`;
                };
                new MutationObserver(blank).observe(document.body, {
                  childList: true,
                  subtree: true,
                });
              }),
            );
            yield* browser.use("Confirm team creation", (page) =>
              page.getByRole("button", { name: "Continue", exact: true }).click(),
            );
            yield* browser.use("Team creation opens a setup step", (page) =>
              page.waitForURL(
                (url) =>
                  url.origin === targetHosts(target).browser &&
                  /^\/org\/[^/]+\/setup\/(accounts|assistant)$/u.test(url.pathname),
              ),
            );
            yield* browser.use("The first step is shown while its order's read is held", (page) =>
              page.locator("h1", { hasText: /^Connect your (accounts|assistant)$/u }).waitFor(),
            );
            return yield* browser
              .use("Read what showed on the way to the first step", (page) =>
                page.evaluate(() => ({
                  blank: document.documentElement.dataset.blankSetup ?? false,
                  read: false,
                })),
              )
              .pipe(
                Effect.zipWith(
                  sequence.requested.pipe(
                    Effect.timeout("1 second"),
                    Effect.as(true),
                    Effect.orElseSucceed(() => false),
                  ),
                  (shown, read) => ({ ...shown, read }),
                ),
              );
          }),
        );
        expect(opened).toEqual({ blank: false, read: false });
        const teams = yield* organizations;
        const team = teams[0];
        if (teams.length !== 1 || team === undefined || team.name !== name)
          return yield* new OnboardingFailed({
            operation: "Confirmation must create exactly the chosen team",
          });
        const setup = `/org/${team.slug}/setup`;
        const [first, second] =
          order === "assistant_first"
            ? (["assistant", "accounts"] as const)
            : (["accounts", "assistant"] as const);
        expect(yield* setupPath).toBe(`${setup}/${first}`);
        const title = { accounts: "Connect your accounts", assistant: "Connect your assistant" };
        yield* heading(title[first]);
        expect(
          yield* browser.use("Only the assigned first step is shown", (page) =>
            page.getByRole("heading", { name: title[second], exact: true }).count(),
          ),
        ).toBe(0);
        const label = order === "assistant_first" ? "Assistant first" : "Accounts first";
        yield* bothSizes(`${label}: ${title[first]}`);
        // The server renders the same first step for this team, so a reload keeps its order.
        yield* browser.use("Reload the first step", (page) => page.reload());
        yield* heading(title[first]);

        // Each step first offers to skip. Managed Cloud lists no catalog apps, so the account step
        // counts no account and stays at Skip for now even after one is linked over the API.
        if (order === "assistant_first") {
          // Skipping the guide moves on without an agent, and Back returns to it.
          yield* chooseWaitingClaude;
          yield* browser.use("Skip Claude's waiting guide", (page) => skipStep(page).click());
          yield* browser.use("Skipping opens the account step without an agent", (page) =>
            page.waitForURL((url) => url.pathname === `${setup}/accounts` && url.search === ""),
          );
          yield* heading("Connect your accounts");
          yield* browser.use("Back to Claude's guide", (page) => page.goBack());
          yield* heading("Add Executor to Claude");
          yield* offersSkip("on Claude's guide after Back");
          yield* connectClaude("Next: connect accounts");
          yield* browser.use("Next opens the account step with the agent", (page) =>
            page.waitForURL((url) => url.pathname === `${setup}/accounts` && url.search !== ""),
          );
          const accounts = yield* setupPath;
          expect(accounts).toMatch(
            new RegExp(`^${setup}/accounts\\?assistant=claude&agent=[^&]+$`, "u"),
          );
          yield* heading("Connect your accounts");
          yield* offersSkip("on the account step before an account connects");
          yield* connectTracker(team.id);
          // The account was saved outside this page; a reload reads it and keeps the agent.
          yield* browser.use("Reload the account step", (page) => page.reload());
          yield* heading("Connect your accounts");
          expect(yield* setupPath).toBe(accounts);
          yield* bothSizes(`${label}: Connect your accounts`);
          yield* browser.use("Skip to the first prompt", (page) => skipStep(page).click());
          yield* firstPromptNamesTracker("after the account step");
          yield* bothSizes(`${label}: Send your first prompt`);
          // Back returns to the account step with its agent; Forward to the prompt.
          yield* browser.use("Back to the account step", (page) => page.goBack());
          yield* heading("Connect your accounts");
          expect(yield* setupPath).toBe(accounts);
          yield* browser.use("Forward to the first prompt", (page) => page.goForward());
          yield* firstPromptNamesTracker("after Forward");
        } else {
          expect(yield* setupSearch).toBe("");
          yield* offersSkip("on the account step before an account connects");
          yield* connectTracker(team.id);
          // The account was saved outside this page, so its list reads it again on reload.
          yield* browser.use("Reload the account step", (page) => page.reload());
          yield* heading("Connect your accounts");
          yield* browser.use("Skip to the assistant step", (page) => skipStep(page).click());
          yield* browser.use("Skipping opens the assistant choices", (page) =>
            page.waitForURL((url) => url.pathname === `${setup}/assistant` && url.search === ""),
          );
          yield* heading("Connect your assistant");
          yield* offersSkip("on the assistants before a connection");
          yield* bothSizes(`${label}: Connect your assistant`);
          yield* chooseWaitingClaude;
          yield* connectClaude("Next: first prompt");
          yield* firstPromptNamesTracker("after the assistant step");
          yield* bothSizes(`${label}: Send your first prompt`);
        }
        yield* browser.use("Open the dashboard", (page) =>
          page.getByRole("link", { name: "Open dashboard", exact: true }).click(),
        );
        yield* browser.use("Setup ends at the team's Apps", (page) =>
          page.waitForURL(`${targetHosts(target).browser}/org/${team.slug}/apps`),
        );
        return team;
      }),
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
      yield* browser.use("Show team details on a phone", (page) => page.setViewportSize(phone));
      yield* fitsPhone("Team details", "team-setup-title");
      yield* browser.checkpoint("Review team details on a phone");
      yield* browser.use("Return to the desktop layout", (page) => page.setViewportSize(desktop));
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
     * Create the team, which opens its account step, then skip to agent setup and leave it:
     * `connect` completes the full assistant journey with a real MCP OAuth authorization; `revisit`
     * connects one on a phone and returns to setup through history, reloads and links; `skip` goes
     * straight to the dashboard.
     */
    confirmTeam: (name: string, agent: "connect" | "revisit" | "skip" = "skip") =>
      Effect.gen(function* () {
        yield* browser.use("Confirm team creation", (page) =>
          page.getByRole("button", { name: "Continue", exact: true }).click(),
        );
        yield* browser.use("Team creation opens the team's account step", (page) =>
          page.waitForURL(
            (url) =>
              url.origin === targetHosts(target).browser &&
              /^\/org\/[^/]+\/setup\/accounts$/u.test(url.pathname),
          ),
        );
        const teams = yield* organizations;
        if (teams.length !== 1 || teams[0]?.name !== name)
          return yield* new OnboardingFailed({
            operation: "Confirmation must create exactly the chosen team",
          });
        const setup = `/org/${teams[0].slug}/setup`;
        expect(
          yield* browser.use("The account step belongs to the new team", (page) =>
            Promise.resolve(new URL(page.url()).pathname),
          ),
        ).toBe(`${setup}/accounts`);
        yield* browser.use("The account step offers the catalog's apps", (page) =>
          page.getByRole("heading", { name: "Connect your accounts", exact: true }).waitFor(),
        );
        expect(
          yield* browser.use("Setup stays outside the dashboard shell", (page) =>
            page.locator(".shell").count(),
          ),
        ).toBe(0);
        // Nothing is connected yet, so the step offers to skip it.
        yield* browser.use("The catalog has loaded", (page) =>
          page.locator("[aria-label='Loading apps']").waitFor({ state: "detached" }),
        );
        yield* browser.checkpoint("Connect your accounts after team creation");
        yield* browser.use("Skip connecting an account", (page) => skipStep(page).click());
        yield* browser.use("Skip opens agent setup", (page) =>
          page.waitForURL(`${targetHosts(target).browser}${setup}/assistant`),
        );
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
        else if (agent === "revisit") yield* revisitAgentSetup(`${setup}/assistant`);
        else yield* browser.use("Skip agent setup for now", (page) => skipStep(page).click());
        const team = teams[0];
        yield* browser.use("The new team opens Apps", (page) =>
          page.waitForURL(`${targetHosts(target).browser}/org/${team.slug}/apps`),
        );
        yield* browser.use("The confirmed team stays open", (page) =>
          page
            .getByRole("button", { name: "Add app", exact: true })
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
