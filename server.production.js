// 🚀 PRODUCTION SERVER - Handles 10K+ Concurrent Users Safely
// Key Feature: Process limiting + Queue system

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis');

const app = express();
const port = process.env.PORT || 3000;

// ============================================
// PROCESS QUEUE (Critical for 10K users!)
// ============================================
class ProcessQueue {
  constructor(maxConcurrent = 20) {
    this.maxConcurrent = maxConcurrent;
    this.running = 0;
    this.queue = [];
    this.stats = {
      processed: 0,
      queued: 0,
      rejected: 0,
      errors: 0
    };
  }

  async add(task) {
    // If queue too long, reject immediately
    if (this.queue.length > 1000) {
      this.stats.rejected++;
      throw new Error('Server busy. Please try again in a moment.');
    }

    // If under limit, run immediately
    if (this.running < this.maxConcurrent) {
      this.running++;
      try {
        const result = await task();
        this.stats.processed++;
        return result;
      } catch (err) {
        this.stats.errors++;
        throw err;
      } finally {
        this.running--;
        this.processNext();
      }
    }

    // Otherwise, queue it
    return new Promise((resolve, reject) => {
      this.queue.push({ task, resolve, reject });
      this.stats.queued++;
    });
  }

  async processNext() {
    if (this.queue.length === 0 || this.running >= this.maxConcurrent) {
      return;
    }

    const { task, resolve, reject } = this.queue.shift();
    this.running++;

    try {
      const result = await task();
      this.stats.processed++;
      resolve(result);
    } catch (err) {
      this.stats.errors++;
      reject(err);
    } finally {
      this.running--;
      this.processNext();
    }
  }

  getStats() {
    return {
      running: this.running,
      queued: this.queue.length,
      ...this.stats
    };
  }
}

// Initialize queue with smart limits
const MAX_CONCURRENT_PROCESSES = parseInt(process.env.MAX_CONCURRENT_PROCESSES || 20);
const extractionQueue = new ProcessQueue(MAX_CONCURRENT_PROCESSES);

console.log(`🔧 Process queue initialized: Max ${MAX_CONCURRENT_PROCESSES} concurrent yt-dlp processes`);

// ============================================
// REDIS SETUP
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
        return null;
      }
      return Math.min(times * 50, 2000);
    },
    maxRetriesPerRequest: 3,
    lazyConnect: true
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

const limiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  message: { error: 'Too many requests. Please wait 1 minute.' },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', (req, res) => {
  const queueStats = extractionQueue.getStats();
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    redis: redis && redisConnected ? 'connected' : 'memory-cache',
    queue: queueStats,
    timestamp: new Date().toISOString()
  });
});

// ============================================
// MAIN API - With Process Queue Protection
// ============================================
app.get('/api/getVideoJson', async (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) {
    return res.status(400).json({ error: 'videoId is required' });
  }

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const cacheKey = `video:${videoId}`;

  // Increment stats
  if (redis && redisConnected) {
    try {
      await redis.incr('stats:total_requests');
    } catch (err) {}
  }

  // 1. Check cache first (IMPORTANT: Reduces queue load!)
  const cached = await getCached(cacheKey);
  if (cached) {
    console.log('✅ Cache HIT:', videoId);
    return res.json({ ...cached, cached: true });
  }

  console.log('⏳ Cache MISS, queueing extraction:', videoId);

  // 2. Queue the extraction (CRITICAL: Prevents process explosion!)
  try {
    const result = await extractionQueue.add(async () => {
      return await extractVideoInfo(url, videoId);
    });

    res.json(result);
  } catch (err) {
    console.error('❌ Extraction error:', err);
    res.status(500).json({ 
      error: err.message || 'Failed to extract video information' 
    });
  }
});

// ============================================
// EXTRACTION FUNCTION (Queue-controlled)
// ============================================
async function extractVideoInfo(url, videoId) {
  const os = require('os');
  const ytDlpExecutable = os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  const ytDlpPath = path.join(__dirname, ytDlpExecutable);

  if (!fs.existsSync(ytDlpPath)) {
    throw new Error('yt-dlp binary not found. Run: node download-ytdlp.js');
  }

  const ytDlpArgs = [
    '-J',
    '--no-playlist',
    '--skip-download',
    '--no-warnings',
    '--geo-bypass',
    url
  ];

  return new Promise((resolve, reject) => {
    const ytDlpProcess = spawn(ytDlpPath, ytDlpArgs, {
      timeout: 30000
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

          const formats = info.formats
            .filter(f => f.ext === 'mp4' || f.ext === 'webm' || f.ext === 'm4a')
            .map(f => ({
              format_id: f.format_id,
              ext: f.ext,
              resolution: f.resolution || f.format_note || 'Audio Only',
              filesize: f.filesize || f.filesize_approx || 0,
              url: f.url,
              vcodec: f.vcodec !== 'none' ? f.vcodec : null,
              acodec: f.acodec !== 'none' ? f.acodec : null,
              quality: f.quality || 0,
              fps: f.fps,
              tbr: f.tbr
            }))
            .sort((a, b) => {
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
            url_expires_in: '6 hours',
            extracted_at: new Date().toISOString()
          };

          // Cache for 5 hours
          await setCached(`video:${videoId}`, result, 5 * 60 * 60);

          console.log(`✅ Extracted: ${info.title} (${formats.length} formats)`);
          resolve(result);

        } catch (e) {
          console.error('❌ Parse error:', e);
          reject(new Error('Failed to parse video data'));
        }
      } else {
        console.error(`❌ yt-dlp error (code ${code}):`, stderrData);
        
        let errorMsg = 'Failed to extract video information';
        if (stderrData.includes('Video unavailable')) {
          errorMsg = 'Video is unavailable or private';
        } else if (stderrData.includes('Sign in')) {
          errorMsg = 'Video requires authentication';
        } else if (stderrData.includes('blocked')) {
          errorMsg = 'Video is blocked in your region';
        }

        reject(new Error(errorMsg));
      }
    });

    ytDlpProcess.on('error', (err) => {
      console.error('❌ Spawn error:', err);
      reject(new Error('Failed to start video extraction'));
    });
  });
}

// ============================================
// SMART DOWNLOAD PROXY
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
// STATS ENDPOINT
// ============================================
app.get('/api/stats', async (req, res) => {
  const queueStats = extractionQueue.getStats();
  
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
        queue: queueStats,
        memory_usage: process.memoryUsage(),
        uptime: Math.round(process.uptime())
      });
    } else {
      res.json({
        cache_type: 'memory',
        cache_size: memoryCache.size,
        queue: queueStats,
        memory_usage: process.memoryUsage(),
        uptime: Math.round(process.uptime())
      });
    }
  } catch (err) {
    res.json({ 
      error: 'Stats unavailable',
      queue: queueStats
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
║   🚀 YT Downloader Backend (PRODUCTION)║
║   Port: ${port}                        ║
║   Environment: ${process.env.NODE_ENV || 'development'}       ║
║   Cache: ${redis && redisConnected ? '✅ Redis' : '⚠️  Memory'}              ║
║   Max Processes: ${MAX_CONCURRENT_PROCESSES}                  ║
╚════════════════════════════════════════╝
  `);
  console.log(`📍 Health check: http://localhost:${port}/health`);
  console.log(`📊 Stats: http://localhost:${port}/api/stats`);
  console.log(`🔒 Process queue active: Max ${MAX_CONCURRENT_PROCESSES} concurrent extractions`);
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

module.exports = app;
