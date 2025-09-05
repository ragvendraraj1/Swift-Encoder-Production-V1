/**
 * Minimal DeckLink -> RTMP/RTMPS streamer (no preview UI).
 * - Pass-through geometry & fps from the card (no scaling/deinterlace forcing)
 * - YouTube + Facebook via tee (one or both)
 * - Start/Stop API, status with SDI signal + LIVE
 * - Debug endpoints: /api/args, /api/log
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const morgan = require('morgan');
const dayjs = require('dayjs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT   = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
const DEVICE = process.env.DECKLINK_DEVICE || 'DeckLink Mini Recorder HD';

const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));
app.use('/', express.static(path.join(__dirname, 'public')));

let proc = null;
let lastArgs = [];
let status = {
  running: false,
  startTime: null,
  uptimeSec: 0,
  fps: 0,
  bitrate: '0kbits/s',
  frame: 0,
  endpoints: [],
  logFile: null,
  lastMsg: '',
  sdi: 'unknown',     // 'unknown' | 'no_signal' | 'ok'
  live: false         // true when frames > 0 while running
};

function joinRtmp(base, key) {
  if (!base) return null;
  const b = base.replace(/\/+$/,'');
  const k = (key||'').replace(/^\/+/, '');
  if (!k) return null;
  return `${b}/${k}`;
}

function buildArgs(opts) {
  const { ytUrl, ytKey, fbUrl, fbKey } = opts;

  const targets = [];
  const yt = joinRtmp(ytUrl, ytKey);
  const fb = joinRtmp(fbUrl, fbKey);
  if (yt) targets.push(`[f=flv:onfail=ignore]${yt}`);
  if (fb) targets.push(`[f=flv:onfail=ignore]${fb}`);

  // Always use tee so either or both can be active
  const args = [
    '-hide_banner',
    '-loglevel', 'info',
    '-probesize', '50M',
    '-analyzeduration', '2M',
    '-thread_queue_size', '2048',
    '-use_wallclock_as_timestamps', '1',
    '-fflags', '+genpts',
    '-f', 'decklink',
    '-i', DEVICE,

    // Explicit stream selection (tee needs streams)
    '-map', '0:v:0',
    '-map', '0:a:0',

    // Video encode (pass-through geometry/fps, just encode H.264)
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-preset', 'veryfast',
    '-tune', 'zerolatency',
    '-profile:v', 'high',
    '-b:v', '4500k',
    '-maxrate', '4500k',
    '-bufsize', '9000k',

    // Audio encode
    '-c:a', 'aac',
    '-ar', '48000',
    '-b:a', '128k',
    '-ac', '2',

    '-flush_packets', '1',
    '-f', 'tee',
    targets.join('|')
  ];

  return { args, endpoints: [yt, fb].filter(Boolean) };
}

function startFFmpeg(opts) {
  if (proc) throw new Error('Already running');

  const startTs = dayjs().format('YYYYMMDD-HHmmss');
  const logFile = path.join(LOG_DIR, `ffmpeg-${startTs}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const built = buildArgs(opts);
  lastArgs = built.args.slice();
  const p = spawn(FFMPEG, built.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  p.on('error', (err) => console.error('[ffmpeg spawn error]', err));

  status.running = true;
  status.startTime = Date.now();
  status.endpoints = built.endpoints;
  status.logFile = logFile;
  status.frame = 0;
  status.fps = 0;
  status.bitrate = '0kbits/s';
  status.sdi = 'unknown';
  status.live = false;

  p.stdout.on('data', (d) => logStream.write(d.toString()));
  p.stderr.on('data', (d) => {
    const s = d.toString();
    status.lastMsg = s.trim();
    logStream.write(s);

    // Detect SDI state
    if (/No input signal detected/i.test(s)) status.sdi = 'no_signal';
    if (/Input returned/i.test(s)) status.sdi = 'ok';

    // Parse progress
    const mFrame = s.match(/frame=\s*(\d+)/);
    const mFps   = s.match(/fps=\s*([\d.]+)/);
    const mBr    = s.match(/bitrate=\s*([^\s]+)/);
    if (mFrame) {
      status.frame = parseInt(mFrame[1], 10);
      if (status.frame > 0) {
        status.live = true;
        if (status.sdi === 'unknown') status.sdi = 'ok';
      }
    }
    if (mFps)   status.fps = parseFloat(mFps[1]);
    if (mBr)    status.bitrate = mBr[1];
  });

  p.on('exit', () => {
    logStream.end();
    proc = null;
    status.running = false;
    status.uptimeSec = 0;
    status.fps = 0;
    status.bitrate = '0kbits/s';
    status.frame = 0;
    status.live = false;
  });

  proc = p;
}

function stopFFmpeg() {
  return new Promise((resolve) => {
    if (!proc) return resolve();
    try {
      proc.once('exit', () => resolve());
      proc.kill('SIGTERM');
      setTimeout(() => { if (proc) proc.kill('SIGKILL'); }, 3000);
    } catch { resolve(); }
  });
}

// -------- API --------
app.post('/api/start', async (req, res) => {
  try {
    if (proc) return res.status(409).json({ ok: false, error: 'Already running' });

    const { ytUrl, ytKey, fbUrl, fbKey } = req.body || {};
    const ytOk = !!(ytUrl && ytKey);
    const fbOk = !!(fbUrl && fbKey);
    if (!ytOk && !fbOk) {
      return res.status(400).json({ ok: false, error: 'Provide at least one complete pair: (YouTube URL + Key) or (Facebook URL + Key)' });
    }
    const isBase = (u) => /^rtmps?:\/\//.test(u);
    if (ytOk && !isBase(ytUrl)) return res.status(400).json({ ok: false, error: 'YouTube URL must start with rtmp:// or rtmps://' });
    if (fbOk && !isBase(fbUrl)) return res.status(400).json({ ok: false, error: 'Facebook URL must start with rtmps:// or rtmp://' });

    startFFmpeg({ ytUrl, ytKey, fbUrl, fbKey });
    return res.json({ ok: true });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/stop', async (_req, res) => { await stopFFmpeg(); return res.json({ ok: true }); });

app.get('/api/status', (_req, res) => {
  const now = Date.now();
  if (status.running && status.startTime) status.uptimeSec = Math.floor((now - status.startTime) / 1000);
  res.json({ ...status, device: DEVICE });
});

// Debug helpers
app.get('/api/args', (_req, res) => res.json({ ffmpeg: FFMPEG, device: DEVICE, args: lastArgs, endpoints: status.endpoints }));
app.get('/api/log', (_req, res) => {
  if (!status.logFile || !fs.existsSync(status.logFile)) return res.status(404).send('No log yet');
  try {
    const raw = fs.readFileSync(status.logFile, 'utf8');
    const lines = raw.split('\n');
    const tail = lines.slice(-300).join('\n');
    res.type('text/plain').send(tail);
  } catch (e) { res.status(500).send(String(e)); }
});

io.on('connection', (socket) => {
  const t = setInterval(() => {
    const now = Date.now();
    if (status.running && status.startTime) status.uptimeSec = Math.floor((now - status.startTime) / 1000);
    socket.emit('status', status);
  }, 1000);
  socket.on('disconnect', () => clearInterval(t));
});

server.listen(PORT, () => {
  console.log(`DeckLink Stream UI at http://0.0.0.0:${PORT}`);
  console.log(`Using device: "${DEVICE}" | FFmpeg: ${FFMPEG}`);
});
