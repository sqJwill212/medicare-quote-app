/**
 * /api/voice-webhook
 *
 * Express route registration for the voice webhook endpoint.
 * Wraps the Vercel-style handler from api/voice-webhook.ts for local dev.
 */
import { type Express } from "express";
import handler from "../api/voice-webhook";

export function registerVoiceWebhookRoute(app: Express): void {
  app.post("/api/voice-webhook", async (req, res) => {
    await handler(req as any, res as any);
  });
}
