# Clip Desk Backend

Cuts clips from a master video using ffmpeg (stream copy, no re-encoding)
and uploads them via one-time signed links issued by Lovable. Triggered
by Lovable, reports back to Lovable when done.

## Required environment variables (set these in Render)

- `PROCESSING_WEBHOOK_SECRET` — shared secret used to sign/verify requests
  in both directions. Must match the same value set in Lovable's secrets.
- `LOVABLE_UPLOAD_URL_ENDPOINT` — full URL of Lovable's upload-link
  endpoint (e.g. `https://your-app.lovable.app/api/public/processing/upload-url`).
- `LOVABLE_CALLBACK_URL` — full URL of Lovable's results callback endpoint
  (e.g. `https://your-app.lovable.app/api/public/processing/callback`).

## API contract

### Incoming: POST /process

Lovable calls this when a master file + transcript are ready.

Headers:
- `x-clipdesk-signature`: lowercase hex HMAC-SHA256 of the raw request
  body, signed with `PROCESSING_WEBHOOK_SECRET`.

Body:
```json
{
  "job_id": "uuid",
  "user_id": "uuid",
  "master_url": "https://... (signed URL, valid ~24h)",
  "clips": [
    {
      "start_timestamp": "MM:SS",
      "end_timestamp": "MM:SS",
      "suggested_title": "short title",
      "hook_line": "exact words spoken",
      "moment_types": ["contrarian", "numbers"]
    }
  ]
}
```

Responds `202` immediately, then processes in the background.

### Outgoing: POST to LOVABLE_UPLOAD_URL_ENDPOINT

Before uploading, this service requests one-time upload links for every
clip and thumbnail file in a single batched call.

Body:
```json
{
  "job_id": "uuid",
  "user_id": "uuid",
  "files": [
    { "name": "01-clip-title.mp4", "kind": "clip" },
    { "name": "01-clip-title.jpg", "kind": "thumbnail" }
  ]
}
```

Response includes an `upload_url` (PUT the file here directly, no auth
header needed) and a `public_url` per file.

### Outgoing: POST to LOVABLE_CALLBACK_URL

When done (or failed), this service calls Lovable back.

Headers:
- `x-clipdesk-signature`: same HMAC scheme as above.

Body (success):
```json
{
  "job_id": "uuid",
  "status": "complete",
  "clips": [
    {
      "storage_path": "userid/jobid/01-title.mp4",
      "thumbnail_path": "userid/jobid/thumbs/01-title.jpg",
      "public_url": "https://.../storage/v1/object/public/clips/...",
      "duration_seconds": 32,
      "size_bytes": 45000000,
      "title": "short title",
      "start_timestamp": "MM:SS",
      "end_timestamp": "MM:SS",
      "hook_line": "exact words spoken",
      "moment_types": ["contrarian", "numbers"]
    }
  ]
}
```

Body (failure):
```json
{ "job_id": "uuid", "status": "failed", "error_message": "..." }
```
