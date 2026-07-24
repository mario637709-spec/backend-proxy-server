const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const Redis = require('ioredis');

const app = express();

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Bypass-Tunnel-Reminder']
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

const inFlightMap = new Map();

app.get('/api/getVideoJson', async (req, res) => {
  const videoId = req.query.videoId;

  if (!videoId || typeof videoId !== 'string' || videoId.trim() === '') {
    return res.status(400).json({ error: 'videoId query parameter is required' });
  }

  const cacheKey = `yt_json:${videoId}`;
  const cachedData = await getCached(cacheKey);

  if (cachedData) {
    console.log('⚡ Redis/Memory Cache HIT for videoId:', videoId);
    return res.json({ ...cachedData, cached: true });
  }

  if (inFlightMap.has(videoId)) {
    console.log('⏳ Joining in-flight extraction request for videoId:', videoId);
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
  const tunnelUrl = process.env.TUNNEL_URL;

  if (tunnelUrl) {
    try {
      const cleanTunnel = (tunnelUrl.startsWith('http://') || tunnelUrl.startsWith('https://') ? tunnelUrl : `https://${tunnelUrl}`).replace(/\/+$/, '');
      const targetUrl = `${cleanTunnel}/api/getVideoJson?videoId=${videoId}${poToken ? `&poToken=${encodeURIComponent(poToken)}` : ''}`;
      console.log('🌐 Forwarding extraction to Laptop Tunnel Bridge:', targetUrl);
      
      process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

      const tunnelResponse = await fetch(targetUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Bypass-Tunnel-Reminder': 'true'
        },
        signal: AbortSignal.timeout(60000)
      });

      const data = await tunnelResponse.json();
      if (tunnelResponse.ok && data && (Array.isArray(data.formats) || data.title)) {
        await setCached(cacheKey, data);
        inFlightMap.delete(videoId);
        resolveInFlight(data);
        return res.json({ ...data, cached: false, tunneled: true });
      } else {
        console.warn('⚠️ Tunnel Bridge returned error:', data);
        inFlightMap.delete(videoId);
        rejectInFlight(new Error(data.error || 'Tunnel extraction failed'));
        return res.status(tunnelResponse.status || 500).json(data);
      }
    } catch (tunnelErr) {
      console.warn('⚠️ Tunnel Bridge connection failed:', tunnelErr.message);
      inFlightMap.delete(videoId);
      rejectInFlight(tunnelErr);
      return res.status(500).json({ error: `Tunnel bridge connection error: ${tunnelErr.message}` });
    }
  }

  return res.status(500).json({ error: 'TUNNEL_URL not configured' });
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Production Backend Proxy Server running on port ${PORT}`);
});
