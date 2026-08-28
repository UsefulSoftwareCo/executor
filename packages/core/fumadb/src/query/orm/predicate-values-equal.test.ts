import { describe, expect, it } from "@effect/vitest";

import { predicateValuesEqual } from "./index";

describe("predicateValuesEqual", () => {
  it("treats a sparse-array hole as unequal to a present element, in both orders", () => {
    // oxlint-disable-next-line unicorn/no-new-array -- the sparse array is the case under test
    expect(predicateValuesEqual(Array(1), [123])).toBe(false);
    // oxlint-disable-next-line unicorn/no-new-array -- the sparse array is the case under test
    expect(predicateValuesEqual([123], Array(1))).toBe(false);
  });

  it("treats arrays with matching holes as equal", () => {
    // oxlint-disable-next-line unicorn/no-new-array -- the sparse array is the case under test
    expect(predicateValuesEqual(Array(2), Array(2))).toBe(true);
  });

  it("keeps structural equality for dense arrays", () => {
    expect(
      predicateValuesEqual([BigInt(7), new Date(5), Number.NaN], [BigInt(7), new Date(5), Number.NaN]),
    ).toBe(true);
    expect(predicateValuesEqual([1, 2], [1, 3])).toBe(false);
    expect(predicateValuesEqual([1, undefined], [1, undefined])).toBe(true);
  });

  it("keeps the existing Date, Uint8Array, and record handling", () => {
    expect(predicateValuesEqual(new Date(5), new Date(5))).toBe(true);
    expect(predicateValuesEqual(new Date(5), new Date(6))).toBe(false);
    expect(predicateValuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(predicateValuesEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false);
    expect(predicateValuesEqual({ a: BigInt(1) }, { a: BigInt(1) })).toBe(true);
    expect(predicateValuesEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
  });
});
