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

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' }
});

app.use('/api/', apiLimiter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/debugCookies', (req, res) => {
  const envCookies = process.env.YT_COOKIES;
  const tmpCookiesPath = getCookiesFilePath();
  const exists = tmpCookiesPath ? fs.existsSync(tmpCookiesPath) : false;
  res.json({
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
      data = await runYtDlpOnRender(videoId, poToken);
    } catch (firstErr) {
      console.warn('⚠️ First extraction attempt failed, retrying without poToken...', firstErr.message.slice(0, 100));
      // Retry without poToken and with fallback client
      data = await runYtDlpOnRender(videoId, null);
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

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Production Backend Server running on port ${PORT}`);
  console.log(`🔧 yt-dlp binary: ${ytDlpBinary} | exists: ${fs.existsSync(ytDlpBinary)}`);
});
