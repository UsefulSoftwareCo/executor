import { describe, expect, it } from "@effect/vitest";

import { collectRawWorkOSList, collectWorkOSList } from "./workos";

describe("collectWorkOSList", () => {
  it("collects memberships beyond the first WorkOS page", async () => {
    const autoPaginationCalls: string[] = [];

    const response = await collectWorkOSList({
      object: "list",
      data: [{ id: "om_first_page" }],
      listMetadata: {
        before: null,
        after: "om_next_page",
      },
      autoPagination: async () => {
        autoPaginationCalls.push("called");
        return [{ id: "om_first_page" }, { id: "om_second_page" }];
      },
    });

    expect(response.data).toEqual([{ id: "om_first_page" }, { id: "om_second_page" }]);
    expect(response.listMetadata).toEqual({ before: null, after: null });
    expect(autoPaginationCalls).toEqual(["called"]);
  });

  it("keeps the first page when WorkOS reports no next page", async () => {
    let autoPaginationCalls = 0;

    const response = await collectWorkOSList({
      object: "list",
      data: [{ id: "om_only_page" }],
      listMetadata: {
        before: null,
        after: null,
      },
      autoPagination: async () => {
        autoPaginationCalls += 1;
        return [{ id: "om_unexpected_page" }];
      },
    });

    expect(response.data).toEqual([{ id: "om_only_page" }]);
    expect(response.listMetadata).toEqual({ before: null, after: null });
    expect(autoPaginationCalls).toBe(0);
  });
});

describe("collectRawWorkOSList", () => {
  it("collects raw WorkOS lists using snake-case cursors", async () => {
    const requestedCursors: Array<string | undefined> = [];

    const response = await collectRawWorkOSList(async (after) => {
      requestedCursors.push(after);
      return after
        ? {
            data: [{ id: "api_key_second_page" }],
            list_metadata: {
              before: null,
              after: null,
            },
          }
        : {
            data: [{ id: "api_key_first_page" }],
            list_metadata: {
              before: null,
              after: "api_key_second_page",
            },
          };
    });

    expect(response.data).toEqual([{ id: "api_key_first_page" }, { id: "api_key_second_page" }]);
    expect(response.listMetadata).toEqual({ before: null, after: null });
    expect(requestedCursors).toEqual([undefined, "api_key_second_page"]);
  });

  it("collects raw WorkOS lists using camel-case cursors", async () => {
    const response = await collectRawWorkOSList(async (after) =>
      after
        ? {
            data: [{ id: "second" }],
            listMetadata: {
              before: null,
              after: null,
            },
          }
        : {
            data: [{ id: "first" }],
            listMetadata: {
              before: null,
              after: "second",
            },
          },
    );

    expect(response.data).toEqual([{ id: "first" }, { id: "second" }]);
  });
});
