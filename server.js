import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';
import { transcribe, asciiDiagram, TranscriptionError } from './transcribe.js';
import { analyze, AnalysisError } from './analyze.js';

const app = express();
const PORT = process.env.PORT || 8080; // Cloud Run injects PORT
const BUCKET = process.env.GCS_BUCKET || 'hackucd-storage';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 128;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
const UPLOAD_URL_MINUTES = 15;
const TRANSCRIBE_TIMEOUT_SECONDS = Number(process.env.TRANSCRIBE_TIMEOUT_SECONDS) || 240;
const ANALYSIS_TIMEOUT_SECONDS = Number(process.env.ANALYSIS_TIMEOUT_SECONDS) || 90;
const RECORDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Subscription plans sold through Stripe Checkout. Prices in cents.
const TRIAL_DAYS = 7;
const PLANS = {
  monthly: { name: 'OutSpoken Monthly', amount: 1500, interval: 'month' },
  yearly: { name: 'OutSpoken Yearly', amount: 15000, interval: 'year' },
};
const CHECKOUT_SESSION_ID = /^cs_(test|live)_[A-Za-z0-9]+$/;

// Audio formats we accept, keyed by what the file's first bytes say it is.
// We trust the bytes, not the browser's reported type: phones often send a blank
// or generic type, and a renamed file can claim to be audio when it isn't.
const AUDIO_FORMATS = {
  webm: { contentType: 'audio/webm', ext: 'webm' }, // Chrome, Firefox recordings
  ogg: { contentType: 'audio/ogg', ext: 'ogg' }, // Firefox recordings
  mp4: { contentType: 'audio/mp4', ext: 'm4a' }, // Safari recordings, voice memos
  mp3: { contentType: 'audio/mpeg', ext: 'mp3' },
  wav: { contentType: 'audio/wav', ext: 'wav' },
};

function detectAudioFormat(buf) {
  const ascii = (start, end) => buf.toString('latin1', start, end);
  if (buf.length < 12) return null;
  if (buf.readUInt32BE(0) === 0x1a45dfa3) return 'webm'; // EBML header
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(4, 8) === 'ftyp') return 'mp4';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 3) === 'ID3') return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && (buf[1] & 0x06) !== 0) return 'mp3'; // MPEG audio frame
  return null;
}

const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|avi|mkv|wmv|3gp)$/i;

function isVideo(declaredType, fileName) {
  return declaredType.startsWith('video/') || (!declaredType.startsWith('audio/') && VIDEO_EXTENSIONS.test(fileName));
}

const bucket = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT }).bucket(BUCKET);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

const errors = {
  video: () => apiError(415, 'UNSUPPORTED_FORMAT', 'Video files are not supported. Upload an audio file (webm, ogg, m4a, mp3 or wav).'),
  notAudio: () => apiError(415, 'UNSUPPORTED_FORMAT', 'This file does not look like a supported audio file. Use webm, ogg, m4a, mp3 or wav.'),
  tooLarge: () => apiError(413, 'FILE_TOO_LARGE', `Recording is larger than ${MAX_UPLOAD_MB} MB.`),
  empty: () => apiError(400, 'EMPTY_FILE', 'The recording is empty. Try recording again.'),
};

// Response shape shared by both upload flows
function recordingInfo(id, metadata) {
  return {
    id,
    objectPath: metadata.name,
    contentType: metadata.contentType,
    sizeBytes: Number(metadata.size),
    createdAt: metadata.timeCreated,
  };
}

// Maps transcribe.js failures onto errors the frontend can show
function transcriptionApiError(err) {
  if (!(err instanceof TranscriptionError)) return err; // e.g. ffmpeg missing: a server problem
  console.error(`Transcription failed (${err.reason}):`, err.message);
  if (err.reason === 'timeout') {
    return apiError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription took too long. Please try again.');
  }
  if (err.reason === 'unreadable') {
    return apiError(422, 'UNREADABLE_AUDIO', 'Could not read the audio in this recording. Try recording again.');
  }
  return apiError(502, 'TRANSCRIPTION_FAILED', 'The transcription service failed. Please try again.');
}

// Calls the Stripe REST API directly (no SDK). params are flat form fields like 'line_items[0][quantity]'.
async function stripeRequest(method, endpoint, params = {}) {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw apiError(503, 'PAYMENTS_NOT_CONFIGURED', 'Payments are not set up yet.');
  const query = new URLSearchParams(params);
  const url = `https://api.stripe.com/v1/${endpoint}${method === 'GET' ? `?${query}` : ''}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: method === 'GET' ? undefined : query,
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    console.error('Stripe request failed:', err.message);
    throw apiError(502, 'PAYMENT_FAILED', 'Could not reach the payment provider. Please try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 404) throw apiError(404, 'CHECKOUT_NOT_FOUND', 'No checkout with that id.');
  if (!res.ok) {
    console.error('Stripe error:', data.error?.message || res.status);
    throw apiError(502, 'PAYMENT_FAILED', 'The payment provider returned an error. Please try again.');
  }
  return data;
}

app.use(express.json());

// Let the frontend call us from another origin
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// The frontend team's single-page app, so the whole site runs from this one service
app.get('/', (req, res) => res.sendFile(path.resolve('frontend/index.html')));

// Throwaway page for recording and uploading while the real frontend is built
app.use('/dev', express.static('dev'));

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Prompts (speaking topics for users to talk about), stored as one JSON file in the bucket.
// Edit prompts/scripts.json and run `npm run prompts:upload`; changes show within a minute.
const PROMPTS_CACHE_MS = 60 * 1000;
let promptsCache = { data: null, loadedAt: 0 };

async function loadPrompts() {
  if (promptsCache.data && Date.now() - promptsCache.loadedAt < PROMPTS_CACHE_MS) return promptsCache.data;
  let data;
  try {
    data = await readSaved(bucket.file('prompts/scripts.json'));
  } catch (err) {
    console.error('Loading prompts failed:', err.message);
    throw apiError(502, 'STORAGE_FAILED', 'Could not load the prompts. Please try again.');
  }
  if (!Array.isArray(data?.prompts)) {
    throw apiError(503, 'PROMPTS_UNAVAILABLE', 'Prompts are not available yet.');
  }
  // Skip entries that weren't added with `npm run prompts:upload` (e.g. the bucket file edited by hand)
  const prompts = data.prompts.filter((p) => typeof p?.id === 'string' && Array.isArray(p.focus));
  if (prompts.length < data.prompts.length) {
    console.error(`Skipped ${data.prompts.length - prompts.length} malformed prompt(s); re-upload with npm run prompts:upload`);
  }
  data = { ...data, prompts };
  promptsCache = { data, loadedAt: Date.now() };
  return data;
}

app.get('/api/prompts', async (req, res, next) => {
  try {
    const { prompts, updatedAt } = await loadPrompts();
    const { focus, difficulty } = req.query;
    const matching = prompts.filter(
      (p) => (!focus || p.focus.includes(focus)) && (!difficulty || p.difficulty === difficulty),
    );
    res.json({ updatedAt, prompts: matching });
  } catch (err) {
    next(err);
  }
});

app.get('/api/prompts/:id', async (req, res, next) => {
  try {
    const prompt = (await loadPrompts()).prompts.find((p) => p.id === req.params.id);
    if (!prompt) return next(apiError(404, 'PROMPT_NOT_FOUND', 'No prompt with that id.'));
    res.json(prompt);
  } catch (err) {
    next(err);
  }
});

app.post('/api/recordings', upload.single('audio'), async (req, res, next) => {
  const file = req.file;
  if (!file) return next(apiError(400, 'MISSING_FILE', 'Send the recording as multipart form field "audio".'));
  if (file.size === 0) return next(errors.empty());

  const declaredType = file.mimetype.split(';')[0].trim().toLowerCase();
  if (isVideo(declaredType, file.originalname)) return next(errors.video());

  const format = AUDIO_FORMATS[detectAudioFormat(file.buffer)];
  if (!format) return next(errors.notAudio());

  const id = randomUUID();
  const saved = bucket.file(`recordings/${id}.${format.ext}`);
  try {
    await saved.save(file.buffer, { contentType: format.contentType, resumable: false });
  } catch (err) {
    console.error('Cloud Storage upload failed:', err.message);
    return next(apiError(502, 'STORAGE_FAILED', 'Could not save the recording. Please try again.'));
  }

  res.status(201).json(recordingInfo(id, saved.metadata));
});

// Large-file flow: the browser uploads straight to Cloud Storage, which avoids
// Cloud Run's 32 MB request limit. Step 1: hand out a short-lived upload link.
app.post('/api/recordings/upload-url', async (req, res, next) => {
  const { contentType = '', fileName = '', sizeBytes } = req.body ?? {};
  const declaredType = String(contentType).split(';')[0].trim().toLowerCase();
  if (isVideo(declaredType, String(fileName))) return next(errors.video());
  if (sizeBytes === 0) return next(errors.empty());
  if (Number(sizeBytes) > MAX_UPLOAD_BYTES) return next(errors.tooLarge());

  const id = randomUUID();
  // The browser must send exactly these headers, or Cloud Storage rejects the upload
  const headers = {
    'Content-Type': String(contentType).trim() || 'application/octet-stream',
    'x-goog-content-length-range': `1,${MAX_UPLOAD_BYTES}`,
  };
  const expires = Date.now() + UPLOAD_URL_MINUTES * 60 * 1000;
  try {
    const [uploadUrl] = await bucket.file(`uploads/${id}`).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires,
      contentType: headers['Content-Type'],
      extensionHeaders: { 'x-goog-content-length-range': headers['x-goog-content-length-range'] },
    });
    res.status(201).json({ id, uploadUrl, method: 'PUT', headers, expiresAt: new Date(expires).toISOString() });
  } catch (err) {
    console.error('Signing upload URL failed:', err.message);
    next(apiError(502, 'STORAGE_FAILED', 'Could not start the upload. Please try again.'));
  }
});

// Step 2: after the browser's upload finishes, check the file and file it under recordings/
app.post('/api/recordings/:id/complete', async (req, res, next) => {
  const { id } = req.params;
  const notFound = () => apiError(404, 'UPLOAD_NOT_FOUND', 'No finished upload with that id. Upload the file first.');
  if (!RECORDING_ID.test(id)) return next(notFound());

  const staged = bucket.file(`uploads/${id}`);
  const reject = async (error) => {
    await staged.delete({ ignoreNotFound: true });
    throw error;
  };
  try {
    // Completed already (e.g. a retried request): return the saved recording
    const [[existing]] = await bucket.getFiles({ prefix: `recordings/${id}.` });
    if (existing) return res.status(201).json(recordingInfo(id, existing.metadata));

    const [exists] = await staged.exists();
    if (!exists) throw notFound();

    const [metadata] = await staged.getMetadata();
    const size = Number(metadata.size);
    if (size === 0) await reject(errors.empty());
    if (size > MAX_UPLOAD_BYTES) await reject(errors.tooLarge());

    const [head] = await staged.download({ start: 0, end: 63 });
    const format = AUDIO_FORMATS[detectAudioFormat(head)];
    if (!format) await reject(errors.notAudio());

    const saved = bucket.file(`recordings/${id}.${format.ext}`);
    await staged.move(saved);
    const [savedMetadata] = await saved.setMetadata({ contentType: format.contentType });
    res.status(201).json(recordingInfo(id, savedMetadata));
  } catch (err) {
    if (err.expose) return next(err);
    console.error('Completing upload failed:', err.message);
    next(apiError(502, 'STORAGE_FAILED', 'Could not save the recording. Please try again.'));
  }
});

// Reads a saved JSON result from the bucket, or null if there isn't one yet
async function readSaved(file) {
  const [exists] = await file.exists();
  if (!exists) return null;
  const [saved] = await file.download();
  return JSON.parse(saved);
}

// Saving is best-effort: the user still gets their result, it just won't be cached
async function saveResult(file, data) {
  try {
    await file.save(JSON.stringify(data), { contentType: 'application/json', resumable: false });
  } catch (err) {
    console.error(`Saving ${file.name} failed:`, err.message);
  }
}

const storageError = (err) => {
  console.error('Cloud Storage read failed:', err.message);
  return apiError(502, 'STORAGE_FAILED', 'Could not load the recording. Please try again.');
};

// Returns the saved transcript, transcribing the recording first if needed
async function getTranscript(id) {
  const transcriptFile = bucket.file(`transcripts/${id}.json`);
  let recordingFile;
  try {
    const saved = await readSaved(transcriptFile);
    // Transcripts saved before the diagram was added get one on the fly
    if (saved) return { ...saved, diagram: saved.diagram ?? asciiDiagram(saved.words, saved.duration) };
    [[recordingFile]] = await bucket.getFiles({ prefix: `recordings/${id}.` });
  } catch (err) {
    throw storageError(err);
  }
  if (!recordingFile) throw apiError(404, 'RECORDING_NOT_FOUND', 'No recording with that id.');

  const workDir = await mkdtemp(path.join(tmpdir(), 'transcribe-'));
  try {
    const audioPath = path.join(workDir, path.basename(recordingFile.name));
    try {
      await recordingFile.download({ destination: audioPath });
    } catch (err) {
      throw storageError(err);
    }

    let result;
    try {
      result = await transcribe(audioPath, workDir, {
        apiKey: process.env.OPENROUTER_API_KEY,
        signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_SECONDS * 1000),
      });
    } catch (err) {
      throw transcriptionApiError(err);
    }
    if (!result.text || !result.words.length) {
      throw apiError(422, 'NO_SPEECH', 'No speech was found in this recording.');
    }

    const transcript = { recordingId: id, ...result, createdAt: new Date().toISOString() };
    await saveResult(transcriptFile, transcript);
    return transcript;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

app.post('/api/recordings/:id/transcript', async (req, res, next) => {
  const { id } = req.params;
  if (!RECORDING_ID.test(id)) return next(apiError(404, 'RECORDING_NOT_FOUND', 'No recording with that id.'));
  try {
    res.json(await getTranscript(id));
  } catch (err) {
    next(err);
  }
});

app.post('/api/recordings/:id/analysis', async (req, res, next) => {
  const { id } = req.params;
  if (!RECORDING_ID.test(id)) return next(apiError(404, 'RECORDING_NOT_FOUND', 'No recording with that id.'));
  // Optional: the id of the prompt (speaking topic) the user was given, from GET /api/prompts
  const promptId = req.body?.promptId ?? null;

  const analysisFile = bucket.file(`analyses/${id}.json`);
  try {
    let saved;
    try {
      saved = await readSaved(analysisFile);
    } catch (err) {
      throw storageError(err);
    }
    // Reuse the saved report only if it was made for the same prompt
    if (saved && (saved.promptId ?? null) === promptId) return res.json(saved);

    let topic;
    if (promptId !== null) {
      topic = (await loadPrompts()).prompts.find((p) => p.id === promptId)?.script;
      if (!topic) throw apiError(404, 'PROMPT_NOT_FOUND', 'No prompt with that id.');
    }

    const transcript = await getTranscript(id);
    let result;
    try {
      result = await analyze(transcript, {
        apiKey: process.env.OPENROUTER_API_KEY,
        signal: AbortSignal.timeout(ANALYSIS_TIMEOUT_SECONDS * 1000),
        topic,
      });
    } catch (err) {
      if (!(err instanceof AnalysisError)) throw err;
      console.error(`Analysis failed (${err.reason}):`, err.message);
      throw err.reason === 'timeout'
        ? apiError(504, 'ANALYSIS_TIMEOUT', 'Analysis took too long. Please try again.')
        : apiError(502, 'ANALYSIS_FAILED', 'Could not analyse the recording. Please try again.');
    }

    const analysis = { recordingId: id, promptId, ...result, createdAt: new Date().toISOString() };
    await saveResult(analysisFile, analysis);
    res.json(analysis);
  } catch (err) {
    next(err);
  }
});

// Starts a Stripe Checkout for a plan; the frontend sends the browser to the returned url
app.post('/api/billing/checkout', async (req, res, next) => {
  const planId = req.body?.plan;
  const plan = PLANS[planId];
  if (!plan) return next(apiError(400, 'UNKNOWN_PLAN', 'Choose the monthly or yearly plan.'));

  // Where Stripe sends the user back to: the deployed frontend, or the page that called us
  const origin = req.get('origin');
  const returnTo = process.env.FRONTEND_URL || (/^https?:\/\//.test(origin || '') ? origin : null);
  if (!returnTo) return next(apiError(400, 'NO_RETURN_URL', 'Open the site over http(s) to subscribe.'));

  try {
    const session = await stripeRequest('POST', 'checkout/sessions', {
      mode: 'subscription',
      // Which payment methods show (e.g. cards only, no Klarna) is set in the Stripe Dashboard:
      // Settings > Payment methods. Stripe rejects payment_method_types here.
      'line_items[0][quantity]': 1,
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': plan.amount,
      'line_items[0][price_data][recurring][interval]': plan.interval,
      'line_items[0][price_data][product_data][name]': plan.name,
      'subscription_data[trial_period_days]': TRIAL_DAYS,
      'metadata[plan]': planId,
      success_url: `${returnTo}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${returnTo}/?checkout=cancelled`,
    });
    res.status(201).json({ url: session.url });
  } catch (err) {
    next(err);
  }
});

// Confirms a finished checkout and reports whether its subscription is still active
app.get('/api/billing/session/:id', async (req, res, next) => {
  const { id } = req.params;
  if (!CHECKOUT_SESSION_ID.test(id)) return next(apiError(404, 'CHECKOUT_NOT_FOUND', 'No checkout with that id.'));
  try {
    const session = await stripeRequest('GET', `checkout/sessions/${id}`, { 'expand[]': 'subscription' });
    const sub = session.subscription;
    const active = session.status === 'complete' && ['trialing', 'active'].includes(sub?.status);
    const toIso = (seconds) => (seconds ? new Date(seconds * 1000).toISOString() : null);
    res.json({
      active,
      plan: session.metadata?.plan || null,
      status: sub?.status || session.status,
      trialEndsAt: toIso(sub?.trial_end),
      renewsAt: toIso(sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end),
    });
  } catch (err) {
    next(err);
  }
});

// Unknown routes
app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
});

// Catch-all error handler so the frontend always gets JSON back
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    err =
      err.code === 'LIMIT_FILE_SIZE'
        ? errors.tooLarge()
        : apiError(400, 'BAD_UPLOAD', `Upload problem: ${err.message}. Send one file in field "audio".`);
  }
  if (!err.expose) console.error(err);
  res.status(err.status || 500).json({
    error: err.expose
      ? { code: err.code || 'BAD_REQUEST', message: err.message }
      : { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  });
});

app.listen(PORT, (err) => {
  if (err) {
    console.error(`Could not start on port ${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Backend listening on http://localhost:${PORT}`);
});
