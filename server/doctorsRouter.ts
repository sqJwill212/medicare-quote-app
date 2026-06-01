/**
 * /api/doctors?name={name}&zip={zip}&radius={radius}
 *
 * Express route registration for the doctor search endpoint.
 * Wraps the Vercel-style handler from api/doctors.ts for local dev.
 */
import { type Express } from "express";
import handler from "../api/doctors";

export function registerDoctorsRoute(app: Express): void {
  app.get("/api/doctors", async (req, res) => {
    await handler(req as any, res as any);
  });
}
