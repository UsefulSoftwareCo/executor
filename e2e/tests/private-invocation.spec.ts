/** Actual external issuer + product + authored app + persistent effect readback, never a fake issuer. */
import { layer } from "@effect/vitest";
import { scenarios } from "../test-plan.ts";
import { HostedLive, withHostedCase } from "../support/case.ts";
import { privateInvocationConformance } from "../support/private-invocation.ts";

layer(HostedLive, { excludeTestServices: true })("Private invocation", (it) => {
  it.effect(scenarios.privateInvocationExternal.title, (context) =>
    withHostedCase(context, privateInvocationConformance),
  );
});
