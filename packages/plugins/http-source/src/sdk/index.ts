export {
  HttpCredentialInput,
  HttpConfiguredValueInput,
  HttpOAuthConfigureInput,
  OAuth2Flow,
  OAuth2SourceConfig,
  type HttpCredentialInput as HttpCredentialInputType,
  type HttpConfiguredValueInput as HttpConfiguredValueInputType,
  type HttpOAuthConfigureInput as HttpOAuthConfigureInputType,
  type OAuth2Flow as OAuth2FlowType,
  type OAuth2SourceConfig as OAuth2SourceConfigType,
} from "./types";

export {
  httpCredentialSlotKey,
  httpHeaderSlotKey,
  httpOAuthClientIdSlotKey,
  httpOAuthClientSecretSlotKey,
  httpOAuthConnectionSlotKey,
  httpQuerySlotKey,
  httpSectionSlotPrefix,
  type HttpCredentialPlacement,
  type HttpCredentialSection,
} from "./slots";

export {
  compileHttpNamedCredentialMap,
  httpCredentialInputToBindingValue,
  type CompiledHttpNamedCredentialBinding,
  type HttpNamedCredentialInput,
} from "./configure";
