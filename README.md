# Clip Desk Backend

Cuts clips from a master video using ffmpeg (stream copy, no re-encoding)
and uploads them to Supabase Storage. Triggered by Lovable, reports back
to Lovable when done.

## Required environment variables (set these in Render)

- `PROCESSING_WEBHOOK_SECRET` — shared secret used to sign/verify requests
  in both directions. Must match the same value set in Lovable's secrets.
- `LOVABLE_CALLBACK_URL` — the full URL of Lovable's callback endpoint
  (e.g. `https://your-app.lovable.app/api/public/processing/callback`).
- `SUPABASE_URL` — your Supabase project URL.
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key (has permission
  to write to the `clips` storage bucket).

## API contract

### Incoming: POST /process

Lovable calls this when a master file + transcript are ready.

Headers:
- `X-Signature`: hex HMAC-SHA256 of the raw request body, signed with
  `PROCESSING_WEBHOOK_SECRET`.

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

### Outgoing: POST to LOVABLE_CALLBACK_URL

When done (or failed), this service calls Lovable back.

Headers:
- `X-Signature`: same HMAC scheme as above.

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
