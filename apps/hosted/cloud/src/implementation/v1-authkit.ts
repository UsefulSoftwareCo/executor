/**
 * What v1's AuthKit host (`signin.executor.sh`) answers once v2 takes it over from WorkOS
 * (`notes/v1-shutdown.md`, "AuthKit"). MCP clients that signed in to v1 hold AuthKit as their
 * authorization server; these answers send each of them to v2's:
 *
 * - The metadata is gone (404), so a client that reads it before it refreshes, as Claude Code
 *   does, finds no server there and signs in again from the MCP URL's 401, which names v2's.
 * - A refresh at the token endpoint AuthKit's metadata named is `invalid_grant` (RFC 6749
 *   section 5.2), which clients take as "sign in again". A network error or a 5xx they retry.
 * - Claude Code, finding no metadata, refreshes at the default `/token` instead, twice, and
 *   shows a 410's `error_description` as the server's issue. It keeps the stored tokens, so its
 *   menu still offers "Clear authentication", which signs in to v2 next. An `invalid_grant`
 *   there drops the tokens but not AuthKit as the server, and that menu then offers only
 *   "Authenticate", which opens AuthKit's page again. So `/token` gets the 410.
 * - A revocation succeeds: RFC 7009 answers an unknown token like a revoked one.
 * - Any page, such as the sign-in page a person's browser opens, says v1's sign-in has shut down
 *   and how to reconnect.
 *
 * Only the method and path are read; nothing from the request is echoed.
 */
import { Effect } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import { v1GonePage } from "./v1-edge.ts";

const shutDown = "Executor v1's sign-in has shut down. Sign in to Executor again.";

/** Public, credential-free answers: any origin may read them, and nothing keeps them. */
const headers = { "cache-control": "no-store", "access-control-allow-origin": "*" };

const json = (status: number, error: string) =>
  HttpServerResponse.jsonUnsafe({ error, error_description: shutDown }, { status, headers });

const page = (browser: string) =>
  v1GonePage({
    title: "Executor v1's sign-in has shut down",
    heading: "Executor v1's sign-in has shut down",
    paragraphs: [
      "This was Executor v1's sign-in page. Your MCP client still remembers v1's sign-in. Clear it in the client and connect again, and the client signs in to Executor.",
      "In Claude Code, run <code>/mcp</code>, choose the Executor server, then choose “Clear authentication” and then “Authenticate”. If it offers only “Authenticate”, remove the server and add it again with the same name and URL: <code>claude mcp remove &lt;name&gt;</code>, then <code>claude mcp add --transport http &lt;name&gt; &lt;URL&gt;</code>.",
      "In Codex, run <code>codex mcp login</code> with the server's name.",
    ],
    browser,
  });

const read = ["GET", "HEAD"];
const at = (path: string) => (pathname: string) => pathname === path;

/** The first rule whose method and path match answers. */
const rules: ReadonlyArray<{
  readonly methods: ReadonlyArray<string>;
  readonly path: (pathname: string) => boolean;
  readonly answer: (browser: string) => HttpServerResponse.HttpServerResponse;
}> = [
  // `oauth-authorization-server`, `openid-configuration`, and their path-inserted and
  // path-appended forms.
  {
    methods: read,
    path: (pathname) => pathname.includes("/.well-known/"),
    answer: () => json(404, "not_found"),
  },
  { methods: ["POST"], path: at("/oauth2/token"), answer: () => json(400, "invalid_grant") },
  {
    methods: ["POST"],
    path: at("/oauth2/revoke"),
    answer: () => HttpServerResponse.empty({ status: 200, headers }),
  },
  { methods: read, path: at("/oauth2/jwks"), answer: () => json(404, "not_found") },
  { methods: ["POST"], path: at("/oauth2/register"), answer: () => json(410, "gone") },
  // `/oauth2/authorize` and every other page.
  { methods: read, path: () => true, answer: page },
];

/** Every request to the AuthKit host. `browser` is where people open Executor. */
export const v1AuthKitHost = (browser: string) =>
  Effect.map(HttpServerRequest.HttpServerRequest, (request) => {
    const { pathname } = new URL(request.originalUrl);
    const rule = rules.find(
      (candidate) => candidate.methods.includes(request.method) && candidate.path(pathname),
    );
    return rule === undefined ? json(410, "gone") : rule.answer(browser);
  });
