// Design-violation fix: agent-handoff must call readCRMFromSession() exported here
// instead of accessing sessionStorage keys directly.

export const CRM_SESSION_KEY_PREFIX = 'pec_crm_';

export function buildCRMPayload(items: any[], risks: any[], ctx: any, handoffRoute: string, aiSummaryGenerated: boolean, sessionId: string) {
  const { completionPct, confirmedCount, flaggedCount } = (() => {
    const done = items.filter((i:any)=>i.status!=='pending').length;
    const conf = items.filter((i:any)=>i.status==='confirmed').length;
    const flag = items.filter((i:any)=>i.status==='flagged').length;
    return { completionPct: items.length?Math.round(done/items.length*100):0, confirmedCount:conf, flaggedCount:flag };
  })();
  return {
    sessionId, generatedAt: new Date().toISOString(),
    planId: ctx.plan.id, planName: ctx.plan.planName, carrier: ctx.plan.carrier,
    zip: ctx.zip, county: ctx.county,
    checklistItems: items.map((i:any) => ({ id:i.id, category:i.category, label:i.label, status:i.status })),
    risks: risks.map((r:any) => ({ severity:r.severity, message:r.message, action:r.action })),
    completionPct, handoffRoute,
    doctors: (ctx.doctors??[]).map((d:any) => d.name),
    drugs: (ctx.rxDrugs??[]).map((d:any) => d.name),
    estimatedAnnualCost: ctx.estimatedAnnualCost,
    aiSummaryGenerated,
    aiDisclosureConfirmed: items.find((i:any)=>i.id==='ai_disclosure')?.status === 'confirmed',
  };
}

export function serializeCRMPayload(payload: any): string { return JSON.stringify(payload, null, 2); }

export function saveCRMToSession(payload: any): void {
  try { sessionStorage.setItem(`${CRM_SESSION_KEY_PREFIX}${payload.planId}`, serializeCRMPayload(payload)); } catch {}
}

/** Explicit reader — the ONLY way other slices should access checklist CRM data */
export function readCRMFromSession(planId: string): any | null {
  try { const raw = sessionStorage.getItem(`${CRM_SESSION_KEY_PREFIX}${planId}`); return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function buildAgentBriefing(payload: any): string {
  const lines = [
    'PRE-ENROLLMENT CHECKLIST SUMMARY', `Generated: ${new Date(payload.generatedAt).toLocaleString()}`, '',
    `PLAN: ${payload.planName} (${payload.carrier})`, `ZIP/County: ${payload.zip} / ${payload.county}`,
    `CHECKLIST COMPLETION: ${payload.completionPct}%`, '',
  ];
  const confirmed = payload.checklistItems.filter((i:any)=>i.status==='confirmed');
  const flagged = payload.checklistItems.filter((i:any)=>i.status==='flagged');
  if (confirmed.length) { lines.push('CONFIRMED:'); confirmed.forEach((i:any)=>lines.push(`  ✓ ${i.label}`)); lines.push(''); }
  if (flagged.length) { lines.push('REQUIRING ATTENTION:'); flagged.forEach((i:any)=>lines.push(`  ⚠ ${i.label}`)); lines.push(''); }
  if (payload.risks.length) { lines.push('RISKS:'); payload.risks.forEach((r:any)=>lines.push(`  [${r.severity.toUpperCase()}] ${r.message}`)); lines.push(''); }
  if (payload.doctors.length) lines.push(`DOCTORS: ${payload.doctors.join(', ')}`);
  if (payload.drugs.length) lines.push(`PRESCRIPTIONS: ${payload.drugs.join(', ')}`);
  lines.push('', `AI DISCLOSURE CONFIRMED: ${payload.aiDisclosureConfirmed?'Yes':'NO — AGENT MUST CONFIRM'}`);
  lines.push(`HANDOFF ROUTE: ${payload.handoffRoute}`, '', 'Not affiliated with Medicare.gov.');
  return lines.join('\n');
}
