import { describe, expect, it } from "@effect/vitest";

import {
  credentialAttemptItemId,
  makeCredentialWriteAttempt,
  parseCredentialWriteAttempt,
} from "./credential-item-reference";

describe("credential write attempt metadata", () => {
  it("never classifies an opaque provider item id as executor-owned", () => {
    expect(parseCredentialWriteAttempt("vault:attempt:foreign:item")).toBeNull();
  });

  it("classifies generated references only through their separate metadata", () => {
    const metadata = makeCredentialWriteAttempt("runtime-1", "attempt-1");
    const itemId = credentialAttemptItemId(
      "connection:org:integration:name:extra:attempt:foreign",
      metadata.attemptId,
    );

    expect(itemId).toContain(":attempt:");
    expect(parseCredentialWriteAttempt(itemId)).toBeNull();
    expect(parseCredentialWriteAttempt(metadata)).toEqual(metadata);
    expect(
      parseCredentialWriteAttempt('{"runtimeId":"runtime-1","attemptId":"attempt-1"}'),
    ).toEqual(metadata);
  });
});
