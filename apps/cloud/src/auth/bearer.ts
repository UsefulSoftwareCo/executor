// ---------------------------------------------------------------------------
// Bearer token parsing — single-sourced HTTP `Authorization: Bearer …` prefix.
//
// Shared by every cloud credential path that splits a bearer token off the
// `Authorization` header (the WorkOS api-key/session resolver and the MCP edge
// auth). Defined once so the literal cannot drift.
// ---------------------------------------------------------------------------

export const BEARER_PREFIX = "Bearer ";
