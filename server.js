import { randomUUID } from 'node:crypto';
import express from 'express';
import multer from 'multer';
import { Storage } from '@google-cloud/storage';

const app = express();
const PORT = process.env.PORT || 8080; // Cloud Run injects PORT
const BUCKET = process.env.GCS_BUCKET || 'hackucd-storage';
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 25;

// Formats browsers record in (MediaRecorder) plus common uploaded audio files
const AUDIO_TYPES = {
  'audio/webm': 'webm', // Chrome, Firefox
  'audio/ogg': 'ogg', // Firefox
  'audio/mp4': 'm4a', // Safari
  'audio/x-m4a': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};

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

  // Browsers send e.g. "audio/webm;codecs=opus"
  const contentType = file.mimetype.split(';')[0].trim().toLowerCase();
  const ext = AUDIO_TYPES[contentType];
  if (!ext) {
    return next(apiError(415, 'UNSUPPORTED_FORMAT', `Unsupported audio format "${contentType}". Use webm, ogg, m4a, mp3 or wav.`));
  }

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

app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
