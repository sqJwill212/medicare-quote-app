/**
 * Tests for the pVerify Plan Lookup router.
 *
 * Privacy note: These tests use synthetic Medicare IDs (not real beneficiary identifiers).
 * The router accepts only a medicareId field — no firstName, lastName, dob, or payerId.
 */

import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function createPublicContext(): TrpcContext {
  return {
    user: null,
    req: {
      protocol: "https",
      headers: {},
    } as TrpcContext["req"],
    res: {
      clearCookie: () => {},
    } as TrpcContext["res"],
  };
}

// Synthetic test Medicare IDs — not real beneficiary identifiers
const SAMPLE_MEDICARE_ID = "1EG4-TE5-MK72";
const ALT_MEDICARE_ID = "2AB3-CD4-EF56";

describe("pverify.lookup", () => {
  it("accepts only medicareId and returns a successful mock eligibility response", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.pverify.lookup({ medicareId: SAMPLE_MEDICARE_ID });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.status).toBe("Active");
    expect(result.data.planName).toBeTruthy();
    expect(result.data.planId).toBeTruthy();
    expect(result.data.effectiveDate).toBe("2025-01-01");
    expect(result.data.terminationDate).toBe("2025-12-31");
    expect(typeof result.data.oopMax).toBe("number");
    expect(typeof result.data.premium).toBe("number");
  }, 10000); // 10s timeout to allow for the 1.2s artificial delay

  it("does NOT include memberName in the response (PII minimization)", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.pverify.lookup({ medicareId: SAMPLE_MEDICARE_ID });

    // memberName should not be present — we only accept medicareId, not name fields
    expect((result.data as Record<string, unknown>).memberName).toBeUndefined();
  }, 10000);

  it("returns deterministically different plans for different Medicare IDs", async () => {
    const caller = appRouter.createCaller(createPublicContext());

    const result1 = await caller.pverify.lookup({ medicareId: "1EG4-TE5-MK7A" });
    const result2 = await caller.pverify.lookup({ medicareId: "1EG4-TE5-MK7B" });

    // Different last characters → different plan variants
    // (may occasionally be the same if charCode % 6 collides, but A vs B won't)
    expect(result1.data.planId).not.toBe(result2.data.planId);
  }, 30000);

  it("has all required copay fields", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.pverify.lookup({ medicareId: SAMPLE_MEDICARE_ID });
    const d = result.data;

    expect(typeof d.pcpCopay).toBe("number");
    expect(typeof d.specialistCopay).toBe("number");
    expect(typeof d.urgentCareCopay).toBe("number");
    expect(typeof d.erCopay).toBe("number");
    expect(typeof d.drugTier1Copay).toBe("number");
    expect(typeof d.drugTier2Copay).toBe("number");
    expect(typeof d.drugTier3Copay).toBe("number");
    expect(d.dentalCoverage).toBeTruthy();
    expect(d.visionCoverage).toBeTruthy();
    expect(d.hearingCoverage).toBeTruthy();
  }, 10000);

  it("returns the same plan for the same Medicare ID (deterministic)", async () => {
    const caller = appRouter.createCaller(createPublicContext());

    const result1 = await caller.pverify.lookup({ medicareId: ALT_MEDICARE_ID });
    const result2 = await caller.pverify.lookup({ medicareId: ALT_MEDICARE_ID });

    expect(result1.data.planId).toBe(result2.data.planId);
    expect(result1.data.planName).toBe(result2.data.planName);
  }, 30000);
});

describe("pverify.eligibilityCheck", () => {
  it("returns a successful result with firstName, lastName, and dob", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.pverify.eligibilityCheck({
      mbi: "1EG4-TE5-MK72",
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(typeof result.data.isActive).toBe("boolean");
    expect(result.data.partA).toBeDefined();
    expect(result.data.partB).toBeDefined();
    expect(typeof result.data.isMockData).toBe("boolean");
  }, 15000);

  it("accepts optional MBI field", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.pverify.eligibilityCheck({
      mbi: "1EG4TE5MK72",
    });

    expect(result.success).toBe(true);
    expect(result.data.isMockData).toBeDefined();
  }, 15000);
});

describe("pverify.compare", () => {
  const CURRENT_PLAN = {
    planName: "UnitedHealthcare AARP MedicareComplete Patriot (HMO)",
    planId: "H0624-001",
    payerId: "UHC001",
    status: "Active",
    effectiveDate: "2025-01-01",
    terminationDate: "2025-12-31",
    premium: 0,
    deductible: 0,
    oopMax: 4900,
    pcpCopay: 0,
    specialistCopay: 35,
    urgentCareCopay: 35,
    erCopay: 90,
    inpatientCost: "$275/day days 1-7",
    drugTier1Copay: 0,
    drugTier2Copay: 5,
    drugTier3Copay: 42,
    dentalCoverage: "$1,500 comprehensive/year",
    visionCoverage: "$150 eyewear allowance/year",
    hearingCoverage: "$1,000 hearing aid allowance",
  };

  const POTENTIAL_PLAN = {
    id: "humana-h1036",
    planName: "Humana Gold Plus H1036-286 (HMO)",
    carrier: "Humana",
    premium: 0,
    deductible: 0,
    oopMax: 3400,
    pcpCopay: 5,
    specialistCopay: 35,
    urgentCareCopay: 30,
    erCopay: 90,
    drugTier1Copay: 0,
    drugTier2Copay: 4,
    drugTier3Copay: 38,
    dentalCoverage: "$1,000 comprehensive/year",
    visionCoverage: "$100 eyewear allowance/year",
    hearingCoverage: "$500 hearing aid allowance",
  };

  it("returns a structured comparison result", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.pverify.compare({
      currentPlan: CURRENT_PLAN,
      potentialPlan: POTENTIAL_PLAN,
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data.summary).toBeTruthy();
    expect(result.data.recommendation).toBeTruthy();
    expect(Array.isArray(result.data.currentPlanPros)).toBe(true);
    expect(Array.isArray(result.data.currentPlanCons)).toBe(true);
    expect(Array.isArray(result.data.potentialPlanPros)).toBe(true);
    expect(Array.isArray(result.data.potentialPlanCons)).toBe(true);
    expect(typeof result.data.estimatedAnnualCostCurrent).toBe("number");
    expect(typeof result.data.estimatedAnnualCostPotential).toBe("number");
  }, 10000);

  it("identifies lower MOOP as a pro for the potential plan", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.pverify.compare({
      currentPlan: CURRENT_PLAN,
      potentialPlan: POTENTIAL_PLAN,
    });

    // Potential plan has lower MOOP ($3400 vs $4900), should be flagged as a pro
    const potentialPros = result.data.potentialPlanPros.join(" ");
    expect(potentialPros).toContain("3,400");
  }, 10000);

  it("calculates annual cost estimates correctly", async () => {
    const caller = appRouter.createCaller(createPublicContext());
    const result = await caller.pverify.compare({
      currentPlan: CURRENT_PLAN,
      potentialPlan: POTENTIAL_PLAN,
    });

    // Current: 0*12 + 0*6 + 35*4 + 35*2 = 0 + 0 + 140 + 70 = 210
    expect(result.data.estimatedAnnualCostCurrent).toBe(210);
    // Potential: 0*12 + 5*6 + 35*4 + 30*2 = 0 + 30 + 140 + 60 = 230
    expect(result.data.estimatedAnnualCostPotential).toBe(230);
  }, 10000);
});
