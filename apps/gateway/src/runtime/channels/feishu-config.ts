import { z } from "zod";

import type {
  RuntimeChannelConfigSchema,
  RuntimeChannelKey,
} from "./channel-config.js";

const REPLY_IN_THREAD_VALUES = ["enabled", "disabled"] as const;
const GROUP_POLICY_VALUES = ["open", "allowlist", "disabled"] as const;

const streamingSchema = z.preprocess(
  (value) => normalizeBoolean(value),
  z.boolean().default(true),
);

const requireMentionSchema = z.preprocess(
  (value) => normalizeBoolean(value),
  z.boolean().default(true),
);

const replyInThreadSchema = z.preprocess(
  (value) => normalizeReplyInThread(value),
  z.enum(REPLY_IN_THREAD_VALUES).default("enabled"),
);

const optionalReplyInThreadSchema = z.preprocess(
  (value) => normalizeReplyInThread(value),
  z.enum(REPLY_IN_THREAD_VALUES).optional(),
);

const groupPolicySchema = z.preprocess(
  (value) => normalizeGroupPolicy(value),
  z.enum(GROUP_POLICY_VALUES).default("open"),
);

const feishuGroupConfigSchema = z.preprocess(
  (value) => (isPlainRecord(value) ? value : {}),
  z
    .object({
      replyInThread: optionalReplyInThreadSchema,
    })
    .catchall(z.unknown())
    .transform(({ replyInThread, ...groupConfig }) => {
      if (!replyInThread) {
        return groupConfig;
      }

      return {
        ...groupConfig,
        replyInThread,
      };
    }),
);

const feishuAccountConfigSchema = z
  .object({
    streaming: streamingSchema,
    groupPolicy: groupPolicySchema,
    requireMention: requireMentionSchema,
    replyInThread: replyInThreadSchema,
    groups: z.preprocess(
      (value) => (isPlainRecord(value) ? value : undefined),
      z.record(z.string(), feishuGroupConfigSchema).optional(),
    ),
  })
  .catchall(z.unknown());

/** Applies gateway defaults and compatibility normalization for Feishu/Lark. */
export class FeishuRuntimeChannelConfigSchema
  implements RuntimeChannelConfigSchema
{
  readonly channelKey: RuntimeChannelKey = "feishu";

  project(config: Record<string, unknown>): Record<string, unknown> {
    return feishuAccountConfigSchema.parse(config);
  }
}

function normalizeReplyInThread(value: unknown): unknown {
  if (value === "enabled" || value === "disabled") {
    return value;
  }
  if (value === true) {
    return "enabled";
  }
  if (value === false) {
    return "disabled";
  }
  return undefined;
}

function normalizeGroupPolicy(value: unknown): unknown {
  if (
    value === "open" ||
    value === "allowlist" ||
    value === "disabled"
  ) {
    return value;
  }
  if (value === "allowall") {
    return "open";
  }
  return undefined;
}

function normalizeBoolean(value: unknown): unknown {
  return typeof value === "boolean" ? value : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
