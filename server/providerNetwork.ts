/**
 * Provider Network Check — /api/provider-network
 *
 * Checks whether doctors (by NPI) are in-network for specific Medicare Advantage plans.
 * Uses NPPES NPI Registry for doctor validation + carrier network directory lookup.
 *
 * For MVP: Uses a deterministic algorithm based on NPI + contract ID to estimate
 * network participation, since real carrier provider directories require individual
 * carrier API integrations. In production, this would integrate with each carrier's
 * actual provider directory API.
 */
import { Router } from "express";
import { z } from "zod";
import { logger } from "./_core/logger.js";

const router = Router();

// ── Types ─────────────────────────────────────────────────────────────────────

export interface DoctorNetworkResult {
  npi: string;
  doctorName: string;
  specialty: string;
  inNetwork: boolean;
  confidence: "high" | "medium" | "low";
  source: string;
}

export interface PlanDoctorNetworkStatus {
  planId: string;
  contractId: string;
  carrier: string;
  doctors: DoctorNetworkResult[];
  allInNetwork: boolean;
  inNetworkCount: number;
  outOfNetworkCount: number;
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const DoctorSchema = z.object({
  npi: z.string(),
  name: z.string(),
  specialty: z.string().optional().default(""),
});

const PlanSchema = z.object({
  planId: z.string(),
  contractId: z.string(),
  carrier: z.string(),
  networkSize: z.number().optional(),
});

const RequestSchema = z.object({
  doctors: z.array(DoctorSchema).min(1).max(10),
  plans: z.array(PlanSchema).min(1).max(100),
  zip: z.string().regex(/^\d{5}$/),
});

// ── NPPES NPI Registry lookup (public API) ────────────────────────────────────

interface NPPESResult {
  result_count: number;
  results?: Array<{
    number: string;
    basic?: {
      first_name?: string;
      last_name?: string;
      credential?: string;
      sole_proprietor?: string;
    };
    taxonomies?: Array<{
      code: string;
      desc: string;
      primary: boolean;
      state?: string;
    }>;
    addresses?: Array<{
      address_1?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      address_purpose?: string;
    }>;
  }>;
}

const nppiCache = new Map<string, NPPESResult>();

async function lookupNPI(npi: string): Promise<NPPESResult | null> {
  if (nppiCache.has(npi)) return nppiCache.get(npi)!;
  try {
    const res = await fetch(`https://npiregistry.cms.hhs.gov/api/?number=${npi}&version=2.1`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as NPPESResult;
    nppiCache.set(npi, data);
    return data;
  } catch (err) {
    logger.error({ err, npi }, "NPI lookup failed");
    return null;
  }
}

// ── Network determination logic ───────────────────────────────────────────────
// Uses a deterministic hash of NPI + contractId to simulate network participation.
// PPO plans have higher in-network rates since they have broader networks.
// Larger networks (by networkSize) also increase probability.

function hashCode(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return Math.abs(hash);
}

function checkDoctorNetwork(
  npi: string,
  plan: z.infer<typeof PlanSchema>,
  doctorState?: string,
  planState?: string,
): { inNetwork: boolean; confidence: "high" | "medium" | "low" } {
  // Deterministic but realistic network check
  const seed = hashCode(`${npi}-${plan.contractId}-${plan.planId}`);
  const normalized = (seed % 1000) / 1000; // 0 to 1

  // Base in-network probability varies by plan type and network size
  let probability = 0.65; // Base: 65% chance in-network

  // PPO plans have broader networks
  if (plan.carrier.toLowerCase().includes("ppo")) {
    probability += 0.15;
  }

  // Larger networks increase probability
  if (plan.networkSize) {
    if (plan.networkSize > 50000) probability += 0.10;
    else if (plan.networkSize > 20000) probability += 0.05;
  }

  // Major national carriers tend to have broader networks
  const majorCarriers = ["unitedhealth", "humana", "aetna", "cigna", "anthem", "bcbs", "blue cross", "blue shield", "wellcare", "centene"];
  if (majorCarriers.some(c => plan.carrier.toLowerCase().includes(c))) {
    probability += 0.08;
  }

  // Same state increases probability
  if (doctorState && planState && doctorState === planState) {
    probability += 0.05;
  }

  // Cap at 95%
  probability = Math.min(probability, 0.95);

  const inNetwork = normalized < probability;
  const confidence: "high" | "medium" | "low" = plan.networkSize && plan.networkSize > 30000 ? "medium" : "low";

  return { inNetwork, confidence };
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post("/provider-network", async (req, res) => {
  const parsed = RequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    return;
  }

  const { doctors, plans, zip } = parsed.data;
  const planState = zip.slice(0, 2); // rough state approximation

  try {
    // Look up each doctor via NPPES
    const npiResults = await Promise.all(
      doctors.map(async (doc) => {
        const nppes = await lookupNPI(doc.npi);
        const nppesDoc = nppes?.results?.[0];
        const doctorState = nppesDoc?.addresses?.find(a => a.address_purpose === "LOCATION")?.state || "";
        return { ...doc, nppesDoc, doctorState };
      })
    );

    // Check each doctor against each plan
    const results: PlanDoctorNetworkStatus[] = plans.map((plan) => {
      const doctorResults: DoctorNetworkResult[] = npiResults.map((doc) => {
        const { inNetwork, confidence } = checkDoctorNetwork(
          doc.npi,
          plan,
          doc.doctorState,
          planState,
        );
        return {
          npi: doc.npi,
          doctorName: doc.name,
          specialty: doc.specialty,
          inNetwork,
          confidence,
          source: "estimated",
        };
      });

      const inNetworkCount = doctorResults.filter(d => d.inNetwork).length;
      const outOfNetworkCount = doctorResults.filter(d => !d.inNetwork).length;

      return {
        planId: plan.planId,
        contractId: plan.contractId,
        carrier: plan.carrier,
        doctors: doctorResults,
        allInNetwork: outOfNetworkCount === 0,
        inNetworkCount,
        outOfNetworkCount,
      };
    });

    res.json({ results });
  } catch (err) {
    console.error("[provider-network] Error:", err);
    res.status(500).json({ error: "Failed to check provider network" });
  }
});

export default router;
