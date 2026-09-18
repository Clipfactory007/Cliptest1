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

async function downloadFile(url, destPath) {
  // Stream directly to disk instead of buffering the whole file in memory.
  // Render's free tier has only 512MB RAM, but master files can be 2-4GB,
  // so loading the full response into memory first would crash the service.
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Failed to download master file: ${res.status}`);
  const fileStream = fs.createWriteStream(destPath);
  await new Promise((resolve, reject) => {
    const { Readable } = require("stream");
    const nodeStream = Readable.fromWeb(res.body);
    nodeStream.pipe(fileStream);
    nodeStream.on("error", reject);
    fileStream.on("error", reject);
    fileStream.on("finish", resolve);
  });
}

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

async function cutClip(masterPath, startSec, durationSec, outPath) {
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

async function processJob(jobId, userId, masterUrl, clips) {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), `job-${jobId}-`));
  const masterPath = path.join(workDir, "master.mp4");

  try {
    console.log(`[${jobId}] Downloading master file...`);
    await downloadFile(masterUrl, masterPath);

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
        await cutClip(masterPath, startSec, durationSec, clipLocalPath);
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
      } catch (clipErr) {
        console.error(`[${jobId}] Clip ${index} failed:`, clipErr.message);
      } finally {
        [clipLocalPath, thumbLocalPath].forEach((p2) => {
          if (fs.existsSync(p2)) fs.unlinkSync(p2);
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
  if (!verifyIncomingSignature(req)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const { job_id, user_id, master_url, clips } = req.body || {};
  if (!job_id || !user_id || !master_url || !Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: "Missing job_id, user_id, master_url, or clips" });
  }

  res.status(202).json({ received: true, job_id });
  processJob(job_id, user_id, master_url, clips).catch((err) => {
    console.error(`[${job_id}] Unhandled error:`, err);
  });
});

app.listen(PORT, () => {
  console.log(`Clip Desk backend listening on port ${PORT}`);
});
