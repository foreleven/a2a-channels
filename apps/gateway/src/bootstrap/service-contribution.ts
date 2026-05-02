export const ServiceContributionToken = Symbol.for(
  "bootstrap.ServiceContribution",
);

/** Process-level service that participates in GatewayServer lifecycle. */
export interface ServiceContribution {
  start(): Promise<void>;
  stop(): Promise<void>;
}
