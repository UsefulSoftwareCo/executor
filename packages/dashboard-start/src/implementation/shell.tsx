/// <reference types="vite/client" />
import { HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { DisplayFormatSync } from "@executor-js/ui/hooks/display-format";
import type {} from "../contracts/build.ts";
import { documentBuild } from "./document-build.ts";
import { BuildChangeNotice } from "./build-change-notice.tsx";

const holdEarlySubmissions = `(() => {
const owned = (form) => Object.keys(form).some((key) => key.startsWith("__reactProps$"));
const held = new Map();
let scheduled = false, replaying = null;
const replay = () => {
scheduled = false;
for (const [form, [submitter, until]] of [...held]) {
if (!form.isConnected || performance.now() > until) held.delete(form);
else if (owned(form)) {
held.delete(form);
replaying = until;
try { form.requestSubmit(submitter && submitter.isConnected && submitter.form === form ? submitter : undefined); }
finally { replaying = null; }
}
}
if (held.size > 0) hold();
};
const hold = (form, submitter) => {
if (form) held.set(form, [submitter, replaying ?? performance.now() + 30000]);
if (!scheduled) { scheduled = true; requestAnimationFrame(replay); }
};
addEventListener("submit", (event) => {
const form = event.target;
if (!(form instanceof HTMLFormElement) || owned(form)) return;
event.preventDefault();
event.stopImmediatePropagation();
hold(form, event.submitter);
}, true);
addEventListener("submit", (event) => {
const form = event.target;
if (!(form instanceof HTMLFormElement) || event.defaultPrevented || form.hasAttribute("action")) return;
event.preventDefault();
hold(form, event.submitter);
});
})();`;

export function DashboardDocument({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en" data-dashboard="">
      <head>
        <meta charSet="UTF-8" />
        <meta name="color-scheme" content="light dark" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
        <meta name="executor-build" content={documentBuild()} />
        <meta
          name="executor-environment"
          content={import.meta.env.VITE_EXECUTOR_ENVIRONMENT_NAME}
        />
        <link rel="icon" href="/favicon.png" />
        <script dangerouslySetInnerHTML={{ __html: holdEarlySubmissions }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <DisplayFormatSync />
        <BuildChangeNotice />
        <Scripts />
      </body>
    </html>
  );
}
