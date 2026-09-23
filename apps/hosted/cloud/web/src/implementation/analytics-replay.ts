import type { SessionRecordingOptions } from "posthog-js";

/** Replay is limited to signed-in dashboard navigation without capability-bearing URLs. */
export const replayPageAllowed = (url: URL) =>
  [...url.searchParams].every(
    ([key, value]) =>
      key === "view" &&
      [
        "overview",
        "tools",
        "accounts",
        "skills",
        "schedules",
        "workflows",
        "settings",
        "deployments",
      ].includes(value),
  ) &&
  url.hash === "" &&
  /^\/org\/[^/]+\/(apps|accounts|connect|settings|groups|approvals)(\/|$)/.test(url.pathname) &&
  !/\/(api-keys|source|connections|oauth|credentials|secrets)(\/|$)/.test(url.pathname);

/** Record readable dashboard content; exclude password fields and marked secrets before transport. */
export const dashboardReplay: SessionRecordingOptions = {
  maskAllInputs: false,
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
  // rrweb also uses this callback for its required page metadata. Keep only a fixed route label.
  maskCapturedNetworkRequestFn: (request) =>
    Object.keys(request).length === 1 && typeof request.name === "string"
      ? { ...request, name: `${location.origin}/dashboard` }
      : null,
};
