/**
 * @fileoverview Site-wide LLM API key management routes
 * @description CRUD for platform-level provider credentials that are NOT owned
 * by any entity. Every handler is gated to site admins. Encrypted data is never
 * returned to the client (uses toSafeKey). At invocation an active site-wide key
 * for a provider is used as a fallback when an entity has not supplied its own
 * key for that provider.
 */

import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { eq } from "drizzle-orm";
import type { ServiceContext } from "@sudobility/shapeshyft_service";
import { db, siteLlmKeys } from "../db";
import {
  siteKeyCreateSchema,
  siteKeyUpdateSchema,
  siteKeyIdParamSchema,
} from "../schemas/site-llm-keys";
import {
  successResponse,
  errorResponse,
  type SiteLlmApiKeySafe,
} from "@sudobility/shapeshyft_types";
import { encryptApiKey } from "../lib/encryption";

// ctx is accepted for parity with createKeysRouter and future needs; site keys
// are gated by the siteAdmin flag on the request, not by entity permissions.
export function createSiteLlmKeysRouter(_ctx: ServiceContext) {
  const siteKeysRouter = new Hono();

  /**
   * Reject anyone who is not a site admin. The siteAdmin flag is set by the
   * shared firebaseAuth middleware this router inherits.
   */
  siteKeysRouter.use("*", async (c, next) => {
    if (!c.get("siteAdmin")) {
      return c.json(errorResponse("Site admin access required"), 403);
    }
    await next();
  });

  /**
   * Convert database key to safe response (no encrypted data)
   */
  function toSafeKey(key: typeof siteLlmKeys.$inferSelect): SiteLlmApiKeySafe {
    return {
      uuid: key.uuid,
      key_name: key.key_name,
      provider: key.provider,
      has_api_key: !!key.encrypted_api_key,
      endpoint_url: key.endpoint_url,
      is_active: key.is_active,
      created_by: key.created_by,
      created_at: key.created_at,
      updated_at: key.updated_at,
    };
  }

  // GET all site-wide keys
  siteKeysRouter.get("/", async c => {
    try {
      const rows = await db.select().from(siteLlmKeys);
      return c.json(successResponse<SiteLlmApiKeySafe[]>(rows.map(toSafeKey)));
    } catch (error: any) {
      console.error("Error getting site keys:", error);
      return c.json(
        errorResponse(error.message || "Internal server error"),
        500
      );
    }
  });

  // GET single site-wide key
  siteKeysRouter.get(
    "/:keyId",
    zValidator("param", siteKeyIdParamSchema),
    async c => {
      try {
        const { keyId } = c.req.valid("param");

        const rows = await db
          .select()
          .from(siteLlmKeys)
          .where(eq(siteLlmKeys.uuid, keyId));

        if (rows.length === 0) {
          return c.json(errorResponse("Key not found"), 404);
        }

        return c.json(successResponse<SiteLlmApiKeySafe>(toSafeKey(rows[0]!)));
      } catch (error: any) {
        console.error("Error getting site key:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // POST create new site-wide key
  siteKeysRouter.post("/", zValidator("json", siteKeyCreateSchema), async c => {
    try {
      const body = c.req.valid("json");

      // Encrypt API key if provided
      let encryptedApiKey: string | null = null;
      let encryptionIv: string | null = null;

      if (body.api_key) {
        const { encrypted, iv } = encryptApiKey(body.api_key);
        encryptedApiKey = encrypted;
        encryptionIv = iv;
      }

      const rows = await db
        .insert(siteLlmKeys)
        .values({
          key_name: body.key_name,
          provider: body.provider,
          encrypted_api_key: encryptedApiKey,
          endpoint_url: body.endpoint_url ?? null,
          encryption_iv: encryptionIv,
          created_by: c.get("userId") ?? null,
        })
        .returning();

      return c.json(
        successResponse<SiteLlmApiKeySafe>(toSafeKey(rows[0]!)),
        201
      );
    } catch (error: any) {
      console.error("Error creating site key:", error);
      return c.json(
        errorResponse(error.message || "Internal server error"),
        500
      );
    }
  });

  // PUT update site-wide key
  siteKeysRouter.put(
    "/:keyId",
    zValidator("param", siteKeyIdParamSchema),
    zValidator("json", siteKeyUpdateSchema),
    async c => {
      try {
        const { keyId } = c.req.valid("param");
        const body = c.req.valid("json");

        const existing = await db
          .select()
          .from(siteLlmKeys)
          .where(eq(siteLlmKeys.uuid, keyId));

        if (existing.length === 0) {
          return c.json(errorResponse("Key not found"), 404);
        }

        const current = existing[0]!;

        // Prepare update values
        let encryptedApiKey = current.encrypted_api_key;
        let encryptionIv = current.encryption_iv;

        if (body.api_key) {
          const { encrypted, iv } = encryptApiKey(body.api_key);
          encryptedApiKey = encrypted;
          encryptionIv = iv;
        }

        const rows = await db
          .update(siteLlmKeys)
          .set({
            key_name: body.key_name ?? current.key_name,
            encrypted_api_key: encryptedApiKey,
            encryption_iv: encryptionIv,
            endpoint_url: body.endpoint_url ?? current.endpoint_url,
            is_active: body.is_active ?? current.is_active,
            updated_at: new Date(),
          })
          .where(eq(siteLlmKeys.uuid, keyId))
          .returning();

        return c.json(successResponse<SiteLlmApiKeySafe>(toSafeKey(rows[0]!)));
      } catch (error: any) {
        console.error("Error updating site key:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  // DELETE site-wide key
  siteKeysRouter.delete(
    "/:keyId",
    zValidator("param", siteKeyIdParamSchema),
    async c => {
      try {
        const { keyId } = c.req.valid("param");

        const rows = await db
          .delete(siteLlmKeys)
          .where(eq(siteLlmKeys.uuid, keyId))
          .returning();

        if (rows.length === 0) {
          return c.json(errorResponse("Key not found"), 404);
        }

        return c.json(successResponse<SiteLlmApiKeySafe>(toSafeKey(rows[0]!)));
      } catch (error: any) {
        console.error("Error deleting site key:", error);
        return c.json(
          errorResponse(error.message || "Internal server error"),
          500
        );
      }
    }
  );

  return siteKeysRouter;
}
