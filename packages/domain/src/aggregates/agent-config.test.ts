import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  AgentConfigAggregate,
  isValidAgentName,
} from "./agent-config.js";

const registerData = {
  id: "agent-1",
  name: "my-agent",
  protocol: "a2a" as const,
  config: { url: "http://agent-1" },
  description: "A test agent",
};

describe("isValidAgentName", () => {
  test("accepts alphanumeric names", () => {
    assert.equal(isValidAgentName("myagent123"), true);
    assert.equal(isValidAgentName("MyAgent"), true);
  });

  test("accepts names with dots, underscores, and hyphens", () => {
    assert.equal(isValidAgentName("my-agent"), true);
    assert.equal(isValidAgentName("my.agent"), true);
    assert.equal(isValidAgentName("my_agent"), true);
    assert.equal(isValidAgentName("my-agent.v2_final"), true);
  });

  test("rejects names with spaces or slashes", () => {
    assert.equal(isValidAgentName("my agent"), false);
    assert.equal(isValidAgentName("my/agent"), false);
    assert.equal(isValidAgentName("my\\agent"), false);
  });

  test("rejects the lone dot", () => {
    assert.equal(isValidAgentName("."), false);
  });

  test("rejects the double dot", () => {
    assert.equal(isValidAgentName(".."), false);
  });

  test("rejects empty string", () => {
    assert.equal(isValidAgentName(""), false);
  });

  test("rejects names with special characters", () => {
    assert.equal(isValidAgentName("agent@1"), false);
    assert.equal(isValidAgentName("agent#1"), false);
    assert.equal(isValidAgentName("agent!"), false);
  });
});

describe("AgentConfigAggregate", () => {
  describe("register", () => {
    test("initializes fields from registration data", () => {
      const agg = AgentConfigAggregate.register(registerData);

      assert.equal(agg.id, "agent-1");
      assert.equal(agg.name, "my-agent");
      assert.equal(agg.protocol, "a2a");
      assert.deepEqual(agg.config, { url: "http://agent-1" });
      assert.equal(agg.description, "A test agent");
      assert.equal(agg.isDeleted, false);
    });

    test("raises an AgentRegistered.v1 pending event", () => {
      const agg = AgentConfigAggregate.register(registerData);

      assert.equal(agg.pendingEvents.length, 1);
      assert.equal(agg.pendingEvents[0]?.eventType, "AgentRegistered.v1");
    });

    test("increments version to 1 after registration", () => {
      const agg = AgentConfigAggregate.register(registerData);
      assert.equal(agg.version, 1);
    });

    test("throws for an invalid agent name", () => {
      assert.throws(
        () =>
          AgentConfigAggregate.register({
            ...registerData,
            name: "my agent",
          }),
        /folder-safe name/,
      );
    });

    test("throws for a . agent name", () => {
      assert.throws(
        () => AgentConfigAggregate.register({ ...registerData, name: "." }),
        /folder-safe name/,
      );
    });
  });

  describe("update", () => {
    test("applies a name change", () => {
      const agg = AgentConfigAggregate.register(registerData);
      agg.clearPendingEvents();

      agg.update({ name: "updated-agent" });

      assert.equal(agg.name, "updated-agent");
      assert.equal(agg.pendingEvents[0]?.eventType, "AgentUpdated.v1");
    });

    test("applies a config change", () => {
      const agg = AgentConfigAggregate.register(registerData);
      agg.clearPendingEvents();

      agg.update({ config: { url: "http://agent-2" } });

      assert.deepEqual(agg.config, { url: "http://agent-2" });
    });

    test("updates description to a new value", () => {
      const agg = AgentConfigAggregate.register(registerData);
      agg.clearPendingEvents();

      agg.update({ description: "New description" });

      assert.equal(agg.description, "New description");
    });

    test("emits no event when no changes are passed", () => {
      const agg = AgentConfigAggregate.register(registerData);
      agg.clearPendingEvents();

      agg.update({});

      assert.equal(agg.pendingEvents.length, 0);
    });

    test("throws when updating a deleted agent", () => {
      const agg = AgentConfigAggregate.register(registerData);
      agg.delete();

      assert.throws(() => agg.update({ name: "new-name" }), /has been deleted/);
    });

    test("throws for an invalid name in update", () => {
      const agg = AgentConfigAggregate.register(registerData);

      assert.throws(
        () => agg.update({ name: "bad name" }),
        /folder-safe name/,
      );
    });
  });

  describe("delete", () => {
    test("marks aggregate as deleted", () => {
      const agg = AgentConfigAggregate.register(registerData);
      agg.delete();

      assert.equal(agg.isDeleted, true);
    });

    test("raises an AgentDeleted.v1 event", () => {
      const agg = AgentConfigAggregate.register(registerData);
      agg.clearPendingEvents();
      agg.delete();

      assert.equal(agg.pendingEvents.length, 1);
      assert.equal(agg.pendingEvents[0]?.eventType, "AgentDeleted.v1");
    });

    test("throws when deleting an already-deleted agent", () => {
      const agg = AgentConfigAggregate.register(registerData);
      agg.delete();

      assert.throws(() => agg.delete(), /already deleted/);
    });
  });

  describe("snapshot", () => {
    test("returns current state as a plain object", () => {
      const agg = AgentConfigAggregate.register(registerData);
      const snap = agg.snapshot();

      assert.equal(snap.id, "agent-1");
      assert.equal(snap.name, "my-agent");
      assert.equal(snap.protocol, "a2a");
      assert.equal(snap.description, "A test agent");
    });
  });

  describe("reconstitute", () => {
    test("rebuilds state from a replayed event stream", () => {
      const original = AgentConfigAggregate.register(registerData);
      original.update({ name: "updated-agent" });

      const rebuilt = AgentConfigAggregate.reconstitute(
        original.pendingEvents.slice(),
      );

      assert.equal(rebuilt.name, "updated-agent");
      assert.equal(rebuilt.pendingEvents.length, 0);
    });

    test("replaying a delete marks the aggregate deleted", () => {
      const original = AgentConfigAggregate.register(registerData);
      original.delete();

      const rebuilt = AgentConfigAggregate.reconstitute(
        original.pendingEvents.slice(),
      );

      assert.equal(rebuilt.isDeleted, true);
    });

    test("version equals the number of replayed events", () => {
      const original = AgentConfigAggregate.register(registerData);
      original.update({ name: "v2-agent" });

      const rebuilt = AgentConfigAggregate.reconstitute(
        original.pendingEvents.slice(),
      );

      assert.equal(rebuilt.version, 2);
    });
  });

  describe("fromSnapshot", () => {
    test("creates aggregate from snapshot without pending events", () => {
      const snap = AgentConfigAggregate.register(registerData).snapshot();
      const agg = AgentConfigAggregate.fromSnapshot(snap);

      assert.equal(agg.id, "agent-1");
      assert.equal(agg.pendingEvents.length, 0);
      assert.equal(agg.version, 0);
    });
  });

  describe("clearPendingEvents", () => {
    test("empties the pending events list", () => {
      const agg = AgentConfigAggregate.register(registerData);
      agg.clearPendingEvents();

      assert.equal(agg.pendingEvents.length, 0);
    });
  });
});
