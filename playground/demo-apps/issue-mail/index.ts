import { defineApp } from "apps";
import { requirements } from "./context.ts";
import { findMail } from "./tools.ts";
import { issueOpened } from "./webhooks.ts";

export default defineApp(requirements, {
  queries: { findMail },
  webhooks: { issueOpened },
});
