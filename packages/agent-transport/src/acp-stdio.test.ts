import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ACPTransport } from "./acp.js";

/** Minimal ACP stdio agent script that echoes prompts and reports its cwd. */
const ECHO_AGENT_SCRIPT = `
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
`;

test("ACPTransport calls an ACP stdio agent through the SDK client", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-stdio-test-"));
  const agentPath = join(tempDir, "agent.mjs");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const transport = new ACPTransport();
  const command = "node";
  const config = { transport: "stdio" as const, command, args: [agentPath] };
  const client = transport.create(config);

  try {
    const response = await client.send({
      userMessage: "hello",
      accountId: "default",
      sessionKey: "ctx",
    });

    assert.deepEqual(response, { text: "echo:hello" });
  } finally {
    await client.stop?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ACPTransport start waits for account-scoped request context", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "acp-stdio-start-test-"));
  const agentPath = join(tempDir, "agent.mjs");
  const cwd = join(tempDir, "agent-cwd");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const transport = new ACPTransport();
  const config = {
    transport: "stdio" as const,
    command: "node",
    args: [agentPath],
    cwd,
  };
  const client = transport.create(config);

  try {
    await client.start?.();

    const entries = await readdir(tempDir);
    assert.ok(
      !entries.includes("agent-cwd"),
      "start should not create an account-scoped worker without accountId",
    );
  } finally {
    await client.stop?.();
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("ACPTransport spawns separate processes per accountId when ACP_BASE_PATH and agentName are set", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "acp-base-"));
  const agentPath = join(basePath, "agent.mjs");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const originalBasePath = process.env["ACP_BASE_PATH"];
  process.env["ACP_BASE_PATH"] = basePath;

  const transport = new ACPTransport();
  const config = {
    transport: "stdio" as const,
    command: "node",
    args: [agentPath],
  };
  const client = transport.create(config, { agentName: "my-agent" });

  try {
    await client.send({
      userMessage: "hello",
      accountId: "user-1",
      sessionKey: "s1",
    });
    await client.send({
      userMessage: "world",
      accountId: "user-2",
      sessionKey: "s2",
    });

    // Each account should have its own subdirectory under basePath/name/
    const entries = await readdir(join(basePath, "my-agent"));
    assert.ok(entries.includes("user-1"), "user-1 cwd directory should be created");
    assert.ok(entries.includes("user-2"), "user-2 cwd directory should be created");
  } finally {
    await client.stop?.();
    if (originalBasePath === undefined) {
      delete process.env["ACP_BASE_PATH"];
    } else {
      process.env["ACP_BASE_PATH"] = originalBasePath;
    }
    await rm(basePath, { recursive: true, force: true });
  }
});

test("ACPTransport rejects unsafe agentName values for isolated workspaces", async () => {
  const basePath = await mkdtemp(join(tmpdir(), "acp-base-"));
  const agentPath = join(basePath, "agent.mjs");

  await writeFile(agentPath, ECHO_AGENT_SCRIPT, "utf8");

  const originalBasePath = process.env["ACP_BASE_PATH"];
  process.env["ACP_BASE_PATH"] = basePath;

  const transport = new ACPTransport();
  const client = transport.create(
    { transport: "stdio", command: "node", args: [agentPath] },
    { agentName: "../agent" },
  );

  try {
    await assert.rejects(() =>
      client.send({
        userMessage: "hello",
        accountId: "user-1",
        sessionKey: "s1",
      }),
    );
  } finally {
    await client.stop?.();
    if (originalBasePath === undefined) {
      delete process.env["ACP_BASE_PATH"];
    } else {
      process.env["ACP_BASE_PATH"] = originalBasePath;
    }
    await rm(basePath, { recursive: true, force: true });
  }
});
