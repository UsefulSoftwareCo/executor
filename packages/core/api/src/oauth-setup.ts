import type { OAuthSetupResult } from "@executor-js/sdk";

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

const httpUrl = (value: string): string | null => {
  const url = URL.parse(value);
  return url?.protocol === "https:" || url?.protocol === "http:" ? url.href : null;
};

const document = (title: string, content: string): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="referrer" content="no-referrer"/>
<title>${escapeHtml(title)}</title>
<style>
:root{color-scheme:light dark;font-family:system-ui,-apple-system,sans-serif;background:#fafafa;color:#18181b}
*{box-sizing:border-box}
body{margin:0;min-height:100svh;display:grid;place-items:center;padding:24px}
main{width:100%;max-width:480px}
h1{font-size:24px;line-height:1.25;letter-spacing:-.03em;margin:0 0 24px;font-weight:600}
h2{font-size:16px;line-height:1.4;margin:0 0 8px;font-weight:600}
p{font-size:14px;line-height:1.6;color:#52525b;margin:0 0 16px}
section+section{border-top:1px solid #e4e4e7;margin-top:24px;padding-top:24px}
a{display:inline-flex;align-items:center;justify-content:center;min-height:40px;border:1px solid #d4d4d8;border-radius:8px;padding:8px 14px;font-size:14px;font-weight:500;text-decoration:none;color:inherit;text-align:center}
a:focus-visible{outline:2px solid #7c3aed;outline-offset:3px}
a:hover{background:#f4f4f5}
a.primary{background:#18181b;border-color:#18181b;color:#fafafa}
a.primary:hover{background:#3f3f46}
@media(prefers-color-scheme:dark){
:root{background:#09090b;color:#fafafa}p{color:#a1a1aa}section+section{border-color:#27272a}
a{border-color:#3f3f46}a:hover{background:#18181b}
a.primary{background:#fafafa;border-color:#fafafa;color:#18181b}a.primary:hover{background:#e4e4e7}
}
</style>
</head>
<body><main>${content}</main></body>
</html>`;

/** The provider URL comes from the owner-scoped session, never query-string
 *  input. Installation stays in a separate tab so the PKCE flow can continue
 *  in this window without relying on a provider's optional setup callback. */
export const oauthSetupDocument = ({ setup, authorizationUrl }: OAuthSetupResult): string => {
  const actionUrl = httpUrl(setup.actionUrl);
  const continuation = httpUrl(authorizationUrl);
  if (actionUrl === null || continuation === null) return oauthSetupUnavailableDocument();
  return document(
    setup.title,
    `<h1>${escapeHtml(setup.title)}</h1>
<section aria-labelledby="setup-heading">
<h2 id="setup-heading">1. Configure access</h2>
<p>${escapeHtml(setup.description)}</p>
<a href="${escapeHtml(actionUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(setup.actionLabel)}</a>
</section>
<section aria-labelledby="authorize-heading">
<h2 id="authorize-heading">2. Authorize your account</h2>
<p>Return here after setup, or continue if you've already configured access.</p>
<a class="primary" href="${escapeHtml(continuation)}" rel="noreferrer">Continue to authorization</a>
</section>`,
  );
};

export const oauthSetupUnavailableDocument = (): string =>
  document(
    "Connection setup unavailable",
    "<h1>Connection setup unavailable</h1><p>This setup link has expired or is no longer available. Close this window and start connecting again.</p>",
  );
