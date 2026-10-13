/**
 * @fileoverview ShapeShyft's instance of @sudobility/shapeshyft_service
 * @description Everything product-specific is decided here: key prefixes,
 * where provider credentials come from (per-entity LLM keys), and the routes
 * only ShapeShyft has.
 */

import type { Hono } from "hono";
import {
  createFirebaseAuth,
  createInvitationEmailSender,
  createShapeshyftService,
} from "@sudobility/shapeshyft_service";
import { db } from "./db";
import { serviceTables } from "./db/schema";
import { encryption } from "./lib/encryption";
import { env } from "./lib/env-helper";
import { readPeerAddress } from "./lib/peer-address";
import { createLlmKeyCredentialResolver } from "./credentials/llm-key-resolver";
import { endpointBinding } from "./schemas/endpoint-binding";
import { createKeysRouter } from "./routes/keys";
import providerSyncRouter from "./routes/provider-sync";
import { createImageProvider } from "./image-provider";

const isTestMode =
  env.get("NODE_ENV") === "test" || env.get("BUN_ENV") === "test";

export const service = createShapeshyftService({
  db: db as any, // drizzle instances can differ under bun link
  tables: serviceTables,
  keyPrefixes: { user: "shyft_", entity: "shyftent" },
  encryption,
  auth: createFirebaseAuth({
    enabled: !isTestMode,
    projectId: env.get("FIREBASE_PROJECT_ID"),
    clientEmail: env.get("FIREBASE_CLIENT_EMAIL"),
    privateKey: env.get("FIREBASE_PRIVATE_KEY"),
    siteAdminEmails: env.get("SITEADMIN_EMAILS"),
  }),
  email: createInvitationEmailSender({
    productName: "ShapeShyft",
    resendApiKey: env.get("RESEND_API_KEY"),
    senderEmail: env.get("RESEND_SENDER_EMAIL"),
    senderName: env.get("RESEND_SENDER_NAME"),
    appUrl: env.get("APP_URL"),
  }),
  credentials: createLlmKeyCredentialResolver({
    db,
    encryption,
    lmStudioTimeoutMs: env.getNumber("LM_STUDIO_TIMEOUT_MS"),
  }),
  getPeerAddress: readPeerAddress,
  endpointBinding,
  createProvider: createImageProvider,
  revenueCatApiKey: env.get("REVENUECAT_API_KEY"),
});

/**
 * ShapeShyft-only admin routes. Mounted before the shared admin routes so the
 * literal "self" is matched here rather than taken as an entity slug.
 */
export function mountShapeshyftRoutes(admin: Hono): void {
  admin.route("/entities/self/providers", providerSyncRouter);
  admin.route("/entities/:entitySlug/keys", createKeysRouter(service.ctx));
}

export const routes = service.buildRoutes({
  mountAdmin: mountShapeshyftRoutes,
});
