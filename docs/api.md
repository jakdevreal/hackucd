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
