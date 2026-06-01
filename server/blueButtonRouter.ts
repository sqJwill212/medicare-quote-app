/**
 * /api/bluebutton-callback
 *
 * Express route registration for the CMS Blue Button OAuth callback.
 * Wraps the Vercel-style handler from api/bluebutton-callback.ts for local dev.
 */
import { type Express } from "express";
import handler from "../api/bluebutton-callback";

export function registerBlueButtonRoute(app: Express): void {
  app.get("/api/bluebutton-callback", async (req, res) => {
    await handler(req as any, res as any);
  });
}
