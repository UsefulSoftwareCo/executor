/** Host-only app authentication protocol and bootstrap; products supply identity and session lifecycle. */
export * from "./contracts/ui-auth.ts";
export { appPrivateHeaders, appSignInPage, appSignInScript } from "./implementation/ui-auth.ts";
