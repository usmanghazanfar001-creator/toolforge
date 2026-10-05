// Save this file as: api/ai.js  (create the "api" folder at your repo root if it doesn't exist)
//
// Vercel serverless function. This is the ONLY place your AI API key lives.
//
// SETUP (in the Vercel dashboard, not in this file):
//   1. Project -> Settings -> Environment Variables.
//   2. Add ANTHROPIC_API_KEY with a key from console.anthropic.com.
//      (To switch providers later: change PROVIDER below to 'openai' and
//      add OPENAI_API_KEY instead.)
//   3. Redeploy. Vercel auto-detects any .js file in /api as a function.
//
// Known limitations, stated plainly:
//   - No cross-request rate limiting: a stateless function can't remember
//     previous calls without a database. Set a spending cap on your AI
//     provider's dashboard as the practical safeguard for now. A proper
//     per-IP limit later would use Vercel KV / Upstash Redis.
//   - Vercel's free plan caps how long a function may run; very long text
//     on a slow model response could hit that ceiling.

const PROVIDER = 'anthropic'; // 'anthropic' | 'openai'
const MAX_INPUT_CHARS = 6000;

// Each mode: builds the system/user prompt, how long the answer may run,
// and how much freedom the model has (temperature). Factual tasks
// (summarizing) use a low temperature so the output stays faithful to the
// source; creative tasks (captions, prompts) use a higher one for variety.
const PROMPTS = {
  'prompt-generator': (input) => ({
    system: 'You are an expert prompt engineer for AI image and text generators. Given a rough idea, write ONE detailed, specific, well-structured prompt that would produce a high-quality result: include relevant detail on subject, style, composition, and tone where it fits the idea. Return only the finished prompt itself, with no preamble, no quotation marks, no explanation, and no alternate versions.',
    user: `Rough idea: ${input.text}`,
    max_tokens: 400,
    temperature: 0.8,
  }),
  'summarize': (input) => {
    const target = input.length === 'short' ? '2-3 sentences (roughly 40-60 words)'
      : input.length === 'long' ? '3-4 short paragraphs (roughly 200-300 words) that cover every key point'
      : 'one tight paragraph (roughly 80-120 words)';
    return {
      system: `Summarize the given text in ${target}. Preserve the key facts, names and numbers exactly as given; never invent details that are not in the source. Return only the summary, with no preamble, no "Summary:" label, and no commentary.`,
      user: input.text,
      max_tokens: 600,
      temperature: 0.3,
    };
  },
  'rewrite': (input) => ({
    system: `Rewrite the given text in a ${input.tone || 'clear, professional'} tone. Preserve the original meaning, facts and roughly the original length. Return only the rewritten text, with no preamble, no label, and no explanation of what changed.`,
    user: input.text,
    max_tokens: 900,
    temperature: 0.5,
  }),
  'caption': (input) => ({
    system: `You write short, engaging, platform-appropriate social media captions for ${input.platform || 'Instagram'}. Write exactly 3 distinct options with different angles (e.g. one direct, one playful, one question-based), each on its own line with no numbering, no quotation marks, and no preamble.`,
    user: `Write captions about: ${input.text}`,
    max_tokens: 400,
    temperature: 0.9,
  }),
  'email': (input) => ({
    system: `Write a clear, ${input.tone || 'professional'} email for the purpose described. Return only the email: a one-line subject prefixed "Subject:", then a blank line, then the body with a greeting and sign-off. No preamble, no explanation, no placeholder brackets unless a name truly cannot be inferred.`,
    user: `Purpose: ${input.text}`,
    max_tokens: 500,
    temperature: 0.6,
  }),
  'outline': (input) => {
    const aud = input.audience || 'general';
    return {
      system: `Write a well-structured blog post outline in Markdown for a ${aud}-level audience. Include a suggested title, 4-6 H2 sections in a logical order, and 2-4 concise sub-bullets under each section. Return only the outline, with no preamble or closing remarks.`,
      user: `Topic: ${input.text}`,
      max_tokens: 700,
      temperature: 0.6,
    };
  },
};

// Retries once on a transient overload/rate-limit response (429, 503, 529)
// with a short delay, since these are usually resolved a second later and
// a single retry meaningfully improves success rate without adding much
// latency to the common case where the first call just succeeds.
async function fetchWithRetry(url, opts) {
  const r1 = await fetch(url, opts);
  if (![429, 503, 529].includes(r1.status)) return r1;
  await new Promise((resolve) => setTimeout(resolve, 700));
  return fetch(url, opts);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { mode, text, tone, platform, length, audience } = body || {};

  if (!mode || !PROMPTS[mode]) {
    res.status(400).json({ error: 'Unknown tool.' });
    return;
  }
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'Please enter some text.' });
    return;
  }
  if (text.length > MAX_INPUT_CHARS) {
    res.status(400).json({ error: `Text is too long (max ${MAX_INPUT_CHARS} characters).` });
    return;
  }

  // Normalize before it reaches the model: trim edges, collapse 3+ blank
  // lines to 2, and collapse runs of 3+ spaces/tabs to one. This keeps the
  // prompt clean and avoids wasting tokens on copy-pasted whitespace, without
  // altering actual wording.
  const cleanText = text
    .trim()
    .replace(/[ \t]{3,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');

  const built = PROMPTS[mode]({ text: cleanText, tone, platform, length, audience });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    let result = '';

    if (PROVIDER === 'anthropic') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) { res.status(500).json({ error: 'Server is not configured yet (missing API key).' }); return; }
      const r = await fetchWithRetry('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: built.max_tokens,
          temperature: built.temperature,
          system: built.system,
          messages: [{ role: 'user', content: built.user }],
        }),
        signal: controller.signal,
      });
      if (!r.ok) {
        console.error('Anthropic API error', r.status, await r.text().catch(() => ''));
        res.status(502).json({ error: 'The AI service could not process this right now.' });
        return;
      }
      const data = await r.json();
      result = (data.content || []).map((b) => b.text || '').join('').trim();
    } else {
      const key = process.env.OPENAI_API_KEY;
      if (!key) { res.status(500).json({ error: 'Server is not configured yet (missing API key).' }); return; }
      const r = await fetchWithRetry('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: built.max_tokens,
          temperature: built.temperature,
          messages: [
            { role: 'system', content: built.system },
            { role: 'user', content: built.user },
          ],
        }),
        signal: controller.signal,
      });
      if (!r.ok) {
        console.error('OpenAI API error', r.status, await r.text().catch(() => ''));
        res.status(502).json({ error: 'The AI service could not process this right now.' });
        return;
      }
      const data = await r.json();
      result = data.choices?.[0]?.message?.content?.trim() || '';
    }

    clearTimeout(timeout);
    if (!result) {
      res.status(502).json({ error: 'The AI service returned an empty response.' });
      return;
    }
    res.status(200).json({ result });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      res.status(504).json({ error: 'The request took too long. Try shorter text.' });
      return;
    }
    console.error('AI route error', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
};
