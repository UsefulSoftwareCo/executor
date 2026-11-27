export const staleRegistryDocument = {
  openapi: "3.1.0",
  info: { title: "Executor registry snapshot", version: "0" },
  paths: {
    "/api/registry/apps": {
      get: {
        operationId: "listApps",
        parameters: [{ name: "name", in: "query", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "Published apps",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
  },
};
