# API

Base URL (deployed): **`https://hackucd-backend-177345674775.europe-west1.run.app`**

Base URL (local): `http://localhost:8080`.

All responses are JSON. Errors use this shape:

```json
{ "error": { "code": "NOT_FOUND", "message": "Human-readable message the frontend can show" } }
```

## GET /api/health

Checks that the server is up.

**Response 200**

```json
{ "status": "ok" }
```

## Uploading a recording

Use this for both in-browser recordings (`MediaRecorder`) and audio files the user picks from their device (`<input type="file" accept="audio/*">`).

Accepted formats: **webm** (Chrome/Firefox recordings), **ogg**, **m4a** (Safari recordings, phone voice memos), **mp3**, **wav**. **Max size: 128 MB.** Video files are rejected.

The server checks the file's actual contents, not the type the browser reports, so files with a blank or wrong type (common on phones) still work, and non-audio files renamed to `.mp3` are rejected.

The file goes **straight from the browser to Cloud Storage**, not through our server. Cloud Run rejects requests over 32 MB, so this is the only way to accept files up to 128 MB. It takes three calls:

```js
// file: a Blob from MediaRecorder, or a File from <input type="file">
// 1. Ask for an upload link
let res = await fetch(`${API_URL}/api/recordings/upload-url`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ contentType: file.type, fileName: file.name, sizeBytes: file.size }),
});
const link = await res.json();
if (!res.ok) throw link.error; // e.g. FILE_TOO_LARGE before uploading anything

// 2. Upload the file to Cloud Storage. Send link.headers exactly as given.
const put = await fetch(link.uploadUrl, { method: link.method, headers: link.headers, body: file });
if (!put.ok) throw { message: 'Upload failed. Please try again.' }; // Cloud Storage error, not our JSON shape

// 3. Tell the backend the upload finished; it checks the file and returns the recording
res = await fetch(`${API_URL}/api/recordings/${link.id}/complete`, { method: 'POST' });
const recording = await res.json(); // on error: recording.error.message is safe to show
```

For upload progress on large files, do step 2 with `XMLHttpRequest` and `xhr.upload.onprogress` instead of `fetch`.

### POST /api/recordings/upload-url

**Request body** (JSON, all fields optional but send them when you have them):

| Field | Example | Used for |
| --- | --- | --- |
| `contentType` | `"audio/webm;codecs=opus"` | `file.type`; may be `""` |
| `fileName` | `"memo.m4a"` | Rejecting video files early |
| `sizeBytes` | `5242880` | Rejecting files over 128 MB before uploading |

**Response 201**

```json
{
  "id": "8e5b7ea0-2d7b-4b0e-ae55-389b9e892465",
  "uploadUrl": "https://storage.googleapis.com/hackucd-storage/uploads/8e5b...?X-Goog-Signature=...",
  "method": "PUT",
  "headers": { "Content-Type": "audio/webm;codecs=opus", "x-goog-content-length-range": "1,134217728" },
  "expiresAt": "2026-10-10T10:48:35.573Z"
}
```

The link works for 15 minutes. Cloud Storage refuses the upload if the headers differ from `headers` or the file is over 128 MB.

**Errors**: 413 `FILE_TOO_LARGE`, 415 `UNSUPPORTED_FORMAT` (video), 400 `EMPTY_FILE`, 502 `STORAGE_FAILED`.

### POST /api/recordings/:id/complete

Call after the upload to Cloud Storage succeeds. No request body. Safe to retry: calling it again returns the same recording.

**Response 201**

```json
{
  "id": "8e5b7ea0-2d7b-4b0e-ae55-389b9e892465",
  "objectPath": "recordings/8e5b7ea0-2d7b-4b0e-ae55-389b9e892465.webm",
  "contentType": "audio/webm",
  "sizeBytes": 151718,
  "createdAt": "2026-10-10T10:33:39.131Z"
}
```

`contentType` is the detected format (`audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg` or `audio/wav`). Keep `id`: the transcript and analysis endpoints take it.

**Errors**

| Status | `code` | When |
| --- | --- | --- |
| 404 | `UPLOAD_NOT_FOUND` | Nothing was uploaded for that `id` (step 2 failed or was skipped) |
| 400 | `EMPTY_FILE` | File is 0 bytes |
| 413 | `FILE_TOO_LARGE` | Over 128 MB |
| 415 | `UNSUPPORTED_FORMAT` | Contents are not one of the formats above |
| 502 | `STORAGE_FAILED` | Cloud Storage error; safe to retry |

A rejected file is deleted. Ask the user for a different file and start again from step 1.

### POST /api/recordings (small files only)

The original one-call upload: `multipart/form-data` with the file in field **`audio`**. Same checks, same 201 response as `/complete`. Once deployed to Cloud Run it **only works for files under 32 MB**, so the frontend should use the three-step flow above. It is kept for quick testing with curl.

Errors: 400 `MISSING_FILE`, 400 `EMPTY_FILE`, 400 `BAD_UPLOAD` (wrong field name or more than one file), 413 `FILE_TOO_LARGE`, 415 `UNSUPPORTED_FORMAT`, 502 `STORAGE_FAILED`.

## POST /api/recordings/:id/transcript

Transcribes a recording uploaded with `POST /api/recordings`, using its `id`. No request body. This can take several seconds: about 3 s for a short clip and 35 s for 5 minutes of audio, with a 240 s limit. Show a loading state.

The transcript is saved to Cloud Storage. Calling this again for the same recording returns the saved transcript instantly, without transcribing again. Retrying after an error is safe.

**Response 200**

```json
{
  "recordingId": "6c0089fd-ea31-4083-a2de-62e14fe66cc8",
  "text": "Hey everyone, so today I want to talk about...",
  "duration": 42.7,
  "words": [
    { "word": "Hey", "start": 0.12, "end": 0.34 },
    { "word": "everyone,", "start": 0.36, "end": 0.81 }
  ],
  "model": "elevenlabs/scribe-v2",
  "createdAt": "2026-10-10T11:30:00.000Z"
}
```

`duration`, `start` and `end` are in seconds from the start of the recording. Use them to highlight words or jump the audio player to a moment.

**Errors**

| Status | `code` | When |
| --- | --- | --- |
| 404 | `RECORDING_NOT_FOUND` | No recording with that `id` |
| 422 | `NO_SPEECH` | Recording has no detectable speech |
| 422 | `UNREADABLE_AUDIO` | File could not be decoded; record again |
| 502 | `TRANSCRIPTION_FAILED` | Transcription service error; safe to retry |
| 502 | `STORAGE_FAILED` | Cloud Storage error; safe to retry |
| 504 | `TRANSCRIPTION_TIMEOUT` | Took longer than 240 s; safe to retry |

## POST /api/recordings/:id/analysis

The coaching report for a recording, and the one call the "Get feedback" button needs after uploading. No request body. If the recording hasn't been transcribed yet, this transcribes it first, so you don't need to call `/transcript` separately. Expect about 20 s for a 1-minute take; show a loading state.

The result is saved. Calling it again returns the saved report instantly without re-analysing, so it's safe to retry and safe to call when re-opening a past recording.

**Response 200**

```json
{
  "recordingId": "8e5b7ea0-2d7b-4b0e-ae55-389b9e892465",
  "summary": "You have a solid, specific idea here... Tighten the opening, cut the filler, and close with a clear takeaway.",
  "strengths": ["You gave concrete details, like waking at 5 AM, which make the advice feel real."],
  "topPriorities": ["Open by stating the topic and the payoff in your first sentence, with no greeting preamble."],
  "feedback": [
    {
      "category": "repetition",
      "quote": "basically, a lot of people ask me",
      "start": 7.8,
      "end": 9.8,
      "issue": "\"Basically\" appears 5 times, and it has started to sound like a habit rather than a word you mean.",
      "tryInstead": "Use a pause or a more specific phrase: \"Honestly, a lot of people ask me how I get so much done.\"",
      "alternatives": ["honestly", "in short", "the truth is"]
    }
  ],
  "stats": {
    "durationSeconds": 49.2,
    "wordCount": 139,
    "wordsPerMinute": 169,
    "sentenceCount": 14,
    "fillers": {
      "total": 10,
      "perMinute": 12.2,
      "byWord": [{ "word": "um", "count": 8, "moments": [{ "start": 1.02, "end": 1.2 }] }]
    },
    "longPauses": [{ "start": 12.4, "end": 14.1, "seconds": 1.7 }],
    "repeatedWords": [{ "word": "basically", "count": 5, "moments": [{ "start": 7.8, "end": 8.3 }] }],
    "sentenceOpeners": [{ "opener": "so", "count": 6 }]
  },
  "model": "anthropic/claude-haiku-5.5",
  "createdAt": "2026-10-10T12:10:00.000Z"
}
```

- **`feedback`**: 0 to 8 items, most important first. `category` is one of `filler`, `repetition`, `opening`, `clarity`, `structure`, `pacing`, `ending`. `quote` is the exact wording from the transcript, and `start`/`end` are seconds into the recording: use them to highlight the words or seek the audio player. `alternatives` is filled for `repetition` items and empty for the rest.
- **`stats`** is measured directly from the transcript, not by the AI, so it is exact and comparable between recordings (the progress-over-time view will use it). `moments` lists every occurrence with timestamps. `longPauses` are silences of 1.5 s or more.
- **`summary`**, **`strengths`** (1-3) and **`topPriorities`** (1-3) are short text for the top of the report.
- For the full transcript (to show the words with highlights), call `POST /api/recordings/:id/transcript`. It is already saved by then, so it returns instantly.

**Errors**

| Status | `code` | When |
| --- | --- | --- |
| 404 | `RECORDING_NOT_FOUND` | No recording with that `id` |
| 422 | `NO_SPEECH` | Recording has no detectable speech |
| 422 | `UNREADABLE_AUDIO` | File could not be decoded; record again |
| 502 | `ANALYSIS_FAILED` | AI service error or unusable reply; safe to retry |
| 502 | `TRANSCRIPTION_FAILED` / `STORAGE_FAILED` | Safe to retry |
| 504 | `ANALYSIS_TIMEOUT` / `TRANSCRIPTION_TIMEOUT` | Took too long; safe to retry |

## GET /api/prompts

Sample scripts for users to read aloud while they practise. Each one targets a speaking habit, using the same names as the analysis `feedback` categories, so after an analysis you can suggest scripts for the user's weakest area: `GET /api/prompts?focus=opening`.

**Query (optional):** `focus` (one of `filler`, `repetition`, `opening`, `clarity`, `structure`, `pacing`, `ending`), `difficulty` (`beginner`, `intermediate`, `advanced`). Without them, all scripts are returned.

**Response 200**

```json
{
  "updatedAt": "2026-10-10T11:56:08.918Z",
  "prompts": [
    {
      "id": "example-script",
      "title": "Example title",
      "category": "Tutorial",
      "difficulty": "beginner",
      "focus": ["opening"],
      "script": "The text the user reads aloud.",
      "tips": ["A short tip for reading it well."],
      "wordCount": 7,
      "estimatedSeconds": 3
    }
  ]
}
```

`estimatedSeconds` assumes a comfortable 150 words per minute. `prompts` is empty when nothing matches the filters, or before any scripts have been added.

**Errors**: 503 `PROMPTS_UNAVAILABLE` (no scripts uploaded yet), 502 `STORAGE_FAILED` (safe to retry).

### GET /api/prompts/:id

One script by `id`, same shape as an item above. **Errors**: 404 `PROMPT_NOT_FOUND`.

### Adding or editing scripts

Scripts live in `gs://hackucd-storage/prompts/scripts.json`. To change them, edit `prompts/scripts.json` in the repo and run `npm run prompts:upload`. The API picks up changes within a minute, with no redeploy.

Each entry in `"prompts"` needs:

| Field | Rules |
| --- | --- |
| `id` | Unique, lowercase with dashes, e.g. `strong-outro` |
| `title` | Short name shown to the user |
| `category` | Free text, e.g. `Tutorial`, `Storytime` |
| `difficulty` | `beginner`, `intermediate` or `advanced` |
| `focus` | One or more of `filler`, `repetition`, `opening`, `clarity`, `structure`, `pacing`, `ending` |
| `script` | The text to read aloud |
| `tips` | List of short reading tips; `[]` if none |

Don't add `wordCount` or `estimatedSeconds`; the upload fills them in. If anything is wrong, the upload refuses and lists every problem.

## Billing (Stripe)

Two plans, both with a **7-day free trial** (card taken at sign-up, charged when the trial ends):

| `plan` | Price |
| --- | --- |
| `monthly` | €15 / month |
| `yearly` | €150 / year |

Runs in Stripe test mode with a `sk_test_` key in `STRIPE_SECRET_KEY`. Test card: `4242 4242 4242 4242`, any future date, any CVC. There are no user accounts: the frontend keeps the checkout `sessionId` in the browser and checks it with `GET /api/billing/session/:id`.

If `STRIPE_SECRET_KEY` is not set, both endpoints return 503 `PAYMENTS_NOT_CONFIGURED`.

### POST /api/billing/checkout

**Request body** (JSON): `{ "plan": "monthly" }`

**Response 201**

```json
{ "url": "https://checkout.stripe.com/c/pay/cs_test_..." }
```

Send the browser to `url` (`location.href = url`). After paying, Stripe sends the user back to `FRONTEND_URL` (or the calling page's origin) with `?checkout=success&session_id=cs_test_...`, or `?checkout=cancelled` if they backed out.

**Errors**: 400 `UNKNOWN_PLAN`, 400 `NO_RETURN_URL` (page opened as a file, not over http), 502 `PAYMENT_FAILED`, 503 `PAYMENTS_NOT_CONFIGURED`.

### GET /api/billing/session/:id

Checks a checkout from the `session_id` Stripe returned. Call it on return from checkout and on later visits to confirm the subscription is still running.

**Response 200**

```json
{
  "active": true,
  "plan": "monthly",
  "status": "trialing",
  "trialEndsAt": "2026-10-17T12:00:00.000Z",
  "renewsAt": "2026-10-17T12:00:00.000Z"
}
```

`active` is true while the subscription is `trialing` or `active`. `status` is Stripe's subscription status (`trialing`, `active`, `past_due`, `canceled`, ...).

**Errors**: 404 `CHECKOUT_NOT_FOUND`, 502 `PAYMENT_FAILED`, 503 `PAYMENTS_NOT_CONFIGURED`.

## The website (GET /)

`GET /` serves `frontend/index.html`, so the whole site runs at the base URL above, with no separate frontend hosting. A redeploy of the backend picks up the latest `frontend/index.html`. Only that one file is served; the rest of `frontend/` is not uploaded.

## Dev test page

`GET /dev/record.html` is a bare page for recording from the mic (or picking a file), uploading it with the three-step flow, and transcribing or analysing it. It is for backend testing only, not part of the product.
