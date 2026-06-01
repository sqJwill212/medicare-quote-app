// api/bluebutton-callback.ts
// Vercel Serverless Function – CMS Blue Button 2.0 OAuth Callback Handler
// Exchanges authorization code for access token, fetches EOB claims data,
// extracts Part D drug history, and returns structured drug list to the client.

import type { VercelRequest, VercelResponse } from "@vercel/node";
import { logger } from "../server/_core/logger.js";

const BB2_BASE = "https://api.bluebutton.cms.gov";
const BB2_SANDBOX_BASE = "https://sandbox.bluebutton.cms.gov";

const BASE_URL =
  process.env.NODE_ENV === "production" ? BB2_BASE : BB2_SANDBOX_BASE;

const CLIENT_ID = process.env.BB2_CLIENT_ID || "";
const CLIENT_SECRET = process.env.BB2_CLIENT_SECRET || "";
const REDIRECT_URI =
  process.env.BB2_REDIRECT_URI ||
  "https://medicare-quote-app.vercel.app/api/bluebutton-callback";

interface EoBItem {
  resourceType: string;
  id: string;
  status: string;
  type?: { coding?: Array<{ code?: string }> };
  item?: Array<{
    productOrService?: {
      coding?: Array<{ system?: string; code?: string; display?: string }>;
    };
    quantity?: { value?: number };
    servicedDate?: string;
  }>;
}

interface DrugEntry {
  name: string;
  rxNorm?: string;
  ndc?: string;
  quantity?: number;
  lastFilled?: string;
  daysSupply?: number;
}

function extractDrugsFromEoB(bundle: { entry?: Array<{ resource?: EoBItem }> }): DrugEntry[] {
  const drugs: Map<string, DrugEntry> = new Map();

  if (!bundle.entry) return [];

  for (const entry of bundle.entry) {
    const resource = entry.resource;
    if (!resource || resource.resourceType !== "ExplanationOfBenefit") continue;

    // Only process Part D (pharmacy) claims
    const claimType = resource.type?.coding?.[0]?.code;
    if (claimType !== "pharmacy" && claimType !== "rx") continue;

    for (const item of resource.item || []) {
      const coding = item.productOrService?.coding || [];

      let rxNorm: string | undefined;
      let ndc: string | undefined;
      let displayName: string | undefined;

      for (const code of coding) {
        if (code.system?.includes("rxnorm") || code.system?.includes("RxNorm")) {
          rxNorm = code.code;
          displayName = code.display;
        }
        if (code.system?.includes("ndc") || code.system?.includes("NDC")) {
          ndc = code.code;
          if (!displayName) displayName = code.display;
        }
      }

      if (!displayName && !rxNorm && !ndc) continue;

      const key = rxNorm || ndc || displayName || "unknown";

      if (!drugs.has(key)) {
        drugs.set(key, {
          name: displayName || `Drug (${rxNorm || ndc || "unknown"})`,
          rxNorm,
          ndc,
          quantity: item.quantity?.value,
          lastFilled: item.servicedDate,
        });
      } else {
        // Keep most recent fill date
        const existing = drugs.get(key)!;
        if (
          item.servicedDate &&
          (!existing.lastFilled || item.servicedDate > existing.lastFilled)
        ) {
          existing.lastFilled = item.servicedDate;
        }
      }
    }
  }

  return Array.from(drugs.values());
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  const { code, state, error } = req.query;

  // ── Step 1: Handle OAuth errors from CMS ───────────────────────────────────
  if (error) {
    console.error("[BlueButton] OAuth error from CMS:", error);
    return res.redirect(
      302,
      `/plans?bb_error=${encodeURIComponent(String(error))}`
    );
  }

  if (!code || typeof code !== "string") {
    return res.status(400).json({
      error: "missing_code",
      message: "Authorization code is required.",
    });
  }

  try {
    // ── Step 2: Exchange code for access token ────────────────────────────────
    const tokenRes = await fetch(`${BASE_URL}/v1/o/token/`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64")}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      const errBody = await tokenRes.text();
      console.error("[BlueButton] Token exchange failed:", errBody);
      return res.redirect(302, `/plans?bb_error=token_exchange_failed`);
    }

    const tokenData = (await tokenRes.json()) as {
      access_token: string;
      token_type: string;
      expires_in: number;
      patient: string;
    };

    const { access_token, patient } = tokenData;

    // ── Step 3: Fetch Explanation of Benefit (claims) data ───────────────────
    // Paginate through all EOB resources to get full 4-year history
    const allEntries: Array<{ resource?: EoBItem }> = [];
    let nextUrl: string | null =
      `${BASE_URL}/v1/fhir/ExplanationOfBenefit/?patient=${patient}&startIndex=0&_count=50`;

    let pageCount = 0;
    while (nextUrl && pageCount < 20) {
      const eobRes = await fetch(nextUrl, {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/json",
        },
      });

      if (!eobRes.ok) break;

      const eobBundle = (await eobRes.json()) as {
        entry?: Array<{ resource?: EoBItem }>;
        link?: Array<{ relation: string; url: string }>;
      };

      if (eobBundle.entry) {
        allEntries.push(...eobBundle.entry);
      }

      const nextLink = eobBundle.link?.find((l) => l.relation === "next");
      nextUrl = nextLink?.url || null;
      pageCount++;
    }

    // ── Step 4: Extract drug list from Part D claims ─────────────────────────
    const drugs = extractDrugsFromEoB({ entry: allEntries });

    // ── Step 5: Fetch patient demographics (name, DOB) ──────────────────────
    let patientName = "";
    try {
      const patientRes = await fetch(`${BASE_URL}/v1/fhir/Patient/${patient}`, {
        headers: {
          Authorization: `Bearer ${access_token}`,
          Accept: "application/json",
        },
      });
      if (patientRes.ok) {
        const patientData = (await patientRes.json()) as {
          name?: Array<{ family?: string; given?: string[] }>;
        };
        const nameObj = patientData.name?.[0];
        if (nameObj) {
          patientName = `${(nameObj.given || []).join(" ")} ${nameObj.family || ""}`.trim();
        }
      }
    } catch (err) {
      logger.error({ err, patient }, "Failed to fetch patient demographics (non-fatal)");
    }

    // ── Step 6: Return structured data ──────────────────────────────────────
    return res.status(200).json({
      success: true,
      patientId: patient,
      patientName,
      drugCount: drugs.length,
      drugs,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[BlueButton] Unexpected error:", err);
    return res.status(500).json({
      error: "internal_error",
      message: "An unexpected error occurred while fetching your Medicare data.",
    });
  }
}
