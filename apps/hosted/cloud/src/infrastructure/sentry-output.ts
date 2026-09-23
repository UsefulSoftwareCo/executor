/** Public configuration exported by the persistent Sentry Alchemy stack. */
export interface SentryOutput {
  readonly organization: string;
  readonly browserProject: string;
  readonly cloudProject: string;
  readonly browserDsn: string;
  readonly browserTunnel: string;
  readonly cloudDsn: string;
}
