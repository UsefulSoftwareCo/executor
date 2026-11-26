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

export const planted = {
  revealed: "rvl1-planted-revealed-secret",
  password: "pwd1-planted-url-password",
  query: "qry1-planted-query-value",
  header: "hdr1-planted-header-value",
  cookie: "ck01-planted-cookie-value",
  opaque: "Pl4nt3dOpaqueT0ken9q8w7e6r5t4y3u2i1o0pAsDfGhJkLz",
  typed: "typ1-planted-typed-value",
  consoleQuery: "cqy1-planted-console-query",
  consoleSecret: "csl1-planted-console-secret",
  straddle: "std1-planted-straddle-secret",
  splitToken: "Spl1tT0kenAb12Cd34Ef56Gh78Ij90Kl12Mn34Op56Qr78St90Uv",
  splitPiece: "Ij90Kl12Mn",
  refusedHeader: "rfh1-planted-refused-header",
  replaced: "rpl1-planted-replacement-secret",
  oauthState: "ost1-planted-oauth-state",
  preparationHeader: "prp1-planted-preparation-header",
  loginCookie: "lgn1-planted-login-cookie",
} as const;

export const shapes = {
  jwt: {
    value:
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkLWp3dCIsIm5hbWUiOiJGYWlsdXJlIn0.Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5",
    title: "A JWT sent as a bearer token is masked",
  },
  signedCookie: {
    value: "sgc1Token.sig/Planted+Value=",
    title: "A signed session cookie seen URL-encoded is masked",
  },
  axiom: {
    value: "xaat-6f1c2a9e-4b7d-4e8a-9c3f-1d2e3f4a5b6c",
    title: "An xaat- token is masked",
  },
  oauthCode: {
    value: "5c0de1a2-7b3c-4d5e-8f90-a1b2c3d4e5f6",
    title: "A UUID-shaped OAuth code in a relative redirect is masked",
  },
  base64: {
    value: "B64sAbCd1234/EfGh5678/IjKl9012/MnOp3456/QrSt7890/UvWx",
    title: "A base64 secret with slashes is masked",
  },
  hex: {
    value: "fa1ceb00c0ffee1234567890abcdef1234567890abcdef12",
    title: "A hex-only key the harness created is masked",
  },
  digits: {
    value: "481516234248151623424815162342481516234248151623",
    title: "A digit-only value a response issued is masked",
  },
  webhook: {
    value: "whsec_PlantedSigningSecret0123456789",
    title: "A webhook signing secret read from configuration is masked",
  },
} as const;

export const webhookVariable = "FAILURE_TEXT_WEBHOOK_SECRET";
