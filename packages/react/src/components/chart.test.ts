import { describe, expect, it } from "@effect/vitest";

import { chartCssColorValue, chartCssVariableName } from "./chart";

describe("chart style helpers", () => {
  it("accepts CSS-safe chart keys and colors", () => {
    expect(chartCssVariableName("requests_2xx")).toBe("--color-requests_2xx");
    expect(chartCssColorValue("#0ea5e9")).toBe("#0ea5e9");
    expect(chartCssColorValue("rgb(14 165 233 / 50%)")).toBe("rgb(14 165 233 / 50%)");
    expect(chartCssColorValue("var(--chart-1)")).toBe("var(--chart-1)");
  });

  it("rejects style-breaking keys and color values", () => {
    expect(chartCssVariableName("x];body{color:red")).toBeNull();
    expect(chartCssColorValue("red; background: url(https://example.test/x)")).toBeNull();
    expect(chartCssColorValue("</style><script>alert(1)</script>")).toBeNull();
  });
});
