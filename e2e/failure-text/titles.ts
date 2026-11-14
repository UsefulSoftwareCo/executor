/** Titles and planted secrets shared by the cases that fail on purpose and the scenario reading them. */
export const failureTextCases = {
  nodeProtocol: "A Node protocol error names its code and message",
  strictMode: "A Playwright strict-mode violation lists the elements it matched",
  timeout: "A Playwright timeout says what it was waiting for",
  request: "A Playwright request keeps its call log without credentials, queries or headers",
  echoed: "An error that echoes a secret keeps its message and causes without it",
  pageErrors: "Page errors a case expects none of are listed in its failure",
  consoleErrors: "Console errors keep their page and message without the secrets in either",
  filled: "A fill that times out keeps its call log without the typed text",
  straddle: "A revealed secret across the line length limit is masked before the line is cut",
  split: "An unrevealed token holding a revealed one is masked whole",
  requestFailed: "A request that fails before it is sent names its cause without its header",
  replaced: "A replaced response that fails names its cause without its secrets",
  sessionCookie: "A session cookie the product set is masked once the harness reads it",
  login: "A cookie the browser is signed in with is masked",
  preparation:
    "An organization preparation could not make ready records its request and causes without secrets",
  passing: "A passing case records no failure text",
} as const;

/**
 * Synthetic secrets the cases plant in their failures, one for each place a secret can appear.
 * Each starts with a distinct ten characters, so a scan finds a cut-off one too. No output of the
 * cases may contain any of them, nor their URL-encoded or base64 forms.
 */
export const planted = {
  /** Revealed to a call through `reveal`, so it is masked wherever it appears. */
  revealed: "rvl1-planted-revealed-secret",
  /** A URL's userinfo password. */
  password: "pwd1-planted-url-password",
  /** A URL's query and fragment. */
  query: "qry1-planted-query-value",
  /** A request header's value. */
  header: "hdr1-planted-header-value",
  /** A cookie header's value. */
  cookie: "ck01-planted-cookie-value",
  /** A token the harness never revealed: an unbroken 48-character run of letters and digits. */
  opaque: "Pl4nt3dOpaqueT0ken9q8w7e6r5t4y3u2i1o0pAsDfGhJkLz",
  /** Text a case types, never revealed: Playwright logs it in `fill("…")`. */
  typed: "typ1-planted-typed-value",
  /** A console error's page query, never revealed. */
  consoleQuery: "cqy1-planted-console-query",
  /** Revealed, and written by the page to its console. */
  consoleSecret: "csl1-planted-console-secret",
  /** Revealed, and placed so the line length limit cuts through it. */
  straddle: "std1-planted-straddle-secret",
  /** Never revealed, and holding `splitPiece`, which is. */
  splitToken: "Spl1tT0kenAb12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv",
  splitPiece: "Ij90Kl12Mn",
  /** A request header the HTTP client refuses to send, never revealed. */
  refusedHeader: "rfh1-planted-refused-header",
  /** In the error of a response replacement, never revealed. */
  replaced: "rpl1-planted-replacement-secret",
  /** An OAuth redirect's state, never revealed, under a name no credential rule knows. */
  oauthState: "ost1-planted-oauth-state",
  /** In a preparation failure's inner cause, never revealed. */
  preparationHeader: "prp1-planted-preparation-header",
  /** The cookie a case signs the browser in with, revealed only by `browser.login`. */
  loginCookie: "lgn1-planted-login-cookie",
} as const;

/**
 * Secrets shaped like those of a deployed run, one case each. Each is planted where it appears in
 * practice and masked by the rule or the registration that case names.
 */
export const shapes = {
  /** An OAuth access token, sent as a bearer token: the `Bearer` rule. */
  jwt: {
    value:
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkLWp3dCIsIm5hbWUiOiJGYWlsdXJlIn0.Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5",
    title: "A JWT sent as a bearer token is masked",
  },
  /** A signed session cookie (`token.signature`), revealed raw and seen URL-encoded. */
  signedCookie: {
    value: "sgc1Token.sig/Planted+Value=",
    title: "A signed session cookie seen URL-encoded is masked",
  },
  /** An Axiom-style token, never revealed: the opaque rule. */
  axiom: {
    value: "xaat-6f1c2a9e-4b7d-4e8a-9c3f-1d2e3f4a5b6c",
    title: "An xaat- token is masked",
  },
  /** An OAuth code in a relative redirect, never revealed: the path query rule. */
  oauthCode: {
    value: "5c0de1a2-7b3c-4d5e-8f90-a1b2c3d4e5f6",
    title: "A UUID-shaped OAuth code in a relative redirect is masked",
  },
  /** A base64 secret with `/`, revealed. */
  base64: {
    value: "B64sAbCd1234/EfGh5678/IjKl9012/MnOp3456/QrSt7890/UvWx",
    title: "A base64 secret with slashes is masked",
  },
  /** A hex-only key the harness created as a secret (`secret`). */
  hex: {
    value: "fa1ceb00c0ffee1234567890abcdef1234567890abcdef12",
    title: "A hex-only key the harness created is masked",
  },
  /** A digit-only value a response issued, decoded through `heldValue`. */
  digits: {
    value: "481516234248151623424815162342481516234248151623",
    title: "A digit-only value a response issued is masked",
  },
  /** A webhook signing secret read from configuration (`secretConfig`). */
  webhook: {
    value: "whsec_PlantedSigningSecret0123456789",
    title: "A webhook signing secret read from configuration is masked",
  },
} as const;

/** The variable the cases read the planted webhook signing secret from. */
export const webhookVariable = "FAILURE_TEXT_WEBHOOK_SECRET";
