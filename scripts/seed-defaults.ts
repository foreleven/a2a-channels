#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import type {
  AgentConfigRepository,
  ChannelBindingRepository,
} from "@a2a-channels/domain";

import { AgentService } from "../apps/gateway/src/application/agent-service.js";
import { AccountIdGenerator } from "../apps/gateway/src/application/account-id-generator.js";
import { ChannelBindingService } from "../apps/gateway/src/application/channel-binding-service.js";
import { AgentConfigStateRepository } from "../apps/gateway/src/infra/agent-config-repo.js";
import { ChannelBindingStateRepository } from "../apps/gateway/src/infra/channel-binding-repo.js";
import {
  LocalRuntimeEventBus,
  type RuntimeEventBus,
} from "../apps/gateway/src/runtime/event-transport/index.js";
import { prisma } from "../apps/gateway/src/store/prisma.js";

export interface DefaultSeedWriterDependencies {
  agentService?: AgentService;
  bindingService?: ChannelBindingService;
  agentRepo?: AgentConfigRepository;
  bindingRepo?: ChannelBindingRepository;
  eventBus?: RuntimeEventBus;
  env?: NodeJS.ProcessEnv;
}

export class DefaultSeedWriter {
  private readonly agentService: AgentService;
  private readonly bindingService: ChannelBindingService;
  private readonly bindingRepo: ChannelBindingRepository;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: DefaultSeedWriterDependencies = {}) {
    const agentRepo = deps.agentRepo ?? new AgentConfigStateRepository();
    const bindingRepo = deps.bindingRepo ?? new ChannelBindingStateRepository();
    const eventBus = deps.eventBus ?? new LocalRuntimeEventBus();

    this.agentService =
      deps.agentService ?? new AgentService(agentRepo, bindingRepo, eventBus);
    this.bindingService =
      deps.bindingService ??
      new ChannelBindingService(
        bindingRepo,
        agentRepo,
        eventBus,
        new AccountIdGenerator(),
      );
    this.bindingRepo = bindingRepo;
    this.env = deps.env ?? process.env;
  }

  async write(): Promise<void> {
    let defaultAgent = (await this.agentService.list())[0];
    if (!defaultAgent) {
      defaultAgent = await this.agentService.register({
        name: "Echo Agent",
        protocol: "a2a",
        config: { url: this.env["ECHO_AGENT_URL"] ?? "http://localhost:3001" },
        description: "Built-in echo agent - mirrors every message back",
      });
    }

    const appId = this.env["FEISHU_APP_ID"];
    const appSecret = this.env["FEISHU_APP_SECRET"];

    if (!appId || !appSecret) {
      return;
    }

    const accountId = this.env["FEISHU_ACCOUNT_ID"] ?? "default";
    const existing = await this.bindingRepo.findByChannelAccount(
      "feishu",
      accountId,
    );
    if (existing) {
      return;
    }

    await this.bindingService.create({
      name: "Bootstrap Feishu Bot",
      channelType: "feishu",
      accountId,
      channelConfig: {
        appId,
        appSecret,
        verificationToken: this.env["FEISHU_VERIFICATION_TOKEN"] || undefined,
        encryptKey: this.env["FEISHU_ENCRYPT_KEY"] || undefined,
        allowFrom: ["*"],
      },
      agentId: defaultAgent.id,
      enabled: true,
    });
  }
}

async function main(): Promise<void> {
  await new DefaultSeedWriter().write();
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main().finally(async () => {
    await prisma.$disconnect();
  });
}
