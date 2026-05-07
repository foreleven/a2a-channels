export interface ScheduledJobRecord {
  id: string;
  name: string;
  channelBindingId: string;
  sessionKey: string;
  prompt: string;
  cronExpression: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}
