import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logger } from '../server/_core/logger.js';

/**
 * Vercel Serverless Function for /api/compare-stream
 * Streaming AI Plan Comparison via SSE
 * Supports both Forge API (OpenAI-compatible) and direct Anthropic API
 */

interface PlanInput {
  id: string;
  carrier: string;
  planName: string;
  planType: string;
  [key: string]: unknown;
}

function s(val: unknown): string {
  if (val === null || val === undefined) return 'N/A';
  return String(val);
}

function n(val: unknown): number {
  if (val === null || val === undefined) return 0;
  const num = Number(val);
  return isNaN(num) ? 0 : num;
}

function benefitList(p: any): string {
  const benefits: string[] = [];
  const eb = p.extraBenefits || {};
  if (eb.dental?.covered) benefits.push(`Dental (${s(eb.dental.details)})`);
  if (eb.vision?.covered) benefits.push(`Vision (${s(eb.vision.details)})`);
  if (eb.hearing?.covered) benefits.push(`Hearing (${s(eb.hearing.details)})`);
  if (eb.otc?.covered) benefits.push(`OTC (${s(eb.otc.details)})`);
  if (eb.fitness?.covered) benefits.push('Fitness');
  if (eb.transportation?.covered) benefits.push('Transportation');
  if (eb.telehealth?.covered) benefits.push('Telehealth');
  if (eb.meals?.covered) benefits.push('Meals after hospital');
  return benefits.join(', ') || 'None';
}

function planSummary(p: any, label: string): string {
  const copays = p.copays || {};
  const rx = p.rxDrugs || {};
  const stars = p.starRating || {};
  return `${label}: ${s(p.planName)} (${s(p.carrier)}, ${s(p.planType)})
- Premium: $${n(p.premium)}/mo | Deductible: $${n(p.deductible)} | MOOP: $${n(p.maxOutOfPocket).toLocaleString()}
- PCP: ${s(copays.primaryCare)} | Specialist: ${s(copays.specialist)} | ER: ${s(copays.emergency)}
- Rx: T1 ${s(rx.tier1)} / T2 ${s(rx.tier2)} / T3 ${s(rx.tier3)} / T4 ${s(rx.tier4)} | Gap: ${rx.gap ? 'Yes' : 'No'}
- Stars: ${n(stars.overall)}/5 | Network: ${n(p.networkSize).toLocaleString()}+ providers
- Extra benefits: ${benefitList(p)}`;
}

function build2PlanPrompt(current: any, newPlan: any): string {
  return `You are a Medicare Advantage expert. Compare these two plans concisely. The user already sees a full data table — provide ONLY the narrative analysis below.

${planSummary(current, 'CURRENT PLAN')}

${planSummary(newPlan, 'NEW PLAN')}

Respond in EXACTLY this markdown format (keep each section brief):

## Quick Summary
2-3 sentences summarizing the key trade-offs in plain language.

## Key Differences
- **Cost:** [1-2 sentences on premium/MOOP/copay differences]
- **Rx Drugs:** [1-2 sentences on drug coverage differences]
- **Extra Benefits:** [what's gained or lost switching plans]
- **Network:** [HMO vs PPO implications if different, or network size note]
- **Quality:** [star rating comparison and what it means]

## Recommendation
1 short paragraph with a clear recommendation. Who should switch? Who should stay? Be specific.`;
}

function build3PlanPrompt(current: any, plan2: any, plan3: any): string {
  return `You are a Medicare Advantage expert. Compare these three plans concisely. The user already sees a full side-by-side data table — provide ONLY the narrative analysis below.

${planSummary(current, 'PLAN 1 (Current Plan)')}

${planSummary(plan2, 'PLAN 2 (New Plan 1)')}

${planSummary(plan3, 'PLAN 3 (New Plan 2)')}

Respond in EXACTLY this markdown format (keep each section brief):

## Quick Summary
2-3 sentences summarizing the overall landscape across all three plans.

## Key Differences
- **Cost:** [Compare premiums, deductibles, and MOOP across all three]
- **Rx Drugs:** [Drug coverage differences across all three]
- **Extra Benefits:** [Notable differences in dental, vision, OTC, fitness, etc.]
- **Network:** [HMO/PPO differences and network size comparison]
- **Quality:** [Star rating comparison across all three plans]

## Recommendation
1 short paragraph naming which plan is best and for whom. Be specific — mention the plan names and the type of beneficiary each suits best.`;
}

function sendSSE(res: VercelResponse, event: string, data: string) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamFromAnthropic(apiKey: string, prompt: string, maxTokens: number, res: VercelResponse) {
  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!anthropicRes.ok) {
    const errorText = await anthropicRes.text();
    sendSSE(res, 'error', `AI API error: ${anthropicRes.status} — ${errorText.slice(0, 200)}`);
    res.end();
    return;
  }

  const reader = anthropicRes.body?.getReader();
  if (!reader) {
    sendSSE(res, 'error', 'No response body from AI');
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let doneSent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (line.startsWith('event: message_stop')) {
        if (!doneSent) { sendSSE(res, 'done', ''); doneSent = true; }
        continue;
      }
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6).trim();
      if (!dataStr) continue;

      try {
        const event = JSON.parse(dataStr);
        if (event.type === 'content_block_delta' && event.delta?.text) {
          sendSSE(res, 'delta', event.delta.text);
        }
        if (event.type === 'message_stop') {
          if (!doneSent) { sendSSE(res, 'done', ''); doneSent = true; }
        }
      } catch (err) {
        logger.debug({ err, dataStr }, "Skipping malformed SSE chunk (Anthropic compare)");
      }
    }
  }

  if (!doneSent) {
    sendSSE(res, 'done', '');
  }
  res.end();
}

async function streamFromForge(apiUrl: string, apiKey: string, prompt: string, maxTokens: number, res: VercelResponse) {
  const forgeRes = await fetch(`${apiUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      stream: true,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!forgeRes.ok) {
    const errorText = await forgeRes.text();
    sendSSE(res, 'error', `AI API error: ${forgeRes.status} — ${errorText.slice(0, 200)}`);
    res.end();
    return;
  }

  const reader = forgeRes.body?.getReader();
  if (!reader) {
    sendSSE(res, 'error', 'No response body from AI');
    res.end();
    return;
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let doneSent = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const dataStr = line.slice(6).trim();
      if (dataStr === '[DONE]') {
        if (!doneSent) { sendSSE(res, 'done', ''); doneSent = true; }
        continue;
      }
      try {
        const event = JSON.parse(dataStr) as any;
        const content = event.choices?.[0]?.delta?.content;
        if (content) sendSSE(res, 'delta', content);
        if (event.choices?.[0]?.finish_reason === 'stop') {
          if (!doneSent) { sendSSE(res, 'done', ''); doneSent = true; }
        }
      } catch (err) {
        logger.debug({ err, dataStr }, "Skipping malformed SSE chunk (Forge compare)");
      }
    }
  }

  if (!doneSent) sendSSE(res, 'done', '');
  res.end();
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body;
  if (!body || !body.currentPlan || !body.newPlan) {
    res.status(400).json({ error: 'Missing currentPlan or newPlan in request body' });
    return;
  }

  const { currentPlan, newPlan, thirdPlan } = body;

  // Set up SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const prompt = thirdPlan
      ? build3PlanPrompt(currentPlan, newPlan, thirdPlan)
      : build2PlanPrompt(currentPlan, newPlan);
    const maxTokens = thirdPlan ? 1280 : 1024;

    // Try Anthropic API first, then Forge API
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const forgeApiUrl = process.env.BUILT_IN_FORGE_API_URL;
    const forgeApiKey = process.env.BUILT_IN_FORGE_API_KEY;

    if (anthropicKey) {
      await streamFromAnthropic(anthropicKey, prompt, maxTokens, res);
    } else if (forgeApiUrl && forgeApiKey) {
      await streamFromForge(forgeApiUrl, forgeApiKey, prompt, maxTokens, res);
    } else {
      res.status(500).json({ error: 'No AI API configured. Set ANTHROPIC_API_KEY or BUILT_IN_FORGE_API_URL + BUILT_IN_FORGE_API_KEY.' });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendSSE(res, 'error', `Streaming error: ${message}`);
    res.end();
  }
}
