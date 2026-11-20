/**
 * @fileoverview Drizzle schema for the `shapeshyft` PostgreSQL schema
 * @description Shared tables come from @sudobility/shapeshyft_service; this file
 * adds only ShapeShyft's own table, `llm_api_keys`. The shared tables are
 * re-exported under their historical names so every existing import of
 * `src/db` keeps working.
 */

import {
  pgSchema,
  uuid,
  varchar,
  text,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createServiceTables } from "@sudobility/shapeshyft_service";

export const shapeshyftSchema = pgSchema("shapeshyft");

export const serviceTables = createServiceTables(shapeshyftSchema, {
  indexPrefix: "shapeshyft",
});

export const {
  llmProviderEnum,
  httpMethodEnum,
  users,
  userSettings,
  entities,
  entityMembers,
  entityInvitations,
  entityApiKeys,
  entityStorageConfigs,
  userApiKeys,
  projects,
  endpoints,
  usageAnalytics,
  rateLimitCounters,
} = serviceTables;

// =============================================================================
// LLM API Keys Table
// Per-entity provider credentials. ShapeShyft's answer to "where does the
// provider key live"; read only by LlmKeyCredentialResolver and routes/keys.ts.
// =============================================================================

export const llmApiKeys = shapeshyftSchema.table("llm_api_keys", {
  uuid: uuid("uuid").primaryKey().defaultRandom(),
  entity_id: uuid("entity_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  key_name: varchar("key_name", { length: 255 }).notNull(),
  provider: llmProviderEnum("provider").notNull(),
  encrypted_api_key: text("encrypted_api_key"),
  endpoint_url: text("endpoint_url"),
  encryption_iv: varchar("encryption_iv", { length: 32 }),
  is_active: boolean("is_active").default(true),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});

// =============================================================================
// Site-wide LLM API Keys Table
// Platform-level provider credentials that are NOT owned by any entity. Managed
// only by site admins. At invocation, an active site-wide key for a provider is
// used as a fallback when an entity has not supplied its own key for that
// provider. Read only by LlmKeyCredentialResolver and routes/site-llm-keys.ts.
// =============================================================================

export const siteLlmKeys = shapeshyftSchema.table("site_llm_keys", {
  uuid: uuid("uuid").primaryKey().defaultRandom(),
  key_name: varchar("key_name", { length: 255 }).notNull(),
  provider: llmProviderEnum("provider").notNull(),
  encrypted_api_key: text("encrypted_api_key"),
  endpoint_url: text("endpoint_url"),
  encryption_iv: varchar("encryption_iv", { length: 32 }),
  is_active: boolean("is_active").default(true),
  /** Firebase UID of the site admin who created this key */
  created_by: varchar("created_by", { length: 128 }),
  created_at: timestamp("created_at").defaultNow(),
  updated_at: timestamp("updated_at").defaultNow(),
});
