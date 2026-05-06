import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ChannelTypeRegistry } from "./channel-type-registry.js";

describe("ChannelTypeRegistry", () => {
  describe("canonicalize", () => {
    test("feishu maps to itself", () => {
      const registry = new ChannelTypeRegistry();
      assert.equal(registry.canonicalize("feishu"), "feishu");
    });

    test("lark maps to feishu", () => {
      const registry = new ChannelTypeRegistry();
      assert.equal(registry.canonicalize("lark"), "feishu");
    });

    test("wechat maps to openclaw-weixin", () => {
      const registry = new ChannelTypeRegistry();
      assert.equal(registry.canonicalize("wechat"), "openclaw-weixin");
    });

    test("weixin maps to openclaw-weixin", () => {
      const registry = new ChannelTypeRegistry();
      assert.equal(registry.canonicalize("weixin"), "openclaw-weixin");
    });

    test("openclaw-weixin maps to itself", () => {
      const registry = new ChannelTypeRegistry();
      assert.equal(registry.canonicalize("openclaw-weixin"), "openclaw-weixin");
    });

    test("unknown channel types pass through unchanged", () => {
      const registry = new ChannelTypeRegistry();
      assert.equal(registry.canonicalize("telegram"), "telegram");
      assert.equal(registry.canonicalize("discord"), "discord");
      assert.equal(registry.canonicalize("whatsapp"), "whatsapp");
    });
  });

  describe("aliasesFor", () => {
    test("returns lark as an alias for feishu", () => {
      const registry = new ChannelTypeRegistry();
      const aliases = registry.aliasesFor("feishu");
      assert.ok(aliases.includes("lark"));
    });

    test("does not include the canonical name itself as an alias", () => {
      const registry = new ChannelTypeRegistry();
      const aliases = registry.aliasesFor("feishu");
      assert.ok(!aliases.includes("feishu"));
    });

    test("returns wechat and weixin as aliases for openclaw-weixin", () => {
      const registry = new ChannelTypeRegistry();
      const aliases = registry.aliasesFor("openclaw-weixin");
      assert.ok(aliases.includes("wechat"));
      assert.ok(aliases.includes("weixin"));
    });

    test("openclaw-weixin is not listed as its own alias", () => {
      const registry = new ChannelTypeRegistry();
      const aliases = registry.aliasesFor("openclaw-weixin");
      assert.ok(!aliases.includes("openclaw-weixin"));
    });

    test("returns empty array for unknown canonical type", () => {
      const registry = new ChannelTypeRegistry();
      const aliases = registry.aliasesFor("telegram");
      assert.deepEqual(aliases, []);
    });
  });
});
