import { describe, expect, it } from "@effect/vitest";
import { checkBuildResources } from "../scripts/check-build-resources";

// The files under apps/desktop/build/ are committed inputs that no module
// imports, so nothing else in the repo notices when they disappear. This test
// is their only reference: it runs in `bun run test` on every PR, which is the
// gate that would have stopped them being deleted before the v1.6.1 tag.
describe("desktop build resources", () => {
  it("keeps every static build input electron-builder packages and signs with", async () => {
    expect(await checkBuildResources()).toEqual([]);
  });
});
