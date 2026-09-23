import { publicDocsBaseUrl } from "@executor-js/ui/contracts/documentation";

// Cloud supplies a same-origin path. Self-host uses the public documentation site.
const configured = import.meta.env.VITE_EXECUTOR_DOCS_BASE_URL ?? publicDocsBaseUrl;
const base = configured === "/docs/" ? configured : new URL(configured).href;

/** Resolve a documentation page from the host's configured documentation base. */
export const documentationUrl = (path = "") => `${base.replace(/\/?$/, "/")}${path}`;
