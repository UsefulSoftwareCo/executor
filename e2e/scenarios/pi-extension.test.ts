// Cross-target: the published Pi extension against a real Executor. Nothing
// here is target-specific — the extension only needs an MCP endpoint and a
// bearer, which is exactly the claim worth testing on every target that serves
// them (cloud's org-scoped /{org}/mcp path included).
//
// The package is packed and installed through Pi's own package manager, then
// discovered, loaded, and wrapped by Pi's own loader (src/clients/pi.ts). So
// what runs is the whole user path — `pi install npm:@executor-js/pi`, the
// `pi` manifest, the default export, `/executor`, Pi's tool wrapper — with only
// the LLM left out: a model picks these tools, it does not make them work.
import { expect } from "@effect/vitest";
import { Effect } from "effect";

import { installPi, piToolText } from "../src/clients/pi";
import { scenario } from "../src/scenario";
import { Mcp, Target } from "../src/services";
import type { Identity } from "../src/target";

const emailOf = (identity: Identity): string => identity.credentials?.email ?? identity.label;

scenario(
  "Pi · the installed Executor extension drives execute, skills, and resume over MCP",
  { timeout: 300_000 },
  Effect.gen(function* () {
    const target = yield* Target;
    const mcp = yield* Mcp;
    const identity = yield* target.newIdentity();
    const bearer = yield* mcp.mintBearer(emailOf(identity));

    // The environment a user copies out of Executor's Connect card and API
    // Keys page — the extension's only configuration.
    const pi = yield* Effect.promise(() =>
      installPi({ EXECUTOR_MCP_URL: mcp.url, EXECUTOR_API_KEY: bearer }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => pi.close()));

    expect(
      pi.loadedExtensions.some((path) => path.includes("@executor-js/pi")),
      "Pi installed the package and loaded its extension from node_modules",
    ).toBe(true);
    expect(pi.toolNames, "Executor's three tools joined Pi's registry").toEqual(
      expect.arrayContaining(["executor_execute", "executor_skills", "executor_resume"]),
    );

    // `/executor` is the one thing a Pi user runs before trusting the install.
    const [status] = yield* Effect.promise(() => pi.runCommand("/executor"));
    expect(status?.type, "the connection check succeeded").toBe("info");
    expect(status?.message, "it reports the endpoint it resolved").toContain(mcp.url);
    expect(status?.message, "pinned to the elicitation mode the resume schema assumes").toContain(
      "elicitation_mode=model",
    );
    expect(status?.message, "and the tools Executor actually serves").toContain("execute");

    const executed = yield* Effect.promise(() =>
      pi.callTool("executor_execute", { code: "return 21 * 2;" }),
    );
    expect(piToolText(executed), "the sandbox ran the code and returned it").toContain("42");

    const documented = yield* Effect.promise(() =>
      pi.callTool("executor_skills", { name: "execute" }),
    );
    expect(
      piToolText(documented).length,
      "the execute guide comes back for the model to read",
    ).toBeGreaterThan(0);

    // Resume needs a paused execution to actually resume, which needs a policy
    // that gates a tool — far more setup than this scenario is for. What is
    // worth proving here is the part that silently breaks: that the server
    // ACCEPTS the arguments this package advertises. A schema mismatch fails
    // as an MCP argument-validation error; an accepted call fails on the
    // unknown id instead, which is what we assert.
    const refused = yield* Effect.promise(() =>
      pi.callTool("executor_resume", { executionId: "exec_does_not_exist", action: "accept" }).then(
        () => "resolved",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      ),
    );
    expect(refused, "the server took the arguments and answered about the id").toContain(
      "exec_does_not_exist",
    );
  }).pipe(Effect.scoped),
);
