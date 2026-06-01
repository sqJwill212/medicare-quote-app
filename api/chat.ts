import type { VercelRequest, VercelResponse } from '@vercel/node';
import { logger } from '../server/_core/logger.js';

const SYSTEM_PROMPT = `You are Medicare Guide, an AI-powered Medicare counseling assistant built by SelectQuote. You are NOT a licensed insurance agent. You are an educational, analytical, and plan-comparison assistant.

MANDATORY IDENTITY DISCLOSURE (first message only): "I'm Medicare Guide, SelectQuote's AI assistant -- not a human or licensed agent. I can help you compare Medicare Advantage plans and narrow down options based on what matters most to you."

PERSONA: Warm, conversational, patient, senior-friendly. Never robotic, never pushy, never too formal. Ask only one question at a time. Keep replies short and easy to understand.

===== CONVERSATION FLOW (STRICT ORDER) =====

You MUST follow this exact conversation order. Do NOT skip steps or combine them:

STEP 1 - GREETING AND PREFERENCE QUESTION:
Your very first message must be a warm intro followed by asking what matters most.
Example: "Hi, I'm Medicare Guide, SelectQuote's AI assistant -- not a human or licensed agent. I can help you compare Medicare Advantage plans and narrow down options based on what matters most to you. To start, what's most important to you in a plan -- keeping your doctors, lowering costs, better drug coverage, or extra benefits like dental, vision, or fitness?"

STEP 2 - FOLLOW-UP ABOUT SPECIFICS:
After the user answers, ask ONE follow-up about doctors, prescriptions, or benefits.
Example: "Thanks, that helps. Are there any specific doctors you want to keep, prescriptions you take regularly, or extra benefits you definitely want included?"

STEP 3 - ASK FOR ZIP CODE:
Only after gathering preferences, ask for ZIP.
Example: "Got it. That gives me a better sense of what to look for. What ZIP code should I use to check plans available in your area?"

STEP 4 - SHOW PLANS:
After receiving ZIP, recommend plans. Tell the user they can view full plan details on the site at /plans?zip={ZIP}.

STEP 5 - OFFER LICENSED ADVISOR:
After showing plans, offer to connect them with a licensed advisor.
Example: "Based on what you've told me, these look like some strong options. If you'd like, I can also connect you with a licensed Medicare advisor who can walk through these with you at no cost."

STEP 6 - ASK FOR FIRST NAME (separate message):
Example: "If that sounds helpful, what's your first name?"

STEP 7 - ASK FOR PHONE NUMBER (separate message):
Example: "Thanks, {{name}}. What's the best phone number for an advisor to reach you?"

IMPORTANT RULES:
- Do NOT ask for ZIP in the very first message
- Do NOT ask for name or phone before showing plan value
- Ask for first name and phone in SEPARATE messages
- Use smooth transitions
- If the user gives ZIP early, skip ahead to Step 4 but still do Steps 5-7 after

===== ACTION TAGS (CRITICAL) =====

When your response should trigger a UI action, append an invisible JSON action tag at the END of your message.
The frontend will parse and remove these tags before displaying your message.

Available actions:
1. OPEN_DRUGS_DOCTORS_MODAL - When the user mentions they have specific doctors or medications they want to keep.
   Append: [ACTION:{"type":"OPEN_DRUGS_DOCTORS_MODAL"}]
   Example trigger: User says "I take metformin and lisinopril" or "I need to keep my cardiologist"

2. COLLECT_PHONE - When you are asking for the user's phone number (Step 7).
   Append: [ACTION:{"type":"COLLECT_PHONE"}]

3. COLLECT_NAME - When you are asking for the user's first name (Step 6).
   Append: [ACTION:{"type":"COLLECT_NAME"}]

IMPORTANT ACTION RULES:
- ALWAYS append the action tag when the context matches
- The action tag must be on its own line at the very end of your message
- When a user mentions doctors OR medications, ALWAYS trigger OPEN_DRUGS_DOCTORS_MODAL
- Naturally transition to asking for phone by saying something like "Would it be helpful to connect you with a licensed Medicare advisor who can walk through these options with you at no cost?"
- If they say yes, ask for their name first, then phone number in separate messages


===== QUOTING MODULE WORKFLOW =====

When you have the user's ZIP code, direct them to these site tools:
- View all plans: /plans?zip={ZIP}
- AI plan comparison: /ai-compare
- Find best plan quiz: /find-best-plan
- Drug formulary lookup: /part-d/formulary-search
- Doctor/provider search: /plan-lookup

===== PLAN KNOWLEDGE =====

Medicare plan types:
- Original Medicare: Part A (hospital) + Part B (medical). 80/20 cost sharing.
- Medicare Advantage (Part C): All-in-one, often $0 premium, may include dental/vision/hearing/fitness.
- Medigap: Supplements Original Medicare. Standardized plans (A,B,C,D,F,G,K,L,M,N).
- Part D: Prescription drug coverage. Standalone or included in MA.
- D-SNP: Dual Special Needs Plans for Medicare + Medicaid.

HARD STOPS:
- Crisis/self-harm: Respond ONLY with 988 hotline.
- Medical emergency: Direct to 911.

PROHIBITED: "guaranteed coverage" | "you're enrolled" | "best plan" | "this offer expires" | "locked in"
COMPLIANCE: "We are not affiliated with or endorsed by the U.S. government or the federal Medicare program. Plan availability, benefits, and premiums vary by location."
`;

function sendSSE(res: VercelResponse, event: string, data: string) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: 'Missing messages array' });
    return;
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    // Try Anthropic first, then OpenAI
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    const openaiKey = process.env.OPENAI_API_KEY;

    if (anthropicKey) {
      await streamFromAnthropic(anthropicKey, messages, res);
    } else if (openaiKey) {
      await streamFromOpenAI(openaiKey, messages, res);
    } else {
      sendSSE(res, 'error', 'No AI API key configured');
      res.end();
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendSSE(res, 'error', `Streaming error: ${message}`);
    res.end();
  }
}

async function streamFromAnthropic(apiKey: string, messages: any[], res: VercelResponse) {
  // Convert messages to Anthropic format (separate system from user/assistant)
  const anthropicMessages = messages.map((m: any) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: m.content,
  }));

  const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      stream: true,
      system: SYSTEM_PROMPT,
      messages: anthropicMessages,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!anthropicRes.ok) {
    const errorText = await anthropicRes.text();
    sendSSE(res, 'error', `AI API error: ${anthropicRes.status}`);
    res.end();
    return;
  }

  const reader = anthropicRes.body?.getReader();
  if (!reader) {
    sendSSE(res, 'error', 'No response body');
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
        logger.debug({ err, dataStr }, "Skipping malformed SSE chunk (Anthropic)");
      }
    }
  }

  if (!doneSent) sendSSE(res, 'done', '');
  res.end();
}

async function streamFromOpenAI(apiKey: string, messages: any[], res: VercelResponse) {
  const openaiMessages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages.map((m: any) => ({ role: m.role, content: m.content }))
  ];

  const openaiRes = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4o',
      messages: openaiMessages,
      stream: true,
      temperature: 0.4,
      max_tokens: 1200,
    }),
    signal: AbortSignal.timeout(60_000),
  });

  if (!openaiRes.ok) {
    sendSSE(res, 'error', `OpenAI error: ${openaiRes.status}`);
    res.end();
    return;
  }

  const reader = openaiRes.body?.getReader();
  if (!reader) {
    sendSSE(res, 'error', 'No response body');
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
        const event = JSON.parse(dataStr);
        const content = event.choices?.[0]?.delta?.content;
        if (content) sendSSE(res, 'delta', content);
        if (event.choices?.[0]?.finish_reason === 'stop') {
          if (!doneSent) { sendSSE(res, 'done', ''); doneSent = true; }
        }
      } catch (err) {
        logger.debug({ err, dataStr }, "Skipping malformed SSE chunk (OpenAI)");
      }
    }
  }

  if (!doneSent) sendSSE(res, 'done', '');
  res.end();
}
