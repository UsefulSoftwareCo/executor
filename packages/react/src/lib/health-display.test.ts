import { describe, expect, it } from "@effect/vitest";

import {
  HEALTH_INDICATOR_COLOR,
  HEALTH_STATUS_LABEL,
  healthStatusForDisplay,
  worstHealthStatus,
} from "./health-display";

describe("healthStatusForDisplay", () => {
  it("keeps an unknown loading verdict neutral", () => {
    const status = healthStatusForDisplay(undefined, true);

    expect(status).toBe("unknown");
    expect(HEALTH_STATUS_LABEL[status]).toBe("Unchecked");
    expect(HEALTH_INDICATOR_COLOR[status].dot).not.toBe(HEALTH_INDICATOR_COLOR.healthy.dot);
  });

  it("preserves a concrete verdict after loading completes", () => {
    expect(healthStatusForDisplay("healthy", false)).toBe("healthy");
    expect(healthStatusForDisplay("expired", false)).toBe("expired");
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
