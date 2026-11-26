import { Effect } from "effect";
import { HttpServerResponse } from "effect/http";

const OPENAI_APPS_CHALLENGE_TOKEN = "P_fW7WgF8HkXXQkP85B7aDZD_RuZv8YmQA2Zq9JoIfc";

export const openAiAppsChallenge = Effect.succeed(
  HttpServerResponse.text(OPENAI_APPS_CHALLENGE_TOKEN, {
    contentType: "text/plain; charset=utf-8",
    headers: { "cache-control": "public, max-age=300" },
  }),
);
