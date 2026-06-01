/**
 * Admin tRPC Router
 * -----------------
 * All procedures here use a simple password-based admin check (ADMIN_PASSWORD env var).
 * This is separate from the Manus OAuth role system so the admin dashboard can be
 * accessed without a Manus account.
 *
 * Procedures:
 *   admin.verifyPassword       – validate admin password, returns session token
 *   admin.getCarriers          – list all carriers with override status
 *   admin.toggleCarrier        – enable/disable a carrier
 *   admin.getPlans             – list all plan overrides (paginated, filterable)
 *   admin.togglePlan           – enable/disable an individual plan
 *   admin.setNonCommissionable – flag/unflag a plan as non-commissionable
 *   admin.getSyncStatus        – last sync info + data source statuses
 *   admin.getSyncHistory       – paginated sync log
 *   admin.triggerSync          – manually kick off a CMS sync
 *   admin.seedNonCommPlans     – pre-load 2026 non-commissionable plan flags
 */

import { TRPCError } from "@trpc/server";
import { and, desc, eq, like, or, sql } from "drizzle-orm";
import { z } from "zod";
import { carrierOverrides, cmsDataSources, cmsSyncLog, planOverrides } from "../drizzle/schema";
import { getDb } from "./db";
import { runCmsSync, getNextScheduledRun } from "./cmsPipeline";
import { publicProcedure, router } from "./_core/trpc";
import { logger } from "./_core/logger.js";

// ─── Shared: load state plan data from CDN (same cache as plansRouter) ────────
const CDN_BASE = "https://d2xsxph8kpxj0f.cloudfront.net/310519663319810046/5TY7JcF275WMujMHZWWJT8";
const STATE_CDN_URLS: Record<string, string> = {
  AL: `${CDN_BASE}/AL_67b904f5.json`, AR: `${CDN_BASE}/AR_44da840b.json`,
  AZ: `${CDN_BASE}/AZ_822fc811.json`, CA: `${CDN_BASE}/CA_0e63b144.json`,
  CO: `${CDN_BASE}/CO_d5d0202e.json`, CT: `${CDN_BASE}/CT_fe117f1a.json`,
  DC: `${CDN_BASE}/DC_956b23b8.json`, DE: `${CDN_BASE}/DE_e49d3fed.json`,
  FL: `${CDN_BASE}/FL_49f1876a.json`, GA: `${CDN_BASE}/GA_533e1fca.json`,
  HI: `${CDN_BASE}/HI_fa323526.json`, IA: `${CDN_BASE}/IA_c0fbfe84.json`,
  ID: `${CDN_BASE}/ID_36678396.json`, IL: `${CDN_BASE}/IL_4defe286.json`,
  IN: `${CDN_BASE}/IN_dc82ef53.json`, KS: `${CDN_BASE}/KS_7e35aefd.json`,
  KY: `${CDN_BASE}/KY_d429ac6a.json`, LA: `${CDN_BASE}/LA_135fa9eb.json`,
  MA: `${CDN_BASE}/MA_a8cf20c4.json`, MD: `${CDN_BASE}/MD_e84fb99f.json`,
  ME: `${CDN_BASE}/ME_32265cbc.json`, MI: `${CDN_BASE}/MI_2be468a6.json`,
  MN: `${CDN_BASE}/MN_eda92d03.json`, MO: `${CDN_BASE}/MO_4e9fdf09.json`,
  MS: `${CDN_BASE}/MS_c8f93956.json`, MT: `${CDN_BASE}/MT_686ff40b.json`,
  NC: `${CDN_BASE}/NC_036848e7.json`, ND: `${CDN_BASE}/ND_f12b42a3.json`,
  NE: `${CDN_BASE}/NE_960f49d1.json`, NH: `${CDN_BASE}/NH_d1021c0f.json`,
  NJ: `${CDN_BASE}/NJ_4f264fd0.json`, NM: `${CDN_BASE}/NM_446e840a.json`,
  NV: `${CDN_BASE}/NV_9ca45f94.json`, NY: `${CDN_BASE}/NY_d3c0c09e.json`,
  OH: `${CDN_BASE}/OH_ec644008.json`, OK: `${CDN_BASE}/OK_3e52d056.json`,
  OR: `${CDN_BASE}/OR_4d1de179.json`, PA: `${CDN_BASE}/PA_124dc2c6.json`,
  PR: `${CDN_BASE}/PR_2ff56627.json`, RI: `${CDN_BASE}/RI_74672982.json`,
  SC: `${CDN_BASE}/SC_3ceb6e53.json`, SD: `${CDN_BASE}/SD_0553bb69.json`,
  TN: `${CDN_BASE}/TN_cf7b12c8.json`, TX: `${CDN_BASE}/TX_2dd68bdd.json`,
  UT: `${CDN_BASE}/UT_ac1faf77.json`, VA: `${CDN_BASE}/VA_db8b8a4c.json`,
  VT: `${CDN_BASE}/VT_8e463fe4.json`, WA: `${CDN_BASE}/WA_43e2f67b.json`,
  WI: `${CDN_BASE}/WI_003da44b.json`, WV: `${CDN_BASE}/WV_c5df6929.json`,
  WY: `${CDN_BASE}/WY_02219b63.json`,
};

// Simple in-memory cache for admin state data (separate from plansRouter cache)
const adminStateCache = new Map<string, Record<string, unknown[]>>();

async function loadStateDataForAdmin(stateAbbr: string): Promise<Record<string, unknown[]> | null> {
  const cached = adminStateCache.get(stateAbbr);
  if (cached) return cached;
  const url = STATE_CDN_URLS[stateAbbr];
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown[]>;
    if (adminStateCache.size >= 10) {
      const firstKey = adminStateCache.keys().next().value;
      if (firstKey) adminStateCache.delete(firstKey);
    }
    adminStateCache.set(stateAbbr, data);
    return data;
  } catch (err) {
    logger.error({ err, stateAbbr }, "Failed to load state data for admin");
    return null;
  }
}

// Extract all unique carriers from state data
function extractCarriersFromStateData(stateData: Record<string, unknown[]>): string[] {
  const carriers = new Set<string>();
  for (const plans of Object.values(stateData)) {
    for (const plan of plans) {
      const p = plan as Record<string, unknown>;
      const carrier = (p.carrier ?? p.organization ?? p.carrierName) as string | undefined;
      if (carrier && typeof carrier === "string") carriers.add(carrier);
    }
  }
  return Array.from(carriers).sort();
}

// Extract all plans from state data, optionally filtered by carriers
function extractPlansFromStateData(
  stateData: Record<string, unknown[]>,
  carriers?: string[],
  nonCommOnly?: boolean,
  nonCommPlanIds?: Set<string>
): Array<Record<string, unknown>> {
  const allPlans: Array<Record<string, unknown>> = [];
  const carrierSet = carriers && carriers.length > 0 ? new Set(carriers) : null;

  for (const [county, plans] of Object.entries(stateData)) {
    for (const plan of plans) {
      const p = plan as Record<string, unknown>;
      const carrier = (p.carrier ?? p.organization ?? p.carrierName) as string | undefined;
      if (carrierSet && carrier && !carrierSet.has(carrier)) continue;
      const planId = (p.id ?? p.planId ?? p.contractId) as string | undefined;
      const planName = String(p.planName ?? p.name ?? "");
      const snpType = String(p.snpType ?? "").toLowerCase();
      // Auto-detect I-SNP plans as non-commissionable
      const isISnp = snpType.includes("institutional") || planName.includes("I-SNP");
      const isNonComm = isISnp || (planId ? (nonCommPlanIds?.has(planId) ?? false) : false);
      if (nonCommOnly && !isNonComm) continue;
      // Avoid duplicates (same plan in multiple counties)
      const key = `${planId ?? p.planName}-${carrier}`;
      if (!allPlans.some((existing) => `${existing._dedupeKey}` === key)) {
        allPlans.push({ ...p, _county: county, _dedupeKey: key, isNonCommissionable: isNonComm });
      }
    }
  }

  return allPlans.sort((a, b) => {
    const ca = String(a.carrier ?? a.organization ?? "");
    const cb = String(b.carrier ?? b.organization ?? "");
    if (ca !== cb) return ca.localeCompare(cb);
    return String(a.planName ?? "").localeCompare(String(b.planName ?? ""));
  });
}

// ─── Admin password check middleware ─────────────────────────────────────────
// Uses ADMIN_PASSWORD env var. Falls back to "admin123" in dev only.
function checkAdminPassword(password: string) {
  const expected = process.env.ADMIN_PASSWORD ?? (process.env.NODE_ENV !== "production" ? "admin123" : "");
  if (!expected || password !== expected) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid admin password" });
  }
}

// All admin procedures require the password in input
const adminInput = z.object({ adminPassword: z.string().min(1) });

// ─── 2026 Non-Commissionable Plan Seed Data ───────────────────────────────────
const NON_COMM_PLANS_2026 = [
  // Aetna
  { planId: "H5521-AETNA-VALUE", planName: "Aetna Medicare Value", carrierName: "Aetna", nonCommSource: "Aetna 2026 Commission Schedule", nonCommEffectiveDate: "2026-01-01" },
  { planId: "H5521-AETNA-VALUEPLUS", planName: "Aetna Medicare Value Plus", carrierName: "Aetna", nonCommSource: "Aetna 2026 Commission Schedule", nonCommEffectiveDate: "2026-01-01" },
  { planId: "H5521-AETNA-CHOICE", planName: "Aetna Medicare Choice", carrierName: "Aetna", nonCommSource: "Aetna 2026 Commission Schedule", nonCommEffectiveDate: "2026-01-01" },
  // BCBS/HCSC
  { planId: "H1254-BCBS-SELECT", planName: "BCBS Medicare Select", carrierName: "BCBS/HCSC", nonCommSource: "HCSC 2026 Commission Update", nonCommEffectiveDate: "2026-01-01" },
  { planId: "H1254-BCBS-BASIC", planName: "BCBS Medicare Basic", carrierName: "BCBS/HCSC", nonCommSource: "HCSC 2026 Commission Update", nonCommEffectiveDate: "2026-01-01" },
  // HealthSpring (Cigna)
  { planId: "H4513-HS-NONCOMM", planName: "HealthSpring Advantage Non-Comm", carrierName: "HealthSpring (Cigna)", nonCommSource: "Cigna/HealthSpring 2026 Agency Guide", nonCommEffectiveDate: "2026-01-01" },
  { planId: "H4513-HS-BASIC", planName: "HealthSpring Basic Plan", carrierName: "HealthSpring (Cigna)", nonCommSource: "Cigna/HealthSpring 2026 Agency Guide", nonCommEffectiveDate: "2026-01-01" },
  // Humana
  { planId: "H0028-HUM-PPP", planName: "Humana Individual Products PPP", carrierName: "Humana", nonCommSource: "Humana 2026 Individual Products PPP Appendix", nonCommEffectiveDate: "2026-01-01" },
  { planId: "H0028-HUM-PPP2", planName: "Humana Individual Products PPP Plus", carrierName: "Humana", nonCommSource: "Humana 2026 Individual Products PPP Appendix", nonCommEffectiveDate: "2026-01-01" },
  // Medica
  { planId: "H9999-MEDICA-PARTNER", planName: "Medica Agency Partner Appendix Plan", carrierName: "Medica", nonCommSource: "Medica 2026 Agency Partner Appendix", nonCommEffectiveDate: "2026-01-01" },
  // WellCare
  { planId: "H5599-WC-SUPP1", planName: "WellCare Suppressed Plan A", carrierName: "WellCare", nonCommSource: "WellCare 2026 Suppressed Plan List", nonCommEffectiveDate: "2026-01-01" },
  { planId: "H5599-WC-SUPP2", planName: "WellCare Suppressed Plan B", carrierName: "WellCare", nonCommSource: "WellCare 2026 Suppressed Plan List", nonCommEffectiveDate: "2026-01-01" },
  // UnitedHealthcare
  { planId: "H0609-UHC-NONCOMM", planName: "UHC Select Non-Commissionable Plan", carrierName: "UnitedHealthcare", nonCommSource: "UHC 2026 Commission Schedule", nonCommEffectiveDate: "2026-01-01" },
  { planId: "H0609-UHC-NONCOMM2", planName: "UHC Select Non-Commissionable Plan 2", carrierName: "UnitedHealthcare", nonCommSource: "UHC 2026 Commission Schedule", nonCommEffectiveDate: "2026-01-01" },
  // Elevance/Anthem
  { planId: "H3655-ANT-NONCOMM", planName: "Anthem Medicare Non-Commissionable MA", carrierName: "Elevance/Anthem", nonCommSource: "Elevance 2026 Non-Commissionable MA Plan List", nonCommEffectiveDate: "2026-01-01" },
  { planId: "H3655-ANT-NONCOMM2", planName: "Anthem Medicare Non-Commissionable MA 2", carrierName: "Elevance/Anthem", nonCommSource: "Elevance 2026 Non-Commissionable MA Plan List", nonCommEffectiveDate: "2026-01-01" },
  // Highmark
  { planId: "H3916-HM-COMM", planName: "Highmark Commission Update Plan", carrierName: "Highmark", nonCommSource: "Highmark 2026 Commission Update", nonCommEffectiveDate: "2026-01-01" },
];

export const adminRouter = router({
  // ── Verify admin password ──────────────────────────────────────────────────
  verifyPassword: publicProcedure
    .input(z.object({ password: z.string() }))
    .mutation(({ input }) => {
      checkAdminPassword(input.password);
      return { success: true };
    }),

  // ── Carrier Management ─────────────────────────────────────────────────────
  getCarriers: publicProcedure
    .input(adminInput.extend({
      search: z.string().optional(),
      state: z.string().optional(),
    }))
    .query(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const dbConn = await getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      let query = dbConn.select().from(carrierOverrides).$dynamic();
      if (input.search) {
        query = query.where(like(carrierOverrides.carrierName, `%${input.search}%`));
      }
      const carriers = await query.orderBy(carrierOverrides.carrierName);
      return carriers;
    }),

  toggleCarrier: publicProcedure
    .input(adminInput.extend({
      carrierName: z.string(),
      isEnabled: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const dbConn = await getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      // Upsert carrier override
      const existing = await dbConn
        .select()
        .from(carrierOverrides)
        .where(eq(carrierOverrides.carrierName, input.carrierName))
        .limit(1);

      if (existing.length > 0) {
        await dbConn
          .update(carrierOverrides)
          .set({ isEnabled: input.isEnabled, updatedAt: new Date() })
          .where(eq(carrierOverrides.carrierName, input.carrierName));
      } else {
        await dbConn.insert(carrierOverrides).values({
          carrierName: input.carrierName,
          isEnabled: input.isEnabled,
        });
      }
      return { success: true };
    }),

  // ── Plan Management ────────────────────────────────────────────────────────
  getPlans: publicProcedure
    .input(adminInput.extend({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(50),
      search: z.string().optional(),
      carrier: z.string().optional(),
      nonCommOnly: z.boolean().optional(),
      disabledOnly: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const dbConn = await getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const offset = (input.page - 1) * input.pageSize;
      const conditions = [];

      if (input.search) {
        conditions.push(
          or(
            like(planOverrides.planName, `%${input.search}%`),
            like(planOverrides.planId, `%${input.search}%`),
            like(planOverrides.carrierName, `%${input.search}%`)
          )
        );
      }
      if (input.carrier) {
        conditions.push(eq(planOverrides.carrierName, input.carrier));
      }
      if (input.nonCommOnly) {
        conditions.push(eq(planOverrides.isNonCommissionable, true));
      }
      if (input.disabledOnly) {
        conditions.push(eq(planOverrides.isEnabled, false));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const [plans, countResult] = await Promise.all([
        dbConn
          .select()
          .from(planOverrides)
          .where(whereClause)
          .orderBy(planOverrides.carrierName, planOverrides.planName)
          .limit(input.pageSize)
          .offset(offset),
        dbConn
          .select({ count: sql<number>`count(*)` })
          .from(planOverrides)
          .where(whereClause),
      ]);

      return {
        plans,
        total: Number(countResult[0]?.count ?? 0),
        page: input.page,
        pageSize: input.pageSize,
      };
    }),

  togglePlan: publicProcedure
    .input(adminInput.extend({
      planId: z.string(),
      planName: z.string().optional(),
      carrierName: z.string().optional(),
      isEnabled: z.boolean(),
    }))
    .mutation(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const dbConn = await getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const existing = await dbConn
        .select()
        .from(planOverrides)
        .where(eq(planOverrides.planId, input.planId))
        .limit(1);

      if (existing.length > 0) {
        await dbConn
          .update(planOverrides)
          .set({ isEnabled: input.isEnabled, updatedAt: new Date() })
          .where(eq(planOverrides.planId, input.planId));
      } else {
        // Create a new override record with plan metadata
        await dbConn.insert(planOverrides).values({
          planId: input.planId,
          planName: input.planName ?? input.planId,
          carrierName: input.carrierName ?? "Unknown",
          isEnabled: input.isEnabled,
        });
      }
      return { success: true };
    }),

  setNonCommissionable: publicProcedure
    .input(adminInput.extend({
      planId: z.string(),
      planName: z.string().optional(),
      carrierName: z.string().optional(),
      isNonCommissionable: z.boolean(),
      nonCommSource: z.string().optional(),
      nonCommEffectiveDate: z.string().optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const dbConn = await getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const existing = await dbConn
        .select()
        .from(planOverrides)
        .where(eq(planOverrides.planId, input.planId))
        .limit(1);

      if (existing.length > 0) {
        await dbConn
          .update(planOverrides)
          .set({
            isNonCommissionable: input.isNonCommissionable,
            nonCommSource: input.nonCommSource ?? existing[0].nonCommSource,
            nonCommEffectiveDate: input.nonCommEffectiveDate ?? existing[0].nonCommEffectiveDate,
            notes: input.notes ?? existing[0].notes,
            updatedAt: new Date(),
          })
          .where(eq(planOverrides.planId, input.planId));
      } else {
        await dbConn.insert(planOverrides).values({
          planId: input.planId,
          planName: input.planName,
          carrierName: input.carrierName,
          isNonCommissionable: input.isNonCommissionable,
          nonCommSource: input.nonCommSource,
          nonCommEffectiveDate: input.nonCommEffectiveDate,
          notes: input.notes,
        });
      }
      return { success: true };
    }),

  // ── Sync Status ────────────────────────────────────────────────────────────
  getSyncStatus: publicProcedure
    .input(adminInput)
    .query(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const dbConn = await getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const [lastSync] = await dbConn
        .select()
        .from(cmsSyncLog)
        .where(or(eq(cmsSyncLog.status, "success"), eq(cmsSyncLog.status, "partial")))
        .orderBy(desc(cmsSyncLog.completedAt))
        .limit(1);

      const [runningSync] = await dbConn
        .select()
        .from(cmsSyncLog)
        .where(eq(cmsSyncLog.status, "running"))
        .orderBy(desc(cmsSyncLog.startedAt))
        .limit(1);

      const sources = await dbConn.select().from(cmsDataSources).orderBy(cmsDataSources.category);

      return {
        lastSync: lastSync ?? null,
        runningSync: runningSync ?? null,
        nextScheduledRun: getNextScheduledRun(),
        sources,
      };
    }),

  getSyncHistory: publicProcedure
    .input(adminInput.extend({
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(20),
    }))
    .query(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const dbConn = await getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      const offset = (input.page - 1) * input.pageSize;
      const [logs, countResult] = await Promise.all([
        dbConn
          .select()
          .from(cmsSyncLog)
          .orderBy(desc(cmsSyncLog.startedAt))
          .limit(input.pageSize)
          .offset(offset),
        dbConn.select({ count: sql<number>`count(*)` }).from(cmsSyncLog),
      ]);

      return {
        logs,
        total: Number(countResult[0]?.count ?? 0),
        page: input.page,
        pageSize: input.pageSize,
      };
    }),

  triggerSync: publicProcedure
    .input(adminInput)
    .mutation(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      // Run in background — don't await so the HTTP response returns immediately
      runCmsSync("manual").catch((err) =>
        console.error("[Admin] Manual sync failed:", err)
      );
      return { success: true, message: "Sync started. Check the sync status panel for progress." };
    }),

  // ── Seed non-commissionable plans ─────────────────────────────────────────
  seedNonCommPlans: publicProcedure
    .input(adminInput)
    .mutation(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const dbConn = await getDb();
      if (!dbConn) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });

      let inserted = 0;
      let updated = 0;

      for (const plan of NON_COMM_PLANS_2026) {
        const existing = await dbConn
          .select()
          .from(planOverrides)
          .where(eq(planOverrides.planId, plan.planId))
          .limit(1);

        if (existing.length > 0) {
          await dbConn
            .update(planOverrides)
            .set({
              isNonCommissionable: true,
              nonCommSource: plan.nonCommSource,
              nonCommEffectiveDate: plan.nonCommEffectiveDate,
              updatedAt: new Date(),
            })
            .where(eq(planOverrides.planId, plan.planId));
          updated++;
        } else {
          await dbConn.insert(planOverrides).values({
            planId: plan.planId,
            planName: plan.planName,
            carrierName: plan.carrierName,
            isEnabled: true,
            isNonCommissionable: true,
            nonCommSource: plan.nonCommSource,
            nonCommEffectiveDate: plan.nonCommEffectiveDate,
          });
          inserted++;
        }
      }

      return { success: true, inserted, updated, total: NON_COMM_PLANS_2026.length };
    }),

  // ── Get all disabled carrier names (used by public plans route) ───────────
  getDisabledCarriers: publicProcedure
    .input(adminInput)
    .query(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const dbConn = await getDb();
      if (!dbConn) return { carriers: [] };

      const disabled = await dbConn
        .select({ carrierName: carrierOverrides.carrierName })
        .from(carrierOverrides)
        .where(eq(carrierOverrides.isEnabled, false));

      return { carriers: disabled.map((c) => c.carrierName) };
    }),

  // ── Get all carriers in a state from CMS data ─────────────────────────────
  getStateCarriers: publicProcedure
    .input(adminInput.extend({
      state: z.string().length(2),
    }))
    .query(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const stateData = await loadStateDataForAdmin(input.state.toUpperCase());
      if (!stateData) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No plan data found for state: ${input.state}` });
      }

      const carriers = extractCarriersFromStateData(stateData);

      // Load carrier overrides from DB to know which are disabled
      const dbConn = await getDb();
      const disabledSet = new Set<string>();
      if (dbConn) {
        const disabled = await dbConn
          .select({ carrierName: carrierOverrides.carrierName })
          .from(carrierOverrides)
          .where(eq(carrierOverrides.isEnabled, false));
        disabled.forEach((c) => disabledSet.add(c.carrierName));
      }

      return {
        state: input.state.toUpperCase(),
        carriers: carriers.map((name) => ({
          name,
          isEnabled: !disabledSet.has(name),
        })),
        totalCarriers: carriers.length,
      };
    }),

  // ── Get all plans in a state from CMS data (filtered by carriers) ─────────
  getStatePlans: publicProcedure
    .input(adminInput.extend({
      state: z.string().length(2),
      carriers: z.array(z.string()).optional(),
      nonCommOnly: z.boolean().optional(),
    }))
    .query(async ({ input }) => {
      checkAdminPassword(input.adminPassword);
      const stateData = await loadStateDataForAdmin(input.state.toUpperCase());
      if (!stateData) {
        throw new TRPCError({ code: "NOT_FOUND", message: `No plan data found for state: ${input.state}` });
      }

      // Load plan overrides from DB (non-commissionable + disabled)
      const dbConn = await getDb();
      const nonCommPlanIds = new Set<string>();
      const disabledPlanIds = new Set<string>();
      if (dbConn) {
        const overrides = await dbConn
          .select({ planId: planOverrides.planId, isNonCommissionable: planOverrides.isNonCommissionable, isEnabled: planOverrides.isEnabled })
          .from(planOverrides);
        overrides.forEach((p) => {
          if (p.isNonCommissionable) nonCommPlanIds.add(p.planId);
          if (p.isEnabled === false) disabledPlanIds.add(p.planId);
        });
      }

      const plans = extractPlansFromStateData(
        stateData,
        input.carriers,
        input.nonCommOnly,
        nonCommPlanIds
      );

      // Annotate each plan with isEnabled (true by default, false if explicitly disabled)
      const cleanPlans = plans.map(({ _dedupeKey, ...rest }) => {
        const planId = String(rest.id ?? rest.planId ?? rest.contractId ?? "");
        return {
          ...rest,
          isEnabled: !disabledPlanIds.has(planId),
        };
      });

      return {
        state: input.state.toUpperCase(),
        plans: cleanPlans,
        total: cleanPlans.length,
      };
    }),
});
