import type { Page, Request, Response } from "playwright";
import { Effect } from "effect";
import { Browser } from "./browser.ts";
import { Evidence } from "./evidence.ts";

type Event =
  | { readonly at: number; readonly kind: "tab" }
  | { readonly at: number; readonly kind: "document"; readonly url: string }
  | { readonly at: number; readonly kind: "url"; readonly url: string }
  | {
      readonly at: number;
      readonly kind: "redirect";
      readonly url: string;
      readonly to: string;
      readonly status: number | undefined;
    }
  | {
      readonly at: number;
      readonly kind: "request";
      readonly method: string;
      readonly url: string;
      readonly status: number | undefined;
      readonly durationMs: number;
    }
  | { readonly at: number; readonly kind: "text"; readonly url: string; readonly text: string };
export type Entry = Event & { readonly tab: number };

const marker = "__executor_app_open__";
const instrumented = new WeakSet<object>();
const captures = new WeakMap<Page, number>();

const safeUrl = (value: string) => {
  const url = new URL(value);
  if (url.origin === "null") return value;
  const search = url.search.replace(/((?:request|code)(?:=|%3D))[^&#%]+/gi, "$1redacted");
  return `${url.origin}${url.pathname}${search}${url.hash === "" ? "" : "#…"}`;
};

const authStep = (url: URL) =>
  url.pathname.startsWith("/_executor/auth/") ||
  url.pathname.startsWith("/api/app-ui/") ||
  url.pathname.startsWith("/api/auth/get-session");

const observeText = (key: string) => {
  let last = "";
  let queued = false;
  const report = () => {
    queued = false;
    const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    if (text === last) return;
    last = text;
    console.debug(key, JSON.stringify({ at: Date.now(), url: location.href, text }));
  };
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(report);
  };
  new MutationObserver(schedule).observe(document, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
  });
  document.addEventListener("DOMContentLoaded", schedule);
  schedule();
};

const render = (entries: ReadonlyArray<Entry>) => {
  const start = entries[0]?.at ?? 0;
  const origins = new Map<string, string>();
  const short = (value: string) => {
    const url = new URL(value.replace("#…", ""));
    if (url.origin === "null") return value;
    if (!origins.has(url.origin)) origins.set(url.origin, `[${origins.size + 1}]`);
    return `${origins.get(url.origin)}${value.slice(url.origin.length)}`;
  };
  const lines = entries.map((entry) => {
    const offset = `+${String(entry.at - start).padStart(6)}ms  tab ${entry.tab}`;
    switch (entry.kind) {
      case "tab":
        return `${offset}  NEW TAB`;
      case "document":
        return `${offset}  DOCUMENT  ${short(entry.url)}`;
      case "url":
        return `${offset}  URL       ${short(entry.url)} (same document)`;
      case "redirect":
        return `${offset}  REDIRECT  ${entry.status ?? "?"} ${short(entry.url)} -> ${short(entry.to)}`;
      case "request":
        return `${offset}  ${entry.method.padEnd(8)}  ${entry.status ?? "failed"} ${short(entry.url)} (${entry.durationMs}ms)`;
      case "text":
        return `${offset}  SCREEN    "${entry.text}"`;
    }
  });
  const legend = [...origins].map(([origin, label]) => `${label} ${origin}`);
  return `${[...legend, "", ...lines].join("\n")}\n`;
};

export const recordAppOpening = <A, E, R>(open: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const evidence = yield* Evidence;
    const entries: Entry[] = [];
    const tabs: Page[] = [];
    const detachments: (() => void)[] = [];
    const attach = (current: Page) => {
      const tab = tabs.push(current);
      const started = new Map<Request, number>();
      let loading = false;
      const push = (event: Event) => entries.push({ ...event, tab });
      const receive = (message: { type(): string; text(): string }) => {
        if (message.type() !== "debug" || !message.text().startsWith(marker)) return;
        const value = JSON.parse(message.text().slice(marker.length + 1)) as {
          at: number;
          url: string;
          text: string;
        };
        push({ at: value.at, kind: "text", url: safeUrl(value.url), text: value.text });
      };
      const request = (request: Request) => {
        started.set(request, Date.now());
        if (request.frame() !== current.mainFrame()) return;
        if (request.isNavigationRequest()) loading = true;
        const from = request.redirectedFrom();
        if (from === null) return;
        void from.response().then((response) =>
          push({
            at: Date.now(),
            kind: "redirect",
            url: safeUrl(from.url()),
            to: safeUrl(request.url()),
            status: response?.status(),
          }),
        );
      };
      const settled = (request: Request, response: Response | null) => {
        const at = started.get(request);
        if (at === undefined || request.resourceType() === "document") return;
        if (!authStep(new URL(request.url()))) return;
        push({
          at,
          kind: "request",
          method: request.method(),
          url: safeUrl(request.url()),
          status: response?.status(),
          durationMs: Date.now() - at,
        });
      };
      const response = (response: Response) => settled(response.request(), response);
      const failed = (request: Request) => settled(request, null);
      const navigated = (frame: { url(): string }) => {
        if (frame !== current.mainFrame()) return;
        push({ at: Date.now(), kind: loading ? "document" : "url", url: safeUrl(frame.url()) });
        loading = false;
      };
      current.on("console", receive);
      current.on("request", request);
      current.on("response", response);
      current.on("requestfailed", failed);
      current.on("framenavigated", navigated);
      detachments.push(() => {
        current.off("console", receive);
        current.off("request", request);
        current.off("response", response);
        current.off("requestfailed", failed);
        current.off("framenavigated", navigated);
      });
    };
    const opened = (current: Page) => {
      attach(current);
      const at = Date.now();
      entries.push({ at, kind: "tab", tab: tabs.length });
      if (current.url() !== "about:blank")
        entries.push({ at, kind: "document", url: safeUrl(current.url()), tab: tabs.length });
    };
    const first = yield* browser.use("Record the app opening timeline", (current) => {
      attach(current);
      current.context().on("page", opened);
      if (instrumented.has(current.context())) return Promise.resolve(current);
      instrumented.add(current.context());
      return current
        .context()
        .addInitScript(observeText, marker)
        .then(() => current);
    });
    const result = yield* open.pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          first.context().off("page", opened);
          for (const detach of detachments) detach();
          const count = (captures.get(first) ?? 0) + 1;
          captures.set(first, count);
          const name = count === 1 ? "app-open-timeline" : `app-open-timeline-${count}`;
          const ordered = entries.toSorted((left, right) => left.at - right.at);
          yield* evidence.json(`${name}.json`, ordered);
          yield* evidence.attach(`${name}.txt`, "text/plain", render(ordered));
          for (const [index, tab] of tabs.entries()) {
            const video = tab.video();
            if (index === 0 || video === null) continue;
            const file = `${name}-tab-${index + 1}.webm`;
            yield* browser
              .use(`Save the recording of opened tab ${index + 1}`, () =>
                tab.close().then(() => video.saveAs(`${evidence.directory}/${file}`)),
              )
              .pipe(Effect.orDie);
            yield* evidence.artifact(`Opened tab ${index + 1} recording`, "video/webm", file);
          }
        }),
      ),
    );
    return { result, timeline: entries.toSorted((left, right) => left.at - right.at) };
  });

export const committedDocuments = (timeline: ReadonlyArray<Entry>) =>
  timeline.flatMap((entry) =>
    entry.kind === "document" ? [new URL(entry.url.replace("#…", ""))] : [],
  );
export const screens = (timeline: ReadonlyArray<Entry>) =>
  timeline.flatMap((entry) => (entry.kind === "text" ? [entry.text] : []));
