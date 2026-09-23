/** Isolated, script-free startup document shown before the local server is ready. */
export const startupUrl = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
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
<main role="status"><h1>Starting Executor</h1><p>Your apps will open here.</p></main>
</html>`)}`;
