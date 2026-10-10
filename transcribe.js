// Transcribes an audio file through OpenRouter with word timestamps.
// JavaScript port of the team's transcribe_video.py: ffmpeg converts the audio to
// small mono mp3 pieces (OpenRouter takes at most 25 MB per request), each piece is
// transcribed, and the word timestamps are shifted back onto one timeline.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const ENDPOINT = 'https://openrouter.ai/api/v1/audio/transcriptions';
const MODEL = process.env.TRANSCRIBE_MODEL || 'elevenlabs/scribe-v2';
const CHUNK_SECONDS = 300; // 5 min of 64 kbps mp3 is about 2.4 MB, far below the limit
const PARALLEL_REQUESTS = 3;
const REQUEST_TIMEOUT_MS = 120_000;
const ATTEMPTS = 3;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

// reason: 'unreadable' (bad audio), 'service' (OpenRouter failed) or 'timeout'
export class TranscriptionError extends Error {
  constructor(reason, message, options) {
    super(message, options);
    this.reason = reason;
  }
}

// One ffmpeg pass: drop video, mono 16 kHz mp3, cut into CHUNK_SECONDS pieces.
// Works even when the source file doesn't record its own duration.
async function splitIntoChunks(source, workDir, signal) {
  try {
    await execFileAsync(
      'ffmpeg',
      ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', source,
        '-vn', '-map', '0:a:0', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k',
        '-f', 'segment', '-segment_time', String(CHUNK_SECONDS), '-reset_timestamps', '1',
        path.join(workDir, 'chunk-%04d.mp3')],
      { signal },
    );
  } catch (err) {
    if (err.code === 'ENOENT' || signal.aborted) throw err; // ffmpeg missing, or timed out
    throw new TranscriptionError('unreadable', `ffmpeg could not decode the audio: ${err.stderr || err.message}`);
  }

  const files = (await readdir(workDir)).filter((f) => /^chunk-\d+\.mp3$/.test(f)).sort();
  if (!files.length) throw new TranscriptionError('unreadable', 'ffmpeg produced no audio');

  // Measure each piece so timestamps line up exactly, whatever ffmpeg's cut points were
  const chunks = [];
  let start = 0;
  for (const file of files) {
    const chunkPath = path.join(workDir, file);
    const { stdout } = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', chunkPath],
      { signal },
    );
    const duration = Number.parseFloat(stdout);
    if (!Number.isFinite(duration)) throw new TranscriptionError('unreadable', `Could not measure ${file}`);
    chunks.push({ path: chunkPath, start, duration });
    start += duration;
  }
  return chunks;
}

async function transcribeChunk(chunkPath, apiKey, signal) {
  const form = new FormData();
  form.append('model', MODEL);
  form.append('response_format', 'verbose_json');
  form.append('timestamp_granularities[]', 'word');
  form.append('file', new Blob([await readFile(chunkPath)], { type: 'audio/mpeg' }), 'chunk.mp3');

  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      if (attempt === ATTEMPTS) throw new TranscriptionError('service', `OpenRouter request failed: ${err.message}`, { cause: err });
      await sleep(2 ** (attempt - 1) * 1000);
      continue;
    }

    if (res.ok) {
      const result = await res.json().catch(() => null);
      if (typeof result?.text !== 'string') {
        throw new TranscriptionError('service', `Unexpected OpenRouter response: ${JSON.stringify(result)?.slice(0, 500)}`);
      }
      return result;
    }
    const detail = (await res.text()).slice(0, 2000);
    if (!RETRY_STATUSES.has(res.status) || attempt === ATTEMPTS) {
      throw new TranscriptionError('service', `OpenRouter HTTP ${res.status}: ${detail}`);
    }
    await sleep(2 ** (attempt - 1) * 1000);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Runs fn over items, at most `limit` at a time, keeping results in order
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Transcribes the audio at `source`, writing temporary pieces into `workDir`.
 * Returns { text, duration, words: [{ word, start, end }], model }, times in seconds.
 * Throws TranscriptionError; `signal` aborts everything (used for the overall timeout).
 */
export async function transcribe(source, workDir, { apiKey, signal }) {
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set');
  try {
    const chunks = await splitIntoChunks(source, workDir, signal);
    const results = await mapLimit(chunks, PARALLEL_REQUESTS, (chunk) => transcribeChunk(chunk.path, apiKey, signal));

    const words = chunks.flatMap((chunk, i) =>
      (results[i].words || [])
        .filter((w) => (!w.type || w.type === 'word') && String(w.word ?? '').trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
        .map((w) => ({
          word: String(w.word).trim(),
          start: round(w.start + chunk.start),
          end: round(w.end + chunk.start),
        })),
    );
    return {
      text: results.map((r) => r.text.trim()).filter(Boolean).join(' '),
      duration: round(chunks.reduce((sum, c) => sum + c.duration, 0)),
      words,
      model: MODEL,
    };
  } catch (err) {
    if (signal.aborted) throw new TranscriptionError('timeout', 'Transcription timed out', { cause: err });
    throw err;
  }
}

const round = (seconds) => Math.round(seconds * 1000) / 1000;
