import { Random } from "alchemy";

export const appDomainControlSecretId = "AppDomainControlSecret";
export const appDomainControlSecret = Random(appDomainControlSecretId);
