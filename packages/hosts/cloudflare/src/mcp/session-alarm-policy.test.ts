import { describe, expect, it } from "@effect/vitest";

import {
  MAX_PAUSED_SESSION_IDLE_MS,
  PAUSED_EXECUTION_LEASE_MS,
  SESSION_TIMEOUT_MS,
  decideSessionAlarm,
} from "./session-alarm-policy";

describe("decideSessionAlarm", () => {
  it("keeps the session within the idle timeout", () => {
    expect(
      decideSessionAlarm({
        idleMs: SESSION_TIMEOUT_MS - 1,
        pausedExecutionCount: 0,
      }),
    ).toEqual({ kind: "idle_within_timeout" });
  });

  it("stays within the idle timeout regardless of paused work", () => {
    expect(
      decideSessionAlarm({
        idleMs: SESSION_TIMEOUT_MS - 1,
        pausedExecutionCount: 3,
      }),
    ).toEqual({ kind: "idle_within_timeout" });
  });

  it("destroys an idle session with no paused work", () => {
    expect(
      decideSessionAlarm({
        idleMs: SESSION_TIMEOUT_MS,
        pausedExecutionCount: 0,
      }),
    ).toEqual({ kind: "destroy_idle_session" });
  });

  it("extends the lease when paused continuations exist", () => {
    expect(
      decideSessionAlarm({
        idleMs: SESSION_TIMEOUT_MS,
        pausedExecutionCount: 1,
      }),
    ).toEqual({
      kind: "extend_paused_lease",
      leaseMs: PAUSED_EXECUTION_LEASE_MS,
    });
  });

  it("destroys a paused session once the lease cap elapses", () => {
    expect(
      decideSessionAlarm({
        idleMs: MAX_PAUSED_SESSION_IDLE_MS,
        pausedExecutionCount: 1,
      }),
    ).toEqual({ kind: "destroy_idle_session" });
  });
});
