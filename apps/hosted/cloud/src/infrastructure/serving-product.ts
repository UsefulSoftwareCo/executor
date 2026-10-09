/** App pages and MCP sessions serve deployed apps over the shared executor, and nothing else. */
import type * as Cloudflare from "alchemy/Cloudflare";
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
  request: () => noSource("request"),
});

/**
 * What app pages and MCP sessions serve: apps, profiles, accounts, skills, tools, app data and
 * build assets. This module never imports `product.ts`, so these Workers upload none of the
 * source, management, provisioning and removal code the API Worker composes.
 */
export const cloudServingProduct = (databases: Cloudflare.DurableObject<AppDataSupervisor>) =>
  cloudProductServices(databases, servingSources).pipe(Effect.map(({ services }) => services));
