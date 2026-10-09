/// <reference types="vite/client" />
/** The HTML document every dashboard renders on the server and hydrates in the browser. */
import { HeadContent, Scripts } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { DisplayFormatSync } from "@executor-js/ui/hooks/display-format";
import type {} from "../contracts/build.ts";
import { documentBuild } from "./document-build.ts";

/**
 * A form rendered on the server has no submit handler until React hydrates it, and the browser
 * would submit it natively: a GET to the current address with every field, passwords included, in
 * the query. This runs before any form exists. It holds a submission until React owns the form,
 * then submits it again with the same button, so an early click or Enter still takes effect. A
 * form still unhydrated after 30 seconds loses the submission rather than sending it natively.
 * React records its props on each element it hydrates (`__reactProps$…`).
 */
const holdEarlySubmissions = `(() => {
  const owned = (form) => Object.keys(form).some((key) => key.startsWith("__reactProps$"));
  const held = new Map();
  let deadline = 0;
  const replay = () => {
    for (const [form, submitter] of held) {
      if (!form.isConnected || performance.now() > deadline) held.delete(form);
      else if (owned(form)) {
        held.delete(form);
        form.requestSubmit(submitter && submitter.isConnected && submitter.form === form ? submitter : undefined);
      }
    }
    if (held.size > 0) requestAnimationFrame(replay);
  };
  addEventListener("submit", (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || owned(form)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (held.size === 0) requestAnimationFrame(replay);
    deadline = performance.now() + 30000;
    held.set(form, event.submitter);
  }, true);
})();`;

/** Public build metadata read by browser telemetry; it carries no identity or configuration secrets. */
export function DashboardDocument({ children }: { readonly children: ReactNode }) {
  return (
    // `data-dashboard` lets automation tell dashboard documents from authored app pages.
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
        <Scripts />
      </body>
    </html>
  );
}
