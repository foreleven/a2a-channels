import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { PrismaClient } from "../generated/prisma/index.js";

export const DB_PATH =
  process.env["DB_PATH"] ?? join(process.cwd(), "db/agent-relay.db");

mkdirSync(dirname(DB_PATH), { recursive: true });

const adapter = new PrismaBetterSqlite3({ url: `file:${DB_PATH}` });

export const prisma = new PrismaClient({ adapter });
