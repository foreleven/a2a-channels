import { injectable } from "inversify";
import type { AgentTransport } from "@a2a-channels/core";
import { TransportRegistry } from "@a2a-channels/core";
import { A2ATransport, ACPTransport } from "@a2a-channels/agent-transport";

@injectable()
export class TransportRegistryAssembler {
  readonly transportRegistry: TransportRegistry;

  constructor(
    transports: AgentTransport[] = [new A2ATransport(), new ACPTransport()],
  ) {
    this.transportRegistry = new TransportRegistry();
    for (const transport of transports) {
      this.transportRegistry.register(transport);
    }
  }
}
