import { Effect } from "effect";
import { Browser } from "./browser.ts";

export const openInApp = (label: string, path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    yield* browser.use(label, (page) =>
      page.evaluate((to) => window.history.pushState(window.history.state, "", to), path),
    );
  });

const neutralPage = (destination: URL) => {
  const organization =
    /^\/org\/([^/?#]+)/.exec(destination.pathname)?.[1] ??
    destination.searchParams.get("organization");
  if (organization === null) return "/connections";
  const settings = `/org/${organization}/organization`;
  return destination.pathname === settings ? `/org/${organization}/connect` : settings;
};

export const openThroughBrowser = (label: string, path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const destination = new URL(path, "http://dashboard.invalid");
    const local = destination.origin === "http://dashboard.invalid";
    yield* browser.use(`${label}: start from another page`, (page) =>
      page.goto(
        local ? neutralPage(destination) : new URL(neutralPage(destination), destination).href,
      ),
    );
    yield* openInApp(label, local ? path : destination.pathname + destination.search);
  });
