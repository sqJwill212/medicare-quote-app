import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic, setupVite } from "./vite";
import { registerCompareStreamRoute } from "../compareStream";
import recommendStreamRouter from "../recommendStream";
import providerNetworkRouter from "../providerNetwork";
import { registerPlansRoute, prewarmPlanCache } from "../plansRouter";
import { registerDoctorsRoute } from "../doctorsRouter";
import { registerChatRoute } from "../chatRouter";
import { registerBlueButtonRoute } from "../blueButtonRouter";
import { registerVoiceWebhookRoute } from "../voiceWebhookRouter";
import { seedCmsDataSources, startCmsPipelineCron } from "../cmsPipeline";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  const app = express();
  const server = createServer(app);

  // Trust the first proxy hop (needed for accurate IP detection behind Manus gateway)
  app.set("trust proxy", 1);

  // ── Security headers (helmet) ─────────────────────────────────────────────
  // Disable CSP in development (Vite HMR uses inline scripts)
  app.use(
    helmet({
      contentSecurityPolicy: process.env.NODE_ENV === "production",
      crossOriginEmbedderPolicy: false, // needed for CDN assets
    })
  );

  // ── Rate limiting ─────────────────────────────────────────────────────────
  // General API rate limit: 200 requests per 15 minutes per IP
  const generalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many requests. Please try again later." },
  });

  // Strict rate limit for AI/LLM endpoints: 20 requests per 15 minutes per IP
  const aiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many AI requests. Please wait before trying again." },
  });

  // Plans endpoint: 60 requests per 15 minutes per IP (ZIP lookups + CSV parsing)
  const plansLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many plan lookup requests. Please try again later." },
  });

  app.use("/api", generalLimiter);
  app.use("/api/compare-stream", aiLimiter);
  app.use("/api/recommend-stream", aiLimiter);
  app.use("/api/plans", plansLimiter);

  // ── Body parser — reduced limit (no file uploads in this app) ────────────
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "1mb", extended: true }));

  // ── Routes ────────────────────────────────────────────────────────────────
  // OAuth callback under /api/oauth/callback
  registerOAuthRoutes(app);
  // Real CMS plans endpoint
  registerPlansRoute(app);
  // Doctor search endpoint
  registerDoctorsRoute(app);
  // Provider network check endpoint
  app.use("/api", providerNetworkRouter);
  // Chat AI endpoint
  registerChatRoute(app);
  // Blue Button OAuth callback
  registerBlueButtonRoute(app);
  // Voice webhook endpoint
  registerVoiceWebhookRoute(app);
  // Streaming AI compare endpoint (SSE) — registered before tRPC
  registerCompareStreamRoute(app);
  // Streaming Plan Recommender AI narrative endpoint
  app.use("/api", recommendStreamRouter);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );

  // development mode uses Vite, production mode uses static files
  if (process.env.NODE_ENV === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

  const preferredPort = parseInt(process.env.PORT || "3000");
  const port = await findAvailablePort(preferredPort);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    // Pre-warm plan cache for common states in the background (non-blocking)
    prewarmPlanCache().catch((err) => console.warn("[Plans] Pre-warm failed:", err));
    // Seed CMS data sources and start the daily sync cron
    seedCmsDataSources().catch((err) => console.warn("[CMS] Seed failed:", err));
    startCmsPipelineCron();
  });
}

startServer().catch(console.error);
