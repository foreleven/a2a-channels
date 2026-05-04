/**
 * Channel plugin registrations for the gateway.
 *
 * Add one registerXxxPlugin(host) call per OpenClaw channel plugin that
 * should be active.  No per-channel package is required – any community
 * plugin that conforms to the OpenClaw plugin API can be wired up here.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import weixinPlugin from "@openclaw/weixin";
import type { OpenClawPluginHost } from "@a2a-channels/openclaw-compat";
import { defineBundledChannelEntry } from "openclaw/plugin-sdk/channel-entry-contract";

import { OpenClawChannelPackageDescriptor } from "./runtime/channel-plugin-descriptor.js";
import { channelTypeRegistry } from "./runtime/channel-type-registry.js";

type BundledPackageChannelRegistration = {
  kind: "package-bundled";
  packageName: string;
  pluginSpecifier: string;
  pluginExportName: string;
  runtimeSpecifier?: string;
  runtimeExportName?: string;
};

type BundledOpenClawChannelRegistration = {
  kind: "openclaw-bundled";
  channelId: "slack" | "telegram";
};

type DirectPackageChannelRegistration = {
  kind: "direct-package";
  packageName: string;
  plugin: RegisterablePlugin;
};

type ChannelRegistration =
  | BundledPackageChannelRegistration
  | BundledOpenClawChannelRegistration
  | DirectPackageChannelRegistration;

type RegisterablePlugin = {
  register(api: any): void;
};

const require = createRequire(import.meta.url);

function resolveOpenClawDistDir(): string {
  const channelEntryContractPath = require.resolve(
    "openclaw/plugin-sdk/channel-entry-contract",
  );
  return dirname(dirname(channelEntryContractPath));
}

function resolvePackageRoot(packageName: string): string {
  return dirname(require.resolve(`${packageName}/package.json`));
}

function resolveOpenClawExtensionRoot(channelId: "slack" | "telegram"): string {
  return join(resolveOpenClawDistDir(), "extensions", channelId);
}

function readOpenClawBundledChannelDescriptor(
  channelId: BundledOpenClawChannelRegistration["channelId"],
): OpenClawChannelPackageDescriptor {
  return OpenClawChannelPackageDescriptor.fromPackageRoot(
    resolveOpenClawExtensionRoot(channelId),
  );
}

function readPackageChannelDescriptor(
  packageName: string,
): OpenClawChannelPackageDescriptor {
  return OpenClawChannelPackageDescriptor.fromPackageRoot(
    resolvePackageRoot(packageName),
  );
}

function buildOpenClawBundledChannelEntry(
  registration: BundledOpenClawChannelRegistration,
) {
  const descriptor = readOpenClawBundledChannelDescriptor(
    registration.channelId,
  );
  const extensionSpecifier = descriptor.extensionSpecifiers[0] ?? "./index.js";
  return defineBundledChannelEntry({
    id: descriptor.channelIds[0] ?? descriptor.pluginId,
    name: descriptor.channelIds[0] ?? descriptor.pluginId,
    description: `${descriptor.packageName} channel plugin`,
    importMetaUrl: pathToFileURL(
      join(
        resolveOpenClawExtensionRoot(registration.channelId),
        extensionSpecifier,
      ),
    ).href,
    plugin: {
      specifier: "./channel-plugin-api.js",
      exportName: `${registration.channelId}Plugin`,
    },
  });
}

function buildPackageBundledChannelEntry(
  registration: BundledPackageChannelRegistration,
) {
  const descriptor = readPackageChannelDescriptor(registration.packageName);
  const channelId = descriptor.channelIds[0] ?? descriptor.pluginId;
  const extensionSpecifier = descriptor.extensionSpecifiers[0] ?? "./index.ts";

  return defineBundledChannelEntry({
    id: channelId,
    name: channelId,
    description: `${descriptor.packageName} channel plugin`,
    importMetaUrl: pathToFileURL(
      join(resolvePackageRoot(registration.packageName), extensionSpecifier),
    ).href,
    plugin: {
      specifier: registration.pluginSpecifier,
      exportName: registration.pluginExportName,
    },
    runtime:
      registration.runtimeSpecifier && registration.runtimeExportName
        ? {
            specifier: registration.runtimeSpecifier,
            exportName: registration.runtimeExportName,
          }
        : undefined,
  });
}

function registerPlugin(
  host: OpenClawPluginHost,
  plugin: RegisterablePlugin,
  label: string,
): void {
  host.registerPlugin((api) => plugin.register(api));
  console.info(`[channel-register] ${label} registered`);
}

function registerMetadataAliases(
  host: OpenClawPluginHost,
  descriptor: OpenClawChannelPackageDescriptor,
): void {
  const targetChannelId = descriptor.channelIds[0] ?? descriptor.pluginId;
  const aliases = new Set<string>([
    ...descriptor.channelIds,
    ...descriptor.aliases,
    ...channelTypeRegistry.aliasesFor(targetChannelId),
  ]);

  aliases.delete(targetChannelId);
  for (const alias of aliases) {
    host.registerChannelAlias(alias, targetChannelId);
  }
}

function registerDirectPackagePlugin(
  host: OpenClawPluginHost,
  registration: DirectPackageChannelRegistration,
): void {
  const descriptor = readPackageChannelDescriptor(registration.packageName);
  registerPlugin(host, registration.plugin, registration.packageName);
  registerMetadataAliases(host, descriptor);
}

function registerBundledPackagePlugin(
  host: OpenClawPluginHost,
  registration: BundledPackageChannelRegistration,
): void {
  registerPlugin(
    host,
    buildPackageBundledChannelEntry(registration),
    registration.packageName,
  );
  registerMetadataAliases(
    host,
    readPackageChannelDescriptor(registration.packageName),
  );
}

function registerBundledOpenClawPlugin(
  host: OpenClawPluginHost,
  registration: BundledOpenClawChannelRegistration,
): void {
  registerPlugin(
    host,
    buildOpenClawBundledChannelEntry(registration),
    `openclaw/${registration.channelId}`,
  );
  registerMetadataAliases(
    host,
    readOpenClawBundledChannelDescriptor(registration.channelId),
  );
}

function registerChannelPlugin(
  host: OpenClawPluginHost,
  registration: ChannelRegistration,
): void {
  if (registration.kind === "direct-package") {
    registerDirectPackagePlugin(host, registration);
    return;
  }
  if (registration.kind === "openclaw-bundled") {
    registerBundledOpenClawPlugin(host, registration);
    return;
  }
  registerBundledPackagePlugin(host, registration);
}

const channelRegistrations: ChannelRegistration[] = [
  {
    kind: "package-bundled",
    packageName: "@openclaw/feishu",
    pluginSpecifier: "./channel-plugin-api.js",
    pluginExportName: "feishuPlugin",
    runtimeSpecifier: "./runtime-api.js",
    runtimeExportName: "setFeishuRuntime",
  },
  {
    kind: "package-bundled",
    packageName: "@openclaw/discord",
    pluginSpecifier: "./channel-plugin-api.js",
    pluginExportName: "discordPlugin",
    runtimeSpecifier: "./runtime-setter-api.js",
    runtimeExportName: "setDiscordRuntime",
  },
  { kind: "openclaw-bundled", channelId: "slack" },
  { kind: "openclaw-bundled", channelId: "telegram" },
  {
    kind: "package-bundled",
    packageName: "@openclaw/whatsapp",
    pluginSpecifier: "./channel-plugin-api.js",
    pluginExportName: "whatsappPlugin",
    runtimeSpecifier: "./runtime-api.js",
    runtimeExportName: "setWhatsAppRuntime",
  },
  {
    kind: "direct-package",
    packageName: "@openclaw/weixin",
    plugin: weixinPlugin,
  },
  {
    kind: "package-bundled",
    packageName: "@openclaw/qqbot",
    pluginSpecifier: "./channel-plugin-api.js",
    pluginExportName: "qqbotPlugin",
    runtimeSpecifier: "./runtime-api.js",
    runtimeExportName: "setQQBotRuntime",
  },
];

// ---------------------------------------------------------------------------
// Register all plugins with the host
// ---------------------------------------------------------------------------

export function registerAllPlugins(host: OpenClawPluginHost): void {
  for (const registration of channelRegistrations) {
    registerChannelPlugin(host, registration);
  }
}
