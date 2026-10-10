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

Use it both for in-browser recordings and for audio files the user picks from their device.

Accepted formats: **webm** (Chrome/Firefox recordings), **ogg**, **m4a** (Safari recordings, phone voice memos), **mp3**, **wav**. Max size: 25 MB. Video files are rejected.

The server checks the file's actual contents, not the type the browser reports, so files with a blank or wrong type (common on phones) still work, and non-audio files renamed to `.mp3` are rejected. The `contentType` in the response is the detected format (`audio/webm`, `audio/ogg`, `audio/mp4`, `audio/mpeg` or `audio/wav`).

For a file picker, `<input type="file" accept="audio/*">` is enough.

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
| 415 | `UNSUPPORTED_FORMAT` | Video file, or contents are not one of the formats above |
| 502 | `STORAGE_FAILED` | Cloud Storage write failed; safe to retry |

## Dev test page

`GET /dev/record.html` is a bare page for recording from the mic (or picking a file) and uploading it. It is for backend testing only, not part of the product.
