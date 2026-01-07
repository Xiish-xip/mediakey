/**
 * MediaKey Pro — Apex Industrial v7.2
 * 400-Line Optimized Studio Engine
 */

const express = require('express');
const cors = require('cors');
const { spawn, execSync } = require('child_process');
const { 
    unlink, 
    existsSync, 
    mkdirSync, 
    statSync, 
    readdirSync 
} = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { randomBytes } = require('crypto');

const app = express();
const PORT = process.env.PORT || 10000;

// --- CONFIG & DIRECTORIES ---
const VAULT_DIR = join(tmpdir(), 'mediakey_apex_vault');
if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true });

app.use(express.static('public'));
app.use(cors());
app.use(express.json());

// --- UTILITIES ---
const log = (tag, msg, err = null) => {
    console.log(`[${new Date().toLocaleTimeString()}] ${tag} ${msg}`);
    if (err) console.error(err?.message || err);
};

/**
 * Strips dangerous chars but keeps it readable.
 * Crucial for avoiding "Invalid Header" errors.
 */
function getSafeFileName(title, ext) {
    let base = (title || "MediaKey")
        .replace(/[^\x00-\x7F]/g, "") // Remove Emojis/Unicode
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
        .replace(/\s+/g, '_')
        .substring(0, 70) || "Media_File";
    return `${base}.${ext}`;
}

// --- CORE API ---

/**
 * Metadata Endpoint
 */
app.get('/api/info', async (req, res) => {
    const { url, mode } = req.query;
    if (!url) return res.status(400).json({ error: 'URL required' });

    log('🔍 [INFO]', `Analyzing: ${url.substring(0, 40)}...`);

    const args = [
        '--no-warnings', '--dump-json', '--no-check-certificates',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        url
    ];

    const proc = spawn('yt-dlp', args);
    let output = '';
    let errorLog = '';

    proc.stdout.on('data', (d) => output += d);
    proc.stderr.on('data', (d) => errorLog += d);

    proc.on('close', (code) => {
        if (code !== 0) {
            log('❌ [ERROR]', 'yt-dlp info failed', errorLog);
            return res.status(500).json({ error: "Platform blocked access." });
        }
        try {
            const data = JSON.parse(output);
            let formats = mode === 'mp3' 
                ? [{ format_id: 'bestaudio', resolution: 'High Quality MP3', ext: 'mp3' }]
                : (data.formats || [])
                    .filter(f => f.ext === 'mp4' && f.vcodec !== 'none')
                    .map(f => ({
                        format_id: f.format_id,
                        resolution: f.resolution || f.format_note || 'Standard',
                        filesize: f.filesize || f.filesize_approx,
                        ext: 'mp4'
                    })).reverse().slice(0, 8);
            
            if (mode !== 'mp3') {
                formats.unshift({ format_id: 'bestvideo+bestaudio/best', resolution: 'Auto Best (Stitched)', ext: 'mp4' });
            }

            res.json({ 
                title: data.title, 
                thumbnail: data.thumbnail, 
                uploader: data.uploader || 'Source', 
                formats 
            });
        } catch (e) { 
            res.status(500).json({ error: "Data Parsing Error" }); 
        }
    });
});

/**
 * Instant 10s Preview
 */
app.get('/api/preview', (req, res) => {
    const id = randomBytes(4).toString('hex');
    const out = join(VAULT_DIR, `prev_${id}.mp4`);
    const proc = spawn('yt-dlp', [
        '-f', 'mp4[height<=480]/best[height<=480]', 
        '--downloader', 'ffmpeg', 
        '--downloader-args', 'ffmpeg:-ss 00:00:00 -t 00:00:10', 
        '-o', out, 
        req.query.url
    ]);
    proc.on('close', () => {
        if (existsSync(out)) {
            res.sendFile(out, () => unlink(out, () => {}));
        } else {
            res.status(404).send();
        }
    });
});

/**
 * Main Download Engine (The Fixer)
 */
app.get('/api/download', async (req, res) => {
    const { url, mode, format_id } = req.query;
    const isMp3 = mode === 'mp3';
    const reqID = randomBytes(4).toString('hex');
    const rawBase = join(VAULT_DIR, `raw_${reqID}`);
    const finalPath = join(VAULT_DIR, `ready_${reqID}.${isMp3 ? 'mp3' : 'mp4'}`);

    log('🚀 [START]', `ID: ${reqID} | Mode: ${mode}`);

    try {
        // 1. Fetch Title for Header
        let title = "MediaKey_File";
        try { 
            title = execSync(`yt-dlp --get-title "${url}"`, { encoding: 'utf8', timeout: 4000 }).trim(); 
        } catch(e) { log('⚠️ [WARN]', 'Title fetch failed'); }

        // 2. Download with dynamic extension
        const dlArgs = [
            '--no-check-certificates', 
            '--user-agent', 'Mozilla/5.0',
            '-f', isMp3 ? 'bestaudio' : (format_id || 'bv*[ext=mp4]+ba[ext=m4a]/best'),
            '-o', `${rawBase}.%(ext)s`,
            url
        ];

        await new Promise((resolve, reject) => {
            const p = spawn('yt-dlp', dlArgs);
            p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`Download fail: ${code}`)));
        });

        // 3. Find exactly what file was created (fixes the FFmpeg failure)
        const downloadedFile = readdirSync(VAULT_DIR).find(f => f.startsWith(`raw_${reqID}`));
        if (!downloadedFile) throw new Error("File not written to disk");
        const fullRawPath = join(VAULT_DIR, downloadedFile);

        // 4. Industrial FFmpeg Processing
        log('🛠️ [FFMPEG]', `Processing: ${downloadedFile}`);
        const ffArgs = isMp3 
            ? ['-i', fullRawPath, '-acodec', 'libmp3lame', '-ab', '192k', '-y', finalPath]
            : ['-i', fullRawPath, '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-movflags', 'faststart', '-y', finalPath];

        await new Promise((resolve, reject) => {
            const p = spawn('ffmpeg', ffArgs);
            p.on('close', (code) => code === 0 ? resolve() : reject(new Error('FFmpeg processing error')));
        });

        // 5. Secure Header Delivery
        if (existsSync(finalPath)) {
            const safeName = getSafeFileName(title, isMp3 ? 'mp3' : 'mp4');
            const encodedName = encodeURIComponent(safeName);

            // RFC 5987 Compliance Fix
            res.setHeader('Content-Disposition', `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`);
            res.setHeader('Content-Type', isMp3 ? 'audio/mpeg' : 'video/mp4');

            res.download(finalPath, safeName, (err) => {
                // Cleanup all instances of this request
                readdirSync(VAULT_DIR).filter(f => f.includes(reqID)).forEach(f => {
                    unlink(join(VAULT_DIR, f), () => {});
                });
                log('✅ [DONE]', `ID: ${reqID} delivered`);
            });
        }
    } catch (err) {
        log('❌ [FAIL]', `ID: ${reqID}`, err);
        res.status(500).json({ error: "Media processing failed." });
        // Cleanup on error
        readdirSync(VAULT_DIR).filter(f => f.includes(reqID)).forEach(f => {
            unlink(join(VAULT_DIR, f), () => {});
        });
    }
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`
    --------------------------------------------------
    🚀 MEDIAKEY APEX ENGINE v7.2 ONLINE
    📡 PORT: ${PORT}
    📂 VAULT: ${VAULT_DIR}
    --------------------------------------------------
    `);
});