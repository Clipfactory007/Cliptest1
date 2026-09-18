// Clip Desk processing backend
// Receives a master video + AI-selected clip timestamps from Lovable,
// cuts each clip with ffmpeg (stream copy, no re-encoding needed since
// files are already 9:16), uploads the results to Supabase Storage,
// and reports back to Lovable's callback endpoint.

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const app = express();

// We need the raw request body to verify the HMAC signature, so capture
// it before JSON parsing.
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

const PORT = process.env.PORT || 3000;
const WEBHOOK_SECRET = process.env.PROCESSING_WEBHOOK_SECRET;
const CALLBACK_URL = process.env.LOVABLE_CALLBACK_URL;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!WEBHOOK_SECRET || !CALLBACK_URL || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.warn(
    "WARNING: one or more required env vars are missing (PROCESSING_WEBHOOK_SECRET, LOVABLE_CALLBACK_URL, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY). The service will start but jobs will fail until these are set in Render's dashboard."
  );
}

function sign(bodyBuffer) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(bodyBuffer).digest("hex");
}

function verifySignature(req) {
  const provided = req.header("X-Signature");
  if (!provided || !req.rawBody) return false;
  const expected = sign(req.rawBody);
  try {
    return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
  } catch {
    return false;
  }
}

// Convert "MM:SS" or "HH:MM:SS" to seconds
function toSeconds(ts) {
  const parts = ts.split(":").map(Number);
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  throw new Error(`Bad timestamp: ${ts}`);
}

function slugify(text) {
  return (text || "clip")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 60);
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download master file: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

async function uploadToSupabase(bucket, storagePath, filePath, contentType) {
  const fileBuffer = fs.readFileSync(filePath);
  const uploadUrl = `${SUPABASE_URL}/storage/v1/object/${bucket}/${storagePath}`;
  const res = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      "Content-Type": contentType,
      "x-upsert": "true",
    },
    body: fileBuffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase upload failed (${res.status}): ${text}`);
  }
  return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${storagePath}`;
}

async function cutClip(masterPath, startSec, durationSec, outPath) {
  // Stream copy: fast, no quality loss, no heavy CPU/RAM use.
  // -ss before -i for fast seeking; fine for social clips where a
  // sub-second snap to the nearest keyframe is not noticeable.
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    String(startSec),
    "-i",
    masterPath,
    "-t",
    String(durationSec),
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    outPath,
  ]);
}

async function makeThumbnail(clipPath, outPath) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-ss",
    "1",
    "-i",
    clipPath,
    "-frames:v",
    "1",
    "-q:v",
    "3",
    outPath,
  ]);
}

async function reportBack(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const signature = sign(body);
  const res = await fetch(CALLBACK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Signature": signature,
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Callback to Lovable failed (${res.status}): ${text}`);
  }
}

async function processJob(jobId, userId, masterUrl, clips) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `job-${jobId}-`));
  const masterPath = path.join(workDir, "master.mp4");

  try {
    console.log(`[${jobId}] Downloading master file...`);
    await downloadFile(masterUrl, masterPath);

    const results = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const index = String(i + 1).padStart(2, "0");
      const slug = slugify(clip.suggested_title || `clip-${index}`);
      const clipFileName = `${index}-${slug}.mp4`;
      const thumbFileName = `${index}-${slug}.jpg`;
      const clipLocalPath = path.join(workDir, clipFileName);
      const thumbLocalPath = path.join(workDir, thumbFileName);

      try {
        const startSec = toSeconds(clip.start_timestamp);
        const endSec = toSeconds(clip.end_timestamp);
        const durationSec = Math.max(1, endSec - startSec);

        console.log(`[${jobId}] Cutting clip ${index}: ${clip.start_timestamp} - ${clip.end_timestamp}`);
        await cutClip(masterPath, startSec, durationSec, clipLocalPath);
        await makeThumbnail(clipLocalPath, thumbLocalPath);

        const storagePath = `${userId}/${jobId}/${clipFileName}`;
        const thumbStoragePath = `${userId}/${jobId}/thumbs/${thumbFileName}`;

        const publicUrl = await uploadToSupabase("clips", storagePath, clipLocalPath, "video/mp4");
        await uploadToSupabase("clips", thumbStoragePath, thumbLocalPath, "image/jpeg");

        const stats = fs.statSync(clipLocalPath);

        results.push({
          storage_path: storagePath,
          thumbnail_path: thumbStoragePath,
          public_url: publicUrl,
          duration_seconds: durationSec,
          size_bytes: stats.size,
          title: clip.suggested_title || null,
          start_timestamp: clip.start_timestamp,
          end_timestamp: clip.end_timestamp,
          hook_line: clip.hook_line || null,
          moment_types: clip.moment_types || [],
        });
      } catch (clipErr) {
        console.error(`[${jobId}] Clip ${index} failed:`, clipErr.message);
        // Continue with remaining clips even if one fails
      } finally {
        [clipLocalPath, thumbLocalPath].forEach((p) => {
          if (fs.existsSync(p)) fs.unlinkSync(p);
        });
      }
    }

    console.log(`[${jobId}] Done. ${results.length}/${clips.length} clips succeeded.`);
    await reportBack({ job_id: jobId, status: results.length > 0 ? "complete" : "failed", clips: results });
  } catch (err) {
    console.error(`[${jobId}] Job failed:`, err.message);
    await reportBack({ job_id: jobId, status: "failed", error_message: err.message });
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/process", (req, res) => {
  if (!verifySignature(req)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { job_id, user_id, master_url, clips } = req.body || {};
  if (!job_id || !user_id || !master_url || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "Missing job_id, user_id, master_url, or clips" });
  }

  // Acknowledge immediately, process in the background.
  res.status(202).json({ received: true, job_id });
  processJob(job_id, user_id, master_url, clips).catch((err) => {
    console.error(`[${job_id}] Unhandled error:`, err);
  });
});

app.listen(PORT, () => {
  console.log(`Clip Desk backend listening on port ${PORT}`);
});
