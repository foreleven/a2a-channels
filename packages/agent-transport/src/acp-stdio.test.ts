import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACPTransport } from "./acp.js";

test("ACPTransport calls an ACP stdio agent through the SDK client", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-stdio-test-"));
  const agentPath = join(tempDir, "agent.mjs");

  await writeFile(
    agentPath,
    `
import readline from "node:readline";

const rl = readline.createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { protocolVersion: 1, agentCapabilities: {} },
    });
    return;
  }

  if (message.method === "session/new") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { sessionId: "session-1" },
    });
    return;
  }

  if (message.method === "session/prompt") {
    send({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId: message.params.sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "echo:" + message.params.prompt[0].text,
          },
        },
      },
    });
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { stopReason: "end_turn" },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: message.id,
    error: { code: -32601, message: "Method not found" },
  });
});
`,
    "utf8",
  );

  const transport = new ACPTransport();
  const command = "node";
  const config = { transport: "stdio" as const, command, args: [agentPath] };
  const client = transport.create(config);

  try {
    const response = await client.send({
        userMessage: "hello",
        contextId: "ctx",
    });

    assert.deepEqual(response, { text: "echo:hello" });
  } finally {
    await client.stop?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});
