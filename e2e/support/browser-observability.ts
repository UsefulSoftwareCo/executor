/** Inject response and document failures through Playwright's real network boundary. */
import { Effect } from "effect";
import { Browser } from "./browser.ts";

/** Keep the real server request and trace, then replace only the response under test. */
export const injectDashboardResponse = (slug: string, body: string, status: number) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    let trace: string | undefined;
    yield* browser.use("Leave the previous document", (page) => page.goto("about:blank"));
    yield* browser.use("Replace the resource response", (page) =>
      page.route("**/api/organizations/*/resources*", (route) =>
        route.fetch().then((response) => {
          trace = route.request().headers()["traceparent"]?.split("-")[1];
          return route.fulfill({ response, status, body, contentType: "application/json" });
        }),
      ),
    );
    yield* browser.use("Open the dashboard", (page) => page.goto(`/org/${slug}/apps`));
    yield* browser.use("Wait for the decoded operation failure", (page) =>
      page.waitForFunction(() => document.documentElement.hasAttribute("data-observed-failure")),
    );
    yield* browser.use("Restore the resource route", (page) =>
      page.unroute("**/api/organizations/*/resources*"),
    );
    return trace;
  });

/** Corrupt synthetic private entry data before any authored dashboard code executes. */
export const corruptDashboardEntry = (slug: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use("Leave the previous document", (page) => page.goto("about:blank"));
    yield* browser.use("Corrupt the private entry before module execution", (page) =>
      page.addInitScript(() => {
        const observer = new MutationObserver(() => {
          if (document.head === null) return;
          const entry =
            document.getElementById("executor-entry") ?? document.createElement("script");
          entry.id = "executor-entry";
          entry.setAttribute("type", "application/json");
          entry.textContent = '{"invalid":true}';
          if (!entry.isConnected) document.head.append(entry);
          document.documentElement.setAttribute("data-corrupt-entry", "true");
          observer.disconnect();
        });
        observer.observe(document, { childList: true, subtree: true });
      }),
    );
    yield* browser.use("Open the corrupt document", (page) => page.goto(`/org/${slug}/apps`));
  });
