/**
 * @fileoverview Zod schemas for ShapeShyft's LLM API key routes
 * @description Moved unchanged from the pre-extraction `schemas/index.ts`; the
 * shared schemas now come from @sudobility/shapeshyft_service.
 */

import { z } from "zod";
import { llmProviderSchema } from "@sudobility/shapeshyft_service";

export const keyIdParamSchema = z.object({
  entitySlug: z.string().min(1).max(12),
  keyId: z.string().uuid(),
});

// =============================================================================
// LLM API Key Schemas
// =============================================================================

export const keyCreateSchema = z
  .object({
    key_name: z.string().min(1).max(255),
    provider: llmProviderSchema,
    api_key: z.string().min(1).optional(),
    endpoint_url: z.string().url().optional(),
  })
  .refine(
    data => {
      // Endpoint-based providers (lm_studio) still need an endpoint URL.
      if (data.provider === "lm_studio") {
        return !!data.endpoint_url;
      }
      // api_key is optional for all other providers: a key saved without one
      // falls back to the site-wide key for that provider at invocation time.
      return true;
    },
    {
      message: "endpoint_url is required for lm_studio",
    }
  );

export const keyUpdateSchema = z.object({
  key_name: z.string().min(1).max(255).optional(),
  api_key: z.string().min(1).optional(),
  endpoint_url: z.string().url().optional(),
  is_active: z.boolean().optional(),
});
