# API

Base URL (local): `http://localhost:8080`. On Cloud Run the port comes from the `PORT` environment variable.

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

## POST /api/recordings

Uploads one audio recording and saves it to Cloud Storage. Send it as `multipart/form-data` with the file in the field **`audio`**.

Accepted formats: `audio/webm` (Chrome/Firefox recordings), `audio/ogg`, `audio/mp4` / `audio/x-m4a` (Safari recordings), `audio/mpeg` (mp3), `audio/wav`. A codecs suffix such as `audio/webm;codecs=opus` is fine. Max size: 25 MB.

Recording in the browser with `MediaRecorder`:

```js
const form = new FormData();
form.append('audio', blob, 'recording.webm'); // blob from MediaRecorder chunks
const res = await fetch(`${API_URL}/api/recordings`, { method: 'POST', body: form });
const data = await res.json(); // on error: data.error.message is safe to show the user
```

Do not set the `Content-Type` header yourself; the browser adds the multipart boundary.

**Response 201**

```json
{
  "id": "6c0089fd-ea31-4083-a2de-62e14fe66cc8",
  "objectPath": "recordings/6c0089fd-ea31-4083-a2de-62e14fe66cc8.wav",
  "contentType": "audio/wav",
  "sizeBytes": 32044,
  "createdAt": "2026-10-10T09:44:55.421Z"
}
```

Keep `id`: later endpoints (analysis) will take it.

**Errors**

| Status | `code` | When |
| --- | --- | --- |
| 400 | `MISSING_FILE` | No file in field `audio` |
| 400 | `EMPTY_FILE` | File is 0 bytes |
| 400 | `BAD_UPLOAD` | Wrong field name or more than one file |
| 413 | `FILE_TOO_LARGE` | Over 25 MB |
| 415 | `UNSUPPORTED_FORMAT` | Not one of the formats above |
| 502 | `STORAGE_FAILED` | Cloud Storage write failed; safe to retry |

## Dev test page

`GET /dev/record.html` is a bare page for recording from the mic (or picking a file) and uploading it. It is for backend testing only, not part of the product.
