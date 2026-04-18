const Jimp = require('jimp');
const sharp = require('sharp');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { downloadImage } = require('../utils/helpers');

// ---------------------------------------------------------------------------
// Monochrome icon path set (Lucide-style). Each value is the inner <path d="">
// content. viewBox is 24x24. Renders crisp at any overlay size.
// ---------------------------------------------------------------------------
// Each icon is either a Lucide-style stroke icon (clean outline) or a
// brand-logo-style fill icon. We pick whichever reads better in the overlay.
const ICONS = {
  phone: {
    mode: 'stroke',
    paths: [
      'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
    ],
  },
  globe: {
    mode: 'stroke',
    // Lucide "globe" — designed for stroke rendering
    paths: [
      'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z',
      'M2 12h20',
      'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10',
      'M12 2a15.3 15.3 0 0 0-4 10 15.3 15.3 0 0 0 4 10',
    ],
  },
  instagram: {
    mode: 'stroke',
    paths: [
      'M16.5 3h-9A4.5 4.5 0 0 0 3 7.5v9A4.5 4.5 0 0 0 7.5 21h9a4.5 4.5 0 0 0 4.5-4.5v-9A4.5 4.5 0 0 0 16.5 3z',
      'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z',
    ],
    extra: '<circle cx="17.5" cy="6.5" r="1" fill="white"/>',
  },
  whatsapp: {
    mode: 'fill',
    // Simple Icons WhatsApp brand (24x24) — natively fits the viewBox
    paths: [
      'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413Z',
    ],
  },
  facebook: {
    mode: 'fill',
    paths: [
      // Filled "f" in a rounded square — reads clearly at small sizes
      'M22 12a10 10 0 1 0-11.6 9.87v-6.98H7.9V12h2.5V9.8c0-2.47 1.47-3.83 3.72-3.83 1.08 0 2.21.19 2.21.19v2.43h-1.25c-1.23 0-1.61.76-1.61 1.55V12h2.74l-.44 2.89h-2.3v6.98A10 10 0 0 0 22 12z',
    ],
  },
  linkedin: {
    mode: 'fill',
    paths: [
      'M20.45 20.45h-3.55v-5.57c0-1.33-.03-3.04-1.86-3.04-1.86 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.86 3.38-1.86 3.6 0 4.27 2.37 4.27 5.45v6.3zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.55V9h3.57v11.45zM22.22 0H1.77C.79 0 0 .77 0 1.72v20.55C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.72V1.72C24 .77 23.2 0 22.22 0z',
    ],
  },
};

function svgIconInner(name) {
  const icon = ICONS[name];
  if (!icon) return '';
  const common = icon.mode === 'stroke'
    ? 'fill="none" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"'
    : 'fill="white"';
  return icon.paths.map(d => `<path d="${d}" ${common}/>`).join('') + (icon.extra || '');
}

// Escape XML-sensitive chars in user-provided strings
function xe(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Render the bottom contact bar (icons + text) to a PNG buffer sized to
// the target image width. Returns null when there's nothing to draw.
async function renderContactBarPng(brand, width) {
  const items = buildContactItems(brand);
  if (!items.length) return null;

  const barH = Math.max(56, Math.round(width * 0.075));
  const fontSize = Math.round(barH * 0.38);
  const iconSize = Math.round(barH * 0.42);
  const gap     = Math.round(barH * 0.35);   // gap between items
  const iconTextGap = Math.round(barH * 0.18);
  const padX    = Math.round(barH * 0.5);

  // Layout pass: measure approx widths to center the group
  const approxCharPx = fontSize * 0.55; // rough monospace-ish estimate
  const measured = items.map((it) => {
    const textW = Math.ceil(it.text.length * approxCharPx);
    return { ...it, textW, totalW: iconSize + iconTextGap + textW };
  });
  let totalW = measured.reduce((a, it) => a + it.totalW, 0) + gap * (measured.length - 1);

  // If the group is wider than available space, scale it down
  const available = width - padX * 2;
  let scale = 1;
  if (totalW > available) {
    scale = available / totalW;
    totalW = available;
  }

  const startX = Math.round((width - totalW) / 2);
  const yBase  = Math.round(barH * 0.62);

  // Build SVG
  let cursor = startX;
  let groups = '';
  for (const it of measured) {
    const localIcon = Math.round(iconSize * scale);
    const localFont = Math.round(fontSize * scale);
    const localTextW = Math.ceil(it.text.length * (localFont * 0.55));
    const yIcon = yBase;
    const yText = yBase;

    // icon group: SVG uses viewBox-style translate; compute via nested svg
    groups += `<svg x="${cursor}" y="${yIcon - localIcon}" width="${localIcon}" height="${localIcon}" viewBox="0 0 24 24">` +
              svgIconInner(it.icon) + `</svg>`;
    const textX = cursor + localIcon + Math.round(iconTextGap * scale);
    groups += `<text x="${textX}" y="${yText}" font-family="Arial, 'Segoe UI', sans-serif" font-size="${localFont}" fill="white" font-weight="600">${xe(it.text)}</text>`;
    cursor += localIcon + Math.round(iconTextGap * scale) + localTextW + Math.round(gap * scale);
  }

  const svg = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${barH}" viewBox="0 0 ${width} ${barH}">` +
      `<rect x="0" y="0" width="${width}" height="${barH}" fill="black" fill-opacity="0.62"/>` +
      groups +
    `</svg>`;

  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  return { png, height: barH };
}

function buildContactItems(brand) {
  const items = [];
  if (brand.phone)            items.push({ icon: 'phone',     text: brand.phone });
  if (brand.whatsapp)         items.push({ icon: 'whatsapp',  text: brand.whatsapp });
  if (brand.website)          items.push({ icon: 'globe',     text: brand.website });
  if (brand.instagram_handle) items.push({ icon: 'instagram', text: '@' + String(brand.instagram_handle).replace(/^@/, '') });
  if (brand.facebook_handle)  items.push({ icon: 'facebook',  text: brand.facebook_handle });
  if (brand.linkedin_handle)  items.push({ icon: 'linkedin',  text: brand.linkedin_handle });
  return items;
}

/**
 * Apply branding overlay to an image buffer
 */
async function applyImageOverlay(imageBuffer, brand) {
  if (!brand) return imageBuffer;

  const hasLogo = !!brand.logo_url;
  const items = buildContactItems(brand);
  if (!hasLogo && !items.length) return imageBuffer;

  const image = await Jimp.read(imageBuffer);
  const width = image.getWidth();
  const height = image.getHeight();

  // ---- Contact bar with icons (rendered from SVG via sharp) ----
  let barHeight = 0;
  if (items.length) {
    try {
      const rendered = await renderContactBarPng(brand, width);
      if (rendered) {
        const bar = await Jimp.read(rendered.png);
        image.composite(bar, 0, height - rendered.height);
        barHeight = rendered.height;
      }
    } catch (err) {
      console.error('[Overlay] Contact bar failed:', err.message);
    }
  }

  // ---- Logo overlay (placed above the bar when at the bottom) ----
  if (hasLogo) {
    try {
      const logoBuffer = await downloadImage(brand.logo_url);
      const logo = await Jimp.read(logoBuffer);
      const logoWidth = Math.round(width * 0.22);
      logo.scaleToFit(logoWidth, logoWidth);

      const margin = 20;
      const padding = 12;
      const pos = brand.overlay_position || 'bottom-right';
      const logoW = logo.getWidth();
      const logoH = logo.getHeight();
      const { x, y } = getLogoPosition(pos, width, height, logoW, logoH, margin, barHeight);

      // Semi-transparent dark pill behind the logo
      const logoBg = new Jimp(logoW + padding * 2, logoH + padding * 2, 0x00000088);
      image.composite(logoBg, x - padding, y - padding);
      image.composite(logo, x, y);
    } catch (err) {
      console.error('[Overlay] Logo failed:', err.message);
    }
  }

  return image.getBufferAsync(Jimp.MIME_JPEG);
}

/**
 * Apply branding overlay to a video (requires FFmpeg)
 */
async function applyVideoOverlay(videoBuffer, brand) {
  if (!brand) return videoBuffer;

  const hasLogo = !!brand.logo_url;
  const items = buildContactItems(brand);
  if (!hasLogo && !items.length) return videoBuffer;

  const ffmpegAvailable = await checkFFmpeg();
  if (!ffmpegAvailable) {
    console.warn('[Overlay] FFmpeg not found, skipping video overlay');
    return videoBuffer;
  }

  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const inputPath      = path.join(tmpDir, `input_${id}.mp4`);
  const outputPath     = path.join(tmpDir, `output_${id}.mp4`);
  const filterFilePath = path.join(tmpDir, `filter_${id}.txt`);
  let logoPath = null;
  let barPath  = null;

  try {
    fs.writeFileSync(inputPath, videoBuffer);
    const videoInfo = await getVideoDimensions(inputPath);

    const filters = [];
    let lastLabel = '[0:v]';
    let inputIdx = 1; // 0 is the video

    if (hasLogo) {
      logoPath = path.join(tmpDir, `logo_${id}.png`);
      const logoBuffer = await downloadImage(brand.logo_url);
      fs.writeFileSync(logoPath, logoBuffer);

      const logoHeight = Math.round(videoInfo.height * 0.12);
      const pos = brand.overlay_position || 'bottom-right';
      const overlayPos = getFFmpegPosition(pos, items.length > 0);
      filters.push(`[${inputIdx}:v]scale=-1:${logoHeight}[logo];${lastLabel}[logo]overlay=${overlayPos}[ov${inputIdx}]`);
      lastLabel = `[ov${inputIdx}]`;
      inputIdx++;
    }

    if (items.length) {
      // Pre-render the icon bar at the exact video width
      const rendered = await renderContactBarPng(brand, videoInfo.width);
      if (rendered) {
        barPath = path.join(tmpDir, `bar_${id}.png`);
        fs.writeFileSync(barPath, rendered.png);
        filters.push(`${lastLabel}[${inputIdx}:v]overlay=0:H-h[ov${inputIdx}]`);
        lastLabel = `[ov${inputIdx}]`;
        inputIdx++;
      }
    }

    const args = ['-y', '-i', inputPath];
    if (logoPath) args.push('-i', logoPath);
    if (barPath)  args.push('-i', barPath);

    if (filters.length > 0) {
      // Rename the final label to [out] for the -map step
      filters[filters.length - 1] = filters[filters.length - 1]
        .replace(/\[ov\d+\]$/, '[out]');
      fs.writeFileSync(filterFilePath, filters.join(';'));
      args.push('-filter_complex_script', filterFilePath, '-map', '[out]', '-map', '0:a?');
    }

    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'copy', outputPath);

    await runFFmpeg(args);
    return fs.readFileSync(outputPath);
  } finally {
    [inputPath, outputPath, logoPath, barPath, filterFilePath].forEach((f) => {
      if (f && fs.existsSync(f)) {
        try { fs.unlinkSync(f); } catch { /* best effort */ }
      }
    });
  }
}

function buildContactLine(brand) {
  const parts = [];
  if (brand.phone) parts.push(brand.phone);
  if (brand.website) parts.push(brand.website);
  if (brand.whatsapp) parts.push(`WA: ${brand.whatsapp}`);
  if (brand.instagram_handle) parts.push(`@${brand.instagram_handle}`);
  if (brand.facebook_handle) parts.push(`fb/${brand.facebook_handle}`);
  if (brand.linkedin_handle) parts.push(`in/${brand.linkedin_handle}`);
  return parts.join('  |  ');
}

function getLogoPosition(position, imgW, imgH, logoW, logoH, margin, barHeight = 0) {
  const bottomOffset = barHeight + margin;
  const positions = {
    'top-left':     { x: margin, y: margin },
    'top-right':    { x: imgW - logoW - margin, y: margin },
    'bottom-left':  { x: margin, y: imgH - logoH - bottomOffset },
    'bottom-right': { x: imgW - logoW - margin, y: imgH - logoH - bottomOffset },
  };
  return positions[position] || positions['bottom-right'];
}

function getFFmpegPosition(position, liftForBar = false) {
  // When the contact bar is present, the logo must sit above it
  const bottomOffset = liftForBar ? 80 : 20;
  const positions = {
    'top-left':     '20:20',
    'top-right':    'W-w-20:20',
    'bottom-left':  `20:H-h-${bottomOffset}`,
    'bottom-right': `W-w-20:H-h-${bottomOffset}`,
  };
  return positions[position] || positions['bottom-right'];
}

function getVideoDimensions(filePath) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', filePath],
      { timeout: 10000 }, (err, stdout) => {
        if (err) return reject(err);
        const info = JSON.parse(stdout);
        const stream = info.streams[0];
        resolve({ width: stream.width, height: stream.height });
      });
  });
}

function checkFFmpeg() {
  return new Promise(resolve => {
    execFile('ffmpeg', ['-version'], (err) => resolve(!err));
  });
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 120000 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`FFmpeg error: ${stderr || err.message}`));
      else resolve(stdout);
    });
  });
}

module.exports = { applyImageOverlay, applyVideoOverlay };
