// Clip Desk processing backend
// Receives a master video + AI-selected clip timestamps from Lovable,
// cuts each clip with ffmpeg (stream copy, no re-encoding needed since
// files are already 9:16), requests one-time upload links from Lovable,
// uploads the results, and reports back when done.

const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

const app = express();

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
const UPLOAD_URL_ENDPOINT = process.env.LOVABLE_UPLOAD_URL_ENDPOINT;
const CALLBACK_URL = process.env.LOVABLE_CALLBACK_URL;
const PROGRESS_URL = process.env.LOVABLE_PROGRESS_URL;

if (!WEBHOOK_SECRET || !UPLOAD_URL_ENDPOINT || !CALLBACK_URL) {
  console.warn(
    "WARNING: missing required env vars (PROCESSING_WEBHOOK_SECRET, LOVABLE_UPLOAD_URL_ENDPOINT, LOVABLE_CALLBACK_URL). The service will start but jobs will fail until these are set in Render's dashboard."
  );
}

function sign(bodyBuffer) {
  return crypto.createHmac("sha256", WEBHOOK_SECRET).update(bodyBuffer).digest("hex");
}

function verifyIncomingSignature(req) {
  const provided = req.header("x-clipdesk-signature");
  if (!provided || !req.rawBody) return false;
  const expected = sign(req.rawBody);
  const clean = provided.replace(/^sha256=/, "");
  try {
    return crypto.timingSafeEqual(Buffer.from(clean), Buffer.from(expected));
  } catch {
    return false;
  }
}

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

// Note: we no longer download the master file locally. ffmpeg reads it
// directly from its signed URL per-clip (see cutClip below), which keeps
// memory and disk usage small regardless of the master's total size.

async function requestUploadUrls(jobId, userId, files) {
  const body = Buffer.from(JSON.stringify({ job_id: jobId, user_id: userId, files }));
  const res = await fetch(UPLOAD_URL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-clipdesk-signature": sign(body),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to get upload URLs (${res.status}): ${text}`);
  }
  const data = await res.json();
  return data.uploads;
}

async function putFile(uploadUrl, filePath, contentType) {
  const fileBuffer = fs.readFileSync(filePath);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fileBuffer,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed (${res.status}): ${text}`);
  }
}

async function cutClip(masterSource, startSec, durationSec, outPath) {
  // masterSource is now the local, faststart-fixed file (fast, cheap
  // seeking), not the original remote URL.
  await execFileAsync(
    "ffmpeg",
    [
      "-y",
      "-ss",
      String(startSec),
      "-i",
      masterSource,
      "-t",
      String(durationSec),
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      outPath,
    ],
    { maxBuffer: 1024 * 1024 * 20 }
  );
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

async function reportProgress(jobId, completed, total, currentClipTitle, stage) {
  if (!PROGRESS_URL) return; // optional; skip quietly if not configured
  try {
    const body = Buffer.from(
      JSON.stringify({
        job_id: jobId,
        completed,
        total,
        current_clip_title: currentClipTitle || null,
        stage: stage || undefined,
      })
    );
    await fetch(PROGRESS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-clipdesk-signature": sign(body),
      },
      body,
    });
  } catch (err) {
    console.error(`[${jobId}] Progress ping failed:`, err.message);
    // Non-fatal; the job keeps processing either way.
  }
}

async function reportBack(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const res = await fetch(CALLBACK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-clipdesk-signature": sign(body),
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`Callback to Lovable failed (${res.status}): ${text}`);
  }
}

const WORK_ROOT = process.env.WORK_DIR || os.tmpdir();

async function remuxToFaststart(masterUrl, localOutPath) {
  // Many raw recording exports put the file's index (moov atom) at the
  // END of the file instead of the front. That forces ffmpeg to pull far
  // more data than it should just to locate a cut point when reading over
  // HTTP, which is what was crashing this service. Fixing it once, up
  // front, with a plain sequential copy (no seeking) makes every
  // subsequent per-clip cut fast and cheap. This needs a real seekable
  // local file to write to (not a network stream), which is why the
  // attached persistent disk matters here.
  await execFileAsync(
    "ffmpeg",
    ["-y", "-i", masterUrl, "-c", "copy", "-movflags", "+faststart", localOutPath],
    { maxBuffer: 1024 * 1024 * 20 }
  );
}

async function processJob(jobId, userId, masterUrl, clips) {
  const workDir = fs.mkdtempSync(path.join(WORK_ROOT, `job-${jobId}-`));
  const fixedMasterPath = path.join(workDir, "master-fixed.mp4");

  try {
    console.log(`[${jobId}] Fixing master file structure (faststart)...`);
    await reportProgress(jobId, 0, 0, null, "fixing_file");
    await remuxToFaststart(masterUrl, fixedMasterPath);

    const planned = clips.map((clip, i) => {
      const index = String(i + 1).padStart(2, "0");
      const slug = slugify(clip.suggested_title || `clip-${index}`);
      return {
        clip,
        index,
        clipFileName: `${index}-${slug}.mp4`,
        thumbFileName: `${index}-${slug}.jpg`,
      };
    });

    const fileRequests = planned.flatMap((p) => [
      { name: p.clipFileName, kind: "clip" },
      { name: p.thumbFileName, kind: "thumbnail" },
    ]);

    console.log(`[${jobId}] Requesting upload links for ${fileRequests.length} files...`);
    const uploadLinks = await requestUploadUrls(jobId, userId, fileRequests);
    const linkByName = new Map(uploadLinks.map((u) => [u.name, u]));

    // Let Lovable know cutting is about to start, before the first clip
    // finishes, so the UI doesn't sit blank waiting for progress.
    await reportProgress(jobId, 0, planned.length, null, "cutting");

    const results = [];

    for (const p of planned) {
      const { clip, index, clipFileName, thumbFileName } = p;
      const clipLocalPath = path.join(workDir, clipFileName);
      const thumbLocalPath = path.join(workDir, thumbFileName);

      try {
        const startSec = toSeconds(clip.start_timestamp);
        const endSec = toSeconds(clip.end_timestamp);
        const durationSec = Math.max(1, endSec - startSec);

        console.log(`[${jobId}] Cutting clip ${index}: ${clip.start_timestamp} - ${clip.end_timestamp}`);
        await cutClip(fixedMasterPath, startSec, durationSec, clipLocalPath);
        await makeThumbnail(clipLocalPath, thumbLocalPath);

        const clipLink = linkByName.get(clipFileName);
        const thumbLink = linkByName.get(thumbFileName);
        if (!clipLink || !thumbLink) throw new Error("Missing upload link for this clip");

        await putFile(clipLink.upload_url, clipLocalPath, "video/mp4");
        await putFile(thumbLink.upload_url, thumbLocalPath, "image/jpeg");

        const stats = fs.statSync(clipLocalPath);

        results.push({
          storage_path: clipLink.storage_path,
          thumbnail_path: thumbLink.storage_path,
          public_url: clipLink.public_url,
          duration_seconds: durationSec,
          size_bytes: stats.size,
          title: clip.suggested_title || null,
          start_timestamp: clip.start_timestamp,
          end_timestamp: clip.end_timestamp,
          hook_line: clip.hook_line || null,
          moment_types: clip.moment_types || [],
        });

        await reportProgress(jobId, results.length, planned.length, clip.suggested_title, "cutting");
      } catch (clipErr) {
        console.error(`[${jobId}] Clip ${index} failed:`, clipErr.message);
        await reportProgress(jobId, results.length, planned.length, clip.suggested_title, "cutting");
      } finally {
        [clipLocalPath, thumbLocalPath].forEach((p2) => {
          if (fs.existsSync(p2)) fs.unlinkSync(p2);
        });
      }
    }

    console.log(`[${jobId}] Done. ${results.length}/${clips.length} clips succeeded.`);
    await reportProgress(jobId, results.length, planned.length, null, "finalizing");
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
  if (!verifyIncomingSignature(req)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  // Lovable sends the clip selections under "clip_plan" (not "clips");
  // accept both names in case that ever changes.
  const { job_id, user_id, master_url } = req.body || {};
  const clips = req.body?.clip_plan || req.body?.clips;
  if (!job_id || !user_id || !master_url || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "Missing job_id, user_id, master_url, or clip_plan" });
  }

  res.status(202).json({ received: true, job_id });
  processJob(job_id, user_id, master_url, clips).catch((err) => {
    console.error(`[${job_id}] Unhandled error:`, err);
  });
});

app.listen(PORT, () => {
  console.log(`Clip Desk backend listening on port ${PORT}`);
});
