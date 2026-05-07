import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { prisma } from "../store/prisma.js";
import { ChannelMessageStateRepository } from "./channel-message-repo.js";

describe("ChannelMessageStateRepository", () => {
  test("appends channel binding input and output messages", async () => {
    await prisma.message.deleteMany({
      where: { channelBindingId: "binding-message-test" },
    });
    await prisma.channelBinding.deleteMany({
      where: { id: "binding-message-test" },
    });
    await prisma.agent.deleteMany({ where: { id: "agent-message-test" } });

    await prisma.agent.create({
      data: {
        id: "agent-message-test",
        name: "Message Test Agent",
        protocol: "a2a",
        config: JSON.stringify({ url: "http://agent.test" }),
      },
    });
    await prisma.channelBinding.create({
      data: {
        id: "binding-message-test",
        name: "Message Test Binding",
        channelType: "feishu",
        accountId: "message-account",
        channelConfig: "{}",
        agentId: "agent-message-test",
        enabledKey: "feishu:message-account",
      },
    });

    const repository = new ChannelMessageStateRepository();
    const input = await repository.append({
      channelBindingId: "binding-message-test",
      direction: "input",
      channelType: "feishu",
      accountId: "message-account",
      sessionKey: "session-1",
      content: "hello",
      metadata: { replyToId: "om_parent" },
    });
    const output = await repository.append({
      channelBindingId: "binding-message-test",
      direction: "output",
      channelType: "feishu",
      accountId: "message-account",
      sessionKey: "session-1",
      content: "world",
      metadata: { kind: "final" },
    });

    assert.equal(input.direction, "input");
    assert.equal(output.direction, "output");

    const rows = await prisma.message.findMany({
      where: { channelBindingId: "binding-message-test" },
      orderBy: { createdAt: "asc" },
    });

    assert.deepEqual(
      rows.map((row) => ({
        direction: row.direction,
        content: row.content,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      })),
      [
        {
          direction: "input",
          content: "hello",
          metadata: { replyToId: "om_parent" },
        },
        {
          direction: "output",
          content: "world",
          metadata: { kind: "final" },
        },
      ],
    );
  });
});
