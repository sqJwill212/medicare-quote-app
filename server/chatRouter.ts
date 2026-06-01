/**
 * /api/chat
 *
 * Express route registration for the AI chat endpoint.
 * Wraps the Vercel-style handler from api/chat.ts for local dev.
 */
import { type Express } from "express";
import handler from "../api/chat";

export function registerChatRoute(app: Express): void {
  app.post("/api/chat", async (req, res) => {
    await handler(req as any, res as any);
  });
}
