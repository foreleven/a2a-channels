import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import type {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";

import { AgentService } from "../application/agent-service.js";
import { ChannelBindingService } from "../application/channel-binding-service.js";
import { AgentConfigStateRepository } from "../infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../infra/channel-binding-repo.js";
import { DB_PATH, prisma } from "../store/prisma.js";

export interface SeedDefaultsDependencies {
  agentService?: AgentService;
  bindingService?: ChannelBindingService;
  agentRepo?: AgentConfigRepository;
  bindingRepo?: ChannelBindingRepository;
}

const GATEWAY_DIR = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_ECHO_AGENT_URL =
  process.env["ECHO_AGENT_URL"] ?? "http://localhost:3001";

export async function initStore(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "channel_bindings" LIMIT 0`;
    await prisma.$queryRaw`SELECT 1 FROM "agents" LIMIT 0`;
    await prisma.$queryRaw`SELECT 1 FROM "outbox_events" LIMIT 0`;
  } catch {
    execSync("npx prisma db push", {
      cwd: GATEWAY_DIR,
      env: { ...process.env, DB_PATH },
      stdio: "inherit",
    });
  }
}

export async function seedDefaults(
  deps: SeedDefaultsDependencies = {},
): Promise<void> {
  const agentRepo = deps.agentRepo ?? new AgentConfigStateRepository();
  const bindingRepo = deps.bindingRepo ?? new ChannelBindingStateRepository();
  const agentService =
    deps.agentService ?? new AgentService(agentRepo, bindingRepo);
  const bindingService =
    deps.bindingService ?? new ChannelBindingService(bindingRepo, agentRepo);

  let defaultAgent = (await agentService.list())[0];
  if (!defaultAgent) {
    defaultAgent = await agentService.register({
      name: "Echo Agent",
      url: DEFAULT_ECHO_AGENT_URL,
      protocol: "a2a",
      description: "Built-in echo agent – mirrors every message back",
    });
  }

  const bootstrapAppId = process.env["FEISHU_APP_ID"];
  const bootstrapAppSecret = process.env["FEISHU_APP_SECRET"];

  if (bootstrapAppId && bootstrapAppSecret) {
    const accountId = process.env["FEISHU_ACCOUNT_ID"] ?? "default";
    const existing = await bindingRepo.findByChannelAccount("feishu", accountId);
    if (!existing) {
      await bindingService.create({
        name: "Bootstrap Feishu Bot",
        channelType: "feishu",
        accountId,
        channelConfig: {
          appId: bootstrapAppId,
          appSecret: bootstrapAppSecret,
          verificationToken: process.env["FEISHU_VERIFICATION_TOKEN"] || undefined,
          encryptKey: process.env["FEISHU_ENCRYPT_KEY"] || undefined,
          allowFrom: ["*"],
        },
        agentId: defaultAgent.id,
        enabled: true,
      });
    }
  }
}
