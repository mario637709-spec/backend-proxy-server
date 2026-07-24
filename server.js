// Load environment variables - updated proxy size limit
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis');

const app = express();
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;

// ============================================
// PROCESS QUEUE (Prevent Server Crash)
// ============================================
const MAX_CONCURRENT_PROCESSES = parseInt(process.env.MAX_CONCURRENT_PROCESSES || '50'); // High concurrency support
let activeProcesses = 0;
const processQueue = [];

// ============================================
// IN-FLIGHT DEDUPLICATION
// If 10 workers request the same videoId at once,
// only 1 yt-dlp spawns — all 10 share the same Promise.
// ============================================
const inFlightMap = new Map(); // videoId -> Promise

function canStartProcess() {
  return activeProcesses < MAX_CONCURRENT_PROCESSES;
}

function startNextInQueue() {
  if (processQueue.length > 0 && canStartProcess()) {
    const nextTask = processQueue.shift();
    nextTask();
  }
}

function executeWithQueue(fn) {
  return new Promise((resolve, reject) => {
    const task = () => {
      activeProcesses++;
      fn()
        .then(resolve)
        .catch(reject)
        .finally(() => {
          activeProcesses--;
          startNextInQueue();
        });
    };

    if (canStartProcess()) {
      task();
    } else {
      processQueue.push(task);
      console.log(`⏳ Queue size: ${processQueue.length}, Active: ${activeProcesses}`);
    }
  });
}

// ============================================
// REDIS SETUP (Optional - Falls back to memory cache)
// ============================================
let redis = null;
let redisConnected = false;

if (process.env.REDIS_HOST) {
  redis = new Redis({
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    retryStrategy: (times) => {
      if (times > 3) {
        console.log('⚠️ Redis connection failed, using memory cache');
        return null; // Stop retrying
      }
      return Math.min(times * 50, 2000);
    },
    maxRetriesPerRequest: 3,
    lazyConnect: true // Don't block server startup
  });

  redis.connect().then(() => {
    redisConnected = true;
    console.log('✅ Redis connected');
  }).catch((err) => {
    console.log('⚠️ Redis unavailable, using memory cache');
    redis = null;
  });
} else {
  console.log('ℹ️ No Redis configured, using memory cache');
}

// Fallback to in-memory cache
const memoryCache = new Map();

async function getCached(key) {
  if (redis && redisConnected) {
    try {
      const data = await redis.get(key);
      if (data) {
        await redis.incr('stats:cache_hits').catch(() => {});
        return JSON.parse(data);
      }
      await redis.incr('stats:cache_misses').catch(() => {});
      return null;
    } catch (err) {
      // Fallback to memory
    }
  }
  return memoryCache.get(key) || null;
}

async function setCached(key, value, ttl = 18000) {
  if (redis && redisConnected) {
    try {
      await redis.setex(key, ttl, JSON.stringify(value));
      return;
    } catch (err) {
      // Fallback to memory
    }
  }
  memoryCache.set(key, value);
  setTimeout(() => memoryCache.delete(key), ttl * 1000);
}

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS?.split(',') || '*',
  credentials: true
}));
app.use(express.json());

// Dynamic rate limiting (bypassed/increased in development)
const limiter = rateLimit({
  windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || 60000),
  max: process.env.NODE_ENV === 'development' ? 10000 : parseInt(process.env.RATE_LIMIT_MAX_REQUESTS || 10),
  message: { error: 'Too many requests. Please wait 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    redis: redis && redisConnected ? 'connected' : 'memory-cache',
    timestamp: new Date().toISOString()
  });
});

// ============================================
// TEMPORARY COOKIES DEBUG ENDPOINT
// ============================================
app.get('/api/debug-cookies', (req, res) => {
  const paths = [
    '/etc/secrets/cookies.txt',
    path.join(__dirname, 'cookies.txt'),
    path.join(__dirname, '..', 'cookies.txt'),
    'cookies.txt'
  ];
  
  const results = {};
  
  for (const p of paths) {
    const absPath = path.resolve(p);
    results[p] = {
      absPath: absPath,
      exists: fs.existsSync(absPath),
      readable: false
    };
    if (results[p].exists) {
      try {
        fs.accessSync(absPath, fs.constants.R_OK);
        results[p].readable = true;
        results[p].size = fs.statSync(absPath).size;
      } catch (e) {
        results[p].error = e.message;
      }
    }
  }

  try {
    if (fs.existsSync('/etc/secrets')) {
      results['/etc/secrets-contents'] = fs.readdirSync('/etc/secrets');
    } else {
      results['/etc/secrets-exists'] = false;
    }
  } catch (e) {
    results['/etc/secrets-error'] = e.message;
  }

  res.json(results);
});

// ============================================
// MAIN API - Video Info Extraction (OPTIMIZED)
// ============================================
app.get('/api/getVideoJson', async (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) {
    return res.status(400).json({ error: 'videoId is required' });
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const cacheKey = `video:${videoId}`;

  // Increment total requests
  if (redis && redisConnected) {
    try {
      await redis.incr('stats:total_requests');
    } catch (err) {}
  }

  // 1. Check cache first (must have valid formats array)
  const cached = await getCached(cacheKey);
  if (cached && Array.isArray(cached.formats) && cached.formats.length > 0) {
    console.log('✅ Cache HIT:', videoId);
    return res.json({ ...cached, cached: true });
  }

  // 1b. Deduplication: if same videoId is already being extracted, share the result
  if (inFlightMap.has(videoId)) {
    console.log('🔄 In-flight HIT (dedup):', videoId);
    try {
      const result = await inFlightMap.get(videoId);
      return res.json({ ...result, cached: true, deduped: true });
    } catch (err) {
      return res.status(500).json({ error: 'Failed to extract video information', details: err.message });
    }
  }

  console.log('⏳ Cache MISS, extracting:', videoId);

  // Register in-flight promise before spawning
  let resolveInFlight, rejectInFlight;
  const inFlightPromise = new Promise((res, rej) => {
    resolveInFlight = res;
    rejectInFlight = rej;
  });
  // Prevent UnhandledPromiseRejection crash if no secondary caller awaits it
  inFlightPromise.catch(() => {});
  inFlightMap.set(videoId, inFlightPromise);

  const poToken = req.query.poToken || req.body?.poToken;

  // 2. Extract using yt-dlp on Render
  const os = require('os');
  const ytDlpExecutable = os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const ytDlpPath = os.platform() === 'win32' ? '.\\yt-dlp.exe' : path.join(__dirname, ytDlpExecutable);

  // Check if yt-dlp exists, if not attempt fallback or error
  if (!fs.existsSync(ytDlpPath)) {
    console.error('❌ yt-dlp not found at:', ytDlpPath);
    return res.status(500).json({ 
      error: 'yt-dlp binary not found on Render. Run: node download-ytdlp.js' 
    });
  }

  const ytDlpArgs = [
    '-J',                    // JSON output
    '--no-playlist',         // Single video only
    '--skip-download',       // Don't download, just extract
    '--no-warnings',         // Clean output
    '--geo-bypass',          // Bypass geo-restrictions
    '--no-check-certificates'
  ];

  if (poToken) {
    ytDlpArgs.push('--extractor-args', `youtube:player_client=mweb,ios;po_token=web+${poToken}`);
  } else {
    ytDlpArgs.push('--extractor-args', 'youtube:player_client=mweb,ios');
  }

  // Inject Laptop Proxy Tunnel into Render yt-dlp if TUNNEL_URL is present
  const tunnelUrl = process.env.TUNNEL_URL;
  if (tunnelUrl) {
    const cleanTunnel = 'http://' + tunnelUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    ytDlpArgs.push('--proxy', cleanTunnel);
    console.log('🌐 Render yt-dlp routing via Laptop Proxy Tunnel:', cleanTunnel);
  }

  // Securely load cookies if present (required for cloud hosting like Render to bypass bot blocks)
  let cookiesPath = process.env.YT_DLP_COOKIES_PATH;
  if (!cookiesPath) {
    if (fs.existsSync('/etc/secrets/cookies.txt')) {
      cookiesPath = '/etc/secrets/cookies.txt';
    } else {
      cookiesPath = path.join(__dirname, 'cookies.txt');
    }
  }

  if (cookiesPath && fs.existsSync(cookiesPath) && fs.statSync(cookiesPath).size > 0) {
    ytDlpArgs.push('--cookies', cookiesPath);
  }

  ytDlpArgs.push(url);

  console.log('🚀 Spawning yt-dlp with arguments:', ytDlpArgs.map(arg => arg.includes('cookies') ? '[COOKIES_FILE]' : arg));

  const ytDlpProcess = spawn(ytDlpPath, ytDlpArgs, {
    timeout: 120000 // Increase timeout to 120 seconds for slow extractions
  });

  ytDlpProcess.on('error', (err) => {
    console.error('❌ Spawn error:', err);
  });

  let stdoutData = '';
  let stderrData = '';

  ytDlpProcess.stdout.on('data', (data) => {
    stdoutData += data.toString();
  });

  ytDlpProcess.stderr.on('data', (data) => {
    stderrData += data.toString();
  });

  ytDlpProcess.on('close', async (code) => {
    if (code === 0) {
      try {
        const info = JSON.parse(stdoutData);

        // 3. Process formats - Return DIRECT URLs
        const formats = info.formats
          .filter(f => f.ext === 'mp4' || f.ext === 'webm' || f.ext === 'm4a')
          .map(f => ({
            format_id: f.format_id,
            ext: f.ext,
            resolution: f.resolution || f.format_note || 'Audio Only',
            filesize: f.filesize || f.filesize_approx || 0,
            url: f.url, // DIRECT YouTube CDN URL (valid for 6 hours)
            vcodec: f.vcodec !== 'none' ? f.vcodec : null,
            acodec: f.acodec !== 'none' ? f.acodec : null,
            quality: f.quality || 0,
            fps: f.fps,
            tbr: f.tbr // Total bitrate
          }))
          .sort((a, b) => {
            // Sort by quality (video first, then audio)
            if (a.vcodec && !b.vcodec) return -1;
            if (!a.vcodec && b.vcodec) return 1;
            return (b.filesize || 0) - (a.filesize || 0);
          });

        const result = {
          title: info.title,
          thumbnail: info.thumbnail,
          view_count: info.view_count,
          duration: info.duration_string || String(info.duration || 0),
          uploader: info.uploader,
          upload_date: info.upload_date,
          formats: formats,
          url_expires_in: '6 hours', // YouTube URLs expire after 6 hours
          extracted_at: new Date().toISOString()
        };

        // 4. Cache for 5 hours (URLs valid for 6)
        await setCached(cacheKey, result, 5 * 60 * 60);

        // Resolve in-flight and remove from map
        inFlightMap.delete(videoId);
        resolveInFlight(result);

        res.json(result);

        console.log(`✅ Extracted: ${info.title} (${formats.length} formats)`);

      } catch (e) {
        console.error('❌ Parse error:', e);
        res.status(500).json({
          error: 'Failed to parse video data',
          details: process.env.NODE_ENV === 'development' ? e.message : undefined
        });
      }
    } else {
      console.error(`❌ yt-dlp error (code ${code}):`, stderrData);
      
      // Reject in-flight and remove from map
      inFlightMap.delete(videoId);
      const extractErr = new Error(stderrData || 'yt-dlp failed');
      rejectInFlight(extractErr);

      // Specific error messages
      let errorMsg = 'Failed to extract video information';
      if (stderrData.includes('Video unavailable')) {
        errorMsg = 'Video is unavailable or private';
      } else if (stderrData.includes('Sign in')) {
        errorMsg = 'Video requires authentication';
      } else if (stderrData.includes('blocked')) {
        errorMsg = 'Video is blocked in your region';
      }

      res.status(500).json({
        error: errorMsg,
        details: process.env.NODE_ENV === 'development' ? stderrData : undefined
      });
    }
  });

  ytDlpProcess.on('error', (err) => {
    console.error('❌ Spawn error:', err);
    res.status(500).json({ error: 'Failed to start video extraction' });
  });
});

// ============================================
// SMART DOWNLOAD PROXY (Optional, for small files)
// ============================================
const { Readable } = require('stream');

app.get('/api/download', async (req, res) => {
  const fileUrl = req.query.url;
  const filename = req.query.filename || 'video.mp4';

  if (!fileUrl) {
    return res.status(400).json({ error: 'URL required' });
  }

  try {
    const fetchHeaders = {
      'User-Agent': 'com.google.android.youtube/19.29.37 (Linux; U; Android 14)',
      'Accept': '*/*'
    };

    if (req.headers.range) {
      fetchHeaders['Range'] = req.headers.range;
    }

    const response = await fetch(fileUrl, {
      headers: fetchHeaders,
      redirect: 'follow'
    });

    if (!response.ok) {
      console.error(`❌ Download fetch failed with status ${response.status}`);
      return res.status(response.status).json({ error: 'Failed to fetch video from source' });
    }

    const contentType = response.headers.get('content-type') || 'video/mp4';
    const contentLength = response.headers.get('content-length');

    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    if (response.headers.get('content-range')) {
      res.setHeader('Content-Range', response.headers.get('content-range'));
      res.status(206);
    }

    const stream = Readable.fromWeb(response.body);
    stream.on('error', (streamErr) => {
      console.log('ℹ️ Stream connection closed by client during download');
    });
    res.on('close', () => {
      stream.destroy();
    });
    stream.pipe(res);

  } catch (err) {
    console.error('❌ Download proxy error:', err);
    res.status(500).json({ error: 'Failed to download video' });
  }
});

// ============================================
// STATS ENDPOINT (Monitor usage)
// ============================================
app.get('/api/stats', async (req, res) => {
  try {
    if (redis && redisConnected) {
      const totalRequests = parseInt(await redis.get('stats:total_requests')) || 0;
      const cacheHits = parseInt(await redis.get('stats:cache_hits')) || 0;
      const cacheMisses = parseInt(await redis.get('stats:cache_misses')) || 0;
      const cacheHitRate = (cacheHits + cacheMisses) > 0 
        ? ((cacheHits / (cacheHits + cacheMisses)) * 100).toFixed(2) 
        : 0;

      res.json({
        total_requests: totalRequests,
        cache_hits: cacheHits,
        cache_misses: cacheMisses,
        cache_hit_rate: `${cacheHitRate}%`,
        cache_type: 'redis',
        memory_usage: process.memoryUsage(),
        uptime: Math.round(process.uptime())
      });
    } else {
      res.json({
        cache_type: 'memory',
        cache_size: memoryCache.size,
        memory_usage: process.memoryUsage(),
        uptime: Math.round(process.uptime()),
        note: 'Using in-memory cache (Redis not configured)'
      });
    }
  } catch (err) {
    res.json({ 
      error: 'Stats unavailable',
      cache_type: 'memory'
    });
  }
});

// ============================================
// ERROR HANDLER
// ============================================
app.use((err, req, res, next) => {
  console.error('💥 Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// ============================================
// START SERVER
// ============================================
const server = app.listen(port, () => {
  console.log(`
╔════════════════════════════════════════╗
║   🚀 YT Downloader Backend             ║
║   Port: ${port}                        ║
║   Environment: ${process.env.NODE_ENV || 'development'}       ║
║   Cache: ${redis && redisConnected ? '✅ Redis' : '⚠️  Memory'}              ║
╚════════════════════════════════════════╝
  `);
  console.log(`📍 Health check: http://localhost:${port}/health`);
  console.log(`📊 Stats: http://localhost:${port}/api/stats`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('⏳ SIGTERM received, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    if (redis) redis.quit();
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n⏳ SIGINT received, closing server...');
  server.close(() => {
    console.log('✅ Server closed');
    if (redis) redis.quit();
    process.exit(0);
  });
});

module.exports = app; // For testing
