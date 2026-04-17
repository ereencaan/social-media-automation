const Jimp = require('jimp');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { downloadImage } = require('../utils/helpers');

/**
 * Apply branding overlay to an image buffer
 */
async function applyImageOverlay(imageBuffer, brand) {
  if (!brand) return imageBuffer;

  const hasLogo = !!brand.logo_url;
  const contactLine = buildContactLine(brand);
  if (!hasLogo && !contactLine) return imageBuffer;

  const image = await Jimp.read(imageBuffer);
  const width = image.getWidth();
  const height = image.getHeight();

  // Logo overlay
  if (hasLogo) {
    try {
      const logoBuffer = await downloadImage(brand.logo_url);
      const logo = await Jimp.read(logoBuffer);
      const logoWidth = Math.round(width * 0.25);
      logo.scaleToFit(logoWidth, logoWidth);

      const margin = 20;
      const padding = 12;
      const pos = brand.overlay_position || 'bottom-right';
      const logoW = logo.getWidth();
      const logoH = logo.getHeight();
      const { x, y } = getLogoPosition(pos, width, height, logoW, logoH, margin);

      // Semi-transparent dark background behind logo
      const logoBg = new Jimp(logoW + padding * 2, logoH + padding * 2, 0x00000088);
      image.composite(logoBg, x - padding, y - padding);
      image.composite(logo, x, y);
    } catch (err) {
      console.error('[Overlay] Logo failed:', err.message);
    }
  }

  // Contact bar overlay
  if (contactLine) {
    const barHeight = 60;
    const font = await Jimp.loadFont(Jimp.FONT_SANS_32_WHITE);

    // Semi-transparent black bar at bottom
    const bar = new Jimp(width, barHeight, 0x000000AA);
    image.composite(bar, 0, height - barHeight);

    // Center text on bar
    const textWidth = Jimp.measureText(font, contactLine);
    const textX = Math.max(0, Math.round((width - textWidth) / 2));
    image.print(font, textX, height - barHeight + 14, contactLine);
  }

  const resultBuffer = await image.getBufferAsync(Jimp.MIME_JPEG);
  return resultBuffer;
}

/**
 * Apply branding overlay to a video (requires FFmpeg)
 */
async function applyVideoOverlay(videoBuffer, brand) {
  if (!brand) return videoBuffer;

  const hasLogo = !!brand.logo_url;
  const contactLine = buildContactLine(brand);
  if (!hasLogo && !contactLine) return videoBuffer;

  const ffmpegAvailable = await checkFFmpeg();
  if (!ffmpegAvailable) {
    console.warn('[Overlay] FFmpeg not found, skipping video overlay');
    return videoBuffer;
  }

  const tmpDir = os.tmpdir();
  const id = crypto.randomUUID();
  const inputPath = path.join(tmpDir, `input_${id}.mp4`);
  const outputPath = path.join(tmpDir, `output_${id}.mp4`);
  const textFilePath = path.join(tmpDir, `text_${id}.txt`);
  const filterFilePath = path.join(tmpDir, `filter_${id}.txt`);
  let logoPath = null;

  try {
    fs.writeFileSync(inputPath, videoBuffer);

    const filters = [];

    if (hasLogo) {
      logoPath = path.join(tmpDir, `logo_${id}.png`);
      const logoBuffer = await downloadImage(brand.logo_url);
      fs.writeFileSync(logoPath, logoBuffer);

      // Get video dimensions to calculate logo size
      const videoInfo = await getVideoDimensions(inputPath);
      const logoHeight = Math.round(videoInfo.height * 0.12);

      const pos = brand.overlay_position || 'bottom-right';
      const overlayPos = getFFmpegPosition(pos);
      // Scale logo to 12% of video height, keep aspect ratio, then overlay
      filters.push(`[1:v]scale=-1:${logoHeight}[logo];[0:v][logo]overlay=${overlayPos}[ov]`);
    }

    if (contactLine) {
      fs.writeFileSync(textFilePath, contactLine.replace(/\|/g, ' - '));
      const lastOutput = hasLogo ? '[ov]' : '[0:v]';
      const fontPath = process.platform === 'win32'
        ? 'C\\:/Windows/Fonts/arial.ttf'
        : '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';
      const textPath = textFilePath.replace(/\\/g, '/').replace(/:/g, '\\:');
      filters.push(
        `${lastOutput}drawtext=fontfile='${fontPath}':textfile='${textPath}':fontsize=24:fontcolor=white:x=(w-text_w)/2:y=h-36:box=1:boxcolor=black@0.65:boxborderw=8[out]`
      );
    }

    const args = ['-y', '-i', inputPath];
    if (logoPath) args.push('-i', logoPath);

    if (filters.length > 0) {
      const lastFilter = filters[filters.length - 1];
      if (!lastFilter.endsWith('[out]')) {
        filters[filters.length - 1] = lastFilter + '[out]';
      }
      fs.writeFileSync(filterFilePath, filters.join(';'));
      args.push('-/filter_complex', filterFilePath, '-map', '[out]', '-map', '0:a?');
    }

    args.push('-c:v', 'libx264', '-preset', 'fast', '-crf', '23', '-c:a', 'copy', outputPath);

    await runFFmpeg(args);
    return fs.readFileSync(outputPath);
  } finally {
    [inputPath, outputPath, logoPath, textFilePath, filterFilePath].forEach(f => {
      if (f && fs.existsSync(f)) fs.unlinkSync(f);
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

function getLogoPosition(position, imgW, imgH, logoW, logoH, margin) {
  const positions = {
    'top-left': { x: margin, y: margin },
    'top-right': { x: imgW - logoW - margin, y: margin },
    'bottom-left': { x: margin, y: imgH - logoH - margin - 65 },
    'bottom-right': { x: imgW - logoW - margin, y: imgH - logoH - margin - 65 }
  };
  return positions[position] || positions['bottom-right'];
}

function getFFmpegPosition(position) {
  const positions = {
    'top-left': '20:20',
    'top-right': 'W-w-20:20',
    'bottom-left': '20:H-h-60',
    'bottom-right': 'W-w-20:H-h-60'
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
