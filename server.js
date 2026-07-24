const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');
const os = require('os');

const app = express();

// Fix X-Forwarded-For ValidationError on Render (behind a proxy)
app.set('trust proxy', 1);

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder', 'ngrok-skip-browser-warning', 'x-requested-with']
}));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', activeTunnelUrl, timestamp: new Date().toISOString() });
});

let redisClient = null;
if (process.env.REDIS_URL) {
  redisClient = new Redis(process.env.REDIS_URL, {
    maxRetriesPerRequest: 3,
    connectTimeout: 5000
  });
  redisClient.on('error', (err) => console.warn('⚠️ Redis Client Error:', err.message));
}

const memoryCache = new Map();

async function getCached(key) {
  if (redisClient) {
    try {
      const data = await redisClient.get(key);
      if (data) return JSON.parse(data);
    } catch (e) {
      console.warn('⚠️ Redis get failure:', e.message);
    }
  }
  const item = memoryCache.get(key);
  if (item && item.expires > Date.now()) {
    return item.data;
  }
  return null;
}

async function setCached(key, value, ttlSeconds = 18000) {
  if (redisClient) {
    try {
      await redisClient.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (e) {
      console.warn('⚠️ Redis set failure:', e.message);
    }
  }
  memoryCache.set(key, {
    data: value,
    expires: Date.now() + (ttlSeconds * 1000)
  });
}

let activeTunnelUrl = process.env.TUNNEL_URL || null;

app.post('/api/updateTunnelUrl', (req, res) => {
  const { tunnelUrl } = req.body || {};
  if (tunnelUrl && typeof tunnelUrl === 'string' && tunnelUrl.startsWith('http')) {
    activeTunnelUrl = tunnelUrl;
    console.log(`📡 In-memory Tunnel URL updated to: ${activeTunnelUrl}`);
    return res.json({ status: 'ok', activeTunnelUrl });
  }
  return res.status(400).json({ error: 'Invalid tunnelUrl provided' });
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' }
});

app.use('/api/', apiLimiter);

app.get('/api/debugCookies', (req, res) => {
  const envCookies = process.env.YT_COOKIES;
  const tmpCookiesPath = getCookiesFilePath();
  const exists = tmpCookiesPath ? fs.existsSync(tmpCookiesPath) : false;
  res.json({
    activeTunnelUrl,
    hasEnvCookies: !!envCookies,
    envCookiesSize: envCookies ? envCookies.length : 0,
    tmpFileExists: exists,
    tmpFileSize: exists ? fs.statSync(tmpCookiesPath).size : 0,
    preview: envCookies ? envCookies.slice(0, 150) : null
  });
});

// Resolve yt-dlp binary path (downloaded via postinstall script)
const ytDlpBinary = path.join(__dirname, os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// Helper to get or create cookies file path
function getCookiesFilePath() {
  if (process.env.YT_COOKIES) {
    const tmpCookies = path.join(os.tmpdir(), 'yt_cookies.txt');
    try {
      const cleanCookies = process.env.YT_COOKIES.replace(/\r\n/g, '\n');
      fs.writeFileSync(tmpCookies, cleanCookies, 'utf8');
      return tmpCookies;
    } catch (e) {
      console.warn('⚠️ Failed writing cookies file:', e.message);
    }
  }
  return null;
}

function runYtDlpOnRender(videoId, poToken) {
  return new Promise((resolve, reject) => {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    const args = [
      '-J',
      '--no-playlist',
      '--skip-download',
      '--no-warnings',
      '--geo-bypass',
      '--no-check-certificates',
      '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
    ];

    const cookiesPath = getCookiesFilePath();
    if (cookiesPath && fs.existsSync(cookiesPath)) {
      args.push('--cookies', cookiesPath);
    }

    // mweb + web + ios + android player_clients with cookies for reliable format extraction on datacenter IPs
    if (poToken) {
      args.push('--extractor-args', `youtube:player_client=mweb,web,ios,android;po_token=web+${poToken}`);
    } else {
      args.push('--extractor-args', 'youtube:player_client=mweb,web,ios,android');
    }

    args.push(videoUrl);

    console.log(`🔧 Running yt-dlp on Render for videoId: ${videoId}`);

    const proc = spawn(ytDlpBinary, args, { timeout: 55000 });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    proc.on('close', code => {
      if (code === 0 && stdout.trim()) {
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error('Failed to parse yt-dlp output: ' + e.message));
        }
      } else {
        reject(new Error(stderr.slice(-500) || `yt-dlp exited with code ${code}`));
      }
    });

    proc.on('error', err => reject(new Error(`yt-dlp spawn error: ${err.message}`)));
  });
}

class ConcurrencyQueue {
  constructor(maxConcurrent = 4) {
    this.maxConcurrent = maxConcurrent;
    this.activeCount = 0;
    this.queue = [];
  }

  async run(fn) {
    if (this.activeCount >= this.maxConcurrent) {
      await new Promise(resolve => this.queue.push(resolve));
    }
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      if (this.queue.length > 0) {
        const next = this.queue.shift();
        next();
      }
    }
  }
}

const extractionQueue = new ConcurrencyQueue(4);

async function extractVideoData(videoId, poToken) {
  return extractionQueue.run(async () => {
    const targetTunnel = activeTunnelUrl || process.env.TUNNEL_URL;
    // Strategy 1: Fetch HTML via Residential Proxy over Cloudflare Tunnel (0 bot detection, 0 laptop CPU!)
    if (targetTunnel && typeof targetTunnel === 'string' && targetTunnel.startsWith('http')) {
    try {
      const proxyFetchUrl = `${targetTunnel}/proxy?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}`;
      console.log(`🌐 Fetching YouTube HTML via Residential Proxy (${targetTunnel}) for videoId: ${videoId}`);
      
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      
      const response = await fetch(proxyFetchUrl, { signal: controller.signal });
      clearTimeout(timer);

      if (response.ok) {
        const html = await response.text();
        const startIdx = html.indexOf('ytInitialPlayerResponse = {');
        if (startIdx !== -1) {
          const jsonStart = startIdx + 'ytInitialPlayerResponse = '.length;
          let braceCount = 0, endIdx = -1;
          for (let i = jsonStart; i < html.length; i++) {
            if (html[i] === '{') braceCount++;
            else if (html[i] === '}') {
              braceCount--;
              if (braceCount === 0) { endIdx = i + 1; break; }
            }
          }
          if (endIdx !== -1) {
            const playerResponse = JSON.parse(html.slice(jsonStart, endIdx));
            const videoDetails = playerResponse.videoDetails || {};
            const formats = (playerResponse.streamingData?.formats || []).concat(playerResponse.streamingData?.adaptiveFormats || []);

            if (videoDetails.title && formats.length > 0) {
              console.log(`✅ Extracted ${formats.length} formats via Residential Proxy HTML parser!`);
              return {
                id: videoId,
                title: videoDetails.title,
                uploader: videoDetails.author,
                duration: parseInt(videoDetails.lengthSeconds || '0'),
                view_count: parseInt(videoDetails.viewCount || '0'),
                thumbnail: videoDetails.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`,
                formats: formats.map(f => {
                  let streamUrl = f.url;
                  if (!streamUrl && (f.signatureCipher || f.cipher)) {
                    try {
                      streamUrl = new URLSearchParams(f.signatureCipher || f.cipher).get('url');
                    } catch (e) {}
                  }
                  return {
                    format_id: f.itag?.toString(),
                    url: streamUrl || `https://www.youtube.com/watch?v=${videoId}`,
                    ext: f.mimeType?.includes('audio') ? 'm4a' : 'mp4',
                    width: f.width,
                    height: f.height,
                    filesize: parseInt(f.contentLength || '0'),
                    vcodec: f.mimeType?.includes('video') ? 'h264' : 'none',
                    acodec: f.mimeType?.includes('audio') ? 'aac' : 'none',
                    format_note: f.qualityLabel || `${f.bitrate || 0}bps`
                  };
                })
              };
            }
          }
        }
      }
    } catch (err) {
      console.warn('⚠️ Residential Proxy HTML extraction failed, falling back to yt-dlp:', err.message);
    }
  }

  // Strategy 2: Direct yt-dlp on Render
  return runYtDlpOnRender(videoId, poToken);
  });
}

const inFlightMap = new Map();

app.get('/api/getVideoJson', async (req, res) => {
  const videoId = req.query.videoId;

  if (!videoId || typeof videoId !== 'string' || videoId.trim() === '') {
    return res.status(400).json({ error: 'videoId query parameter is required' });
  }

  const cacheKey = `yt_json:${videoId}`;
  const cachedData = await getCached(cacheKey);

  if (cachedData) {
    console.log('⚡ Cache HIT for videoId:', videoId);
    return res.json({ ...cachedData, cached: true });
  }

  if (inFlightMap.has(videoId)) {
    console.log('⏳ Joining in-flight extraction for videoId:', videoId);
    try {
      const result = await inFlightMap.get(videoId);
      return res.json({ ...result, cached: true });
    } catch (err) {
      return res.status(500).json({ error: err.message || 'In-flight extraction failed' });
    }
  }

  let resolveInFlight, rejectInFlight;
  const inFlightPromise = new Promise((resolve, reject) => {
    resolveInFlight = resolve;
    rejectInFlight = reject;
  });

  inFlightPromise.catch(() => {});
  inFlightMap.set(videoId, inFlightPromise);

  const poToken = req.query.poToken || req.body?.poToken;

  // Check if yt-dlp binary exists on Render
  if (!fs.existsSync(ytDlpBinary)) {
    inFlightMap.delete(videoId);
    rejectInFlight(new Error('yt-dlp binary not found'));
    return res.status(500).json({ error: 'yt-dlp binary not found. Run postinstall.' });
  }

  try {
    let data;
    try {
      data = await extractVideoData(videoId, poToken);
    } catch (firstErr) {
      console.warn('⚠️ First extraction attempt failed, retrying without poToken...', firstErr.message.slice(0, 100));
      data = await extractVideoData(videoId, null);
    }

    if (data && (data.title || Array.isArray(data.formats))) {
      await setCached(cacheKey, data);
      inFlightMap.delete(videoId);
      resolveInFlight(data);
      return res.json({ ...data, cached: false, tunneled: false });
    } else {
      throw new Error('yt-dlp returned empty/invalid data');
    }
  } catch (err) {
    console.error('❌ yt-dlp extraction failed:', err.message.slice(0, 200));
    inFlightMap.delete(videoId);
    rejectInFlight(err);
    return res.status(500).json({ error: err.message.slice(0, 300) });
  }
});

app.get('/api/download', async (req, res) => {
  const mediaUrl = req.query.url;
  const filename = req.query.filename || 'media_download.mp4';

  if (!mediaUrl || typeof mediaUrl !== 'string') {
    return res.status(400).send('url parameter is required');
  }

  console.log(`📥 Download stream requested for: ${filename}`);

  const safeFilename = filename.replace(/[/\\?%*:|"<>]/g, '_');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(safeFilename)}"`);
  res.setHeader('Content-Type', safeFilename.endsWith('.mp3') || safeFilename.endsWith('.m4a') ? 'audio/mpeg' : 'video/mp4');

  try {
    const fetchHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': '*/*'
    };

    let fetchTarget = mediaUrl;
    if (activeTunnelUrl && mediaUrl.includes('googlevideo.com')) {
      fetchTarget = `${activeTunnelUrl}/proxy?url=${encodeURIComponent(mediaUrl)}`;
      console.log(`🌐 Proxying media download stream through Residential Tunnel: ${activeTunnelUrl}`);
    }

    let mediaRes = await fetch(fetchTarget, { headers: fetchHeaders });
    if (!mediaRes.ok && fetchTarget !== mediaUrl) {
      console.warn(`⚠️ Tunnel download failed with HTTP ${mediaRes.status}, retrying direct fetch...`);
      mediaRes = await fetch(mediaUrl, { headers: fetchHeaders });
    }

    if (!mediaRes.ok) {
      return res.status(mediaRes.status).send(`Failed to stream media: HTTP ${mediaRes.status}`);
    }

    if (mediaRes.headers.get('content-length')) {
      res.setHeader('Content-Length', mediaRes.headers.get('content-length'));
    }

    const { Readable } = require('stream');
    if (mediaRes.body.getReader) {
      Readable.fromWeb(mediaRes.body).pipe(res);
    } else if (typeof mediaRes.body.pipe === 'function') {
      mediaRes.body.pipe(res);
    } else {
      const buffer = await mediaRes.arrayBuffer();
      res.send(Buffer.from(buffer));
    }
  } catch (err) {
    console.error('❌ Download streaming error:', err.message);
    res.status(500).send(`Download streaming error: ${err.message}`);
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Production Backend Server running on port ${PORT}`);
  console.log(`🔧 yt-dlp binary: ${ytDlpBinary} | exists: ${fs.existsSync(ytDlpBinary)}`);
});
