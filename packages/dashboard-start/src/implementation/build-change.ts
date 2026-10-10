/**
 * A tab left open across an upgrade keeps running the previous build against the new server. Its
 * requests can fail in ways that look like an outage, such as a read batch naming an endpoint the
 * new server no longer has. The server names its build on every response (`layerBuildHeader`). The
 * first API response naming a build other than the one that served this page's document marks the
 * page outdated, so the dashboard offers a reload and explains failures as the update they are.
 */
import { Effect } from "effect";
import { HttpClient } from "effect/http";
import { buildHeader } from "../contracts/build.ts";

/**
 * The state belongs to the page, not the module, so it lives on the document: this attribute marks
 * it outdated and this event announces the change.
 */
const outdatedAttribute = "data-outdated-build";
const outdatedEvent = "executor:page-outdated";

/** How a request failure on an outdated page reads: the failure is likely the update itself. */
export const outdatedPageMessage = "Executor was updated. Reload this page to use the new version.";

/** Whether a response from this page's server named a build other than the page's own. */
export const pageOutdated = (): boolean =>
  typeof document !== "undefined" && document.documentElement.hasAttribute(outdatedAttribute);

/** Notify `listener` once the page is found outdated. Returns its removal. */
export const subscribePageOutdated = (listener: () => void) => {
  window.addEventListener(outdatedEvent, listener);
  return () => window.removeEventListener(outdatedEvent, listener);
};

/**
 * The build that served this document, from its `Server-Timing`. A document whose server named no
 * build, such as in development, has none, and the page compares nothing.
 */
const documentServerBuild = () =>
  performance
    .getEntriesByType("navigation")
    .flatMap((entry) => (entry instanceof PerformanceNavigationTiming ? entry.serverTiming : []))
    .find((metric) => metric.name === buildHeader)?.description;

/** Compare every response's build with the page's. Server rendering returns the client unchanged. */
export const observeBuild = (client: HttpClient.HttpClient): HttpClient.HttpClient => {
  if (typeof window === "undefined") return client;
  const page = documentServerBuild();
  if (page === undefined) return client;
  return HttpClient.tap(client, (response) =>
    Effect.sync(() => {
      const server = response.headers[buildHeader];
      if (pageOutdated() || server === undefined || server === page) return;
      document.documentElement.setAttribute(outdatedAttribute, server);
      window.dispatchEvent(new Event(outdatedEvent));
    }),
  );
};
