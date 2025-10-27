// server.js
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const { createReadStream } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { randomBytes } = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000; // Render uses 10000 by default

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

// Block YouTube explicitly
function isYouTube(url) {
  return url.includes('youtube.com') || url.includes('youtu.be');
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

  const args = ['--dump-json', '--no-warnings', '--no-call-home'];
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
      return res.status(500).json({ error: msg });
    }

    try {
      const info = JSON.parse(output);
      let formats = [];

      if (mode === 'mp3') {
        formats = [{ format_id: 'bestaudio', ext: 'mp3', resolution: 'Audio only', filesize: info.filesize_approx || info.filesize }];
      } else {
        formats = (info.formats || [])
          .filter(f => (f.vcodec !== 'none' && f.acodec !== 'none') || (f.acodec !== 'none' && f.vcodec === 'none'))
          .map(f => ({
            format_id: f.format_id,
            ext: f.ext,
            resolution: f.resolution || f.format_note || (f.acodec !== 'none' && f.vcodec === 'none' ? 'Audio only' : 'Unknown'),
            filesize: f.filesize || f.filesize_approx
          }))
          .sort((a, b) => (b.filesize || 0) - (a.filesize || 0));

        if (formats.length === 0) {
          formats = [{ format_id: 'best', ext: 'mp4', resolution: 'Auto (best)', filesize: null }];
        }
      }

      res.json({
        title: (info.title || 'Media').substring(0, 100),
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
    await new Promise((resolve, reject) => {
      const ytDlp = spawn('yt-dlp', [
        '-f', formatId,
        '-o', tempInput,
        ...(mode === 'mp3' ? ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0'] : []),
        url
      ]);
      ytDlp.on('close', (code) => code === 0 ? resolve() : reject(new Error(`yt-dlp failed`)));
      ytDlp.stderr.on('data', (data) => console.error('yt-dlp stderr:', data.toString()));
    });

    if (mode === 'mp4') {
      await new Promise((resolve, reject) => {
        const ffmpeg = spawn('ffmpeg', [
          '-i', tempInput,
          '-c', 'copy',
          '-movflags', '+faststart',
          '-y',
          tempOutput
        ]);
        ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error('FFmpeg failed')));
        ffmpeg.stderr.on('data', (data) => console.error('ffmpeg stderr:', data.toString()));
      });
    } else {
      require('fs').renameSync(tempInput, tempOutput);
    }

    res.setHeader('Content-Type', mode === 'mp3' ? 'audio/mpeg' : 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="MediaKey.${mode === 'mp3' ? 'mp3' : 'mp4'}"`);
    const stream = createReadStream(tempOutput);
    stream.pipe(res);

    stream.on('end', () => {
      require('fs').unlink(tempInput, () => {});
      require('fs').unlink(tempOutput, () => {});
    });

  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Download failed. Try again.' });
    require('fs').unlink(tempInput, () => {});
    require('fs').unlink(tempOutput, () => {});
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🎥 MediaKey running on port ${PORT}`);
});