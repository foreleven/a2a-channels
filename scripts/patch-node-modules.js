#!/usr/bin/env node
/**
 * Patches node_modules after npm install to fix compatibility issues:
 *
 * 1. All packages with ESM-only exports (import but no require):
 *    Adds a `require` condition mirroring `import`, so tsx CJS hook can
 *    resolve them when required from CJS context.
 *
 * 2. @larksuite/openclaw-lark:
 *    - Fixes broken `exports` (was pointing to non-existent dist/)
 *    - Exposes `./package.json` subpath needed by register.ts
 *
 * 3. openclaw/dist/models-config-B-YHRI3g.js:
 *    - Removes a dead `path.resolve(import.meta.dirname, ...)` expression
 *      that crashes tsx's CJS transformer.
 */

const fs = require("fs");
const path = require("path");

const NM = path.join(__dirname, "..", "node_modules");

// ---------------------------------------------------------------------------
// 1. Add `require` condition to all ESM-only exports
// ---------------------------------------------------------------------------
let patchCount = 0;

function patchExports(obj) {
  if (!obj || typeof obj !== "object") return false;
  let changed = false;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === "object") {
      if (val.import && !val.require) {
        val.require = val.import;
        changed = true;
      }
      if (patchExports(val)) changed = true;
    }
  }
  return changed;
}

function patchPkg(pkgPath) {
  try {
    const raw = fs.readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw);
    if (!pkg.exports) return;
    if (patchExports(pkg.exports)) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      console.log(
        "[patch] added require condition:",
        pkgPath.replace(NM + "/", ""),
      );
      patchCount++;
    }
  } catch (_) {}
}

for (const entry of fs.readdirSync(NM)) {
  const entryPath = path.join(NM, entry);
  if (entry.startsWith("@")) {
    try {
      for (const pkg of fs.readdirSync(entryPath)) {
        patchPkg(path.join(entryPath, pkg, "package.json"));
      }
    } catch (_) {}
  } else {
    patchPkg(path.join(entryPath, "package.json"));
  }
}

// ---------------------------------------------------------------------------
// 2. Fix @larksuite/openclaw-lark broken exports
// ---------------------------------------------------------------------------
const larkPkgPath = path.join(
  NM,
  "@larksuite",
  "openclaw-lark",
  "package.json",
);
try {
  const pkg = JSON.parse(fs.readFileSync(larkPkgPath, "utf8"));
  pkg.exports = {
    ".": { require: "./index.js", default: "./index.js" },
    "./package.json": "./package.json",
  };
  pkg.main = "./index.js";
  fs.writeFileSync(larkPkgPath, JSON.stringify(pkg, null, 2));
  console.log("[patch] fixed @larksuite/openclaw-lark exports");
} catch (e) {
  console.warn("[patch] could not patch @larksuite/openclaw-lark:", e.message);
}

// ---------------------------------------------------------------------------
// 3. Remove dead import.meta.dirname expression in openclaw dist
// ---------------------------------------------------------------------------
const openclaw = path.join(NM, "openclaw", "dist", "models-config-B-YHRI3g.js");
try {
  let src = fs.readFileSync(openclaw, "utf8");
  const before = src;
  src = src.replace(
    /path\.resolve\(import\.meta\.dirname,\s*["'][^"']*["']\);/g,
    "/* patched */",
  );
  if (src !== before) {
    fs.writeFileSync(openclaw, src);
    console.log("[patch] removed import.meta.dirname in openclaw/dist");
  }
} catch (e) {
  console.warn("[patch] could not patch openclaw dist:", e.message);
}

console.log(
  `[patch] done. ${patchCount} packages patched with require condition.`,
);
