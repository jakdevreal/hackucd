import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';

const app = express();
const PORT = process.env.PORT || 8080; // Cloud Run injects PORT
const BUCKET = process.env.GCS_BUCKET || 'hackucd-storage';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 25;

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
    error: { code: err.code || 'INTERNAL_ERROR', message: err.expose ? err.message : 'Something went wrong' },
  });
});

app.listen(PORT, (err) => {
  if (err) {
    console.error(`Could not start on port ${PORT}: ${err.message}`);
    process.exit(1);
  }
  console.log(`Backend listening on http://localhost:${PORT}`);
});
