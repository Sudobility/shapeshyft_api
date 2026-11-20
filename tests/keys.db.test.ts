import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestApp, createTestRequest, testUser } from "./utils";
import { cleanupTestUser, createTestUserWithEntity } from "./utils/test-db";
import { initDatabase } from "../src/db";
import type { Hono } from "hono";

describe("Keys Routes", () => {
  let app: Hono;
  let entitySlug: string;
  let userId: string;

  beforeAll(async () => {
    await initDatabase();
  });

  beforeEach(async () => {
    await cleanupTestUser(testUser.uid);
    // Create user with entity for each test
    const { user, entity } = await createTestUserWithEntity(testUser);
    userId = user.firebase_uid;
    entitySlug = entity.entity_slug;
    // Create app with the user's ID
    app = createTestApp(testUser, userId);
  });

  afterAll(async () => {
    await cleanupTestUser(testUser.uid);
  });

  describe("GET /api/v1/entities/:entitySlug/keys", () => {
    it("should return empty array when no keys exist", async () => {
      const res = await createTestRequest(app, "GET", `/api/v1/entities/${entitySlug}/keys`);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data).toEqual([]);
    });

    it("should return keys for entity", async () => {
      // Create a key first
      await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "Test Key",
          provider: "openai",
          api_key: "sk-test-key-123",
        },
      });

      const res = await createTestRequest(app, "GET", `/api/v1/entities/${entitySlug}/keys`);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(Array.isArray(json.data)).toBe(true);
      expect(json.data.length).toBe(1);
    });

    it("should not expose encrypted API key", async () => {
      // Create a key first
      await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "Test Key",
          provider: "openai",
          api_key: "sk-test-key-123",
        },
      });

      const res = await createTestRequest(app, "GET", `/api/v1/entities/${entitySlug}/keys`);
      const json = await res.json();

      expect(json.data[0]).not.toHaveProperty("encrypted_api_key");
      expect(json.data[0]).not.toHaveProperty("encryption_iv");
      expect(json.data[0]).toHaveProperty("has_api_key", true);
    });

    it("should return 404 for non-existent entity", async () => {
      const res = await createTestRequest(app, "GET", `/api/v1/entities/nonexist/keys`);
      expect(res.status).toBe(404);

      const json = await res.json();
      expect(json.success).toBe(false);
    });
  });

  describe("POST /api/v1/entities/:entitySlug/keys", () => {
    it("should create a new key with API key", async () => {
      const res = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "My OpenAI Key",
          provider: "openai",
          api_key: "sk-test-key-123",
        },
      });

      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.key_name).toBe("My OpenAI Key");
      expect(json.data.provider).toBe("openai");
      expect(json.data.has_api_key).toBe(true);
      expect(json.data.is_active).toBe(true);
    });

    it("should create a new key with endpoint URL for lm_studio", async () => {
      const res = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "My LLM Server",
          provider: "lm_studio",
          endpoint_url: "http://localhost:8080/generate",
        },
      });

      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.provider).toBe("lm_studio");
      expect(json.data.endpoint_url).toBe("http://localhost:8080/generate");
    });

    it("should create an API-provider key without an api_key (site-wide fallback)", async () => {
      const res = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "OpenAI (use site-wide)",
          provider: "openai",
        },
      });

      expect(res.status).toBe(201);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.provider).toBe("openai");
      expect(json.data.has_api_key).toBe(false);
    });

    it("should reject invalid provider", async () => {
      const res = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "Invalid Key",
          provider: "invalid",
          api_key: "sk-test",
        },
      });

      expect(res.status).toBe(400);
    });

    it("should reject missing key_name", async () => {
      const res = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          provider: "openai",
          api_key: "sk-test",
        },
      });

      expect(res.status).toBe(400);
    });
  });

  describe("GET /api/v1/entities/:entitySlug/keys/:keyId", () => {
    it("should return a specific key", async () => {
      // Create key first
      const createRes = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "Test Key",
          provider: "anthropic",
          api_key: "sk-ant-test",
        },
      });
      const createJson = await createRes.json();
      const keyId = createJson.data.uuid;

      const res = await createTestRequest(app, "GET", `/api/v1/entities/${entitySlug}/keys/${keyId}`);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.success).toBe(true);
      expect(json.data.uuid).toBe(keyId);
      expect(json.data.key_name).toBe("Test Key");
    });

    it("should return 404 for non-existent key", async () => {
      const res = await createTestRequest(
        app,
        "GET",
        `/api/v1/entities/${entitySlug}/keys/00000000-0000-0000-0000-000000000000`
      );
      expect(res.status).toBe(404);
    });
  });

  describe("PUT /api/v1/entities/:entitySlug/keys/:keyId", () => {
    it("should update key name", async () => {
      // Create key first
      const createRes = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "Original Name",
          provider: "openai",
          api_key: "sk-test",
        },
      });
      const createJson = await createRes.json();
      const keyId = createJson.data.uuid;

      const res = await createTestRequest(app, "PUT", `/api/v1/entities/${entitySlug}/keys/${keyId}`, {
        body: {
          key_name: "Updated Name",
        },
      });

      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.data.key_name).toBe("Updated Name");
    });

    it("should update API key", async () => {
      // Create key first
      const createRes = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "Test Key",
          provider: "openai",
          api_key: "sk-original",
        },
      });
      const createJson = await createRes.json();
      const keyId = createJson.data.uuid;

      const res = await createTestRequest(app, "PUT", `/api/v1/entities/${entitySlug}/keys/${keyId}`, {
        body: {
          api_key: "sk-updated",
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.has_api_key).toBe(true);
    });

    it("should deactivate key", async () => {
      // Create key first
      const createRes = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "Test Key",
          provider: "openai",
          api_key: "sk-test",
        },
      });
      const createJson = await createRes.json();
      const keyId = createJson.data.uuid;

      const res = await createTestRequest(app, "PUT", `/api/v1/entities/${entitySlug}/keys/${keyId}`, {
        body: {
          is_active: false,
        },
      });

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data.is_active).toBe(false);
    });
  });

  describe("DELETE /api/v1/entities/:entitySlug/keys/:keyId", () => {
    it("should delete a key", async () => {
      // Create key first
      const createRes = await createTestRequest(app, "POST", `/api/v1/entities/${entitySlug}/keys`, {
        body: {
          key_name: "Test Key",
          provider: "openai",
          api_key: "sk-test",
        },
      });
      const createJson = await createRes.json();
      const keyId = createJson.data.uuid;

      const res = await createTestRequest(app, "DELETE", `/api/v1/entities/${entitySlug}/keys/${keyId}`);
      expect(res.status).toBe(200);

      // Verify deletion
      const getRes = await createTestRequest(app, "GET", `/api/v1/entities/${entitySlug}/keys/${keyId}`);
      expect(getRes.status).toBe(404);
    });

    it("should return 404 for non-existent key", async () => {
      const res = await createTestRequest(
        app,
        "DELETE",
        `/api/v1/entities/${entitySlug}/keys/00000000-0000-0000-0000-000000000000`
      );
      expect(res.status).toBe(404);
    });
  });
});
