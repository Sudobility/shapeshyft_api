# shapeshyft_api

Backend API server for ShapeShyft, an LLM structured output platform.

## Setup

```bash
bun install
cp .env.example .env.local   # Configure DATABASE_URL, Firebase, ENCRYPTION_KEY
bun run db:init              # Create schema, tables, and indexes (idempotent)
bun run dev                  # Start dev server (port 3000)

# db:init is optional -- the same initDatabase() runs on every server boot.
# Run it when you want the schema applied without starting the server, such as
# preparing a fresh database or applying new columns in a release step.
```

## Usage

```bash
# Public: Execute an AI endpoint (project API key auth).
# The path is /ai/<entity-slug>/<project>/<endpoint> -- there is no /invoke suffix.
curl -X POST https://api.shapeshyft.ai/api/v1/ai/my-org/my-project/my-endpoint \
  -H "Authorization: Bearer sk_live_..." -H "Content-Type: application/json" \
  -d '{"text": "Classify this text"}'

# Public: see the prompt that endpoint would send, without calling the LLM
curl -X POST https://api.shapeshyft.ai/api/v1/ai/my-org/my-project/my-endpoint/prompt \
  -H "Authorization: Bearer sk_live_..." -H "Content-Type: application/json" \
  -d '{"text": "Classify this text"}'

# Admin: List projects (Firebase auth)
curl https://api.shapeshyft.ai/api/v1/entities/my-org/projects \
  -H "Authorization: Bearer <firebase-token>"

# Admin: the same call with a personal API key
curl https://api.shapeshyft.ai/api/v1/entities/my-org/projects \
  -H "X-API-Key: shyft_..."

# Admin: the same call as the workspace itself, with an entity API key
curl https://api.shapeshyft.ai/api/v1/entities/my-org/projects \
  -H "X-API-Key: shyftent_..."

# Create a personal API key (Firebase token required)
curl -X POST https://api.shapeshyft.ai/api/v1/users/<uid>/api-keys \
  -H "Authorization: Bearer <firebase-token>" -H "Content-Type: application/json" \
  -d '{"key_name":"CLI"}'
```

## Routes

- **Health** (`/`, `/health`, `/health/ready`) -- unauthenticated; `ready` verifies the database
- **Public** (`/api/v1/ai/*`, `/api/v1/providers/*`) -- AI invocation and provider catalog. The AI routes take a project API key (`sk_live_...`) via `Authorization: Bearer` or `?api_key=`, with an optional per-endpoint IPv4 allowlist.
- **Admin** (`/api/v1/entities/*`, `/api/v1/users/*`, `/api/v1/ratelimits/*`, `/api/v1/invitations/*`) -- Full CRUD for entities, projects, endpoints, keys, analytics, settings. Accepts a Firebase ID token, a personal `shyft_...` key, **or** an entity `shyftent_...` key (the last is limited to `/entities/*` paths and cannot manage API keys).

Supports 10 LLM providers: OpenAI, Anthropic, Gemini, Groq, Mistral, xAI, DeepSeek, Perplexity, Cohere, LM Studio.

> Cohere is reached through its OpenAI-compatible Compatibility API
> (`https://api.cohere.ai/compatibility/v1`), with structured output requested via
> `response_format` because that API has no `tool_choice`.

## Development

```bash
bun run dev          # Dev server with hot reload
bun run test:unit    # Unit tests (Vitest; never plain `bun test`). No `test` script exists.
TEST_DATABASE_URL=postgresql://localhost:5432/shapeshyft_test bun run test:db  # Database tests
bun run typecheck    # TypeScript check
bun run lint         # ESLint
bun run verify       # Typecheck + lint + unit tests
```

## Build & Deploy

```bash
bun run build        # Bundle to dist/ (bun build, target bun) -- production only
bun run start:prod   # Run the built dist/index.js
```

The dev server defaults to port 3000; the Docker image (`Dockerfile`) exposes and
health-checks port 8020, overridable via `PORT`. CI/CD (`.github/workflows`) builds
the Docker image and deploys on pushes to `main`.

## Related Packages

- `@sudobility/shapeshyft_types` -- Shared type definitions
- `shapeshyft_app` -- Frontend web application
- `@sudobility/auth_service`, `@sudobility/entity_service`, `@sudobility/ratelimit_service` -- Backend services

## License

BUSL-1.1
