import type {
  RuntimeChannelConfigSchema,
  RuntimeChannelKey,
} from "./channel-config.js";
import { FeishuRuntimeChannelConfigSchema } from "./feishu-config.js";

const schemas = new Map<RuntimeChannelKey, RuntimeChannelConfigSchema>(
  [new FeishuRuntimeChannelConfigSchema()].map((schema) => [
    schema.channelKey,
    schema,
  ]),
);

/** Applies channel-specific schema defaults and normalization when present. */
export function projectRuntimeChannelConfig(
  channelKey: RuntimeChannelKey,
  config: Record<string, unknown>,
): Record<string, unknown> {
  return schemas.get(channelKey)?.project(config) ?? config;
}

