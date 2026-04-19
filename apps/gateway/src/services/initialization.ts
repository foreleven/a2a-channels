import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { DB_PATH, prisma } from "../store/prisma.js";

const GATEWAY_DIR = fileURLToPath(new URL("../../", import.meta.url));
const DEFAULT_ECHO_AGENT_URL =
  process.env["ECHO_AGENT_URL"] ?? "http://localhost:3001";

export async function initStore(): Promise<void> {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "channel_bindings" LIMIT 0`;
  } catch {
    execSync("npx prisma db push", {
      cwd: GATEWAY_DIR,
      env: { ...process.env, DB_PATH },
      stdio: "inherit",
    });
  }
}

export async function seedDefaults(): Promise<void> {
  const agentCount = await prisma.agent.count();
  if (agentCount === 0) {
    await prisma.agent.create({
      data: {
        name: "Echo Agent",
        url: DEFAULT_ECHO_AGENT_URL,
        protocol: "a2a",
        description: "Built-in echo agent – mirrors every message back",
      },
    });
  }

  const bootstrapAppId = process.env["FEISHU_APP_ID"];
  const bootstrapAppSecret = process.env["FEISHU_APP_SECRET"];

  if (bootstrapAppId && bootstrapAppSecret) {
    const accountId = process.env["FEISHU_ACCOUNT_ID"] ?? "default";
    const existing = await prisma.channelBinding.findFirst({
      where: { channelType: "feishu", accountId },
    });
    if (!existing) {
      await prisma.channelBinding.create({
        data: {
          name: "Bootstrap Feishu Bot",
          channelType: "feishu",
          accountId,
          channelConfig: JSON.stringify({
            appId: bootstrapAppId,
            appSecret: bootstrapAppSecret,
            verificationToken:
              process.env["FEISHU_VERIFICATION_TOKEN"] || undefined,
            encryptKey: process.env["FEISHU_ENCRYPT_KEY"] || undefined,
            allowFrom: ["*"],
          }),
          agentUrl: DEFAULT_ECHO_AGENT_URL,
          enabled: true,
        },
      });
    }
  }
}
