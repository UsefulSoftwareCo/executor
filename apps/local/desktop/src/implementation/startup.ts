/** Isolated, script-free status documents shown before the local server is ready. */
const statusUrl = (title: string, detail: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>Executor</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { text-align: center; padding: 32px; }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.5px; margin: 0 0 10px; }
  p { font-size: 14px; margin: 0; opacity: 0.65; }
</style>
<main role="status"><h1>${title}</h1><p>${detail}</p></main>
</html>`)}`;

export const startupUrl = statusUrl("Starting Executor", "Your apps will open here.");

/** Shown while the desktop's old data moves into the CLI's data directory, once. */
export const movingUrl = statusUrl(
  "Moving your Executor data…",
  "Executor now shares its data with the CLI. This happens once and can take a minute.",
);
