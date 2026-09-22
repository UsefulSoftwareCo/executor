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

/** Mask content at the recorder, before transport. Code, form values and app frames are never recorded. */
export const dashboardReplay: SessionRecordingOptions = {
  maskAllInputs: true,
  maskAllElementAttributes: true,
  slimDOMOptions: "all",
  captureJsonLd: false,
  maskTextSelector: "*",
  maskTextFn: () => "***",
  maskInputFn: () => "***",
  blockSelector:
    'iframe,pre,code,form,input,textarea,select,img,video,audio,canvas,[contenteditable="true"],[data-private],[data-product-private],a[href*="?"],a[href*="#"]',
  recordCrossOriginIframes: false,
  recordHeaders: false,
  recordBody: false,
  collectFonts: false,
  inlineStylesheet: false,
  captureCanvas: { recordCanvas: false },
  // rrweb also uses this callback for its required page metadata. Keep only a fixed route label.
  maskCapturedNetworkRequestFn: (request) =>
    Object.keys(request).length === 1 && typeof request.name === "string"
      ? { ...request, name: `${location.origin}/dashboard` }
      : null,
};
