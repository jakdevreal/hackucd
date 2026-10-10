// Speech analysis: exact measurements from the word timestamps, plus coaching from
// an LLM via OpenRouter. Every coaching item must quote the transcript; quotes we
// can't find are dropped, and found ones get their real timestamps.

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.ANALYSIS_MODEL || 'anthropic/claude-haiku-5.5';
const REQUEST_TIMEOUT_MS = 60_000;
const ATTEMPTS = 2; // one retry for malformed output or a transient failure
const LONG_PAUSE_SECONDS = 1.5;

// reason: 'service' (OpenRouter failed or returned unusable output) or 'timeout'
export class AnalysisError extends Error {
  constructor(reason, message, options) {
    super(message, options);
    this.reason = reason;
  }
}

// --- Measurements -----------------------------------------------------------

// Clear fillers only: words like "like" or "so" are fillers in some sentences
// and not others, so the model judges those in context instead.
const FILLERS = ['um', 'uh', 'uhm', 'er', 'erm', 'ah', 'hmm', 'mm', 'you know', 'i mean'];

const STOPWORDS = new Set(`a an the and or but so if then than that this these those it its it's i i'm i've
me my we our you your he she they them their his her is am are was were be been being do does did
done have has had to of in on at by for with from up down out over into about as just not no yes
can could will would should may might must there here what when where which who how why all some
any one two very really too also well get got go going gonna want like know think say said make
okay ok oh yeah um uh er erm ah hmm mm uhm`.split(/\s+/));

// Lowercase, strip punctuation: "6:00," -> "600", "Don't" -> "don't"
const norm = (text) => String(text).toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '').replace(/^'+|'+$/g, '');

const round = (n, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
const moment = (w) => ({ start: w.start, end: w.end });

// Splits the transcript into sentences, keeping word positions for timestamp lookups
function toSentences(words) {
  const sentences = [];
  let first = 0;
  words.forEach((w, i) => {
    if (/[.!?]["')\]]*$/.test(w.word) || i === words.length - 1) {
      const slice = words.slice(first, i + 1);
      sentences.push({
        index: sentences.length + 1,
        firstWord: first,
        lastWord: i,
        start: slice[0].start,
        end: slice[slice.length - 1].end,
        text: slice.map((x) => x.word).join(' '),
      });
      first = i + 1;
    }
  });
  return sentences;
}

export function measure(transcript) {
  const { words, duration } = transcript;
  const tokens = words.map((w) => norm(w.word));
  const minutes = Math.max(duration, 1) / 60;

  // Fillers, including two-word ones ("you know")
  const fillerMoments = new Map(FILLERS.map((f) => [f, []]));
  tokens.forEach((t, i) => {
    if (fillerMoments.has(t)) fillerMoments.get(t).push(moment(words[i]));
    const pair = `${t} ${tokens[i + 1]}`;
    if (fillerMoments.has(pair)) fillerMoments.get(pair).push({ start: words[i].start, end: words[i + 1].end });
  });
  const byWord = [...fillerMoments]
    .filter(([, m]) => m.length)
    .map(([word, moments]) => ({ word, count: moments.length, moments }))
    .sort((a, b) => b.count - a.count);
  const fillerTotal = byWord.reduce((sum, f) => sum + f.count, 0);

  // Silences between words
  const longPauses = [];
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end;
    if (gap >= LONG_PAUSE_SECONDS) longPauses.push({ start: words[i - 1].end, end: words[i].start, seconds: round(gap, 1) });
  }

  // Content words used 3+ times
  const repeats = new Map();
  tokens.forEach((t, i) => {
    if (t.length < 3 || STOPWORDS.has(t) || /^\d+$/.test(t)) return;
    if (!repeats.has(t)) repeats.set(t, []);
    repeats.get(t).push(moment(words[i]));
  });
  const repeatedWords = [...repeats]
    .filter(([, m]) => m.length >= 3)
    .map(([word, moments]) => ({ word, count: moments.length, moments }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // First word of each sentence, when the same one starts 2+ sentences
  const sentences = toSentences(words);
  const openerCounts = new Map();
  for (const s of sentences) {
    const opener = norm(words[s.firstWord].word);
    if (opener) openerCounts.set(opener, (openerCounts.get(opener) || 0) + 1);
  }
  const sentenceOpeners = [...openerCounts]
    .filter(([, count]) => count >= 2)
    .map(([opener, count]) => ({ opener, count }))
    .sort((a, b) => b.count - a.count);

  return {
    sentences,
    stats: {
      durationSeconds: round(duration, 1),
      wordCount: words.length,
      wordsPerMinute: Math.round(words.length / minutes),
      fillers: { total: fillerTotal, perMinute: round(fillerTotal / minutes, 1), byWord },
      longPauses,
      repeatedWords,
      sentenceOpeners,
      sentenceCount: sentences.length,
    },
  };
}

// --- Coaching from the model -------------------------------------------------

const CATEGORIES = ['filler', 'repetition', 'opening', 'clarity', 'structure', 'pacing', 'ending'];

const SYSTEM_PROMPT = `You are a speaking coach for social media creators who talk to camera. You get a transcript of one take, split into numbered sentences with timestamps, plus measurements computed from it. Give coaching the creator can act on before their next video.

What to look for:
- Filler words and verbal habits: "um", "like", "you know", "basically", "so" at the start of sentences, sentences that trail off. Judge words like "like" and "so" in context; "I like coffee" is not a filler.
- Repetitive vocabulary: overused words and phrases. Suggest specific alternatives that fit the sentence.
- Opening: does the first sentence or two give viewers a reason to keep watching?
- Clarity and structure: rambling, points that never land, ideas in a confusing order.
- Ending: does it finish with a clear point or call to action, or fizzle out?
- Pacing: use the measured words per minute and pauses. Around 140-170 words per minute suits most talking-to-camera videos.

Rules:
- Every feedback item must point at a real moment. "quote" must be copied exactly from the sentence you name, character for character, and be short: the few words that show the problem, not the whole sentence unless needed.
- "tryInstead" says exactly what to do or say instead, ideally a rewritten version of the quoted words.
- "alternatives" lists replacement words for repetition items; leave it empty for other categories.
- Be specific to what this person said. No generic public-speaking advice.
- Combine repeats of the same habit into one item that quotes the clearest example, rather than one item per occurrence.
- Give 3 to 8 feedback items, ordered most important first. Fewer is fine for a short take.
- "strengths": 1 to 3 genuine things they did well, specific to this take.
- "topPriorities": the 1 to 3 changes that would most improve their next take, as short instructions.
- "summary": 2 to 3 sentences, encouraging and direct, written to the creator ("you").`;

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    strengths: { type: 'array', items: { type: 'string' } },
    topPriorities: { type: 'array', items: { type: 'string' } },
    feedback: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: CATEGORIES },
          sentence: { type: 'integer', description: 'Number of the sentence the quote comes from' },
          quote: { type: 'string', description: 'Exact words copied from that sentence' },
          issue: { type: 'string' },
          tryInstead: { type: 'string' },
          alternatives: { type: 'array', items: { type: 'string' } },
        },
        required: ['category', 'sentence', 'quote', 'issue', 'tryInstead', 'alternatives'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'strengths', 'topPriorities', 'feedback'],
  additionalProperties: false,
};

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

function buildPrompt(sentences, stats) {
  const measurements = {
    durationSeconds: stats.durationSeconds,
    wordsPerMinute: stats.wordsPerMinute,
    fillers: stats.fillers.byWord.map(({ word, count }) => ({ word, count })),
    longPauses: stats.longPauses.map((p) => `${p.seconds}s at ${clock(p.start)}`),
    repeatedWords: stats.repeatedWords.map(({ word, count }) => ({ word, count })),
    sentenceOpeners: stats.sentenceOpeners,
  };
  const transcript = sentences.map((s) => `[${s.index}] (${clock(s.start)}) ${s.text}`).join('\n');
  return `Measurements:\n${JSON.stringify(measurements, null, 2)}\n\nTranscript:\n${transcript}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// One request to OpenRouter. Errors carry `retryable` for requestCoaching.
async function requestOnce(prompt, apiKey, signal) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      provider: { require_parameters: true }, // only route to providers that enforce the schema
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'speech_coaching', strict: true, schema: RESPONSE_SCHEMA } },
    }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!res.ok) {
    const error = new AnalysisError('service', `OpenRouter HTTP ${res.status}: ${(await res.text()).slice(0, 1000)}`);
    error.retryable = res.status === 429 || res.status >= 500;
    throw error;
  }
  const choice = (await res.json()).choices?.[0];
  const content = choice?.message?.content ?? '';
  try {
    const coaching = JSON.parse(content);
    if (typeof coaching.summary !== 'string' || !Array.isArray(coaching.feedback)) throw new Error('missing fields');
    return coaching;
  } catch (err) {
    const error = new AnalysisError(
      'service',
      `Malformed model output (finish_reason ${choice?.finish_reason}): ${content.slice(0, 300)}`,
      { cause: err },
    );
    error.retryable = true;
    throw error;
  }
}

// Retries once on network errors, 429/5xx and malformed output
async function requestCoaching(prompt, apiKey, signal) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestOnce(prompt, apiKey, signal);
    } catch (err) {
      if (signal.aborted) throw err;
      const error = err instanceof AnalysisError
        ? err
        : Object.assign(new AnalysisError('service', `OpenRouter request failed: ${err.message}`, { cause: err }), { retryable: true });
      if (!error.retryable || attempt === ATTEMPTS) throw error;
      console.warn(`Analysis attempt ${attempt} failed, retrying: ${error.message}`);
      await sleep(1000);
    }
  }
}

// Finds the quote's words in the transcript, preferring the sentence the model named.
// Returns the exact transcript wording and timestamps, or null if it isn't there.
function locateQuote(quote, sentenceNumber, sentences, words, tokens) {
  const needle = String(quote).split(/\s+/).map(norm).filter(Boolean);
  if (!needle.length) return null;
  const named = sentences[sentenceNumber - 1];
  const ranges = named ? [[named.firstWord, named.lastWord], [0, words.length - 1]] : [[0, words.length - 1]];
  for (const [from, to] of ranges) {
    for (let i = from; i + needle.length - 1 <= to; i++) {
      if (needle.every((t, k) => tokens[i + k] === t)) {
        const matched = words.slice(i, i + needle.length);
        return { quote: matched.map((w) => w.word).join(' '), start: matched[0].start, end: matched[matched.length - 1].end };
      }
    }
  }
  return null;
}

/**
 * Analyses a transcript ({ text, duration, words }) and returns
 * { summary, strengths, topPriorities, feedback, stats, model }.
 * Throws AnalysisError; `signal` aborts everything (used for the overall timeout).
 */
export async function analyze(transcript, { apiKey, signal }) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  const { sentences, stats } = measure(transcript);

  let coaching;
  try {
    coaching = await requestCoaching(buildPrompt(sentences, stats), apiKey, signal);
  } catch (err) {
    if (signal.aborted) throw new AnalysisError('timeout', 'Analysis timed out', { cause: err });
    throw err;
  }

  const tokens = transcript.words.map((w) => norm(w.word));
  const feedback = [];
  let dropped = 0;
  for (const item of coaching.feedback) {
    const found = locateQuote(item.quote, item.sentence, sentences, transcript.words, tokens);
    if (!found) {
      dropped++;
      continue;
    }
    feedback.push({
      category: item.category,
      quote: found.quote,
      start: found.start,
      end: found.end,
      issue: item.issue,
      tryInstead: item.tryInstead,
      alternatives: item.category === 'repetition' ? item.alternatives : [],
    });
  }
  if (dropped) console.warn(`Analysis: dropped ${dropped} feedback item(s) whose quote was not in the transcript`);

  return {
    summary: coaching.summary,
    strengths: coaching.strengths.slice(0, 3),
    topPriorities: coaching.topPriorities.slice(0, 3),
    feedback: feedback.slice(0, 8),
    stats,
    model: MODEL,
  };
}
