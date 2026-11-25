import type * as Cloudflare from "alchemy/Cloudflare";
import type { MarkdownReader } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { cloudProductServices } from "./product-services.ts";
import type { AppSources } from "./source.ts";
import type { AppDataSupervisor } from "./app-data.ts";

const noSource = (operation: string) =>
  Effect.die(new Error(`No app source in this Worker (${operation})`));
const servingSources: AppSources = () => ({
  history: () => noSource("history"),
  create: () => noSource("create"),
  head: () => noSource("head"),
  read: () => noSource("read"),
  commit: () => noSource("commit"),
  blob: () => noSource("blob"),
  file: () => noSource("file"),
  request: () => noSource("request"),
});

const servingMarkdown: MarkdownReader = () =>
  Effect.die(new Error("No Markdown parser in this Worker"));

export const cloudServingProduct = (databases: Cloudflare.DurableObject<AppDataSupervisor>) =>
  cloudProductServices(databases, servingSources, servingMarkdown).pipe(
    Effect.map(({ services }) => services),
  );
