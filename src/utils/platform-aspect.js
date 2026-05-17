// Aspect-ratio routing for the per-platform render pass.
//
// Different social platforms want different image proportions. Until now we
// rendered one image at platforms[0]'s size and used it everywhere, which
// looked terrible when a single post targeted (say) Instagram + TikTok at
// once — the IG square got vertically letterboxed on TikTok, or the TikTok
// vertical got crammed into a square.
//
// We now render one image per distinct aspect group (max 3: square,
// landscape, vertical) and stash the resulting URLs in posts.image_variants
// as JSON. Publishers call getMediaUrlFor() to pick the right one.

const ASPECT_OF = {
  instagram:      'square',
  facebook:       'landscape',
  linkedin:       'landscape',
  tiktok:         'vertical',
  youtube_shorts: 'vertical',
};

// Representative platform for each aspect — used as the cache key into
// flux/openai/templated SIZES maps. Picking instagram for square (1024×1024),
// linkedin for landscape (1024×768), and tiktok for vertical (1080×1920)
// matches the canonical native sizes for each shape.
const REP_PLATFORM = {
  square:    'instagram',
  landscape: 'linkedin',
  vertical:  'tiktok',
};

/** Convert a platform name to its aspect group. Defaults to 'square'. */
function aspectOf(platform) {
  return ASPECT_OF[platform] || 'square';
}

/** Distinct aspect groups for a list of platforms, in first-seen order. */
function distinctAspects(platforms = []) {
  const seen = new Set();
  const out = [];
  for (const p of platforms) {
    const a = aspectOf(p);
    if (!seen.has(a)) { seen.add(a); out.push(a); }
  }
  return out.length ? out : ['square'];
}

/** The platform name we feed image generators when we want a given aspect. */
function repPlatformFor(aspect) {
  return REP_PLATFORM[aspect] || REP_PLATFORM.square;
}

/**
 * Pick the right rendered URL for a publisher.
 *
 * Priority:
 *   1. The aspect-matched variant from posts.image_variants
 *   2. drive_url (single-render legacy / video posts)
 *   3. image_url (raw provider URL, last-resort)
 *
 * Video posts have a single drive_url which is already platform-aware
 * (we pick the platform when /generate-video runs), so this helper
 * returns drive_url unchanged for them — image_variants is null on
 * video posts.
 */
function getMediaUrlFor(post, platform) {
  if (!post) return null;
  if (post.image_variants) {
    let variants;
    try { variants = JSON.parse(post.image_variants); } catch { variants = null; }
    if (variants && typeof variants === 'object') {
      const aspect = aspectOf(platform);
      if (variants[aspect]) return variants[aspect];
    }
  }
  return post.drive_url || post.image_url || null;
}

module.exports = {
  ASPECT_OF,
  REP_PLATFORM,
  aspectOf,
  distinctAspects,
  repPlatformFor,
  getMediaUrlFor,
};
