import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';

const app = express();
const PORT = process.env.PORT || 8080; // Cloud Run injects PORT
const BUCKET = process.env.GCS_BUCKET || 'hackucd-storage';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 25;
const TRANSCRIBE_TIMEOUT_SECONDS = Number(process.env.TRANSCRIBE_TIMEOUT_SECONDS) || 240;
const TRANSCRIBE_SCRIPT = fileURLToPath(new URL('./transcribe_video.py', import.meta.url));
const RECORDING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const execFileAsync = promisify(execFile);

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

const bucket = new Storage({ projectId: process.env.GOOGLE_CLOUD_PROJECT }).bucket(BUCKET);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

function apiError(status, code, message) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

// Runs transcribe_video.py (ffmpeg + OpenRouter) and returns its combined transcript.json
async function runTranscription(audioPath, outputDir) {
  if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY is not set');
  try {
    await execFileAsync('python3', [TRANSCRIBE_SCRIPT, audioPath, '--output-dir', outputDir], {
      timeout: TRANSCRIBE_TIMEOUT_SECONDS * 1000,
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    if (err.killed) {
      throw apiError(504, 'TRANSCRIPTION_TIMEOUT', 'Transcription took too long. Please try again.');
    }
    const detail = (err.stderr || err.message).trim();
    console.error('Transcription failed:', detail);
    // ffprobe/ffmpeg ran but could not decode the file
    if (/\['ff(probe|mpeg)'.*returned non-zero exit status/.test(detail)) {
      throw apiError(422, 'UNREADABLE_AUDIO', 'Could not read the audio in this recording. Try recording again.');
    }
    if (/OpenRouter/.test(detail)) {
      throw apiError(502, 'TRANSCRIPTION_FAILED', 'The transcription service failed. Please try again.');
    }
    throw err; // ffmpeg/python missing or another server problem
  }
  return JSON.parse(await readFile(path.join(outputDir, 'transcript.json'), 'utf8'));
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

// Throwaway page for recording and uploading while the real frontend is built
app.use('/dev', express.static('dev'));

app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/api/recordings', upload.single('audio'), async (req, res, next) => {
  const file = req.file;
  if (!file) return next(apiError(400, 'MISSING_FILE', 'Send the recording as multipart form field "audio".'));
  if (file.size === 0) return next(apiError(400, 'EMPTY_FILE', 'The recording is empty. Try recording again.'));

  const declaredType = file.mimetype.split(';')[0].trim().toLowerCase();
  if (declaredType.startsWith('video/') || (!declaredType.startsWith('audio/') && VIDEO_EXTENSIONS.test(file.originalname))) {
    return next(apiError(415, 'UNSUPPORTED_FORMAT', 'Video files are not supported. Upload an audio file (webm, ogg, m4a, mp3 or wav).'));
  }

  const format = AUDIO_FORMATS[detectAudioFormat(file.buffer)];
  if (!format) {
    return next(apiError(415, 'UNSUPPORTED_FORMAT', 'This file does not look like a supported audio file. Use webm, ogg, m4a, mp3 or wav.'));
  }
  const { contentType, ext } = format;

  const id = randomUUID();
  const objectPath = `recordings/${id}.${ext}`;
  try {
    await bucket.file(objectPath).save(file.buffer, { contentType, resumable: false });
  } catch (err) {
    console.error('Cloud Storage upload failed:', err.message);
    return next(apiError(502, 'STORAGE_FAILED', 'Could not save the recording. Please try again.'));
  }

  res.status(201).json({
    id,
    objectPath,
    contentType,
    sizeBytes: file.size,
    createdAt: new Date().toISOString(),
  });
});

app.post('/api/recordings/:id/transcript', async (req, res, next) => {
  const { id } = req.params;
  if (!RECORDING_ID.test(id)) return next(apiError(404, 'RECORDING_NOT_FOUND', 'No recording with that id.'));

  const transcriptFile = bucket.file(`transcripts/${id}.json`);
  let recordingFile;
  try {
    // Already transcribed: return the saved copy instead of paying for it again
    const [exists] = await transcriptFile.exists();
    if (exists) {
      const [saved] = await transcriptFile.download();
      return res.json(JSON.parse(saved));
    }
    [[recordingFile]] = await bucket.getFiles({ prefix: `recordings/${id}.` });
  } catch (err) {
    console.error('Cloud Storage read failed:', err.message);
    return next(apiError(502, 'STORAGE_FAILED', 'Could not load the recording. Please try again.'));
  }
  if (!recordingFile) return next(apiError(404, 'RECORDING_NOT_FOUND', 'No recording with that id.'));

  const workDir = await mkdtemp(path.join(tmpdir(), 'transcribe-'));
  try {
    const audioPath = path.join(workDir, path.basename(recordingFile.name));
    try {
      await recordingFile.download({ destination: audioPath });
    } catch (err) {
      console.error('Cloud Storage download failed:', err.message);
      throw apiError(502, 'STORAGE_FAILED', 'Could not load the recording. Please try again.');
    }

    const result = await runTranscription(audioPath, path.join(workDir, 'out'));
    const words = (result.words || [])
      .filter((w) => (!w.type || w.type === 'word') && String(w.word ?? '').trim())
      .map((w) => ({ word: String(w.word).trim(), start: w.start, end: w.end }));
    if (!result.text?.trim() || !words.length) {
      throw apiError(422, 'NO_SPEECH', 'No speech was found in this recording.');
    }

    const transcript = {
      recordingId: id,
      text: result.text.trim(),
      duration: result.duration,
      words,
      model: result.model,
      createdAt: new Date().toISOString(),
    };
    try {
      await transcriptFile.save(JSON.stringify(transcript), { contentType: 'application/json', resumable: false });
    } catch (err) {
      // Still give the user their transcript; it just won't be cached
      console.error('Saving transcript failed:', err.message);
    }
    res.json(transcript);
  } catch (err) {
    next(err);
  } finally {
    await rm(workDir, { recursive: true, force: true });
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
        ? apiError(413, 'FILE_TOO_LARGE', `Recording is larger than ${MAX_UPLOAD_MB} MB.`)
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
