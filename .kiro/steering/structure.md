# Project Structure

## Top-Level Layout

```
├── api/              # Vercel serverless API routes (deployment edge functions)
├── client/           # React frontend (Vite SPA)
│   └── src/
│       ├── _core/        # Core client infrastructure (hooks, providers)
│       ├── components/   # Shared UI components
│       │   └── ui/       # shadcn/ui primitives (button, dialog, input, etc.)
│       ├── contexts/     # React context providers (theme, etc.)
│       ├── features/     # Feature-specific modules with co-located tests
│       ├── hooks/        # Shared custom hooks
│       ├── lib/          # Utility libraries (trpc client, helpers)
│       └── pages/        # Route page components
│           ├── company/      # Company info pages
│           ├── ma/           # Medicare Advantage pages
│           ├── partd/        # Part D pages
│           ├── resources/    # Educational resource pages
│           └── supplement/   # Medicare Supplement pages
├── server/           # Express server + tRPC routers
│   └── _core/        # Server infrastructure (env, trpc init, auth, logging, vite)
├── shared/           # Code shared between client and server
│   └── _core/        # Shared core utilities (error types)
├── drizzle/          # Database schema, relations, and migrations
└── patches/          # npm package patches (patch-package style)
```

## Conventions

- **`_core/` directories**: Infrastructure and foundational code that rarely changes. Present in `client/src/`, `server/`, and `shared/`.
- **Router pattern**: Each server feature has its own `*Router.ts` file (e.g., `compareRouter.ts`, `plansRouter.ts`). Routers are assembled in `server/routers.ts`.
- **tRPC procedures**: Use `publicProcedure`, `protectedProcedure`, or `adminProcedure` from `server/_core/trpc.ts` based on auth requirements.
- **Page components**: One file per route in `client/src/pages/`. Sub-categories are grouped in subdirectories.
- **UI components**: Radix-based primitives live in `components/ui/`. Feature-specific components live directly in `components/`.
- **Shared types**: Export from `shared/types.ts` which re-exports Drizzle schema types and error types.
- **Database schema**: Defined in `drizzle/schema.ts`. Migrations generated via Drizzle Kit.
- **Tests**: Co-located with server code as `*.test.ts` files. Client feature tests live in `features/**/__tests__/`.
- **Environment config**: Server env vars validated/exported from `server/_core/env.ts`. Client env vars prefixed with `VITE_`.
- **API routes (Vercel)**: The `api/` directory contains Vercel-style serverless functions for edge deployment, mirroring server routes.
