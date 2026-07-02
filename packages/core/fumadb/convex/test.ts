import { createHandler } from "../src/convex";
import { v1 } from "../test/query/query.schema";

export const { mutationHandler, queryHandler } = createHandler({
  secret: "test",
  schema: v1,
});
