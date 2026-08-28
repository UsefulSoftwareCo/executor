// A health check writes its response sample into `connection.last_health`, so
// whatever the sample carries is persisted. The operation being probed is
// user-chosen from the plugin's catalog, which means it can be a key-listing
// endpoint just as easily as a `/me`.
//
// These use real response bodies of the shape those endpoints return, because
// the property under test is what survives the walk into the database.

import { describe, expect, it } from "@effect/vitest";

import { extractResponseFields, REDACTED_SAMPLE_VALUE } from "./health-check";

/** The sample as a path -> value lookup, which is how the assertions read. */
const byPath = (data: unknown): Record<string, string> =>
  Object.fromEntries(extractResponseFields(data).map((f) => [f.path, f.value]));

describe("health-check response sample redaction", () => {
  it("redacts credential-named leaves while keeping the identity fields", () => {
    const fields = byPath({
      email: "alex@example.com",
      login: "alex",
      id: 4711,
      api_key: "sk-live-must-not-be-persisted",
      refresh_token: "rt-must-not-be-persisted",
      session: "sess-must-not-be-persisted",
    });

    // The reason the sample exists still works.
    expect(fields.email).toBe("alex@example.com");
    expect(fields.login).toBe("alex");
    expect(fields.id).toBe("4711");

    expect(fields.api_key).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields.refresh_token).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields.session).toBe(REDACTED_SAMPLE_VALUE);
  });

  it("redacts nested and array-borne credentials, not just top-level ones", () => {
    // What a key-listing endpoint actually returns. This is the case a scrub
    // of the connection's own value cannot catch: these are different secrets.
    const fields = byPath({
      keys: [
        { name: "prod", token: "sk-prod-must-not-be-persisted" },
        { name: "staging", token: "sk-staging-must-not-be-persisted" },
      ],
      account: { billing: { secret: "whsec-must-not-be-persisted" } },
    });

    expect(fields["keys.0.name"]).toBe("prod");
    expect(fields["keys.0.token"]).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields["keys.1.token"]).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields["account.billing.secret"]).toBe(REDACTED_SAMPLE_VALUE);
  });

  it("redacts a bare array of secrets, where only the enclosing key names them", () => {
    // `{"tokens": ["sk-…"]}` yields the paths `tokens.0`, `tokens.1`. Their last
    // segment is an array index, so a check that reads the literal leaf finds
    // "0" and lets the secret straight through into `connection.last_health`.
    const fields = byPath({
      tokens: ["sk-live-must-not-be-persisted", "sk-test-must-not-be-persisted"],
      names: ["prod", "staging"],
    });

    expect(fields["tokens.0"]).toBe(REDACTED_SAMPLE_VALUE);
    expect(fields["tokens.1"]).toBe(REDACTED_SAMPLE_VALUE);

    // The index walk-back stops at the nearest NAMED segment, so an innocent
    // collection is still shown in full.
    expect(fields["names.0"]).toBe("prod");
    expect(fields["names.1"]).toBe("staging");
  });

  it("redacts camelCase credential keys, in both spellings", () => {
    // `accessToken` has no non-letter before `Token`, so a matcher that only
    // looks for a separator reads it as innocent. camelCase is the dominant
    // spelling in JSON APIs, so this is not an edge case.
    const fields = byPath({
      accessToken: "at-must-not-be-persisted",
      refreshToken: "rt-must-not-be-persisted",
      clientSecret: "cs-must-not-be-persisted",
      privateKey: "pk-must-not-be-persisted",
      sessionId: "sid-must-not-be-persisted",
      // Still matched as one contiguous word, which is how it has always
      // matched: splitting on the case boundary alone would lose it.
      apiKey: "ak-must-not-be-persisted",
    });

    for (const value of Object.values(fields)) {
      expect(value).toBe(REDACTED_SAMPLE_VALUE);
    }
  });

  it("does not redact camelCase keys that merely start with a matching word", () => {
    // The other direction of the same change: exposing the case boundary must
    // not turn ordinary fields into blanks.
    const fields = byPath({
      author: "alex",
      authors: "alex, sam",
      authorName: "Alex",
      privacyLevel: "public",
      tokenizer: "bpe",
    });

    expect(fields.author).toBe("alex");
    expect(fields.authors).toBe("alex, sam");
    expect(fields.authorName).toBe("Alex");
    expect(fields.privacyLevel).toBe("public");
    expect(fields.tokenizer).toBe("bpe");
  });

  it("redacts a secret under an innocent leaf inside a credential-named array", () => {
    // The shape a key-listing endpoint actually returns. The nearest named
    // segment is the harmless `value`; only the array's own key says what the
    // collection holds.
    const fields = byPath({
      api_keys: [{ name: "prod", value: "sk-live-must-not-be-persisted" }],
      names: ["prod", "staging"],
      results: [{ value: "42" }],
    });

    expect(fields["api_keys.0.value"]).toBe(REDACTED_SAMPLE_VALUE);

    // An array whose key names nothing is untouched, at either depth.
    expect(fields["names.0"]).toBe("prod");
    expect(fields["results.0.value"]).toBe("42");
  });

  it("scrubs a known credential value before truncating, not after", () => {
    // A credential can sit under a key that names nothing — the body echoing
    // back the key it was authenticated with. Only the caller can recognise it,
    // by exact value. Truncating first cuts it to a 120-char prefix that the
    // exact-value scrub no longer matches, and that prefix is what reaches
    // `connection.last_health`.
    const secret = `sk-live-${"x".repeat(200)}`;
    expect(secret.length).toBeGreaterThan(120);

    const sample = extractResponseFields(
      { data: secret },
      { scrub: (value) => value.split(secret).join(REDACTED_SAMPLE_VALUE) },
    );

    expect(sample[0]?.value).toBe(REDACTED_SAMPLE_VALUE);
    // Not merely "shorter than the secret": assert no recognisable prefix of it
    // survived, which is the actual leak.
    expect(sample[0]?.value).not.toContain("sk-live-");
  });

  it("still truncates a long value the scrub does not recognise", () => {
    // Reordering must not disable the cap for everything else.
    const long = "y".repeat(400);
    const sample = extractResponseFields({ blob: long }, { scrub: (value) => value });

    expect(sample[0]?.value).toBe(`${"y".repeat(120)}...`);
  });

  it("keeps the field visible so the preview still shows the shape", () => {
    // Dropping the row would change what the picker displays. Redacting the
    // value keeps the response shape legible without persisting the secret.
    const sample = extractResponseFields({ api_key: "sk-live-x" });

    expect(sample).toHaveLength(1);
    expect(sample[0]?.path).toBe("api_key");
  });

  it("does not redact identity keys that merely contain a matching substring", () => {
    // `author` contains "auth". Matching it would silently blank a normal
    // field, which is how an over-eager redactor makes the feature useless.
    const fields = byPath({ author: "alex", authorization: "Bearer x" });

    expect(fields.author).toBe("alex");
    expect(fields.authorization).toBe(REDACTED_SAMPLE_VALUE);
  });

  it("POSITIVE CONTROL: an unredacted body does come through verbatim", () => {
    // Proves these assertions can fail. Without it, an extractor that returned
    // nothing, or redacted everything, would satisfy the checks above.
    const fields = byPath({ email: "alex@example.com", plan: "pro" });

    expect(fields.email).toBe("alex@example.com");
    expect(fields.plan).toBe("pro");
    expect(Object.values(fields)).not.toContain(REDACTED_SAMPLE_VALUE);
  });
});
