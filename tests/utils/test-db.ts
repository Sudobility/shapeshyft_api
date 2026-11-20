import {
  db,
  users,
  userSettings,
  llmApiKeys,
  siteLlmKeys,
  projects,
  endpoints,
  usageAnalytics,
  entities,
  entityMembers,
} from "../../src/db";
import { eq, and } from "drizzle-orm";
import type { MockFirebaseUser } from "./mock-auth";

/**
 * Clean up all test data for a specific user and their entities
 */
export async function cleanupTestUser(firebaseUid: string) {
  // Get all entities where user is a member
  const userMemberships = await db
    .select({ entity_id: entityMembers.entity_id })
    .from(entityMembers)
    .where(eq(entityMembers.user_id, firebaseUid));

  for (const membership of userMemberships) {
    // Get all projects for entity
    const entityProjects = await db
      .select()
      .from(projects)
      .where(eq(projects.entity_id, membership.entity_id));

    // Delete usage analytics and endpoints for each project
    for (const project of entityProjects) {
      const projectEndpoints = await db
        .select()
        .from(endpoints)
        .where(eq(endpoints.project_id, project.uuid));

      for (const endpoint of projectEndpoints) {
        await db
          .delete(usageAnalytics)
          .where(eq(usageAnalytics.endpoint_id, endpoint.uuid));
      }

      await db.delete(endpoints).where(eq(endpoints.project_id, project.uuid));
    }

    // Delete projects
    await db.delete(projects).where(eq(projects.entity_id, membership.entity_id));

    // Delete LLM keys
    await db.delete(llmApiKeys).where(eq(llmApiKeys.entity_id, membership.entity_id));

    // Delete entity members
    await db.delete(entityMembers).where(eq(entityMembers.entity_id, membership.entity_id));

    // Delete entity
    await db.delete(entities).where(eq(entities.id, membership.entity_id));
  }

  // Delete user settings
  await db.delete(userSettings).where(eq(userSettings.firebase_uid, firebaseUid));

  // Delete user
  await db.delete(users).where(eq(users.firebase_uid, firebaseUid));
}

/**
 * Get user by firebase UID (firebase_uid is the primary key)
 */
export async function getUserId(firebaseUid: string): Promise<string> {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.firebase_uid, firebaseUid));

  if (rows.length === 0) {
    throw new Error(`User not found for firebase UID: ${firebaseUid}`);
  }

  // Return firebase_uid as the user ID (it's now the primary key)
  return rows[0]!.firebase_uid;
}

/** @deprecated Use getUserId instead */
export const getUserUuid = getUserId;

/**
 * Create a test user in the database
 */
export async function createTestUser(mockUser: MockFirebaseUser) {
  const rows = await db
    .insert(users)
    .values({
      firebase_uid: mockUser.uid,
      email: mockUser.email ?? null,
      display_name: mockUser.displayName ?? null,
    })
    .returning();

  return rows[0]!;
}

/**
 * Get user by firebase UID
 */
export async function getTestUser(firebaseUid: string) {
  const rows = await db
    .select()
    .from(users)
    .where(eq(users.firebase_uid, firebaseUid));

  return rows.length > 0 ? rows[0]! : null;
}

/**
 * Generate a random 8-character slug
 */
function generateSlug(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let slug = "";
  for (let i = 0; i < 8; i++) {
    slug += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return slug;
}

/**
 * Create a test entity (personal by default)
 * Note: Ownership is tracked via entity_members table, not entities table
 * @param firebaseUid - The firebase_uid of the user who owns this entity
 */
export async function createTestEntity(
  firebaseUid: string,
  data?: {
    entity_slug?: string;
    entity_type?: "personal" | "organization";
    display_name?: string;
  }
) {
  const entitySlug = data?.entity_slug ?? generateSlug();
  const entityType = data?.entity_type ?? "personal";
  const displayName = data?.display_name ?? "Test Entity";

  // Create entity (no owner_user_id - ownership tracked via entity_members)
  const rows = await db
    .insert(entities)
    .values({
      entity_slug: entitySlug,
      entity_type: entityType,
      display_name: displayName,
    })
    .returning();

  const entity = rows[0]!;

  // Add user as manager member (personal entities use 'manager', organizations use 'owner')
  const role = entityType === "personal" ? "manager" : "owner";
  await db.insert(entityMembers).values({
    entity_id: entity.id,
    user_id: firebaseUid,
    role: role,
  });

  return entity;
}

/**
 * Get entity by slug
 */
export async function getTestEntity(entitySlug: string) {
  const rows = await db
    .select()
    .from(entities)
    .where(eq(entities.entity_slug, entitySlug));

  return rows.length > 0 ? rows[0]! : null;
}

/**
 * Get user's personal entity via entity_members
 */
export async function getPersonalEntity(firebaseUid: string) {
  const rows = await db
    .select({ entity: entities })
    .from(entities)
    .innerJoin(entityMembers, eq(entities.id, entityMembers.entity_id))
    .where(
      and(
        eq(entityMembers.user_id, firebaseUid),
        eq(entities.entity_type, "personal"),
        eq(entityMembers.is_active, true)
      )
    );

  return rows.length > 0 ? rows[0]!.entity : null;
}

/**
 * Create a test user with a personal entity
 * Returns both the user and their personal entity
 */
export async function createTestUserWithEntity(mockUser: MockFirebaseUser) {
  const user = await createTestUser(mockUser);
  // Pass firebase_uid to createTestEntity (not user.id since firebase_uid is the PK)
  const entity = await createTestEntity(user.firebase_uid, {
    entity_type: "personal",
    display_name: mockUser.displayName ?? "Personal",
  });
  return { user, entity };
}

/**
 * Create a test LLM API key
 */
export async function createTestLlmKey(
  entityId: string,
  data: {
    key_name: string;
    provider: "openai" | "gemini" | "anthropic" | "lm_studio" | "deepseek" | "openrouter";
    encrypted_api_key?: string;
    encryption_iv?: string;
    endpoint_url?: string;
  }
) {
  const rows = await db
    .insert(llmApiKeys)
    .values({
      entity_id: entityId,
      key_name: data.key_name,
      provider: data.provider,
      encrypted_api_key: data.encrypted_api_key ?? null,
      encryption_iv: data.encryption_iv ?? null,
      endpoint_url: data.endpoint_url ?? null,
    })
    .returning();

  return rows[0]!;
}

/**
 * Delete all site-wide LLM keys (they are not entity-scoped, so cleanupTestUser
 * does not touch them). Call in beforeEach/afterAll of site-key tests.
 */
export async function cleanupSiteLlmKeys() {
  await db.delete(siteLlmKeys);
}

/**
 * Create a test site-wide LLM API key directly in the database
 */
export async function createTestSiteLlmKey(data: {
  key_name: string;
  provider: "openai" | "gemini" | "anthropic" | "lm_studio" | "deepseek" | "openrouter";
  encrypted_api_key?: string;
  encryption_iv?: string;
  endpoint_url?: string;
  is_active?: boolean;
  created_by?: string;
}) {
  const rows = await db
    .insert(siteLlmKeys)
    .values({
      key_name: data.key_name,
      provider: data.provider,
      encrypted_api_key: data.encrypted_api_key ?? null,
      encryption_iv: data.encryption_iv ?? null,
      endpoint_url: data.endpoint_url ?? null,
      is_active: data.is_active ?? true,
      created_by: data.created_by ?? null,
    })
    .returning();

  return rows[0]!;
}

/**
 * Create a test project
 */
export async function createTestProject(
  entityId: string,
  data: {
    project_name: string;
    display_name: string;
    description?: string;
  }
) {
  const rows = await db
    .insert(projects)
    .values({
      entity_id: entityId,
      project_name: data.project_name,
      display_name: data.display_name,
      description: data.description ?? null,
    })
    .returning();

  return rows[0]!;
}

/**
 * Create a test endpoint
 */
export async function createTestEndpoint(
  projectId: string,
  llmKeyId: string,
  data: {
    endpoint_name: string;
    display_name: string;
    http_method?: "GET" | "POST";
    input_schema?: object;
    output_schema?: object;
    instructions?: string;
    context?: string;
  }
) {
  const rows = await db
    .insert(endpoints)
    .values({
      project_id: projectId,
      llm_key_id: llmKeyId,
      endpoint_name: data.endpoint_name,
      display_name: data.display_name,
      http_method: data.http_method ?? "POST",
      input_schema: data.input_schema ?? null,
      output_schema: data.output_schema ?? null,
      instructions: data.instructions ?? null,
      context: data.context ?? null,
    })
    .returning();

  return rows[0]!;
}

/**
 * Create test usage analytics
 */
export async function createTestUsageAnalytics(
  endpointId: string,
  data: {
    success: boolean;
    error_message?: string;
    tokens_input?: number;
    tokens_output?: number;
    latency_ms?: number;
    estimated_cost_cents?: number;
    timestamp?: Date;
  }
) {
  const rows = await db
    .insert(usageAnalytics)
    .values({
      endpoint_id: endpointId,
      timestamp: data.timestamp ?? new Date(),
      success: data.success,
      error_message: data.error_message ?? null,
      tokens_input: data.tokens_input ?? null,
      tokens_output: data.tokens_output ?? null,
      latency_ms: data.latency_ms ?? null,
      estimated_cost_cents: data.estimated_cost_cents ?? null,
    })
    .returning();

  return rows[0]!;
}
