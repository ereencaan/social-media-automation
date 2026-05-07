// Multi-clip reel composer (P5).
//
// Runway gen4.5 maxes out at 5–10 second clips per call. To get a 15s,
// 30s, or 60s reel we:
//   1. Ask Claude to break the brief into N short scene descriptions
//      that flow together visually (storyboard).
//   2. Generate each scene as a 5-second Runway clip in parallel.
//   3. Stitch the clips with ffmpeg using xfade crossfade transitions
//      so the joins are smooth instead of hard cuts.
//   4. Return the final mp4 as a Buffer for the caller (posts route)
//      to pass through its existing brand-overlay + Cloudinary upload
//      pass.
//
// Cost note: each 5s clip costs ~$0.40 (Runway gen4.5 ≈ $0.08/s). A
// 60s reel is therefore ~12 × $0.40 = $4.80 in Runway alone, plus the
// Claude storyboard call (~$0.01) and the Cloudinary bandwidth for
// the upload. Plan-tier gating in plans.js keeps Starter / Free out
// of this path entirely; Pro caps at 30s, Agency at 60s.
//
// Crossfade math: each xfade overlaps two adjacent 5s clips by 0.5s.
// For N clips and (N-1) xfades, final duration ≈ N*5 - (N-1)*0.5.
// 12 clips → 54.5s, 7 clips → 32s, 4 clips → 18.5s. Slightly short of
// the round-number target durations but a smooth-cut reel reads as
// "this is a real video", which is the point of P5.
//
// Implementation note: we shell out to ffmpeg via child_process rather
// than pulling in fluent-ffmpeg, because the binary is already on the
// VM (apt installed) and the filter_complex we need is generated as a
// string anyway — fluent-ffmpeg's API would just wrap that.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const RUNWAY_CLIP_SECONDS = 5;          // gen4.5's natural unit
const XFADE_SECONDS       = 0.5;        // smoothness vs. duration tradeoff
const FFMPEG_BIN          = process.env.FFMPEG_BIN || 'ffmpeg';

// ---- Storyboard via Claude --------------------------------------------------

const { getClient: getAnthropic } = require('./claude.service'); // eslint-disable-line

/**
 * Break a brief into N scene prompts that flow together. Each scene is
 * 5 seconds (the Runway unit), so the operator-facing duration target
 * is met by ceil(target / RUNWAY_CLIP_SECONDS) clips.
 *
 * Returned shape: { scenes: [{ description }, ...] }
 *
 * The Claude prompt forbids brand names / readable text in the scene —
 * the Runway service strips brand tokens defensively too, but stopping
 * Claude from generating them in the first place avoids wasted clips
 * that would later have to be re-rendered with cleaner prompts.
 */
async function storyboard({ brief, targetSeconds, platform = 'instagram', brand = null }) {
  const sceneCount = Math.max(2, Math.ceil(targetSeconds / RUNWAY_CLIP_SECONDS));

  const Anthropic = require('@anthropic-ai/sdk').Anthropic;
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Tight system prompt — multi-line YAML-ish would be cleaner but Claude
  // returns more reliably from a plain numbered structure.
  const brandLine = brand && brand.business_name
    ? `The video is for ${brand.business_name}${brand.industry ? ` (${brand.industry})` : ''}.`
    : '';
  const audienceLine = brand && brand.target_audience
    ? `Target audience: ${brand.target_audience}.`
    : '';
  const toneLine = brand && brand.tone_of_voice
    ? `Tone: ${brand.tone_of_voice}.`
    : '';

  const sys = `You are a video storyboard director. Output strict JSON only.
The user gives you a brief and a target reel length. You break it into
exactly ${sceneCount} sequential ${RUNWAY_CLIP_SECONDS}-second scenes that
tell one continuous visual story. Each scene description is 1–2
sentences, photorealistic, cinematic, vertical 9:16 framing.

CRITICAL constraints, in order of priority:
- ABSOLUTELY NO text, signs, logos, watermarks, or readable screen
  content in any scene. The brand logo is added as a separate overlay
  pass after rendering — your scenes must be visually clean.
- NO people unless the brief explicitly asks for them.
- Scenes flow into each other (consistent palette, similar camera
  motion, related subject matter) so the final cut feels like one
  continuous shot rather than a disconnected slideshow.
- Each scene is self-contained but visually similar to its neighbours.

Output JSON exactly: {"scenes": [{"description": "..."}, ...]}`;

  const user = `Brief: ${brief}
Reel length target: ~${targetSeconds} seconds (${sceneCount} scenes × ${RUNWAY_CLIP_SECONDS}s)
Platform: ${platform}
${brandLine}
${audienceLine}
${toneLine}`.trim();

  const res = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1500,
    system: sys,
    messages: [{ role: 'user', content: user }],
  });
  const text = (res.content && res.content[0] && res.content[0].text) || '';
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); }
  catch (e) {
    throw new Error(`Storyboard JSON parse failed: ${e.message}\nGot: ${cleaned.slice(0, 200)}`);
  }
  if (!parsed.scenes || !Array.isArray(parsed.scenes) || !parsed.scenes.length) {
    throw new Error('Storyboard returned no scenes');
  }
  // Trim to exactly the requested count — Claude occasionally returns
  // one extra to be safe.
  return parsed.scenes.slice(0, sceneCount).map((s) => ({
    description: String((s && s.description) || '').trim(),
  }));
}

// ---- Parallel Runway clip generation ----------------------------------------

const { generateVideo } = require('./runway.service');

/**
 * Kick off one Runway request per scene in parallel and download each
 * clip into a temp file. We can't ffmpeg-concat from URLs — the binary
 * needs local files for the filter_complex chain. Returns the array
 * of temp file paths in scene order.
 */
async function renderClips({ scenes, platform, tmpDir }) {
  fs.mkdirSync(tmpDir, { recursive: true });
  // Promise.all on text_to_video — each call returns when Runway finishes
  // rendering. Cap concurrency at 4 to keep API queue pressure in check;
  // beyond 4 simultaneous gen4.5 jobs Runway has been observed to throttle.
  const results = await runWithConcurrency(scenes, 4, async (scene, idx) => {
    const video = await generateVideo(scene.description, platform, RUNWAY_CLIP_SECONDS);
    if (!video || !video.url) throw new Error(`Runway returned no URL for scene ${idx + 1}`);
    const localPath = path.join(tmpDir, `scene_${String(idx + 1).padStart(2, '0')}.mp4`);
    await downloadToFile(video.url, localPath);
    return { idx, scene, path: localPath, runwayUrl: video.url };
  });
  return results.sort((a, b) => a.idx - b.idx);
}

async function runWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

function downloadToFile(url, dest) {
  return new Promise((resolve, reject) => {
    fetch(url).then((res) => {
      if (!res.ok) return reject(new Error(`Clip download ${res.status}: ${url}`));
      const out = fs.createWriteStream(dest);
      // res.body is a web ReadableStream in Node 18+. Pipe via Readable.fromWeb.
      const { Readable } = require('stream');
      Readable.fromWeb(res.body).pipe(out);
      out.on('finish', resolve);
      out.on('error', reject);
    }).catch(reject);
  });
}

// ---- ffmpeg crossfade concat -----------------------------------------------

/**
 * Build a filter_complex string that crossfades N input videos with a
 * fixed XFADE_SECONDS overlap and concatenates them into one stream.
 *
 * For 4 clips with offsets:
 *   [0:v][1:v]xfade=transition=fade:duration=0.5:offset=4.5[v01];
 *   [v01][2:v]xfade=transition=fade:duration=0.5:offset=9.0[v02];
 *   [v02][3:v]xfade=transition=fade:duration=0.5:offset=13.5[vout]
 *
 * Each subsequent xfade offset = previous_total_duration - XFADE_SECONDS,
 * because xfade's `offset` is "how many seconds into the FIRST input the
 * transition should start" and the running stream's duration grows by
 * (clip - XFADE_SECONDS) each step.
 */
function buildXfadeFilter(clipCount) {
  if (clipCount === 1) return null;
  const parts = [];
  let runningDur = RUNWAY_CLIP_SECONDS;     // length of the first clip alone
  let prevLabel = '0:v';
  for (let i = 1; i < clipCount; i++) {
    const offset = (runningDur - XFADE_SECONDS).toFixed(3);
    const outLabel = (i === clipCount - 1) ? 'vout' : `v0${i}`;
    parts.push(`[${prevLabel}][${i}:v]xfade=transition=fade:duration=${XFADE_SECONDS}:offset=${offset}[${outLabel}]`);
    prevLabel = outLabel;
    runningDur += RUNWAY_CLIP_SECONDS - XFADE_SECONDS;
  }
  return parts.join(';');
}

/**
 * Spawn ffmpeg, wait for exit, return the output path. Streams stderr
 * back through the parent process so any "no such filter" / codec
 * errors surface in the journalctl log instead of a silent black mp4.
 */
function runFfmpeg(args, label = 'ffmpeg') {
  return new Promise((resolve, reject) => {
    const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stderrChunks = [];
    proc.stderr.on('data', (d) => stderrChunks.push(d));
    proc.on('error', (err) => reject(new Error(`${label} spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = Buffer.concat(stderrChunks).toString('utf8').slice(-1500);
      reject(new Error(`${label} exit code ${code}\n${tail}`));
    });
  });
}

async function concatClips({ clipPaths, tmpDir }) {
  const out = path.join(tmpDir, 'composed.mp4');
  if (clipPaths.length === 1) {
    // Single clip: re-encode would just lose quality, copy through.
    await runFfmpeg(['-y', '-i', clipPaths[0], '-c', 'copy', out], 'ffmpeg-copy');
    return out;
  }
  const inputs = clipPaths.flatMap((p) => ['-i', p]);
  const filter = buildXfadeFilter(clipPaths.length);
  // Re-encode is required for xfade — the filter graph mutates the video
  // stream so `-c copy` won't apply. libx264 with veryfast keeps the
  // pass under a minute even for 12-clip reels. We don't include audio
  // (-an) because Runway clips are silent and a separate audio bed is
  // outside scope for this commit.
  await runFfmpeg([
    '-y',
    ...inputs,
    '-filter_complex', filter,
    '-map', '[vout]',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-an',
    out,
  ], 'ffmpeg-xfade');
  return out;
}

// ---- High-level entry point -------------------------------------------------

/**
 * Compose a multi-clip reel from a single brief.
 *
 * @param {object} opts
 * @param {string} opts.brief         User prompt / topic
 * @param {number} opts.durationSeconds  Target reel length (5, 10, 15, 30, 60)
 * @param {string} [opts.platform='instagram']
 * @param {object} [opts.brand]       brand_settings row for tone/audience context
 *
 * @returns {Promise<{ buffer: Buffer, scenes: Array, durationSeconds: number }>}
 *   `buffer`        — the final mp4 ready for Cloudinary upload + brand overlay
 *   `scenes`        — the storyboard (for diagnostics / activity log)
 *   `durationSeconds` — actual duration of the composed reel (slightly
 *                       under the target due to xfade overlaps)
 */
async function composeReel({ brief, durationSeconds, platform = 'instagram', brand = null }) {
  if (!brief) throw new Error('brief required');
  if (!durationSeconds || durationSeconds < RUNWAY_CLIP_SECONDS) {
    throw new Error(`durationSeconds must be ≥${RUNWAY_CLIP_SECONDS}`);
  }

  const tmpDir = path.join(os.tmpdir(), `hitrapost-reel-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    const scenes = await storyboard({ brief, targetSeconds: durationSeconds, platform, brand });
    const clips  = await renderClips({ scenes, platform, tmpDir });
    const finalPath = await concatClips({ clipPaths: clips.map((c) => c.path), tmpDir });
    const buffer = fs.readFileSync(finalPath);

    // Effective duration after crossfade overlaps.
    const actual = clips.length === 1
      ? RUNWAY_CLIP_SECONDS
      : clips.length * RUNWAY_CLIP_SECONDS - (clips.length - 1) * XFADE_SECONDS;

    return { buffer, scenes, durationSeconds: actual, clipCount: clips.length };
  } finally {
    // Best-effort cleanup. We don't await rmSync because in some
    // environments (Oracle VM with slow disk) the unlink can take
    // seconds and we don't want to delay the response on it.
    setImmediate(() => {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) { /* ignored */ }
    });
  }
}

module.exports = {
  composeReel,
  // exported for tests
  buildXfadeFilter,
  RUNWAY_CLIP_SECONDS,
  XFADE_SECONDS,
};
