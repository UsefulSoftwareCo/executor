export {
  ApiKeyAuthMethod,
  AuthCarrier,
  AuthPlacement,
  NoneAuthMethod,
  TOKEN_VARIABLE,
  apiKeyMethodLabel,
  describeApiKeyAuthMethod,
  describeNoneAuthMethod,
  normalizeAuthMethodSlugs,
  oauthBearerPlacement,
  renderAuthPlacements,
  requiredPlacementVariables,
  type RenderedAuthPlacements,
} from "./auth-method";

// Migration-only legacy vocabulary — runtime code must not use these.
export {
  LegacyApiKeyTemplate,
  LegacyTemplateValue,
  apiKeyMethodFromLegacyTemplate,
  decodeLegacyApiKeyTemplate,
} from "./legacy";
export {
  planAuthConfigMigration,
  runSqliteAuthConfigMigration,
  type AuthConfigMigrationRow,
  type AuthConfigMigrationUpdate,
  type AuthConfigTransform,
  type SqliteAuthConfigClient,
} from "./migrate";
