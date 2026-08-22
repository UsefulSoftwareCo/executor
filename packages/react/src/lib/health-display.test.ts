import { describe, expect, it } from "@effect/vitest";

import {
  HEALTH_INDICATOR_COLOR,
  HEALTH_STATUS_LABEL,
  healthStatusForDisplay,
  worstHealthStatus,
} from "./health-display";

describe("healthStatusForDisplay", () => {
  it("keeps a stale healthy verdict neutral while probing", () => {
    const status = healthStatusForDisplay("healthy", true);

    expect(status).toBe("unknown");
    expect(HEALTH_STATUS_LABEL[status]).toBe("Unchecked");
    expect(HEALTH_INDICATOR_COLOR[status].dot).not.toBe(HEALTH_INDICATOR_COLOR.healthy.dot);
  });

  it("keeps a persisted expired verdict visible while probing", () => {
    const status = healthStatusForDisplay("expired", false);

    expect(status).toBe("expired");
    expect(HEALTH_STATUS_LABEL[status]).toBe("Expired");
  });

  it("preserves a concrete healthy verdict after loading completes", () => {
    expect(healthStatusForDisplay("healthy", false)).toBe("healthy");
  });
});

describe("worstHealthStatus", () => {
  it("orders expired above degraded above healthy", () => {
    expect(worstHealthStatus(["healthy", "degraded", "healthy"])).toBe("degraded");
    expect(worstHealthStatus(["degraded", "expired", "healthy"])).toBe("expired");
    expect(worstHealthStatus(["healthy", "healthy"])).toBe("healthy");
  });

  it("ignores unknown connections when aggregating", () => {
    expect(worstHealthStatus(["unknown", "healthy", "unknown"])).toBe("healthy");
    expect(worstHealthStatus(["unknown", "expired"])).toBe("expired");
  });

  it("has no verdict when nothing has been probed", () => {
    expect(worstHealthStatus([])).toBeNull();
    expect(worstHealthStatus(["unknown", "unknown"])).toBeNull();
  });
});
