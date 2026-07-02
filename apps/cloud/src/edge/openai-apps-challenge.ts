import { createMiddleware } from "@tanstack/react-start";

export const OPENAI_APPS_CHALLENGE_PATH = "/.well-known/openai-apps-challenge";
export const OPENAI_APPS_CHALLENGE_TOKEN = "P_fW7WgF8HkXXQkP85B7aDZD_RuZv8YmQA2Zq9JoIfc";

export const isOpenAiAppsChallengePath = (pathname: string) =>
  pathname === OPENAI_APPS_CHALLENGE_PATH;

export const openAiAppsChallengeResponse = () =>
  new Response(OPENAI_APPS_CHALLENGE_TOKEN, {
    headers: {
      "cache-control": "public, max-age=300",
      "content-type": "text/plain; charset=utf-8",
    },
  });

export const openAiAppsChallengeMiddleware = createMiddleware({ type: "request" }).server(
  ({ pathname, next }) => {
    if (!isOpenAiAppsChallengePath(pathname)) return next();
    return openAiAppsChallengeResponse();
  },
);
