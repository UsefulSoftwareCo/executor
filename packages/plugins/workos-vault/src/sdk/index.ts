export {
  makeConfiguredWorkOSVaultClient,
  makeWorkOSVaultClient,
  WorkOSVaultClientError,
  WorkOSVaultClientInstantiationError,
  type WorkOSVaultClient,
  type WorkOSVaultCredentials,
  type WorkOSVaultObject,
  type WorkOSVaultObjectMetadata,
} from "./client";
export {
  workosVaultPlugin,
  type WorkOSVaultExtension,
  type WorkOSVaultPluginOptions,
} from "./plugin";
export {
  WORKOS_VAULT_PROVIDER_KEY,
  makeWorkOSVaultCredentialProvider,
  makeWorkosVaultStore,
  type WorkOSVaultCredentialProviderOptions,
  type WorkosVaultStore,
} from "./secret-store";
