/**
 * Test host only: a document's in-process organization access check refuses, reports an outage,
 * fails in transport, or refuses only after the render deadline, while the page's other reads run
 * normally. Both run the same organization middleware,
 * so no request from outside can produce that split. Production entry points never provide it.
 */
import { Cookies, HttpRouter } from "effect/http";
import { Effect, Schema } from "effect";
import { InProcessReadFixture } from "@executor-js/dashboard-start/in-process";
import { AuthenticationUnavailable } from "@executor-js/hosted-server";

/** The browser cookie that selects the access check's answer for documents it requests. */
export const accessCheckCookie = "executor-test-access-check";
const Mode = Schema.Literals(["refuse", "unavailable", "fail", "stall"]);
const accessPath = /^\/api\/organizations\/[^/]+\/access$/;
/** No organization has this slug, so the product refuses it as it refuses any unknown one. */
const refusedPath = "/api/organizations/access-check-refused/access";

const fixture = (pipeline: (request: Request) => Promise<Response>) => {
  const reads = new Set<Promise<unknown>>();
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const mode = Schema.decodeUnknownOption(Mode)(
      Cookies.parseHeader(request.headers.get("cookie") ?? "")[accessCheckCookie],
    );
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
    // Past the dashboard's 10-second render deadline, so the page renders without an answer.
    if (mode.value === "stall") await new Promise((resolve) => setTimeout(resolve, 12_000));
    // The page's reads start with this check. Answering once they have settled means a document
    // that released them early would already hold their data.
    const answer = await pipeline(
      mode.value === "refuse" || mode.value === "stall"
        ? new Request(new URL(refusedPath + url.search, url), request)
        : request,
    );
    await Promise.all(reads);
    if (mode.value === "fail") throw new TypeError("The test host failed this access check");
    // A declared failure that is not a refusal, encoded as the API encodes it.
    if (mode.value === "unavailable")
      return Response.json(
        Schema.encodeUnknownSync(AuthenticationUnavailable)(new AuthenticationUnavailable({})),
        { status: 503 },
      );
    return answer;
  };
};

/** Provide the fixture to every request the test host serves. */
export const accessCheckFixture = HttpRouter.middleware(
  (serve) => Effect.provideService(serve, InProcessReadFixture, fixture),
  { global: true },
);
