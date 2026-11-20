/**
 * @fileoverview ShapeShyft's provider credentials: one LlmApiKey per endpoint
 * @description The only code outside routes/keys.ts and routes/provider-sync.ts
 * that reads llm_api_keys. Error messages and statuses are the ones
 * endpoints.ts and ai.ts returned before the service extraction.
 */

import { and, desc, eq } from "drizzle-orm";
import type {
  Encryption,
  ProviderCredentialResolver,
} from "@sudobility/shapeshyft_service";
import type { LlmProvider } from "@sudobility/shapeshyft_types";
import { db as appDb, llmApiKeys, siteLlmKeys } from "../db";

export const LLM_KEY_NOT_OWNED =
  "LLM key not found or doesn't belong to this entity";
export const LLM_KEY_INACTIVE = "LLM API key not found or inactive";
export const noActiveProviderKey = (provider: string) =>
  `No active ${provider} API key for this organization`;

export function createLlmKeyCredentialResolver(opts: {
  db: typeof appDb;
  encryption: Encryption;
  /** LM_STUDIO_TIMEOUT_MS; undefined leaves the engine's ten-minute default */
  lmStudioTimeoutMs?: number;
}): ProviderCredentialResolver {
  const { db, encryption } = opts;

  async function ownedKey(entityId: string, keyId: string) {
    const rows = await db
      .select()
      .from(llmApiKeys)
      .where(
        and(eq(llmApiKeys.entity_id, entityId), eq(llmApiKeys.uuid, keyId))
      );
    return rows[0] ?? null;
  }

  // Both llm_api_keys and site_llm_keys rows carry these fields; the resolver
  // only ever needs this structural subset to build a credential.
  function credentialFrom(key: {
    provider: LlmProvider;
    encrypted_api_key: string | null;
    encryption_iv: string | null;
    endpoint_url: string | null;
  }) {
    return {
      ok: true as const,
      provider: key.provider,
      apiKey:
        key.encrypted_api_key && key.encryption_iv
          ? encryption.decryptApiKey(key.encrypted_api_key, key.encryption_iv)
          : undefined,
      endpointUrl: key.endpoint_url ?? undefined,
      timeoutMs: opts.lmStudioTimeoutMs,
    };
  }

  /**
   * The most recently updated active site-wide key for a provider, or null.
   * Site-wide keys belong to the platform, not any entity, and are used as a
   * fallback when an entity has not supplied its own key for the provider.
   */
  async function activeSiteKey(provider: LlmProvider) {
    const [key] = await db
      .select()
      .from(siteLlmKeys)
      .where(
        and(eq(siteLlmKeys.provider, provider), eq(siteLlmKeys.is_active, true))
      )
      .orderBy(desc(siteLlmKeys.updated_at), desc(siteLlmKeys.created_at))
      .limit(1);
    return key ?? null;
  }

  return {
    async bindEndpoint({ entityId, body, current }) {
      const requested = body.llm_key_id as string | undefined;

      // An update that leaves the key alone keeps it, as before. The provider
      // is re-read only if this row predates the provider column.
      if (
        current?.llm_key_id &&
        (requested === undefined || requested === current.llm_key_id)
      ) {
        if (current.provider) {
          return {
            ok: true,
            provider: current.provider,
            llmKeyId: current.llm_key_id,
          };
        }
        const key = await ownedKey(entityId, current.llm_key_id);
        if (key)
          return { ok: true, provider: key.provider, llmKeyId: key.uuid };
      }

      // zod requires llm_key_id on create, so `requested` is set on that path
      const key = requested ? await ownedKey(entityId, requested) : null;
      if (!key) {
        return { ok: false, status: 400, message: LLM_KEY_NOT_OWNED };
      }
      return { ok: true, provider: key.provider, llmKeyId: key.uuid };
    },

    async resolve({ entityId, endpoint, provider }) {
      // The effective provider is the call-time override if any, else the one
      // the endpoint was bound to.
      const effectiveProvider = provider ?? endpoint.provider ?? undefined;

      // The entity's candidate key: for a call-time override (`llm_provider`),
      // the entity's active key for that provider (most recently updated if
      // several); otherwise the key the endpoint is bound to.
      let entityKey: typeof llmApiKeys.$inferSelect | null = null;
      if (provider) {
        const [key] = await db
          .select()
          .from(llmApiKeys)
          .where(
            and(
              eq(llmApiKeys.entity_id, entityId),
              eq(llmApiKeys.provider, provider),
              eq(llmApiKeys.is_active, true)
            )
          )
          .orderBy(desc(llmApiKeys.updated_at), desc(llmApiKeys.created_at))
          .limit(1);
        entityKey = key ?? null;
      } else {
        const rows = endpoint.llm_key_id
          ? await db
              .select()
              .from(llmApiKeys)
              .where(
                and(
                  eq(llmApiKeys.uuid, endpoint.llm_key_id),
                  eq(llmApiKeys.is_active, true)
                )
              )
          : [];
        entityKey = rows[0] ?? null;
      }

      // Use the entity's own key when it carries its own credential -- an API
      // key, or an endpoint URL for self-hosted providers. A key saved without
      // either is an explicit request to use the site-wide key instead.
      if (
        entityKey &&
        (entityKey.encrypted_api_key || entityKey.endpoint_url)
      ) {
        return credentialFrom(entityKey);
      }

      // Fall back to an active site-wide key for the provider, if one exists.
      if (effectiveProvider) {
        const siteKey = await activeSiteKey(effectiveProvider);
        if (siteKey) {
          return credentialFrom(siteKey);
        }
      }

      // Nothing usable: no entity credential and no site-wide fallback.
      if (provider) {
        return {
          ok: false,
          status: 400,
          message: noActiveProviderKey(provider),
        };
      }
      return { ok: false, status: 500, message: LLM_KEY_INACTIVE };
    },
  };
}
