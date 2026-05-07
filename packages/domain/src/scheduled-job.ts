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

export interface CreateScheduledJobData {
  name: string;
  channelBindingId: string;
  sessionKey: string;
  prompt: string;
  cronExpression: string;
  enabled?: boolean;
}

export interface UpdateScheduledJobData {
  name?: string;
  channelBindingId?: string;
  sessionKey?: string;
  prompt?: string;
  cronExpression?: string;
  enabled?: boolean;
}
