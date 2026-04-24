export type ConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";

export interface RuntimeConnectionStatus {
  bindingId: string;
  status: ConnectionStatus;
  agentUrl?: string;
  error?: string;
  updatedAt: string;
}
