import type { AgentTransport } from "@a2a-channels/core";
import { TransportRegistry } from "@a2a-channels/core";

export class TransportRegistryProvider {
  readonly transportRegistry: TransportRegistry;

  constructor(transports: AgentTransport[]) {
    this.transportRegistry = new TransportRegistry();
    for (const transport of transports) {
      this.transportRegistry.register(transport);
    }
  }
}
