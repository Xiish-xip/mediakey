// server.js
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { createReadStream, unlink } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { randomBytes } = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

app.use(express.static('public'));
app.use(cors());

app.get('/', (req, res) => {
  res.redirect('/index.html');
});

function isSupportedPlatform(url) {
  const supported = [
    'tiktok.com',
    'instagram.com',
    'twitter.com',
    'x.com',
    'facebook.com',
    'fb.watch',
    'twitch.tv',
    'kick.com',
    'reddit.com',
    'vm.tiktok.com',
    'vt.tiktok.com',
    'snapchat.com',
    'story.snapchat.com'
  ];
  return supported.some(domain => url.includes(domain));
}

function isYouTube(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
}

// Sanitize filename (remove unsafe chars)
function sanitizeFilename(title) {
  return title
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .substring(0, 100)
    .trim();
}

app.get('/api/info', (req, res) => {
  const url = req.query.url;
  const mode = (req.query.mode || 'mp4').toLowerCase();

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (isYouTube(url)) {
    return res.status(400).json({ 
      error: 'YouTube is temporarily unavailable. Please try TikTok, Instagram, X, Facebook, Twitch, Kick, Reddit, or Snapchat.' 
    });
  }

  if (!isSupportedPlatform(url)) {
    return res.status(400).json({ 
      error: 'Unsupported platform. Supported: TikTok, Instagram, X, Facebook, Twitch, Kick, Reddit, Snapchat.' 
    });
  }

  // Build args with platform-specific fixes
  const args = ['--dump-json', '--no-warnings'];

  // Instagram fix
  if (url.includes('instagram.com')) {
    args.push('--extractor-args', 'instagram:player_client=web');
  }

  // Facebook fix
  if (url.includes('facebook.com') || url.includes('fb.watch')) {
    args.push('--extractor-args', 'facebook:player_client=web');
  }

  if (mode === 'mp3') {
    args.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
  }

  args.push(url);

  const ytDlp = spawn('yt-dlp', args);
  let output = '';
  let errorOutput = '';

  ytDlp.stdout.on('data', (data) => output += data.toString());
  ytDlp.stderr.on('data', (data) => errorOutput += data.toString());

  ytDlp.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp stderr:', errorOutput);
      let msg = 'Failed to analyze link. Make sure it’s a public post.';
      if (errorOutput.includes('Private') || errorOutput.includes('private')) {
        msg = 'This post is private or unavailable.';
      }
      if (errorOutput.includes('HTTP Error 404')) {
        msg = 'Video not found. Link may be broken or deleted.';
      }
      if (url.includes('instagram.com') && errorOutput.includes('Login required')) {
        msg = 'Instagram requires login for this post. Only public posts work.';
      }
      return res.status(500).json({ error: msg });
    }

    try {
      const info = JSON.parse(output);
      let formats = [];

      if (mode === 'mp3') {
        formats = [{ format_id: 'bestaudio', ext: 'mp3', resolution: 'Audio only', filesize: info.filesize_approx || info.filesize }];
      } else {
        formats = (info.formats || [])
          .filter(f => {
            // Prioritize MP4 with H.264 + AAC
            return f.ext === 'mp4' && f.vcodec?.startsWith('avc') && f.acodec !== 'none';
          })
          .map(f => ({
            format_id: f.format_id,
            ext: f.ext,
            resolution: f.resolution || f.format_note || 'Unknown',
            filesize: f.filesize || f.filesize_approx
          }))
          .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

        // Fallback if no MP4
        if (formats.length === 0) {
          formats = (info.formats || [])
            .filter(f => (f.vcodec !== 'none' && f.acodec !== 'none'))
            .map(f => ({
              format_id: f.format_id,
              ext: f.ext,
              resolution: f.resolution || f.format_note || 'Auto',
              filesize: f.filesize || f.filesize_approx
            }))
            .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));
        }

        if (formats.length === 0) {
          formats = [{ format_id: 'best', ext: 'mp4', resolution: 'Auto (best)', filesize: null }];
        }
      }

      res.json({
        title: info.title || 'Media',
        thumbnail: info.thumbnail || '',
        duration: info.duration,
        formats: formats
      });
    } catch (e) {
      console.error('JSON parse error:', e);
      res.status(500).json({ error: 'Invalid media data' });
    }
  });
});

app.get('/api/download', async (req, res) => {
  const url = req.query.url;
  const mode = (req.query.mode || 'mp4').toLowerCase();
  const formatId = req.query.format_id || (mode === 'mp3' ? 'bestaudio' : 'best');

  if (!url) {
    return res.status(400).json({ error: 'URL required' });
  }

  if (isYouTube(url)) {
    return res.status(400).json({ error: 'YouTube downloads are not supported.' });
  }

  if (!isSupportedPlatform(url)) {
    return res.status(400).json({ error: 'Unsupported platform.' });
  }

  const tempInput = join(tmpdir(), `${randomBytes(16).toString('hex')}.tmp`);
  const tempOutput = join(tmpdir(), `${randomBytes(16).toString('hex')}.${mode === 'mp3' ? 'mp3' : 'mp4'}`);

  try {
    // Fetch metadata to get title for filename
    const metaArgs = ['--dump-json', '--no-warnings'];
    if (url.includes('instagram.com')) metaArgs.push('--extractor-args', 'instagram:player_client=web');
    if (url.includes('facebook.com') || url.includes('fb.watch')) metaArgs.push('--extractor-args', 'facebook:player_client=web');
    metaArgs.push(url);

    let metaOutput = '';
    const metaProc = spawn('yt-dlp', metaArgs);
    metaProc.stdout.on('data', (data) => metaOutput += data.toString());
    await new Promise((resolve, reject) => {
      metaProc.on('close', (code) => code === 0 ? resolve() : reject(new Error('Metadata fetch failed')));
    });
    const meta = JSON.parse(metaOutput);
    const safeTitle = sanitizeFilename(meta.title || 'MediaKey');

    // Download raw stream
    const dlArgs = ['-f', formatId, '-o', tempInput];
    if (url.includes('instagram.com')) dlArgs.push('--extractor-args', 'instagram:player_client=web');
    if (url.includes('facebook.com') || url.includes('fb.watch')) dlArgs.push('--extractor-args', 'facebook:player_client=web');
    if (mode === 'mp3') {
      dlArgs.push('--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0');
    }
    dlArgs.push(url);

    await new Promise((resolve, reject) => {
      const ytDlp = spawn('yt-dlp', dlArgs);
      ytDlp.on('close', (code) => code === 0 ? resolve() : reject(new Error(`yt-dlp failed: ${code}`)));
      ytDlp.stderr.on('data', (data) => console.error('yt-dlp stderr:', data.toString()));
    });

    // Remux to MP4 (H.264 + AAC) for universal playback
    if (mode === 'mp4') {
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-i', tempInput,
          '-c:v', 'libx264',
          '-c:a', 'aac',
          '-strict', 'experimental',
          '-movflags', '+faststart',
          '-y',
          tempOutput
        ]);
        ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error('FFmpeg remux failed')));
        ffmpeg.stderr.on('data', (data) => console.error('ffmpeg stderr:', data.toString()));
      });
    } else {
      require('fs').renameSync(tempInput, tempOutput);
    }

    // Set filename with original title
    const ext = mode === 'mp3' ? 'mp3' : 'mp4';
    const filename = `${safeTitle}.${ext}`;
    res.setHeader('Content-Type', mode === 'mp3' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    const stream = createReadStream(tempOutput);
    stream.pipe(res);

    stream.on('end', () => {
      unlink(tempInput, () => {});
      unlink(tempOutput, () => {});
    });

  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed. Try again.' });
    unlink(tempInput, () => {});
    unlink(tempOutput, () => {});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎥 MediaKey running on port ${PORT}`);
});