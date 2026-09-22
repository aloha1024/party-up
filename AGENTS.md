# Repository Guidelines

## Project Structure & Module Organization

Stack: Next.js App Router, React, TypeScript, Prisma, and SQLite.

- `app/`: pages, layouts, API routes, and `icon.svg`.
- `components/`: feature components; `components/ui/` contains shared UI primitives.
- `server/`: database access, authentication, and reservation business logic.
- `lib/` and `types/`: validation, utilities, and shared types.
- `prisma/`: schema and versioned migrations.
- `scripts/`: initialization, Docker startup, backups, and test orchestration.
- `tests/`: business, HTTP, concurrency, migration, and script tests.

Keep business logic in `server/`; reuse reservation transactions to prevent concurrent overbooking.

## Build, Test, and Development Commands

Use Node.js 22.13+ and npm.

- `npm ci`: install locked dependencies.
- Copy `.env.example` to `.env` if absent.
- `npm run db:generate` and `npm run db:migrate`: generate Prisma Client and apply migrations.
- `npm run admin:setup`: initialize the local administrator.
- `npm run dev`: start development at port 3000.
- `npm run typecheck`: check TypeScript.
- `npm test`: build and run tests with a temporary database and independent HTTP service.
- `npm run test:unit`: skip the build and HTTP tests.
- `npm run test:e2e`: isolated Playwright tests; install Chromium first.
- `npm run benchmark:queries`: synthetic in-memory query comparison.
- `npm run build` / `npm start`: build / run production.
- `docker compose up -d --build`: deploy using Docker.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, double quotes, and semicolons. Follow Prettier formatting: `npx prettier --write <files>`. No lint command exists.

Use kebab-case filenames, PascalCase components/types, and camelCase functions/variables. Follow App Router names such as `page.tsx` and `route.ts`. Preserve Chinese interface text and responsive dark styling. Shell scripts require LF endings.

## Testing Guidelines

Unit/HTTP tests use `node:test`, `node:assert/strict`, and `tsx`; name files `tests/*.test.ts`. Browser tests use Playwright in `tests/e2e/*.spec.ts`. Import `./support/isolated` before application database imports.

Cover authorization, validation, state transitions, concurrent mutations, and migration preservation when affected. No numeric coverage threshold exists. Run type checking and relevant tests before review. Full tests overwrite `.next`; stop local servers first. Never target production databases or services.

## Commit & Pull Request Guidelines

Follow existing prefixes: `feat:`, `fix:`, and `docs:`; use concise imperative summaries. Keep commits focused.

PRs should describe behavior changes, validation results, and migration/deployment implications. Link relevant issues and include screenshots for UI changes. Update README instructions and update history when behavior changes.

## Security & Framework Guidance

Never commit credentials, `.env`, databases, or backups. Enforce authorization and Zod validation server-side. Back up persistent data before migrations.

<!-- BEGIN:nextjs-agent-rules -->

Consult relevant installed Next.js documentation in `node_modules/next/dist/docs/` before framework changes; this version may differ from familiar APIs.

<!-- END:nextjs-agent-rules -->
