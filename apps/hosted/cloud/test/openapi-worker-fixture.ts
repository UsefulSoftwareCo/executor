/** Bundled importer and app runtime used by the Worker regression. */
import { Effect } from "effect";
import { compileOpenApi } from "@executor-js/app-templates";
import { defineApp, jsonSchema } from "apps";
import { createAppHandler, hostContext } from "apps/host";
import { openapiOperations } from "apps/openapi";

export default {
  async fetch() {
    const results = [];
    for (const openapi of ["3.0.3", "3.1.0"]) {
      const metadata = await Effect.runPromise(
        compileOpenApi(
          { name: "Worker reference fixture" },
          {
            openapi,
            servers: [{ url: "https://example.test" }],
            components: {
              parameters: {
                Id: {
                  name: "id",
                  in: "path",
                  required: true,
                  style: "matrix",
                  explode: true,
                  schema: { type: "object" },
                },
              },
              schemas: {
                Node: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    child: { $ref: "#/components/schemas/Node" },
                  },
                  required: ["label"],
                },
              },
              requestBodies: {
                Body: {
                  required: true,
                  content: {
                    "application/json": { schema: { $ref: "#/components/schemas/Node" } },
                  },
                },
              },
            },
            paths: {
              "/items/{id}": {
                post: {
                  operationId: "write",
                  parameters: [{ $ref: "#/components/parameters/Id" }],
                  requestBody: { $ref: "#/components/requestBodies/Body" },
                  responses: { "200": { content: { "application/json": { schema: {} } } } },
                },
              },
            },
          },
        ),
      );
      const op = metadata.operations[0];
      if (op === undefined) throw new Error("Missing imported operation");
      // Operations reference the app's shared definitions; the runtime attaches them on use.
      const validator = jsonSchema({ ...op.input, $defs: metadata.definitions });
      let rejects = false;
      try {
        validator.parse({ path: { id: {} }, body: { label: "parent", child: { label: 42 } } });
      } catch {
        rejects = true;
      }
      const handler = createAppHandler(
        defineApp({ accounts: {} }, () =>
          openapiOperations({
            ...metadata,
            fetch: async (input, init) => {
              const request = new Request(input, init);
              return Response.json({ url: request.url, body: await request.json() });
            },
          }),
        ),
      );
      const response = await handler(
        new Request("https://app.test", {
          method: "POST",
          body: JSON.stringify({
            operation: "call",
            tool: "mutations.write",
            input: {
              path: { id: { role: "admin" } },
              body: { label: "parent", child: { label: "leaf" } },
            },
          }),
        }),
        hostContext({}),
      );
      results.push({ openapi, rejects, result: await response.json() });
    }
    return Response.json(results);
  },
};
