/**
 * @fileoverview DDL for ShapeShyft's site_llm_keys table
 * @description Platform-level provider credentials, not owned by any entity.
 * Runs after initServiceTables on every boot. Idempotent.
 */

import type { Sql } from "postgres";

export async function initSiteLlmKeys(client: Sql): Promise<void> {
  await client`
    CREATE TABLE IF NOT EXISTS shapeshyft.site_llm_keys (
      uuid UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      key_name VARCHAR(255) NOT NULL,
      provider shapeshyft.llm_provider NOT NULL,
      encrypted_api_key TEXT,
      endpoint_url TEXT,
      encryption_iv VARCHAR(32),
      is_active BOOLEAN DEFAULT true,
      created_by VARCHAR(128),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `;

  /*
    The resolver looks keys up by provider, filtered to active, so an index on
    (provider, is_active) keeps that hot path cheap. Not unique: like the entity
    path, several active keys for one provider are allowed and the resolver
    picks the most recently updated.
  */
  await client`
    CREATE INDEX IF NOT EXISTS shapeshyft_site_llm_keys_provider_idx
      ON shapeshyft.site_llm_keys (provider, is_active)
  `;
}
