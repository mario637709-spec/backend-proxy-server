const path = require('path');
const backendModules = path.join(__dirname, 'backend', 'node_modules');

const express = require(path.join(backendModules, 'express'));
const cors = require(path.join(backendModules, 'cors'));
const https = require('https');
const http = require('http');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 8080;

app.get(['/health', '/'], (req, res) => {
  res.json({ status: 'active', engine: 'Residential Fetch Proxy (Zero Timeout Native Stream)' });
});

function extractYouTubeVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  let str = input.trim();

  try {
    str = decodeURIComponent(str);
  } catch (e) {}

  // If input contains multiple URLs or prefix, extract the last valid 11-char ID
  const matches = str.match(/([a-zA-Z0-9_-]{11})/g);
  if (matches && matches.length > 0) {
    // Check from last to first for valid video ID pattern
    for (let i = matches.length - 1; i >= 0; i--) {
      const candidate = matches[i];
      if (/^[a-zA-Z0-9_-]{11}$/.test(candidate) && candidate !== 'watch' && candidate !== 'shorts') {
        return candidate;
      }
    }
  }

  return null;
}

// ✅ Tunnel Fallback Video Extraction Endpoint
app.get('/api/getVideoJson', (req, res) => {
  const rawInput = req.query.videoId || req.query.url;
  if (!rawInput) return res.status(400).json({ error: 'videoId required' });

  const videoId = extractYouTubeVideoId(rawInput);
  if (!videoId) return res.status(400).json({ error: 'Invalid YouTube Video ID or URL' });

  const url = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(`⚡ [Tunnel Extraction Request] -> ${url}`);

  const pyScript = path.join(__dirname, 'backend', 'yt_fetch.py');
  
  // Try 'py' first on Windows, fallback to 'python' or 'python3'
  const pythonCmd = process.platform === 'win32' ? 'py' : 'python3';
  const pyProcess = spawn(pythonCmd, [pyScript, url]);

  let stdoutData = '';
  let stderrData = '';

  pyProcess.stdout.on('data', d => stdoutData += d.toString());
  pyProcess.stderr.on('data', d => stderrData += d.toString());

  pyProcess.on('close', code => {
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

        console.log(`✅ [Tunnel Extracted Successfully] -> "${info.title}" (${formats.length} formats)`);

        res.json({
          title: info.title,
          thumbnail: info.thumbnail,
          view_count: info.view_count,
          duration: info.duration_string || info.duration,
          uploader: info.uploader,
          upload_date: info.upload_date,
          formats: formats,
          extracted_via: 'Residential Laptop Tunnel'
        });
      } catch (err) {
        console.error('❌ JSON Parse Error on Laptop Proxy:', err.message);
        res.status(500).json({ error: 'Parse error on residential proxy' });
      }
    } else {
      console.error(`❌ Laptop Proxy Extraction Error (code ${code}):`, stderrData);
      res.status(500).json({ error: stderrData || 'Residential extraction failed' });
    }
  });
});

// Native HTTP/HTTPS reverse proxy with infinite socket timeout (setTimeout=0)
app.get('/proxy', (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).send('url parameter required');

  console.log(`🌐 [Proxy Fetch Stream] -> ${targetUrl.slice(0, 90)}`);

  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Invalid protocol');
    }
  } catch (err) {
    return res.status(400).send('Invalid URL format');
  }

  const client = parsedUrl.protocol === 'https:' ? https : http;

  const options = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': '*/*',
      'Accept-Encoding': 'identity'
    }
  };

  if (req.headers.range) {
    options.headers['Range'] = req.headers.range;
  }

  const proxyReq = client.get(targetUrl, options, (proxyRes) => {
    res.status(proxyRes.statusCode);

    const headersToForward = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition'];
    headersToForward.forEach(h => {
      if (proxyRes.headers[h]) {
        res.setHeader(h, proxyRes.headers[h]);
      }
    });

    proxyRes.pipe(res);

    proxyRes.on('error', (err) => {
      console.error('❌ Proxy Response Error:', err.message);
      if (!res.headersSent) res.status(500).send(err.message);
    });
  });

  // 120 second timeout instead of infinite
  proxyReq.setTimeout(120000);

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) res.status(504).send('Gateway Timeout');
  });

  proxyReq.on('error', (err) => {
    console.error('❌ Proxy Request Error:', err.message);
    if (!res.headersSent) res.status(500).send(err.message);
  });
  
  res.on('close', () => {
    proxyReq.destroy();
  });
});

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Residential Fetch Proxy running on http://0.0.0.0:${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`ℹ️ Proxy already active on http://127.0.0.1:${PORT}`);
  } else {
    console.error(err);
  }
});

// ✅ HTTP CONNECT Tunnel Handler (for HTTPS proxying by yt-dlp)
const net = require('net');
server.on('connect', (req, clientSocket, head) => {
  const [host, portStr] = req.url.split(':');
  const port = parseInt(portStr || '443', 10);

  console.log(`🔌 [CONNECT Tunnel] ${host}:${port}`);

  const targetSocket = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length > 0) targetSocket.write(head);
    targetSocket.pipe(clientSocket);
    clientSocket.pipe(targetSocket);
  });

  targetSocket.on('error', (err) => {
    console.error(`❌ CONNECT tunnel error: ${err.message}`);
    clientSocket.destroy();
  });

  clientSocket.on('error', () => targetSocket.destroy());
});
