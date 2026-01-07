/**
 * MEDIAKEY APEX - VERSION 7.4
 * --------------------------------------------------
 * Optimized for: MacBook Pro & Render.com
 * Hybrid Audio Extraction & Chrome Mimicry
 * --------------------------------------------------
 */

const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const { unlink, existsSync, mkdirSync, readdirSync, statSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { randomBytes } = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// VAULT CONFIG
const VAULT_DIR = join(tmpdir(), 'mediakey_apex_vault');
if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true });

app.use(express.static('public'));
app.use(cors());
app.use(express.json());

// INDUSTRIAL LOGGER
const log = (tag, msg, err = null) => {
    const time = new Date().toLocaleTimeString();
    console.log(`[${time}] ${tag} ${msg}`);
    if (err) console.error(`   ⚠️ SYSTEM_ERROR: ${err.message || err}`);
};

/**
 * AUTO-MAINTENANCE
 * Keeps the server lightweight by purging the vault every 10 minutes.
 */
const cleanVault = () => {
    try {
        const now = Date.now();
        readdirSync(VAULT_DIR).forEach(file => {
            const filePath = join(VAULT_DIR, file);
            const stats = statSync(filePath);
            if (now - stats.mtimeMs > 1800000) unlink(filePath, () => {}); // 30 Min limit
        });
    } catch (e) {}
};
setInterval(cleanVault, 600000);

/**
 * FILENAME SANITIZER
 */
function getSafeFileName(title, ext) {
    let base = (title || "MediaKey")
        .replace(/[^\x00-\x7F]/g, "") 
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 75) || "Download";
    return `${base}.${ext}`;
}

/**
 * API: ANALYZE SOURCE
 */
app.get('/api/info', async (req, res) => {
    const { url, mode } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    log('🔍 [INFO]', `Analyzing: ${url.substring(0, 45)}...`);

    // We use a generic high-quality User-Agent as a fallback for impersonation
    const args = [
        '--no-warnings', '--dump-json', '--no-check-certificates',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        url
    ];

    const proc = spawn('yt-dlp', args);
    let output = '';
    proc.stdout.on('data', (d) => output += d);
    proc.on('close', (code) => {
        if (code !== 0) return res.status(500).json({ error: "Platform blocked request." });
        try {
            const data = JSON.parse(output);
            let formats = [];

            if (mode === 'mp3') {
                formats = [{ format_id: 'bestaudio/best', resolution: 'Studio Grade MP3', ext: 'mp3' }];
            } else {
                formats = (data.formats || [])
                    .filter(f => f.ext === 'mp4' && f.vcodec !== 'none')
                    .map(f => ({
                        format_id: f.format_id,
                        resolution: f.resolution || `${f.height}p` || 'HD',
                        ext: 'mp4'
                    })).reverse().slice(0, 6);
                formats.unshift({ format_id: 'bv+ba/b', resolution: 'Apex Best (Auto)', ext: 'mp4' });
            }

            res.json({
                title: data.title,
                thumbnail: data.thumbnail,
                uploader: data.uploader || 'Social Source',
                formats
            });
        } catch (e) { res.status(500).json({ error: "Parsing failure." }); }
    });
});

/**
 * API: EXECUTE DOWNLOAD
 */
app.get('/api/download', async (req, res) => {
    const { url, mode, format_id } = req.query;
    const isMp3 = mode === 'mp3';
    const reqID = randomBytes(4).toString('hex');
    const rawBase = join(VAULT_DIR, `raw_${reqID}`);
    const finalPath = join(VAULT_DIR, `ready_${reqID}.${isMp3 ? 'mp3' : 'mp4'}`);

    log('🚀 [START]', `ID: ${reqID} | Mode: ${mode}`);

    try {
        // 1. Resolve Title
        let title = "MediaKey_File";
        try {
            title = execSync(`yt-dlp --get-title --no-check-certificates "${url}"`, { encoding: 'utf8', timeout: 5000 }).trim();
        } catch(e) {}

        // 2. Download Phase
        // HYBRID FIX: For TikTok MP3s, we download the combined video (best) 
        // to ensure we actually get the file, then let FFmpeg strip the audio.
        const dlArgs = [
            '--no-check-certificates',
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            '-f', isMp3 ? 'b/ba' : (format_id || 'bv+ba/b'),
            '-o', `${rawBase}.%(ext)s`,
            url
        ];

        await new Promise((resolve, reject) => {
            const p = spawn('yt-dlp', dlArgs);
            p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Exit ${code}`)));
        });

        // 3. Locate Raw File
        const rawFile = readdirSync(VAULT_DIR).find(f => f.startsWith(`raw_${reqID}`));
        if (!rawFile) throw new Error("File missing");
        const fullRawPath = join(VAULT_DIR, rawFile);

        // 4. Processing Phase (FFmpeg)
        log('🛠️ [FFMPEG]', `Converting: ${rawFile} to ${isMp3 ? 'MP3' : 'MP4'}`);
        
        const ffArgs = isMp3 
            ? ['-i', fullRawPath, '-vn', '-acodec', 'libmp3lame', '-ab', '192k', '-ar', '44100', '-y', finalPath]
            : ['-i', fullRawPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', 'faststart', '-y', finalPath];

        await new Promise((resolve, reject) => {
            const p = spawn('ffmpeg', ffArgs);
            p.on('close', (code) => code === 0 ? resolve() : reject(new Error('FFmpeg error')));
        });

        // 5. Final Delivery
        if (existsSync(finalPath)) {
            const safeName = getSafeFileName(title, isMp3 ? 'mp3' : 'mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(safeName)}`);
            
            res.download(finalPath, safeName, () => {
                // Wipe all request files immediately after download
                readdirSync(VAULT_DIR).filter(f => f.includes(reqID)).forEach(f => unlink(join(VAULT_DIR, f), () => {}));
                log('✅ [DONE]', `ID: ${reqID} delivered`);
            });
        }
    } catch (err) {
        log('❌ [FAIL]', `ID: ${reqID}`, err);
        res.status(500).json({ error: "System failure" });
        // Emergency purge
        readdirSync(VAULT_DIR).filter(f => f.includes(reqID)).forEach(f => unlink(join(VAULT_DIR, f), () => {}));
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    --------------------------------------------------
    🚀 MEDIAKEY APEX ENGINE v7.4 ONLINE
    📡 PORT: ${PORT}
    📂 VAULT: ${VAULT_DIR}
    --------------------------------------------------
    `);
});