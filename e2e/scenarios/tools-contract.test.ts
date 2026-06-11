// Cross-target: every advertised tool carries the minimal metadata an agent
// consumer needs to pick and invoke it — a non-empty address, name, and
// description. A failure names the offending tools.
import { expect } from "@effect/vitest";
import { Effect } from "effect";
import { composePluginApi } from "@executor-js/api/server";

import { scenario } from "../src/scenario";
import { Api, Target } from "../src/services";

const coreApi = composePluginApi([] as const);

scenario(
  "Tools · every advertised tool is well-formed enough to call",
  {},
  Effect.gen(function* () {
    const target = yield* Target;
    const { client } = yield* Api;
    const identity = yield* target.newIdentity();
    const api = yield* client(coreApi, identity);
    const tools = yield* api.tools.list({ query: {} });

    expect(tools.length, "the catalog advertises tools").toBeGreaterThan(0);

    const malformed = tools
      .filter((tool) => !(tool.address?.length && tool.name?.length && tool.description?.length))
      .map((tool) => tool.address || tool.name || "(unidentifiable tool)");
    expect(malformed, "tools missing an address, name, or description").toEqual([]);
  }),
);
