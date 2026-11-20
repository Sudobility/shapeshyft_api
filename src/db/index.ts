/**
 * @fileoverview Database connection and initialization
 * @description A lazy connection (nothing connects at import) from
 * @sudobility/shapeshyft_service. initDatabase() creates the shared tables,
 * then ShapeShyft's own llm_api_keys table.
 */

import {
  createLazyDatabase,
  initServiceTables,
} from "@sudobility/shapeshyft_service";
import * as schema from "./schema";
import { getRequiredEnv } from "../lib/env-helper";
import { initLlmApiKeys } from "./llm-api-keys";
import { initSiteLlmKeys } from "./site-llm-keys";

const database = createLazyDatabase(
  () => getRequiredEnv("DATABASE_URL"),
  schema
);

export const db = database.db;

export async function initDatabase() {
  const client = database.client();

  // Shared tables, enums, entity and rate-limit tables, additive columns
  await initServiceTables(client as any, {
    schemaName: "shapeshyft",
    indexPrefix: "shapeshyft",
  });

  // ShapeShyft's own: llm_api_keys, its FK from endpoints, provider backfill
  await initLlmApiKeys(client);

  // Site-wide (platform) provider keys, managed by site admins
  await initSiteLlmKeys(client);

  console.log("Database tables initialized");
}

export const closeDatabase = database.close;

// Re-export schema for convenience
export * from "./schema";
