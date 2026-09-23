/** The control key has one Alchemy owner. Teardown reads that owner's state, including after an interrupted create. */
import { Random } from "alchemy";

/** Stable root resource identity shared by the API binding, resume action and teardown. */
export const appDomainControlSecretId = "AppDomainControlSecret";
/** Generated and retained by Alchemy; never supplied through a deployment credential. */
export const appDomainControlSecret = Random(appDomainControlSecretId);
