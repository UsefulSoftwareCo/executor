import { describe, expect, it } from "@effect/vitest";

import { httpCredentialsValid } from "@executor-js/plugin-http-source/react";
import { initialGraphqlCredentials } from "./defaults";

describe("initialGraphqlCredentials", () => {
  it("does not add an incomplete default header that blocks OAuth sign-in", () => {
    const credentials = initialGraphqlCredentials();

    expect(credentials.headers).toEqual([]);
    expect(credentials.queryParams).toEqual([]);
    expect(httpCredentialsValid(credentials)).toBe(true);
  });
});
