import type { RuntimeChannelStatus } from "./api";

export interface RuntimeChannelStatusSnapshot {
  statuses: RuntimeChannelStatus[];
  generatedAt: string;
}

export class ChannelStatusEventStream {
  private source: EventSource | null = null;

  constructor(private readonly url = "/api/runtime/channel-statuses/events") {}

  connect(options: {
    onSnapshot(snapshot: RuntimeChannelStatusSnapshot): void;
    onError(error: string): void;
  }) {
    this.close();
    this.source = new EventSource(this.url);
    this.source.onerror = () => options.onError("Channel status stream is disconnected.");
    this.source.addEventListener("snapshot", (event) => {
      options.onSnapshot(JSON.parse((event as MessageEvent).data));
    });
    this.source.addEventListener("error-state", (event) => {
      options.onError(JSON.parse((event as MessageEvent).data));
    });
  }

  close() {
    this.source?.close();
    this.source = null;
  }
}
