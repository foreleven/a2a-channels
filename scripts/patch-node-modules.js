#!/usr/bin/env node
/**
 * Patches node_modules after pnpm install to fix compatibility issues:
 *
 * 1. @larksuite/openclaw-lark:
 *    - Fixes broken `exports` (was pointing to non-existent dist/)
 *    - Exposes `./package.json` subpath needed by register.ts
 */

import fs from "fs";
import path from "path";

const ROOT = path.join(import.meta.dirname, "..");

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function findInstalledPackageDirs(packageParts) {
  const found = new Set();
  const nmRoot = path.join(ROOT, "node_modules");
  const direct = path.join(nmRoot, ...packageParts);
  if (isDir(direct)) found.add(direct);
  const virtualStore = path.join(nmRoot, ".pnpm");
  if (isDir(virtualStore)) {
    for (const dir of fs.readdirSync(virtualStore)) {
      const candidate = path.join(
        virtualStore,
        dir,
        "node_modules",
        ...packageParts,
      );
      if (isDir(candidate)) found.add(candidate);
    }
  }
  return Array.from(found);
}

// ---------------------------------------------------------------------------
// Fix @larksuite/openclaw-lark broken exports
// ---------------------------------------------------------------------------
let larkPatched = 0;
for (const larkDir of findInstalledPackageDirs([
  "@larksuite",
  "openclaw-lark",
])) {
  const larkPkgPath = path.join(larkDir, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(larkPkgPath, "utf8"));
    pkg.type = "commonjs";
    pkg.exports = {
      ".": { require: "./index.js", default: "./index.js" },
      "./package.json": "./package.json",
    };
    pkg.main = "./index.js";
    fs.writeFileSync(larkPkgPath, JSON.stringify(pkg, null, 2));
    larkPatched++;
  } catch (e) {
    console.warn(
      "[patch] could not patch @larksuite/openclaw-lark at",
      path.relative(ROOT, larkPkgPath),
      ":",
      e.message,
    );
  }
}
if (larkPatched > 0) {
  console.log(
    `[patch] fixed @larksuite/openclaw-lark exports in ${larkPatched} location(s)`,
  );
} else {
  console.warn("[patch] @larksuite/openclaw-lark not found");
}

// ---------------------------------------------------------------------------
// Fix @larksuite/openclaw-lark src/**/*.js: import.meta in CJS files
// ---------------------------------------------------------------------------
function walkJs(dir, cb) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walkJs(full, cb);
    else if (entry.endsWith(".js") && !entry.endsWith(".d.ts")) cb(full);
  }
}
for (const larkDir of findInstalledPackageDirs([
  "@larksuite",
  "openclaw-lark",
])) {
  const srcDir = path.join(larkDir, "src");
  if (!isDir(srcDir)) continue;
  walkJs(srcDir, (filePath) => {
    try {
      let src = fs.readFileSync(filePath, "utf8");
      if (!src.includes("import.meta")) return;
      const before = src;
      // fileURLToPath(import.meta.url)  →  __filename
      src = src.replace(
        /\(0,\s*node_url_1\.fileURLToPath\)\(import\.meta\.url\)/g,
        "__filename",
      );
      // ternary guard: typeof __filename !== 'undefined' ? __filename : import.meta.url
      src = src.replace(
        /typeof __filename\s*!==\s*['"]undefined['"]\s*\?\s*__filename\s*:\s*import\.meta\.url/g,
        "__filename",
      );
      // bare import.meta.url remaining
      src = src.replace(/import\.meta\.url/g, "__filename");
      if (src !== before) {
        fs.writeFileSync(filePath, src);
        console.log(
          "[patch] fixed import.meta in",
          path.relative(larkDir, filePath),
        );
      }
    } catch (e) {
      console.warn(
        "[patch] could not patch",
        path.relative(larkDir, filePath),
        ":",
        e.message,
      );
    }
  });
}
