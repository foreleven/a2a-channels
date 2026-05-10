#!/usr/bin/env node
/**
 * relay bin launcher
 *
 * Registers the tsx ESM loader so that the TypeScript source files under
 * `src/` can be imported without a separate build step, then bootstraps the
 * CLI entry point.
 *
 * This shim is the `bin.relay` target defined in package.json.  It is a plain
 * `.js` file so Node executes it directly; tsx is added programmatically via
 * the `node:module` register API (Node 20.6+).
 */

import { register } from "node:module";
import { pathToFileURL } from "node:url";

// Register tsx as an ESM loader so TypeScript source files resolve correctly.
// The base URL must point to the package root so that tsx finds tsconfig.json.
const packageRoot = new URL("../", import.meta.url);
register("tsx/esm", pathToFileURL(packageRoot.pathname));

// Bootstrap the CLI.  The URL is relative to this launcher file.
await import(new URL("../src/index.ts", import.meta.url).href);
