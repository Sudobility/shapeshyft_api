# ShapeShyft API

Backend API server for ShapeShyft, an LLM structured-output platform. It exposes
public AI-invocation routes (`/api/v1/ai/*`), a provider catalog, and admin CRUD
for entities, projects, endpoints, keys, and analytics. See `README.md` for the
route catalog and curl examples.

> **Git policy — never auto-commit or auto-push.** Leave work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `scripts/push_all.sh` **only when
> the user explicitly asks in that turn**. Approval for an earlier change does not
> carry forward. Stay on the current branch — do not create feature branches.

## Tech stack

- **Runtime**: Bun (not Node). **Package manager**: Bun only — never npm/yarn/pnpm.
- **Language**: TypeScript strict, ESM, `noEmit` (tsc is typecheck-only).
- **Framework**: Hono v4.11. **DB**: PostgreSQL + Drizzle ORM v0.45 (`postgres` driver).
- **Auth**: Firebase Admin (via `@sudobility/auth_service`). **Validation**: Zod.
- **Testing**: Vitest v4. **License**: BUSL-1.1.

## Architecture: this repo is a thin product shell

Almost all behavior — the HTTP server, middleware, health checks, auth, shared
DB tables/DDL, all admin + public routes, and every LLM adapter/prompt/provider
catalog — lives in two external packages:

- `@sudobility/shapeshyft_service` — server (`createApiServer`), routes, middleware,
  auth (`createFirebaseAuth`), lazy DB (`createLazyDatabase`), shared tables/DDL
  (`initServiceTables`), invitation email.
- `@sudobility/shapeshyft_engine` — LLM adapters, prompts, media, provider catalog,
  domain types (`createLLMProvider`).

**New backend logic almost always belongs in those libraries, not here.** A fix to an
adapter, prompt, or shared route goes in the library, then both this API and ShapeRouter
bump the dependency. Release order lives in `shapeshyft_app/scripts/push_all.sh`.

What is genuinely local (ShapeShyft-only) — the only code to edit here:

```
src/
├── index.ts                   # Entry: createApiServer(name, routes, db, initDatabase, port ?? 3000)
├── service.ts                 # createShapeshyftService(...) wiring + mountShapeshyftRoutes
├── image-provider.ts          # Wraps createLLMProvider to add Gemini/OpenAI image output
├── credentials/llm-key-resolver.ts  # Provider creds from entity's llm_api_keys row
├── db/
│   ├── index.ts               # createLazyDatabase + initDatabase() (service tables + llm_api_keys)
│   ├── init.ts                # `bun run db:init` — runs initDatabase() then exits
│   ├── schema.ts              # Service tables re-exported + llm_api_keys
│   ├── llm-api-keys.ts        # llm_api_keys DDL, endpoints FK, provider backfill
│   └── migrate.ts             # One-off data migration (user_id -> entity_id)
├── routes/
│   ├── keys.ts                # LLM provider API key CRUD (encrypted) — createKeysRouter(ctx)
│   └── provider-sync.ts       # Point self-hosted (lm_studio) providers at caller's IP
├── schemas/{keys,endpoint-binding}.ts
└── lib/{encryption,env-helper,peer-address,provider-url}.ts
tests/   *.db.test.ts = DB suites; tests/unit/*.test.ts = unit; stubs/hono-bun.ts
```

## Commands

```bash
bun install          # Bun only
bun run dev          # Dev server, hot reload (--watch). Default port 3000.
bun run start        # Run src/index.ts directly (no build)
bun run build        # Bundle to dist/ (production/Docker only)
bun run start:prod   # Run dist/index.js
bun run typecheck    # tsc --noEmit
bun run lint         # eslint src
bun run format       # prettier --write src
bun run test:unit    # Unit tests (Vitest). THIS is what CI runs. No `test` script exists.
bun run test:watch   # Unit tests, watch mode
bun run test:db      # DB suites (*.db.test.ts), MANUAL. Needs TEST_DATABASE_URL on localhost.
bun run test:db:setup  # Create local shapeshyft_test database
bun run db:init      # Apply schema/tables/indexes then exit (idempotent)
bun run verify       # Pre-commit gate: typecheck + lint + test:unit
```

## Testing gotchas (important)

- **One runner: Vitest. NEVER run `bun test`.** `bun test` is Bun's own runner: it
  ignores both vitest configs and the localhost guard, collects the `*.db.test.ts`
  suites, and runs them against `DATABASE_URL` from `.env` — a **remote** database it
  will migrate and mutate. There is no `test` npm script, so `bun run test` errors;
  use `bun run test:unit`. `bun run verify` uses `test:unit` for this reason.
- Two configs: `vitest.config.ts` (unit) **excludes** `**/*.db.test.ts`, so CI never
  touches a DB; `vitest.db.config.ts` collects **only** those files, no parallelism.
- DB suffix is the only marker: a test is a DB test iff its file ends `.db.test.ts`
  (directory irrelevant).
- `tests/setup.ts` deletes `DATABASE_URL` so a prod URL in your shell can't leak into
  unit tests. `tests/setup.db.ts` requires `TEST_DATABASE_URL` to be exactly `localhost`
  (refuses `127.0.0.1`) before assigning it to `DATABASE_URL`.
- `hono/bun` only resolves under Bun; both vitest configs alias it to
  `tests/stubs/hono-bun.ts` (reads the peer from the server object). Don't hardcode an
  address there — suites supply their own fixtures.
- `@sudobility/*` service packages are compiled by tsc with extensionless/directory
  relative imports that Node's ESM resolver rejects, so both configs `server.deps.inline`
  them to route through Vite.

## Database

- PostgreSQL, **`shapeshyft` schema** (not `public`). Shared-table DDL comes from
  `initServiceTables`; the one local table is `llm_api_keys` (`src/db/llm-api-keys.ts`,
  encrypted provider keys, FK from `endpoints.llm_key_id`).
- **`initDatabase()` IS the migration system** — no migration tool. It runs on every
  server boot and via `bun run db:init`; every statement is idempotent (additive
  `ALTER TABLE ... IF NOT EXISTS`). A new column must be added there by hand.
- **Lazy Proxy connection** (`createLazyDatabase`): nothing connects at import; first
  access initializes. Intentional — lets tests/scripts import without `DATABASE_URL`.

## Environment

Loaded via `src/lib/env-helper.ts` (`.env.local` wins over `.env`). Required:
`DATABASE_URL`, `ENCRYPTION_KEY` (exactly 64 hex chars = 32 bytes, AES-256),
`FIREBASE_PROJECT_ID` / `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY`,
`REVENUECAT_API_KEY` (rate limiting). Optional: `SITEADMIN_EMAILS`, `RESEND_*`,
`APP_URL`, `PORT` (default 3000; Docker uses 8020), `LM_STUDIO_TIMEOUT_MS`,
`NODE_ENV`/`BUN_ENV` (`test` disables Firebase). Full list in `.env.example`.

## Key conventions & gotchas

- **Three key types, different jobs** (the prefix routes the credential — never reuse):
  `sk_live_...` is a **project** key authenticating callers of a public AI endpoint
  (from `Authorization: Bearer` or `?api_key=`); `shyft_...` is a **personal** key
  authenticating its owner on admin routes; `shyftent_...` is an **entity** key
  authenticating as the workspace itself (path-restricted to `/entities/*`, cannot
  mint/reveal keys). Key prefixes are set in `src/service.ts`.
- **Public AI routes do their own project-key auth** — not Firebase, not `X-API-Key`.
  The invoke path has **no `/invoke` suffix**: `POST /api/v1/ai/:entitySlug/:project/:endpoint`;
  the endpoint name is the last segment, `/prompt` is the one reserved suffix.
- **Provider credentials are per-entity**, resolved from the `llm_api_keys` row bound by
  `endpoints.llm_key_id` (`src/credentials/llm-key-resolver.ts`), decrypted with
  `ENCRYPTION_KEY`. Encrypt/decrypt via `src/lib/encryption.ts`.
- **No build step for dev** — `bun run dev` runs TypeScript directly; `bun run build` is
  only for the production Docker image.
- **Six `@sudobility/*` deps** — version mismatches between them are the most common
  source of type errors. After bumping any, run `bun run typecheck`.
- `provider-sync.ts` rewrites `lm_studio` provider hosts to the caller's resolved public
  IP; it imports `getConnInfo` from `hono/bun` (hence the test alias above). This is a
  **leaf app** — nothing depends on it.

Deep route/LLM-provider/structured-output/rate-limit behavior is implemented in the
shared packages above; document and change it there, not in this README/CLAUDE.md.
