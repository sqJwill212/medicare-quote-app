# Tech Stack & Build System

## Languages & Runtime

- TypeScript 5.9 (strict mode)
- Node.js 22+
- ESM modules (`"type": "module"` in package.json)

## Frontend

- React 19
- Tailwind CSS 4 (via `@tailwindcss/vite` plugin)
- Radix UI primitives (dialog, select, tabs, tooltip, etc.)
- shadcn/ui component patterns (components in `client/src/components/ui/`)
- Wouter for client-side routing
- TanStack React Query for server state
- tRPC React client (`@trpc/react-query`)
- Zustand for client-side state management
- Framer Motion for animations
- Recharts for data visualization
- Lucide React for icons
- react-hook-form + zod for form validation
- Sonner for toast notifications

## Backend

- Express 4 with tRPC adapters
- tRPC v11 with superjson transformer
- Drizzle ORM with MySQL (mysql2 driver)
- Pino for structured logging
- Helmet for security headers
- express-rate-limit for API rate limiting
- jose for JWT handling
- node-cron for scheduled tasks (CMS data sync)
- Axios for external API calls

## Build & Dev Tools

- Vite 7 (build + dev server with HMR)
- tsx for running TypeScript server in dev (watch mode)
- esbuild (used by Vite under the hood)
- Prettier for code formatting
- Vitest for testing
- Drizzle Kit for database migrations

## External Integrations

- CMS Marketplace API (plan data)
- pVerify (eligibility verification)
- Blue Button 2.0 / CMS (beneficiary claims)
- Vapi AI (voice assistant)
- AWS S3 (file storage)
- AWS CodeArtifact (private npm registry)
- LLM APIs: Forge AI (primary), Anthropic Claude, OpenAI (fallback)

## Common Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start dev server (Express + Vite HMR) |
| `npm run build` | Production build via Vite |
| `npm start` | Run production build |
| `npm run check` | TypeScript type-check (no emit) |
| `npm run format` | Format all files with Prettier |
| `npm test` | Run tests with Vitest |
| `npm run db:push` | Generate + apply Drizzle migrations |

## Path Aliases

| Alias | Resolves To |
|-------|-------------|
| `@/*` | `./client/src/*` |
| `@shared/*` | `./shared/*` |
| `@assets/*` | `./attached_assets/*` |

## Code Style (Prettier)

- Double quotes, semicolons, trailing commas (es5)
- 2-space indent, 80 char print width
- Arrow parens: avoid when possible
- LF line endings
