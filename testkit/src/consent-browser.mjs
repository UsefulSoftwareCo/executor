// Browser consent: drive the real OAuth consent in a browser and record it —
// the Playwright "real hands" part. Returns { code, videoPath }.
export function browserConsent({ appBaseUrl, email, password, videoDir, headless = true, log = () => {} }) {
  return async ({ authorizationUrl, redirectUrl }) => {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({
      viewport: { width: 1100, height: 760 },
      recordVideo: videoDir ? { dir: videoDir, size: { width: 1100, height: 760 } } : undefined,
    });
    const page = await context.newPage();
    let code = null;
    const cbBase = redirectUrl.split("?")[0];
    await context.route(cbBase + "**", (route) => {
      try { code = new URL(route.request().url()).searchParams.get("code"); } catch {}
      log("callback intercepted, code?", !!code);
      route.fulfill({ status: 200, contentType: "text/html",
        body: "<html><body style='font:600 30px system-ui;display:grid;place-items:center;height:100vh;margin:0;color:#15803d;background:#f0fdf4'>✓ Connected to MCP</body></html>" });
    });
    try {
      log("goto authorize");
      await page.goto(authorizationUrl, { waitUntil: "domcontentloaded" });
      log("wait email field");
      await page.waitForSelector("input[type=email]", { timeout: 10000 });
      await page.waitForTimeout(400);
      await page.fill("input[type=email]", email);
      await page.fill("input[type=password]", password);
      await page.waitForTimeout(300);
      log("click sign in");
      await page.click("button[type=submit]");
      log("wait for callback url");
      await page.waitForURL(cbBase + "**", { timeout: 25000 });
      log("on callback, code captured?", !!code);
      await page.waitForTimeout(1400); // show the "Connected" screen in the clip
    } finally {
      const videoPath = videoDir ? await page.video()?.path().catch(() => null) : null;
      await context.close();
      await browser.close();
      this_video = videoPath;
      if (!code) throw new Error("browserConsent: no authorization code captured");
      return { code, videoPath };
    }
  };
}
let this_video;
