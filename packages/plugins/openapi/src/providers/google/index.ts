export {
  convertGoogleDiscoveryBundleToOpenApi,
  convertGoogleDiscoveryToOpenApi,
  fetchGoogleDiscoveryDocument,
  isGoogleDiscoveryUrl,
  type GoogleDiscoveryOpenApiConversion,
} from "./discovery";
export {
  googleOpenApiBundlePreset,
  googleCatalog,
  googleOpenApiPresets,
  googlePhotosOpenApiBundlePreset,
  googlePhotosOpenApiPresets,
  googlePhotosPresetIds,
  GOOGLE_PHOTOS_ICON,
  GOOGLE_PHOTOS_PRESET_ID,
  googleStandardUserOAuthPresets,
  googleOAuthConsentScopes,
  googleOAuthConsentScopesForPreset,
  googleServiceSlug,
  googleAudienceWarningsForUrls,
  googlePresetForDiscoveryUrl,
  type GoogleOpenApiOAuthAudience,
  type GoogleOpenApiPreset,
  type GooglePreset,
} from "./presets";
export {
  compactGoogleOAuthScopes,
  filterGoogleUserConsentOAuthScopes,
  isGoogleUserConsentOAuthScope,
} from "./oauth-scopes";
export { deriveGoogleDiscoveryIdentity, googleDiscoveryAdapter } from "./spec-format-adapter";
export {
  googleOpenApiOwnershipDataMigration,
  runSqliteGoogleOpenApiOwnershipMigration,
} from "./openapi-ownership-migration";
