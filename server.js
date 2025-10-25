// server.js
const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));
app.use(cors());

// Health check
app.get('/', (req, res) => {
  res.redirect('/index.html');
});

// Get media info
app.get('/api/info', (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  const ytDlp = spawn('yt-dlp', [
    '--dump-json',
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=web,default',
    url
  ]);

  let output = '';
  let errorOutput = '';

  ytDlp.stdout.on('data', (data) => output += data.toString());
  ytDlp.stderr.on('data', (data) => errorOutput += data.toString());

  ytDlp.on('close', (code) => {
    if (code !== 0) {
      console.error('yt-dlp stderr:', errorOutput);
      return res.status(500).json({ error: 'Failed to analyze link. Make sure it’s a public post from YouTube, TikTok, Instagram, X, or Reddit.' });
    }

    try {
      const info = JSON.parse(output);
      const formats = (info.formats || [])
        .filter(f => 
          f.ext === 'mp4' || 
          f.ext === 'm4a' || 
          (f.vcodec !== 'none' && f.acodec !== 'none') // has both audio+video
        )
        .map(f => ({
          format_id: f.format_id,
          ext: f.ext,
          resolution: f.resolution || f.format_note || 'audio',
          filesize: f.filesize,
          fps: f.fps
        }));

      res.json({
        title: info.title?.substring(0, 100) || 'Media',
        thumbnail: info.thumbnail || '',
        duration: info.duration,
        formats: formats.length ? formats : [{ format_id: 'best', ext: 'mp4', resolution: 'Auto (best)' }]
      });
    } catch (e) {
      console.error('Parse error:', e);
      res.status(500).json({ error: 'Invalid media data' });
    }
  });
});

// Stream download
app.get('/api/download', (req, res) => {
  const url = req.query.url;
  const formatId = req.query.format_id || 'best';

  if (!url) return res.status(400).json({ error: 'URL required' });

  const args = ['-f', formatId, '-o', '-', url];
  const ytDlp = spawn('yt-dlp', args);

  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', 'attachment; filename="MediaKey_Download.mp4"');

  ytDlp.stdout.pipe(res);
  ytDlp.stderr.on('data', (data) => {
    console.error('Download stderr:', data.toString());
  });

  req.on('close', () => ytDlp.kill());
});

app.listen(PORT, () => {
  console.log(`🎥 MediaKey running on http://localhost:${PORT}`);
});