/** Runtime lifecycle states reported for an owned channel binding. */
export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

/** Snapshot of the last known connection state for one binding. */
export interface RuntimeConnectionStatus {
  bindingId: string;
  status: ConnectionStatus;
  agentUrl?: string;
  error?: string;
  updatedAt: string;
}
