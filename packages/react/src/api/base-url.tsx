import {
  getExecutorApiBaseUrl,
  getExecutorServerAuthPassword,
  setExecutorServerApiBaseUrl,
} from "./server-connection";

export const getBaseUrl = (): string => getExecutorApiBaseUrl();

export const setBaseUrl = (url: string): void => {
  setExecutorServerApiBaseUrl(url);
};

export const getAuthPassword = (): string | null => getExecutorServerAuthPassword();
