/** App pages and MCP sessions serve deployed apps over the shared executor, and nothing else. */
import type * as Cloudflare from "alchemy/Cloudflare";
import type { MarkdownReader } from "@executor-js/sdk/core";
import { Effect } from "effect";
import { cloudProductServices } from "./product-services.ts";
import type { AppSources } from "./source.ts";
import type { AppDataSupervisor } from "./app-data.ts";

/**
 * Nothing app pages or MCP sessions run reads or writes app source: deploys, authoring and Git
 * requests are served by the API Worker. So they upload no Git client, and a source operation in
 * one of them is a defect, not a missing repository.
 */
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

/**
 * Deploys, which read authored Markdown, are served by the API Worker too. So these Workers neither
 * parse Markdown nor bind the Formatter Worker that does, and reading it in one of them is a
 * defect. It is not `MarkdownUnavailable`, which would ask the caller to retry a request that
 * cannot succeed here and report a routing bug as an outage.
 */
const servingMarkdown: MarkdownReader = () =>
  Effect.die(new Error("No Markdown parser in this Worker"));

/**
 * What app pages and MCP sessions serve: apps, accounts and their links, skills, tools, app data and
 * build assets. This module never imports `product.ts`, so these Workers upload none of the
 * source, management, provisioning and removal code the API Worker composes.
 */
export const cloudServingProduct = (databases: Cloudflare.DurableObject<AppDataSupervisor>) =>
  cloudProductServices(databases, servingSources, servingMarkdown).pipe(
    Effect.map(({ services }) => services),
  );
