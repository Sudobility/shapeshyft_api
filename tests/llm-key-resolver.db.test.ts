import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db, initDatabase, llmApiKeys } from "../src/db";
import { encryption } from "../src/lib/encryption";
import {
  createLlmKeyCredentialResolver,
  LLM_KEY_INACTIVE,
  LLM_KEY_NOT_OWNED,
  noActiveProviderKey,
} from "../src/credentials/llm-key-resolver";
import {
  cleanupSiteLlmKeys,
  cleanupTestUser,
  createTestEndpoint,
  createTestLlmKey,
  createTestProject,
  createTestSiteLlmKey,
  createTestUserWithEntity,
} from "./utils/test-db";
import { testUser } from "./utils";

const OTHER_ENTITY = "00000000-0000-4000-8000-000000000000";

describe("LlmKeyCredentialResolver", () => {
  const resolver = createLlmKeyCredentialResolver({
    db,
    encryption,
    lmStudioTimeoutMs: 900_000,
  });
  let entityId: string;
  let keyId: string;

  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(async () => {
    await cleanupTestUser(testUser.uid);
    await cleanupSiteLlmKeys();
    const { entity } = await createTestUserWithEntity(testUser);
    entityId = entity.id;
    const { encrypted, iv } = encryption.encryptApiKey("sk-real");
    const key = await createTestLlmKey(entityId, {
      key_name: "k",
      provider: "lm_studio",
      encrypted_api_key: encrypted,
      encryption_iv: iv,
      endpoint_url: "http://10.0.0.5:1234/v1",
    });
    keyId = key.uuid;
  });

  async function endpointBoundToKey() {
    const project = await createTestProject(entityId, {
      project_name: "p",
      display_name: "P",
    });
    return createTestEndpoint(project.uuid, keyId, {
      endpoint_name: "e",
      display_name: "E",
    });
  }

  describe("bindEndpoint", () => {
    it("binds a key the entity owns and returns its provider", async () => {
      expect(
        await resolver.bindEndpoint({ entityId, body: { llm_key_id: keyId } })
      ).toEqual({ ok: true, provider: "lm_studio", llmKeyId: keyId });
    });

    it("refuses another entity's key with today's 400 message", async () => {
      expect(
        await resolver.bindEndpoint({
          entityId: OTHER_ENTITY,
          body: { llm_key_id: keyId },
        })
      ).toEqual({ ok: false, status: 400, message: LLM_KEY_NOT_OWNED });
      expect(LLM_KEY_NOT_OWNED).toBe(
        "LLM key not found or doesn't belong to this entity"
      );
    });

    it("keeps the current binding when an update does not name a key", async () => {
      const endpoint = await endpointBoundToKey();
      expect(
        await resolver.bindEndpoint({
          entityId,
          body: { display_name: "x" },
          current: endpoint,
        })
      ).toEqual({ ok: true, provider: "lm_studio", llmKeyId: keyId });
    });
  });

  describe("resolve", () => {
    it("decrypts the key and passes endpoint URL and timeout", async () => {
      const endpoint = await endpointBoundToKey();
      expect(await resolver.resolve({ entityId, endpoint })).toEqual({
        ok: true,
        provider: "lm_studio",
        apiKey: "sk-real",
        endpointUrl: "http://10.0.0.5:1234/v1",
        timeoutMs: 900_000,
      });
    });

    it("refuses an inactive key with today's 500 message", async () => {
      const endpoint = await endpointBoundToKey();
      await db
        .update(llmApiKeys)
        .set({ is_active: false })
        .where(eq(llmApiKeys.uuid, keyId));
      expect(await resolver.resolve({ entityId, endpoint })).toEqual({
        ok: false,
        status: 500,
        message: LLM_KEY_INACTIVE,
      });
      expect(LLM_KEY_INACTIVE).toBe("LLM API key not found or inactive");
    });
  });

  describe("resolve with a provider override", () => {
    async function addKey(
      owner: string,
      provider: "openrouter" | "deepseek",
      secret: string,
      isActive = true
    ) {
      const { encrypted, iv } = encryption.encryptApiKey(secret);
      const key = await createTestLlmKey(owner, {
        key_name: secret,
        provider,
        encrypted_api_key: encrypted,
        encryption_iv: iv,
      });
      if (!isActive) {
        await db
          .update(llmApiKeys)
          .set({ is_active: false })
          .where(eq(llmApiKeys.uuid, key.uuid));
      }
      return key;
    }

    it("returns the entity's active key for that provider, not the bound one", async () => {
      const endpoint = await endpointBoundToKey();
      await addKey(entityId, "openrouter", "sk-or");
      expect(
        await resolver.resolve({ entityId, endpoint, provider: "openrouter" })
      ).toEqual({
        ok: true,
        provider: "openrouter",
        apiKey: "sk-or",
        endpointUrl: undefined,
        timeoutMs: 900_000,
      });
    });

    it("prefers the most recently updated active key", async () => {
      const endpoint = await endpointBoundToKey();
      const older = await addKey(entityId, "deepseek", "sk-old");
      await addKey(entityId, "deepseek", "sk-new");
      await addKey(entityId, "deepseek", "sk-off", false);
      await db
        .update(llmApiKeys)
        // In SQL: the column is a timestamp without time zone, set by now()
        .set({ updated_at: sql`now() - interval '1 minute'` })
        .where(eq(llmApiKeys.uuid, older.uuid));
      const resolved = await resolver.resolve({
        entityId,
        endpoint,
        provider: "deepseek",
      });
      expect(resolved.ok && resolved.apiKey).toBe("sk-new");
    });

    it("refuses with 400 when the entity has no active key for it", async () => {
      const endpoint = await endpointBoundToKey();
      await addKey(entityId, "openrouter", "sk-off", false);
      expect(
        await resolver.resolve({ entityId, endpoint, provider: "openrouter" })
      ).toEqual({
        ok: false,
        status: 400,
        message: noActiveProviderKey("openrouter"),
      });
      expect(noActiveProviderKey("openrouter")).toBe(
        "No active openrouter API key for this organization"
      );
    });

    it("never returns another entity's key", async () => {
      const endpoint = await endpointBoundToKey();
      await addKey(entityId, "openrouter", "sk-mine");
      const resolved = await resolver.resolve({
        entityId: OTHER_ENTITY,
        endpoint,
        provider: "openrouter",
      });
      expect(resolved.ok).toBe(false);
    });
  });

  describe("resolve with site-wide fallback", () => {
    async function addSiteKey(
      provider: "openrouter" | "openai",
      secret: string,
      isActive = true
    ) {
      const { encrypted, iv } = encryption.encryptApiKey(secret);
      return createTestSiteLlmKey({
        key_name: `site-${secret}`,
        provider,
        encrypted_api_key: encrypted,
        encryption_iv: iv,
        is_active: isActive,
      });
    }

    it("uses the entity's own key when it has one, ignoring the site key", async () => {
      const endpoint = await endpointBoundToKey();
      const { encrypted, iv } = encryption.encryptApiKey("sk-entity");
      await createTestLlmKey(entityId, {
        key_name: "entity-or",
        provider: "openrouter",
        encrypted_api_key: encrypted,
        encryption_iv: iv,
      });
      await addSiteKey("openrouter", "sk-site");

      const resolved = await resolver.resolve({
        entityId,
        endpoint,
        provider: "openrouter",
      });
      expect(resolved.ok && resolved.apiKey).toBe("sk-entity");
    });

    it("falls back to the site-wide key when the entity key has no api key", async () => {
      const endpoint = await endpointBoundToKey();
      // Entity key saved with no api key (the new optional case).
      await createTestLlmKey(entityId, {
        key_name: "entity-or-empty",
        provider: "openrouter",
      });
      await addSiteKey("openrouter", "sk-site");

      const resolved = await resolver.resolve({
        entityId,
        endpoint,
        provider: "openrouter",
      });
      expect(resolved.ok && resolved.apiKey).toBe("sk-site");
    });

    it("falls back on the no-override path when the bound key is empty", async () => {
      // An endpoint bound to an entity key that carries no credential of its own.
      const emptyKey = await createTestLlmKey(entityId, {
        key_name: "entity-openai-empty",
        provider: "openai",
      });
      const project = await createTestProject(entityId, {
        project_name: "p2",
        display_name: "P2",
      });
      const endpoint = await createTestEndpoint(project.uuid, emptyKey.uuid, {
        endpoint_name: "e2",
        display_name: "E2",
      });
      await addSiteKey("openai", "sk-site-openai");

      const resolved = await resolver.resolve({
        entityId,
        // The test helper leaves endpoint.provider null; emulate the persisted value.
        endpoint: { ...endpoint, provider: "openai" },
      });
      expect(resolved.ok && resolved.provider).toBe("openai");
      expect(resolved.ok && resolved.apiKey).toBe("sk-site-openai");
    });

    it("errors when the entity key is empty and no site key exists", async () => {
      const endpoint = await endpointBoundToKey();
      await createTestLlmKey(entityId, {
        key_name: "entity-or-empty",
        provider: "openrouter",
      });

      expect(
        await resolver.resolve({ entityId, endpoint, provider: "openrouter" })
      ).toEqual({
        ok: false,
        status: 400,
        message: noActiveProviderKey("openrouter"),
      });
    });
  });
});
