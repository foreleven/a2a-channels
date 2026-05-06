import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ChannelBindingAggregate } from "./channel-binding.js";

const createData = {
  id: "binding-1",
  name: "My Binding",
  channelType: "feishu",
  accountId: "default",
  channelConfig: { appId: "cli_1", appSecret: "sec_1" },
  agentId: "agent-1",
  enabled: true,
};

describe("ChannelBindingAggregate", () => {
  describe("create", () => {
    test("initializes fields from creation data", () => {
      const agg = ChannelBindingAggregate.create(createData);

      assert.equal(agg.id, "binding-1");
      assert.equal(agg.name, "My Binding");
      assert.equal(agg.channelType, "feishu");
      assert.equal(agg.accountId, "default");
      assert.deepEqual(agg.channelConfig, { appId: "cli_1", appSecret: "sec_1" });
      assert.equal(agg.agentId, "agent-1");
      assert.equal(agg.enabled, true);
      assert.equal(agg.isDeleted, false);
    });

    test("creates a ChannelBindingCreated.v1 pending event", () => {
      const agg = ChannelBindingAggregate.create(createData);

      assert.equal(agg.pendingEvents.length, 1);
      assert.equal(agg.pendingEvents[0]?.eventType, "ChannelBindingCreated.v1");
    });

    test("increments version after creation", () => {
      const agg = ChannelBindingAggregate.create(createData);
      assert.equal(agg.version, 1);
    });
  });

  describe("update", () => {
    test("applies name change", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.clearPendingEvents();

      agg.update({ name: "Updated Binding" });

      assert.equal(agg.name, "Updated Binding");
      assert.equal(agg.pendingEvents.length, 1);
      assert.equal(agg.pendingEvents[0]?.eventType, "ChannelBindingUpdated.v1");
    });

    test("applies enabled flag change", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.clearPendingEvents();

      agg.update({ enabled: false });

      assert.equal(agg.enabled, false);
    });

    test("applies channelConfig change", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.clearPendingEvents();

      agg.update({ channelConfig: { appId: "cli_2", appSecret: "sec_2" } });

      assert.deepEqual(agg.channelConfig, { appId: "cli_2", appSecret: "sec_2" });
    });

    test("applies agentId change", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.clearPendingEvents();

      agg.update({ agentId: "agent-2" });

      assert.equal(agg.agentId, "agent-2");
    });

    test("does not emit an event when no changes are provided", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.clearPendingEvents();

      agg.update({});

      assert.equal(agg.pendingEvents.length, 0);
    });

    test("throws when updating a deleted binding", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.delete();

      assert.throws(
        () => agg.update({ name: "New Name" }),
        /has been deleted/,
      );
    });
  });

  describe("delete", () => {
    test("marks aggregate as deleted", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.delete();

      assert.equal(agg.isDeleted, true);
    });

    test("raises a ChannelBindingDeleted.v1 event", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.clearPendingEvents();
      agg.delete();

      assert.equal(agg.pendingEvents.length, 1);
      assert.equal(agg.pendingEvents[0]?.eventType, "ChannelBindingDeleted.v1");
    });

    test("throws when deleting an already-deleted binding", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.delete();

      assert.throws(
        () => agg.delete(),
        /already deleted/,
      );
    });
  });

  describe("snapshot", () => {
    test("returns current state as a plain object", () => {
      const agg = ChannelBindingAggregate.create(createData);
      const snapshot = agg.snapshot();

      assert.equal(snapshot.id, "binding-1");
      assert.equal(snapshot.name, "My Binding");
      assert.equal(snapshot.channelType, "feishu");
      assert.equal(snapshot.agentId, "agent-1");
      assert.equal(snapshot.enabled, true);
    });
  });

  describe("clearPendingEvents", () => {
    test("empties the pending events list", () => {
      const agg = ChannelBindingAggregate.create(createData);
      agg.clearPendingEvents();

      assert.equal(agg.pendingEvents.length, 0);
    });
  });

  describe("reconstitute", () => {
    test("rebuilds aggregate state by replaying events", () => {
      const original = ChannelBindingAggregate.create(createData);
      original.update({ name: "Renamed Binding", enabled: false });

      const events = original.pendingEvents.slice();
      const rebuilt = ChannelBindingAggregate.reconstitute(events);

      assert.equal(rebuilt.id, "binding-1");
      assert.equal(rebuilt.name, "Renamed Binding");
      assert.equal(rebuilt.enabled, false);
    });

    test("reconstituted aggregate has no pending events", () => {
      const original = ChannelBindingAggregate.create(createData);
      const rebuilt = ChannelBindingAggregate.reconstitute(
        original.pendingEvents.slice(),
      );

      assert.equal(rebuilt.pendingEvents.length, 0);
    });

    test("replaying a delete event marks the aggregate as deleted", () => {
      const original = ChannelBindingAggregate.create(createData);
      original.delete();

      const rebuilt = ChannelBindingAggregate.reconstitute(
        original.pendingEvents.slice(),
      );

      assert.equal(rebuilt.isDeleted, true);
    });

    test("version equals the number of replayed events", () => {
      const original = ChannelBindingAggregate.create(createData);
      original.update({ name: "v2" });

      const rebuilt = ChannelBindingAggregate.reconstitute(
        original.pendingEvents.slice(),
      );

      assert.equal(rebuilt.version, 2);
    });
  });

  describe("fromSnapshot", () => {
    test("creates aggregate from a snapshot without pending events", () => {
      const snapshot = ChannelBindingAggregate.create(createData).snapshot();
      const agg = ChannelBindingAggregate.fromSnapshot(snapshot);

      assert.equal(agg.id, "binding-1");
      assert.equal(agg.pendingEvents.length, 0);
      assert.equal(agg.version, 0);
    });
  });
});
