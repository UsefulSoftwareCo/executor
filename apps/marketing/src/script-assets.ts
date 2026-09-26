/**
 * Browser error reporting treats an uncaught failure as ours only when a script
 * from the built asset directory raised it (see @executor-js/telemetry/browser-errors).
 * Astro inlines small processed scripts into the page, where their failures are
 * indistinguishable from code injected into the document, so every processed
 * script is emitted as its own file. Other assets keep Vite's default limit.
 */
export const assetsInlineLimit = (file: string): boolean | undefined =>
  file.endsWith(".js") ? false : undefined;
