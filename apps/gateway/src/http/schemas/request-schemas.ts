import type {
  CreateChannelBindingData,
  UpdateChannelBindingData,
} from "../../application/channel-binding-service.js";
import type {
  RegisterAgentData,
  UpdateAgentData,
} from "../../application/agent-service.js";
import { z } from "../utils/schema.js";

const nonEmptyString = z.string().min(1);

/**
 * HTTP request schemas are owned by the transport layer.
 *
 * They describe the public JSON contract and can apply API-specific defaults
 * without coupling the application layer to a validation library.
 */
export const createChannelBindingBodySchema: z.ZodType<CreateChannelBindingData> =
  z.object({
    name: nonEmptyString,
    channelType: z.string().default("feishu"),
    accountId: z.string().optional(),
    channelConfig: z.record(z.string(), z.unknown()),
    agentId: nonEmptyString,
    enabled: z.boolean().default(true),
  });

export const updateChannelBindingBodySchema: z.ZodType<UpdateChannelBindingData> =
  z.object({
    name: z.string().optional(),
    channelType: z.string().optional(),
    accountId: z.string().optional(),
    channelConfig: z.record(z.string(), z.unknown()).optional(),
    agentId: z.string().optional(),
    enabled: z.boolean().optional(),
  });

export const startChannelQrLoginBodySchema = z.object({
  accountId: z.string().optional(),
  force: z.boolean().optional(),
});

export const waitForChannelQrLoginBodySchema = z.object({
  accountId: z.string().optional(),
  sessionKey: z.string().optional(),
  timeoutMs: z.number().int().positive().max(480_000).optional(),
});

export const registerAgentBodySchema: z.ZodType<RegisterAgentData> = z.object({
  name: nonEmptyString,
  url: nonEmptyString,
  protocol: z.string().default("a2a"),
  description: z.string().optional(),
});

export const updateAgentBodySchema: z.ZodType<UpdateAgentData> = z.object({
  name: z.string().optional(),
  url: z.string().optional(),
  protocol: z.string().optional(),
  description: z.string().optional(),
});
