import {
  emptyHttpCredentials,
  type HttpCredentialsState,
} from "@executor-js/plugin-http-source/react";

export const initialGraphqlCredentials = (): HttpCredentialsState => emptyHttpCredentials();
