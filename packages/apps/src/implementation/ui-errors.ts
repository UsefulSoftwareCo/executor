/** This bootstrap must run before authored modules and must not depend on their framework. */
const installAppFailureUI = () => {
  let reported = false;
  const extension = /^(?:chrome|moz|safari-web)-extension:/;
  const errorTypes = new Set([
    "Error",
    "TypeError",
    "ReferenceError",
    "SyntaxError",
    "RangeError",
    "URIError",
    "EvalError",
    "AggregateError",
  ]);
  const sourceAttributes = (filename: string, line = 0, column = 0) => {
    const attributes: Array<{
      key: string;
      value: { stringValue: string } | { intValue: string };
    }> = [];
    if (!URL.canParse(filename)) return attributes;
    const url = new URL(filename);
    if (
      url.origin !== location.origin ||
      !url.pathname.startsWith("/_executor/assets/") ||
      !url.pathname.endsWith(".js")
    )
      return attributes;
    attributes.push({ key: "code.file.path", value: { stringValue: url.pathname } });
    if (Number.isSafeInteger(line) && line > 0)
      attributes.push({ key: "code.line.number", value: { intValue: String(line) } });
    if (Number.isSafeInteger(column) && column > 0)
      attributes.push({ key: "code.column.number", value: { intValue: String(column) } });
    return attributes;
  };

  const fail = (
    kind: "runtime" | "script" | "rejection",
    details: string,
    attributes: ReturnType<typeof sourceAttributes> = [],
  ) => {
    if (reported) return;
    reported = true;
    const traceId = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const time = `${Date.now()}000000`;
    const show = () => {
      const host = document.createElement("div");
      const root = host.attachShadow({ mode: "open" });
      const dialog = document.createElement("dialog");
      dialog.setAttribute("aria-labelledby", "executor-failure-title");
      const title = document.createElement("h2");
      title.id = "executor-failure-title";
      title.textContent =
        kind === "script" ? "This app could not load" : "This app stopped working";
      const message = document.createElement("p");
      message.textContent =
        kind === "script"
          ? "A file needed by this page did not load. Reload the page to try again."
          : "The app encountered an unexpected error. Reload the page to try again.";
      const warning = document.createElement("p");
      warning.textContent = "Copy any unsaved work before reloading.";
      const disclosure = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = "Error details";
      const report = document.createElement("textarea");
      report.readOnly = true;
      report.rows = 10;
      report.cols = 36;
      report.setAttribute("aria-label", "Error details");
      report.value = `${details.slice(0, 12000)}\n\nDiagnostic ID: ${traceId}`;
      disclosure.append(summary, report);
      const status = document.createElement("p");
      status.setAttribute("role", "status");
      status.textContent = "Sending error report…";
      const reload = document.createElement("button");
      reload.type = "button";
      reload.textContent = "Reload page";
      reload.addEventListener("click", () => location.reload());
      const close = document.createElement("button");
      close.type = "button";
      close.textContent = "Close";
      close.addEventListener("click", () => dialog.close());
      dialog.append(title, message, warning, disclosure, status, reload, close);
      root.append(dialog);
      document.documentElement.append(host);
      dialog.showModal();

      // Error text can contain app data. Keep it in this browser; export only a fixed classification.
      void fetch("/_executor/api/telemetry/traces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        keepalive: true,
        body: JSON.stringify({
          resourceSpans: [
            {
              scopeSpans: [
                {
                  spans: [
                    {
                      traceId,
                      spanId: traceId.slice(0, 16),
                      name: "ui.app.failure",
                      kind: 1,
                      startTimeUnixNano: time,
                      endTimeUnixNano: time,
                      status: { code: 2 },
                      attributes: [
                        { key: "executor.ui.failure.kind", value: { stringValue: kind } },
                        ...attributes,
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        }),
      }).then(
        (response) => {
          status.textContent = response.ok
            ? "Error report sent."
            : "Could not send the error report. You can copy the error details.";
        },
        () => {
          status.textContent = "Could not send the error report. You can copy the error details.";
        },
      );
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", show, { once: true });
    } else {
      show();
    }
  };
  window.addEventListener(
    "error",
    (event: Event) => {
      if (event instanceof ErrorEvent) {
        if (extension.test(event.filename)) return;
        const attributes = sourceAttributes(event.filename, event.lineno, event.colno);
        if (event.error instanceof Error && errorTypes.has(event.error.name))
          attributes.push({ key: "exception.type", value: { stringValue: event.error.name } });
        fail(
          "runtime",
          event.error instanceof Error ? (event.error.stack ?? event.message) : event.message,
          attributes,
        );
      } else if (event.target instanceof HTMLScriptElement) {
        fail(
          "script",
          `Could not load script: ${event.target.src}`,
          sourceAttributes(event.target.src),
        );
      }
    },
    true,
  );
  window.addEventListener("unhandledrejection", (event) => {
    const reason: unknown = event.reason;
    fail(
      "rejection",
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : "An app operation failed without handling its error.",
    );
  });
};

/** Inline host script: no app dependencies, credentials, or authored HTML enter its source. */
export const appFailureBootstrap = `<script>(${installAppFailureUI.toString()})()</script>`;
