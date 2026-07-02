import { collectTables } from "@executor-js/sdk";
import { createPgliteRuntime, type PgliteRuntime } from "./pglite";

const PORT = 5435;
const DATABASE_NAMESPACE = "executor_worker_test";

let runtime: PgliteRuntime | undefined;

export default async function setup() {
  runtime = await createPgliteRuntime({
    tables: collectTables(),
    namespace: DATABASE_NAMESPACE,
    host: "127.0.0.1",
    port: PORT,
  });

  return async () => {
    await runtime?.close();
  };
}
