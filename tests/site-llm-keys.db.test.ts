import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestApp, createTestRequest, testUser } from "./utils";
import { cleanupSiteLlmKeys } from "./utils/test-db";
import { initDatabase } from "../src/db";
import type { Hono } from "hono";

describe("Site-wide LLM Keys Routes", () => {
  let adminApp: Hono;
  let nonAdminApp: Hono;

  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(async () => {
    await cleanupSiteLlmKeys();
    // Site admin app (siteAdmin = true) and a regular user app (siteAdmin = false)
    adminApp = createTestApp(testUser, testUser.uid, true);
    nonAdminApp = createTestApp(testUser, testUser.uid, false);
  });

  afterAll(async () => {
    await cleanupSiteLlmKeys();
  });

  describe("site-admin gating", () => {
    it("should reject a non-site-admin with 403 on list", async () => {
      const res = await createTestRequest(nonAdminApp, "GET", `/api/v1/site/llm-keys`);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.success).toBe(false);
    });

    it("should reject a non-site-admin with 403 on create", async () => {
      const res = await createTestRequest(nonAdminApp, "POST", `/api/v1/site/llm-keys`, {
        body: { key_name: "Nope", provider: "openai", api_key: "sk-test" },
      });
      expect(res.status).toBe(403);
    });
  });

  describe("GET /api/v1/site/llm-keys", () => {
    it("should return empty array when no keys exist", async () => {
      const res = await createTestRequest(adminApp, "GET", `/api/v1/site/llm-keys`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
    });

    it("should not expose encrypted API key", async () => {
      await createTestRequest(adminApp, "POST", `/api/v1/site/llm-keys`, {
        body: { key_name: "Platform OpenAI", provider: "openai", api_key: "sk-test-key-123" },
      });

      const res = await createTestRequest(adminApp, "GET", `/api/v1/site/llm-keys`);
      const json = await res.json();

      expect(json.data[0]).not.toHaveProperty("encrypted_api_key");
      expect(json.data[0]).not.toHaveProperty("encryption_iv");
      expect(json.data[0]).not.toHaveProperty("entity_id");
      expect(json.data[0]).toHaveProperty("has_api_key", true);
      expect(json.data[0]).toHaveProperty("created_by", testUser.uid);
    });
  });

  describe("POST /api/v1/site/llm-keys", () => {
    it("should create a new key with API key", async () => {
      const res = await createTestRequest(adminApp, "POST", `/api/v1/site/llm-keys`, {
        body: { key_name: "Platform OpenAI", provider: "openai", api_key: "sk-test-key-123" },
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.key_name).toBe("Platform OpenAI");
      expect(json.data.provider).toBe("openai");
      expect(json.data.has_api_key).toBe(true);
      expect(json.data.is_active).toBe(true);
      expect(json.data.created_by).toBe(testUser.uid);
    });

    it("should create an lm_studio key with endpoint URL", async () => {
      const res = await createTestRequest(adminApp, "POST", `/api/v1/site/llm-keys`, {
        body: {
          key_name: "Platform LLM Server",
          provider: "lm_studio",
          endpoint_url: "http://localhost:8080/generate",
        },
      });

      expect(res.status).toBe(201);
      const json = await res.json();
      expect(json.data.provider).toBe("lm_studio");
      expect(json.data.endpoint_url).toBe("http://localhost:8080/generate");
    });

    it("should reject an invalid provider", async () => {
      const res = await createTestRequest(adminApp, "POST", `/api/v1/site/llm-keys`, {
        body: { key_name: "Invalid", provider: "invalid", api_key: "sk-test" },
      });
      expect(res.status).toBe(400);
    });

    it("should reject a missing key_name", async () => {
      const res = await createTestRequest(adminApp, "POST", `/api/v1/site/llm-keys`, {
        body: { provider: "openai", api_key: "sk-test" },
      });
      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/site/llm-keys/:keyId", () => {
    it("should return a specific key", async () => {
      const createRes = await createTestRequest(adminApp, "POST", `/api/v1/site/llm-keys`, {
        body: { key_name: "Anthropic", provider: "anthropic", api_key: "sk-ant-test" },
      });
      const keyId = (await createRes.json()).data.uuid;

      const res = await createTestRequest(adminApp, "GET", `/api/v1/site/llm-keys/${keyId}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.uuid).toBe(keyId);
      expect(json.data.key_name).toBe("Anthropic");
    });

    it("should return 404 for a non-existent key", async () => {
      const res = await createTestRequest(
        adminApp,
        "GET",
        `/api/v1/site/llm-keys/00000000-0000-0000-0000-000000000000`
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/v1/site/llm-keys/:keyId", () => {
    it("should update name, rotate key, and deactivate", async () => {
      const createRes = await createTestRequest(adminApp, "POST", `/api/v1/site/llm-keys`, {
        body: { key_name: "Original", provider: "openai", api_key: "sk-original" },
      });
      const keyId = (await createRes.json()).data.uuid;

      const res = await createTestRequest(adminApp, "PUT", `/api/v1/site/llm-keys/${keyId}`, {
        body: { key_name: "Updated", api_key: "sk-updated", is_active: false },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.key_name).toBe("Updated");
      expect(json.data.has_api_key).toBe(true);
      expect(json.data.is_active).toBe(false);
    });

    it("should return 404 for a non-existent key", async () => {
      const res = await createTestRequest(
        adminApp,
        "PUT",
        `/api/v1/site/llm-keys/00000000-0000-0000-0000-000000000000`,
        { body: { key_name: "x" } }
      );
      expect(res.status).toBe(404);
    });
  });

  describe("DELETE /api/v1/site/llm-keys/:keyId", () => {
    it("should delete a key", async () => {
      const createRes = await createTestRequest(adminApp, "POST", `/api/v1/site/llm-keys`, {
        body: { key_name: "Temp", provider: "openai", api_key: "sk-test" },
      });
      const keyId = (await createRes.json()).data.uuid;

      const res = await createTestRequest(adminApp, "DELETE", `/api/v1/site/llm-keys/${keyId}`);
      expect(res.status).toBe(200);

      const getRes = await createTestRequest(adminApp, "GET", `/api/v1/site/llm-keys/${keyId}`);
      expect(getRes.status).toBe(404);
    });

    it("should return 404 for a non-existent key", async () => {
      const res = await createTestRequest(
        adminApp,
        "DELETE",
        `/api/v1/site/llm-keys/00000000-0000-0000-0000-000000000000`
      );
      expect(res.status).toBe(404);
    });
  });
});
