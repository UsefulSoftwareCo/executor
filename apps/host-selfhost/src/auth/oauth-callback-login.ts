import { loginPath } from "./return-to";

export const OAUTH_CALLBACK_PATH = "/api/oauth/callback";

interface SessionAuth {
  readonly api: {
    readonly getSession: (input: { readonly headers: Headers }) => Promise<unknown | null>;
  };
}

export const oauthCallbackSignInRedirectLocation = async (
  request: Request,
  auth: SessionAuth,
): Promise<string | null> => {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const url = new URL(request.url);
  if (url.pathname !== OAUTH_CALLBACK_PATH) return null;

  const session = await auth.api.getSession({ headers: request.headers });
  if (session) return null;

  return loginPath(`${url.pathname}${url.search}`);
};
