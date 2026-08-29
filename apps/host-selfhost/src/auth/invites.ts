import { type Client } from "@libsql/client";
import { libSqlClientAdapter } from "./better-auth";
import {
  ensureInviteCodeTable as sharedEnsureInviteCodeTable,
  createInviteCode as sharedCreateInviteCode,
  listInviteCodes as sharedListInviteCodes,
  revokeInviteCode as sharedRevokeInviteCode,
  findRedeemableCode as sharedFindRedeemableCode,
  consumeInviteCode as sharedConsumeInviteCode,
} from "@executor-js/api/server";

export type { InviteRole, InviteCodeRow, CreateInviteCodeInput } from "@executor-js/api/server";

export const ensureInviteCodeTable = (client: Client) =>
  sharedEnsureInviteCodeTable(libSqlClientAdapter(client));

export const createInviteCode = (client: Client, input: any) =>
  sharedCreateInviteCode(libSqlClientAdapter(client), input);

export const listInviteCodes = (client: Client) =>
  sharedListInviteCodes(libSqlClientAdapter(client));

export const revokeInviteCode = (client: Client, id: string) =>
  sharedRevokeInviteCode(libSqlClientAdapter(client), id);

export const findRedeemableCode = (client: Client, code: string) =>
  sharedFindRedeemableCode(libSqlClientAdapter(client), code);

export const consumeInviteCode = (client: Client, code: string, by: any) =>
  sharedConsumeInviteCode(libSqlClientAdapter(client), code, by);
