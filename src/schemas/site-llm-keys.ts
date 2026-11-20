/**
 * @fileoverview Zod schemas for ShapeShyft's site-wide LLM API key routes
 * @description Mirror of schemas/keys.ts without the entitySlug param: site-wide
 * keys are platform-level and not owned by any entity.
 */

import { z } from "zod";
import { llmProviderSchema } from "@sudobility/shapeshyft_service";

export const siteKeyIdParamSchema = z.object({
  keyId: z.string().uuid(),
});

export const siteKeyCreateSchema = z
  .object({
    key_name: z.string().min(1).max(255),
    provider: llmProviderSchema,
    api_key: z.string().min(1).optional(),
    endpoint_url: z.string().url().optional(),
  })
  .refine(
    data => {
      // For API-based providers, api_key is required
      if (data.provider !== "lm_studio") {
        return !!data.api_key;
      }
      // For lm_studio, endpoint_url is required
      return !!data.endpoint_url;
    },
    {
      message:
        "api_key is required for API providers, endpoint_url is required for lm_studio",
    }
  );

export const siteKeyUpdateSchema = z.object({
  key_name: z.string().min(1).max(255).optional(),
  api_key: z.string().min(1).optional(),
  endpoint_url: z.string().url().optional(),
  is_active: z.boolean().optional(),
});
