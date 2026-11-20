import type { Context, Next } from "hono";
import type { DecodedIdToken } from "firebase-admin/auth";

/**
 * Mock Firebase user for testing
 */
export interface MockFirebaseUser {
  uid: string;
  email?: string;
  displayName?: string;
}

/**
 * Default test user
 */
export const testUser: MockFirebaseUser = {
  uid: "test-firebase-uid-123",
  email: "test@example.com",
  displayName: "Test User",
};

/**
 * Create a mock decoded token from a mock user
 */
export function createMockDecodedToken(
  user: MockFirebaseUser
): DecodedIdToken {
  return {
    uid: user.uid,
    email: user.email,
    name: user.displayName,
    aud: "test-project",
    auth_time: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 3600,
    iat: Math.floor(Date.now() / 1000),
    iss: `https://securetoken.google.com/test-project`,
    sub: user.uid,
    firebase: {
      identities: {},
      sign_in_provider: "password",
    },
  };
}

/**
 * Mock Firebase auth middleware for testing
 * Automatically authenticates requests with the test user
 * Also sets userId from the testUserId parameter (internal user UUID)
 */
export function mockFirebaseAuthMiddleware(
  mockUser: MockFirebaseUser = testUser,
  testUserId?: string,
  siteAdmin = false
) {
  return async (c: Context, next: Next) => {
    const decodedToken = createMockDecodedToken(mockUser);
    c.set("firebaseUser", decodedToken);
    // Set userId - this would normally be set by the real auth middleware after DB lookup
    if (testUserId) {
      c.set("userId", testUserId);
    }
    // Site-admin flag - normally derived from SITEADMIN_EMAILS by the real auth
    c.set("siteAdmin", siteAdmin);
    await next();
  };
}

/**
 * Create authorization header for test requests
 * The actual token value doesn't matter since we're mocking the middleware
 */
export function getTestAuthHeader(): Record<string, string> {
  return {
    Authorization: "Bearer test-token",
  };
}
