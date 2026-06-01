import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logger } from '../server/_core/logger.js';
import { enrichPlansWithDrugCosts as enrichWithFormulary } from './formularyCalculator.js';
interface DrugInput { name: string; dosage?: string; }

// CDN URLs for pre-processed per-state plan JSON files
const CDN_BASE = 'https://d2xsxph8kpxj0f.cloudfront.net/310519663319810046/5TY7JcF275WMujMHZWWJT8';
const STATE_CDN_URLS: Record<string, string> = {
  AL: `${CDN_BASE}/AL_67b904f5.json`,
  AR: `${CDN_BASE}/AR_44da840b.json`,
  AZ: `${CDN_BASE}/AZ_822fc811.json`,
  CA: `${CDN_BASE}/CA_0e63b144.json`,
  CO: `${CDN_BASE}/CO_d5d0202e.json`,
  CT: `${CDN_BASE}/CT_fe117f1a.json`,
  DC: `${CDN_BASE}/DC_956b23b8.json`,
  DE: `${CDN_BASE}/DE_e49d3fed.json`,
  FL: `${CDN_BASE}/FL_49f1876a.json`,
  GA: `${CDN_BASE}/GA_533e1fca.json`,
  HI: `${CDN_BASE}/HI_fa323526.json`,
  IA: `${CDN_BASE}/IA_c0fbfe84.json`,
  ID: `${CDN_BASE}/ID_36678396.json`,
  IL: `${CDN_BASE}/IL_4defe286.json`,
  IN: `${CDN_BASE}/IN_dc82ef53.json`,
  KS: `${CDN_BASE}/KS_7e35aefd.json`,
  KY: `${CDN_BASE}/KY_d429ac6a.json`,
  LA: `${CDN_BASE}/LA_135fa9eb.json`,
  MA: `${CDN_BASE}/MA_a8cf20c4.json`,
  MD: `${CDN_BASE}/MD_e84fb99f.json`,
  ME: `${CDN_BASE}/ME_32265cbc.json`,
  MI: `${CDN_BASE}/MI_2be468a6.json`,
  MN: `${CDN_BASE}/MN_eda92d03.json`,
  MO: `${CDN_BASE}/MO_4e9fdf09.json`,
  MS: `${CDN_BASE}/MS_c8f93956.json`,
  MT: `${CDN_BASE}/MT_686ff40b.json`,
  NC: `${CDN_BASE}/NC_036848e7.json`,
  ND: `${CDN_BASE}/ND_f12b42a3.json`,
  NE: `${CDN_BASE}/NE_960f49d1.json`,
  NH: `${CDN_BASE}/NH_d1021c0f.json`,
  NJ: `${CDN_BASE}/NJ_4f264fd0.json`,
  NM: `${CDN_BASE}/NM_446e840a.json`,
  NV: `${CDN_BASE}/NV_9ca45f94.json`,
  NY: `${CDN_BASE}/NY_d3c0c09e.json`,
  OH: `${CDN_BASE}/OH_ec644008.json`,
  OK: `${CDN_BASE}/OK_3e52d056.json`,
  OR: `${CDN_BASE}/OR_4d1de179.json`,
  PA: `${CDN_BASE}/PA_124dc2c6.json`,
  PR: `${CDN_BASE}/PR_2ff56627.json`,
  RI: `${CDN_BASE}/RI_74672982.json`,
  SC: `${CDN_BASE}/SC_3ceb6e53.json`,
  SD: `${CDN_BASE}/SD_0553bb69.json`,
  TN: `${CDN_BASE}/TN_cf7b12c8.json`,
  TX: `${CDN_BASE}/TX_2dd68bdd.json`,
  UT: `${CDN_BASE}/UT_ac1faf77.json`,
  VA: `${CDN_BASE}/VA_db8b8a4c.json`,
  VT: `${CDN_BASE}/VT_8e463fe4.json`,
  WA: `${CDN_BASE}/WA_43e2f67b.json`,
  WI: `${CDN_BASE}/WI_003da44b.json`,
  WV: `${CDN_BASE}/WV_c5df6929.json`,
  WY: `${CDN_BASE}/WY_02219b63.json`,
};

const CMS_ZIP_API = 'https://marketplace.api.healthcare.gov/api/v1/counties/by/zip';
const CMS_API_KEY = process.env.CMS_MARKETPLACE_API_KEY ?? '';

// In-memory caches (persist across warm invocations)
const stateCache = new Map<string, Record<string, any[]>>();
const zipCache = new Map<string, { stateAbbr: string; countyName: string }>();

function toTitleCase(str: string): string {
  return str.toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
    .replace(/\bOf\b/g, 'of').replace(/\bThe\b/g, 'the');
}

function classifySnpCategory(snpType?: string, planName?: string): string | null {
  if (!snpType && !planName) return null;
  const raw = ((snpType || '') + ' ' + (planName || '')).toUpperCase();
  if (raw.includes('D-SNP') || raw.includes('DSNP') || raw.includes('DUAL')) return 'DSNP';
  if (raw.includes('C-SNP') || raw.includes('CSNP') || raw.includes('CHRONIC')) return 'CSNP';
  if (raw.includes('I-SNP') || raw.includes('ISNP') || raw.includes('INSTITUTIONAL')) return 'ISNP';
  if (raw.includes('SNP')) return 'OTHER_SNP';
  return null;
}

async function resolveZipToCounty(zip: string) {
  const cached = zipCache.get(zip);
  if (cached) return cached;

  try {
    const res = await fetch(`${CMS_ZIP_API}/${zip}?apikey=${CMS_API_KEY}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const data = await res.json() as any;
    const counties = data.counties;
    if (!counties || counties.length === 0) return null;

    const primary = counties[0];
    const result = { stateAbbr: primary.state.toUpperCase(), countyName: primary.name.toUpperCase() };
    zipCache.set(zip, result);
    return result;
  } catch (err) {
    logger.error({ err, zip }, "Failed to resolve ZIP to county");
    return null;
  }
}

async function getStateData(stateAbbr: string) {
  const cached = stateCache.get(stateAbbr);
  if (cached) return cached;

  const url = STATE_CDN_URLS[stateAbbr];
  if (!url) return null;

  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    const data = await res.json() as Record<string, any[]>;
    stateCache.set(stateAbbr, data);
    return data;
  } catch (err) {
    logger.error({ err, stateAbbr }, "Failed to fetch state plan data");
    return null;
  }
}

function findPlansForCounty(stateData: Record<string, any[]>, countyName: string): any[] {
  const upper = countyName.toUpperCase();
  if (stateData[upper]) return stateData[upper];

  const without = upper.replace(/ COUNTY$/, '').trim();

  for (const key of Object.keys(stateData)) {
    if (key === without || key.replace(/ COUNTY$/, '') === without) return stateData[key];
  }

  for (const key of Object.keys(stateData)) {
    if (key.includes(without) || without.includes(key.replace(/ COUNTY$/, ''))) return stateData[key];
  }

  return [];
}

function annotatePlans(plans: any[]): any[] {
  const sorted = [...plans].sort((a: any, b: any) => {
    const moopA = a.maxOutOfPocket ?? a.outOfPocketMax ?? a.moop ?? Infinity;
    const moopB = b.maxOutOfPocket ?? b.outOfPocketMax ?? b.moop ?? Infinity;
    if (moopA !== moopB) return moopA - moopB;
    return (a.premium ?? 0) - (b.premium ?? 0);
  });
  return sorted.map((plan: any, idx) => {
    const snpType = (plan.snpType ?? '').toLowerCase();
    const planName = plan.planName ?? plan.name ?? '';
    const isISnp = snpType.includes('institutional') || planName.includes('I-SNP');
    const snpCategory = classifySnpCategory(plan.snpType, planName);
    return {
      ...plan,
      isBestMatch: idx === 0,
      isMostPopular: idx === 1,
      isNonCommissionable: isISnp,
      snpCategory,
    };
  });
}

// Parse drugs from query parameter (handles Vercel query parsing)
function parseDrugsParam(drugsParam: string | string[] | undefined): DrugInput[] {
  if (!drugsParam) return [];
  try {
    if (typeof drugsParam === 'string') {
      return JSON.parse(drugsParam);
    }
    if (Array.isArray(drugsParam)) {
      // Vercel may split repeated params into array
      return JSON.parse(drugsParam[0]);
    }
  } catch (err) {
    console.warn('[Plans API] Failed to parse drugs param:', err);
  }
  return [];
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS headers
    const allowedOrigins = ['https://medicare-quote-app.vercel.app', 'http://localhost:5173'];
    const origin = req.headers.origin || '';
    res.setHeader('Access-Control-Allow-Origin', allowedOrigins.includes(origin) ? origin : allowedOrigins[0]);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const zip = (typeof req.query.zip === 'string' ? req.query.zip : '').trim();
  if (!zip || !/^\d{5}$/.test(zip)) {
    return res.status(400).json({ error: 'Please provide a valid 5-digit ZIP code.', plans: [] });
  }

  try {
    const location = await resolveZipToCounty(zip);
    if (!location) {
      return res.status(404).json({
        error: `Could not find county information for ZIP code ${zip}.`,
        plans: [],
        location: null
      });
    }

    const { stateAbbr, countyName } = location;
    const stateData = await getStateData(stateAbbr);
    if (!stateData) {
      return res.status(503).json({
        error: `Plan data for ${stateAbbr} is temporarily unavailable.`,
        plans: [],
        location: { stateAbbr, countyName: toTitleCase(countyName), zip }
      });
    }

    const rawPlans = findPlansForCounty(stateData, countyName);
    if (rawPlans.length === 0) {
      return res.status(404).json({
        error: `No Medicare Advantage plans found for ${toTitleCase(countyName)}, ${stateAbbr}.`,
        plans: [],
        location: { stateAbbr, countyName: toTitleCase(countyName), zip }
      });
    }

    let plans = annotatePlans(rawPlans);

    // Enrich with drug costs if drugs parameter provided
    const drugsParam = req.query.drugs;
    const drugs = parseDrugsParam(drugsParam as string | string[] | undefined);
    if (drugs.length > 0) {
      plans = enrichWithFormulary(plans, drugs);
    }

    return res.status(200).json({
      plans,
      location: { stateAbbr, countyName: toTitleCase(countyName), zip },
      totalAvailable: rawPlans.length,
      showing: plans.length,
    });
  } catch (err) {
    console.error('[Plans API] Error:', err);
    return res.status(500).json({ error: 'An unexpected error occurred while loading plans.', plans: [] });
  }
}
