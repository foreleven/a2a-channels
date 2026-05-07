import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { AccountIdGenerator } from "./account-id-generator.js";

describe("AccountIdGenerator", () => {
  describe("generate", () => {
    test("returns a non-empty string prefixed with account-", () => {
      const gen = new AccountIdGenerator();
      const id = gen.generate();
      assert.ok(id.startsWith("account-"));
      assert.ok(id.length > "account-".length);
    });

    test("produces unique ids on each call", () => {
      const gen = new AccountIdGenerator();
      const first = gen.generate();
      const second = gen.generate();
      assert.notEqual(first, second);
    });
  });

  describe("normalize", () => {
    test("returns the trimmed string for a non-empty input", () => {
      const gen = new AccountIdGenerator();
      assert.equal(gen.normalize("  my-account  "), "my-account");
      assert.equal(gen.normalize("default"), "default");
    });

    test("returns undefined for whitespace-only strings", () => {
      const gen = new AccountIdGenerator();
      assert.equal(gen.normalize("   "), undefined);
      assert.equal(gen.normalize("\t\n"), undefined);
    });

    test("returns undefined for an empty string", () => {
      const gen = new AccountIdGenerator();
      assert.equal(gen.normalize(""), undefined);
    });

    test("returns undefined when called with undefined", () => {
      const gen = new AccountIdGenerator();
      assert.equal(gen.normalize(undefined), undefined);
    });
  });

  describe("resolve", () => {
    test("returns the normalized account id when one is provided", () => {
      const gen = new AccountIdGenerator();
      assert.equal(gen.resolve("my-account"), "my-account");
      assert.equal(gen.resolve("  trimmed  "), "trimmed");
    });

    test("generates a new id when the account id is absent", () => {
      const gen = new AccountIdGenerator();
      const resolved = gen.resolve(undefined);
      assert.ok(resolved.startsWith("account-"));
    });

    test("generates a new id when the account id is whitespace-only", () => {
      const gen = new AccountIdGenerator();
      const resolved = gen.resolve("   ");
      assert.ok(resolved.startsWith("account-"));
    });
  });
});
