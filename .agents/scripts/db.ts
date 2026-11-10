// Life AI's connection to Neon. node-postgres because the Cloudflare Worker will reach Neon through Hyperdrive, which needs it.
import { fileURLToPath } from "node:url";
import { parseEnv } from "@neon/env";
import pg from "pg";
import config from "../../neon.ts";

// Locally, read what `neon env pull` wrote; the Worker will get these as bindings instead.
if (!process.env.DATABASE_URL) process.loadEnvFile(fileURLToPath(new URL("../../.env.local", import.meta.url)));

// pg v9 weakens sslmode=require; verify-full keeps today's certificate check.
const url = parseEnv(config).postgres.databaseUrl.replace("sslmode=require", "sslmode=verify-full");
export const db = new pg.Pool({ connectionString: url });
