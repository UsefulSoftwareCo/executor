import type { SessionRecordingOptions } from "posthog-js";
import { AssistantId } from "@executor-js/ui/contracts/dashboard";
import { Schema } from "effect";

/** App tabs a dashboard link can name; source tabs are excluded. */
const dashboardViews = [
  "overview",
  "tools",
  "accounts",
  "skills",
  "schedules",
  "workflows",
  "settings",
  "versions",
  // The former name of `versions`, in links saved before the rename.
  "deployments",
];

/**
 * Setup's own parameters: the chosen assistant, its first-prompt step and the connected agent's
 * grant ID. A grant ID names an authorization record and is never a credential.
 */
const setupParameters = new Map<string, (value: string) => boolean>([
  ["assistant", Schema.is(AssistantId)],
  ["step", (value) => value === "prompt"],
  ["agent", (value) => /^[A-Za-z0-9_-]{1,128}$/.test(value)],
]);

const onlyParameters = (url: URL, allowed: (key: string, value: string) => boolean) =>
  [...url.searchParams].every(([key, value]) => allowed(key, value));

/**
 * Replay is limited to signed-in dashboard navigation, team creation and a team's setup steps,
 * without capability-bearing URLs. OAuth returns, consent and device pages stay excluded.
 */
export const replayPageAllowed = (url: URL) => {
  if (url.hash !== "") return false;
  if (url.pathname === "/create") return url.search === "";
  if (/^\/org\/[^/]+\/setup(\/(accounts|assistant))?\/?$/.test(url.pathname))
    return onlyParameters(url, (key, value) => setupParameters.get(key)?.(value) === true);
  return (
    onlyParameters(url, (key, value) => key === "view" && dashboardViews.includes(value)) &&
    /^\/org\/[^/]+\/(apps|accounts|connect|settings|groups|approvals)(\/|$)/.test(url.pathname) &&
    !/\/(api-keys|source|connections|oauth|credentials|secrets)(\/|$)/.test(url.pathname)
  );
};

/** Record dashboard navigation; mask every input and exclude marked private content before transport. */
export const dashboardReplay: SessionRecordingOptions = {
  maskAllInputs: true,
  maskInputOptions: { password: true },
  maskAllElementAttributes: false,
  // Embedded HTML can contain secret fields; record its DOM with the same selectors instead.
  maskAttributeFn: (name, value) => (name === "srcdoc" ? "" : value),
  slimDOMOptions: "all",
  captureJsonLd: false,
  maskTextSelector: "",
  blockSelector: 'input[type="password"],[data-private],[data-product-private]',
  recordCrossOriginIframes: false,
  recordHeaders: false,
  recordBody: false,
  collectFonts: false,
  inlineStylesheet: true,
  captureCanvas: { recordCanvas: false },
  // rrweb also uses this callback for its required page metadata. Keep only the page's path, which
  // replayPageAllowed has already vetted; drop the query string and hash.
  maskCapturedNetworkRequestFn: (request) => {
    if (Object.keys(request).length !== 1 || typeof request.name !== "string") return null;
    const url = new URL(request.name, location.origin);
    return { ...request, name: `${url.origin}${url.pathname}` };
  },
};
