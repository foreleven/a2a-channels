import path from "path";
import { defineConfig } from "prisma/config";

const DB_PATH =
  process.env["DB_PATH"] ?? path.join(process.cwd(), "db/a2a-channels.db");

export default defineConfig({
  schema: "./prisma/schema.prisma",
  datasource: {
    url: `file:${DB_PATH}`,
  },
});
