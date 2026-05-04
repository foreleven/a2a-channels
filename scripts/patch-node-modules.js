#!/usr/bin/env node
/**
 * Patches node_modules after pnpm install to fix compatibility issues:
 *
 * 1. @openclaw/weixin:
 *    - Ships TypeScript source; mark it no-check so repo typecheck does not
 *      validate third-party source under node_modules.
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
// Fix @openclaw/weixin TypeScript source package
// ---------------------------------------------------------------------------
function walkTs(dir, cb) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) walkTs(full, cb);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) cb(full);
  }
}

let weixinPatched = 0;
for (const weixinDir of findInstalledPackageDirs([
  "@openclaw",
  "weixin",
])) {
  for (const root of [weixinDir, path.join(weixinDir, "src")]) {
    if (!isDir(root)) continue;
    walkTs(root, (filePath) => {
      try {
        const src = fs.readFileSync(filePath, "utf8");
        if (src.startsWith("// @ts-nocheck")) return;
        fs.writeFileSync(filePath, `// @ts-nocheck\n${src}`);
        weixinPatched++;
      } catch (e) {
        console.warn(
          "[patch] could not patch",
          path.relative(weixinDir, filePath),
          ":",
          e.message,
        );
      }
    });
  }
}
if (weixinPatched > 0) {
  console.log(
    `[patch] marked @openclaw/weixin TS source no-check in ${weixinPatched} file(s)`,
  );
}
