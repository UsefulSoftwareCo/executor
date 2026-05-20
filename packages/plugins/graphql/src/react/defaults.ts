import {
  emptyHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/react/plugins/http-credentials";

export const initialGraphqlCredentials = (): HttpCredentialsState => emptyHttpCredentials();
