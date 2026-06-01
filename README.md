# Medicare Quote Engine (CQE)

A full-stack application for comparing and recommending Medicare plans. Built with React 19, Express, tRPC, Drizzle ORM, and Tailwind CSS.

## Prerequisites

- **Node.js** v22+ (managed via nvm recommended)
- **npm** v10+
- **AWS CLI** v2 — configured with credentials that have access to the SelectQuote AWS account
- **MySQL** — local instance or remote connection for the database

## AWS CodeArtifact Access

This project pulls npm packages from a private AWS CodeArtifact registry. You must authenticate before running `npm install`.

### First-time setup

1. Ensure your AWS CLI is configured with credentials for the SelectQuote account (`586672212047`):

   ```bash
   aws configure
   ```

2. Log in to CodeArtifact:

   ```bash
   aws codeartifact login \
     --tool npm \
     --repository selectquote-npm \
     --domain selectquote \
     --domain-owner 586672212047 \
     --region us-west-2
   ```

   This writes an auth token to your `~/.npmrc`. The token expires after 12 hours by default — re-run this command when it expires.

## Getting Started

1. **Clone the repo**

   ```bash
   git clone <repo-url>
   cd CQE
   ```

2. **Authenticate with CodeArtifact** (see above)

3. **Install dependencies**

   ```bash
   npm install
   ```

4. **Create your `.env` file**

   Copy the placeholder and fill in real values:

   ```bash
   cp .env.example .env
   ```

   Or create `.env` at the project root with the following variables:

   | Variable | Description |
   |----------|-------------|
   | `DATABASE_URL` | MySQL connection string (e.g. `mysql://user:pass@localhost:3306/cqe`) |
   | `JWT_SECRET` | Secret for signing session cookies |
   | `OAUTH_SERVER_URL` | OAuth server endpoint |
   | `OWNER_OPEN_ID` | Owner OpenID identifier |
   | `VITE_APP_ID` | OAuth application ID (exposed to client) |
   | `VITE_OAUTH_PORTAL_URL` | OAuth portal URL for login redirects (exposed to client) |
   | `BUILT_IN_FORGE_API_URL` | Forge AI API endpoint |
   | `BUILT_IN_FORGE_API_KEY` | Forge AI API key |
   | `ANTHROPIC_API_KEY` | Anthropic Claude API key (optional) |
   | `OPENAI_API_KEY` | OpenAI API key (optional fallback) |
   | `PVERIFY_CLIENT_ID` | pVerify client ID |
   | `PVERIFY_CLIENT_SECRET` | pVerify client secret |
   | `PVERIFY_API_KEY` | pVerify API key |
   | `BB2_CLIENT_ID` | Blue Button 2.0 client ID |
   | `BB2_CLIENT_SECRET` | Blue Button 2.0 client secret |
   | `BB2_REDIRECT_URI` | Blue Button callback URL |
   | `CMS_MARKETPLACE_API_KEY` | CMS Marketplace API key |
   | `ADMIN_PASSWORD` | Admin panel password (defaults to `admin123` in dev) |
   | `PORT` | Server port (defaults to `3000`) |

5. **Set up MySQL**

   Run a local MySQL instance via Docker:

   ```bash
   docker run -d \
     --name mysql \
     -e MYSQL_ROOT_PASSWORD={password} \
     -p 3306:3306 \
     -v mysql_data:/var/lib/mysql \
     mysql:8
   ```

   Then create the database:

   ```bash
   mysql -h 127.0.0.1 -u root -p{password} -e "CREATE DATABASE IF NOT EXISTS cqe;"
   ```

6. **Run database migrations**

   ```bash
   npm run db:push
   ```

   This generates migration files from the Drizzle schema and applies them to create all tables.

7. **Start the dev server**

   ```bash
   npm run dev
   ```

   The app will be available at `http://localhost:3000` (or the next available port).

## Available Scripts

| Script | Description |
|--------|-------------|
| `npm run dev` | Start the development server with hot reload |
| `npm run build` | Build the production bundle via Vite |
| `npm start` | Run the production build |
| `npm run check` | TypeScript type checking (no emit) |
| `npm run format` | Format code with Prettier |
| `npm test` | Run tests with Vitest |
| `npm run db:push` | Generate and run Drizzle database migrations |

## Tech Stack

- **Frontend:** React 19, Tailwind CSS 4, Radix UI, Recharts, Framer Motion, Wouter
- **Backend:** Express, tRPC, Drizzle ORM, MySQL
- **Build:** Vite 7, TypeScript 5.9, tsx
- **Testing:** Vitest

## Project Structure

```
├── api/              # Vercel-style serverless API routes
├── client/           # React frontend (Vite entry at client/index.html)
│   └── src/
│       ├── components/
│       └── _core/
├── server/           # Express server, tRPC routers, DB schema
│   └── _core/       # Server bootstrap, env config, Vite integration
├── .env              # Local environment variables (gitignored)
├── drizzle.config.ts # Drizzle Kit configuration
├── package.json
└── vite.config.ts
```

## Troubleshooting

**`npm install` returns 401 Unauthorized**
Your CodeArtifact token has expired. Re-run the `aws codeartifact login` command above.

**Database connection errors**
Ensure MySQL is running and `DATABASE_URL` in your `.env` is correct. The app will start without a DB connection but database-dependent features won't work.

**Port already in use**
The dev server will automatically find the next available port if 3000 is taken.
