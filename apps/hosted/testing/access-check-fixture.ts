import { Cookies, HttpRouter } from "effect/http";
import { Effect, Schema } from "effect";
import { InProcessReadFixture } from "@executor-js/dashboard-start/in-process";
import { AuthenticationUnavailable } from "@executor-js/hosted-server";

export const accessCheckCookie = "executor-test-access-check";
const Mode = Schema.Literals(["refuse", "unavailable", "fail", "stall"]);
const accessPath = /^\/api\/organizations\/[^/]+\/access$/;
export const signInSettingsCookie = "executor-test-sign-in-settings";
const signInSettingsPath = "/api/auth/self-host/config";
const stallMs = 12_000;

const stall = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, stallMs);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

const refusedPath = "/api/organizations/access-check-refused/access";

const fixture = (pipeline: (request: Request) => Promise<Response>) => {
  const reads = new Set<Promise<unknown>>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const cookies = Cookies.parseHeader(request.headers.get("cookie") ?? "");
    if (url.pathname === signInSettingsPath && cookies[signInSettingsCookie] === "stall") {
      await stall(request.signal);
      request.signal.throwIfAborted();
      return pipeline(request);
    }
    const mode = Schema.decodeUnknownOption(Mode)(cookies[accessCheckCookie]);
    if (mode._tag === "None" || !accessPath.test(url.pathname)) {
      const response = pipeline(request);
      const settled = response.then(
        () => undefined,
        () => undefined,
      );
      reads.add(settled);
      void settled.then(() => reads.delete(settled));
      return response;
    }
    if (mode.value === "stall") await new Promise((resolve) => setTimeout(resolve, stallMs));
    const answer = await pipeline(
      mode.value === "refuse" || mode.value === "stall"
        ? new Request(new URL(refusedPath + url.search, url), request)
        : request,
    );
    await Promise.all(reads);
    if (mode.value === "fail") throw new TypeError("The test host failed this access check");
    if (mode.value === "unavailable")
      return Response.json(
        Schema.encodeUnknownSync(AuthenticationUnavailable)(new AuthenticationUnavailable({})),
        { status: 503 },
      );
    return answer;
  };
};

export const accessCheckFixture = HttpRouter.middleware(
  (serve) => Effect.provideService(serve, InProcessReadFixture, fixture),
  { global: true },
);
