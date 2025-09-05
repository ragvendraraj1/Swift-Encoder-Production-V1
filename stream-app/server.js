/**
 * DeckLink -> RTMP/RTMPS streamer (with login + lock)
 */
const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const morgan = require('morgan');
const dayjs = require('dayjs');
const session = require('express-session');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT   = process.env.PORT || 3000;
const FFMPEG = process.env.FFMPEG_PATH || '/usr/local/bin/ffmpeg';
const DEVICE = process.env.DECKLINK_DEVICE || 'DeckLink Mini Recorder HD';

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';

const LOG_DIR = path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

app.use(express.json({ limit: '5mb' }));
app.use(morgan('dev'));
app.use(session({
  name: 'dlrtmp.sid',
  secret: process.env.SESSION_SECRET || 'change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 24*60*60*1000 }
}));

// ---------- Auth helpers ----------
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) return next();
  if (req.accepts('html')) return res.redirect('/login');
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

// ---------- Public (no-auth) routes ONLY for login page assets ----------
app.get('/login', (req, res) => {
  if (req.session && req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});
// Whitelist CSS (and optional favicon) so the login page can load styles
app.get('/style.css', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'style.css'));
});
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------- Auth endpoints ----------
app.post('/auth/login', (req, res) => {
  const { username, password } = req.body || {};
  if (username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authenticated = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: 'Invalid credentials' });
});
app.post('/auth/logout', requireAuth, (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

// ---------- Protected static (dashboard) ----------
app.use('/', requireAuth, express.static(path.join(__dirname, 'public')));

// ---------- Stream process ----------
let proc = null;
let lastArgs = [];
let panelLocked = false;

let status = {
  running: false,
  startTime: null,
  uptimeSec: 0,
  fps: 0,
  bitrate: '0kbits/s',
  frame: 0,
  logFile: null,
  lastMsg: '',
  sdi: 'unknown',
  live: false,
  locked: false
};

function buildOutputUrl(base, key) {
  if (!base || !key) return null;
  let url = base.replace(/\/+$/,'') + '/' + key.replace(/^\/+/, '');
  if (/^rtmps?:\/\//i.test(url) && !/[?&]rtmp_live=1\b/i.test(url)) {
    url += (url.includes('?') ? '&' : '?') + 'rtmp_live=1';
  }
  return url;
}

function buildArgs(opts) {
  const { ytUrl, ytKey, fbUrl, fbKey } = opts;
  const targets = [];
  const yt = buildOutputUrl(ytUrl, ytKey);
  const fb = buildOutputUrl(fbUrl, fbKey);
  if (yt) targets.push(`[f=flv:onfail=ignore]${yt}`);
  if (fb) targets.push(`[f=flv:onfail=ignore]${fb}`);

  return {
    args: [
      '-hide_banner','-loglevel','info',
      '-probesize','50M','-analyzeduration','2M',
      '-thread_queue_size','2048','-use_wallclock_as_timestamps','1',
      '-fflags','+genpts',
      '-f','decklink','-i', DEVICE,
      '-map','0:v:0','-map','0:a:0',
      '-c:v','libx264','-pix_fmt','yuv420p','-preset','veryfast','-tune','zerolatency',
      '-profile:v','high','-b:v','4500k','-maxrate','4500k','-bufsize','9000k',
      '-c:a','aac','-ar','48000','-b:a','128k','-ac','2',
      '-flvflags','+no_duration_filesize',
      '-flush_packets','1','-f','tee', targets.join('|')
    ]
  };
}

function startFFmpeg(opts) {
  if (proc) throw new Error('Already running');

  const startTs = dayjs().format('YYYYMMDD-HHmmss');
  const logFile = path.join(LOG_DIR, `ffmpeg-${startTs}.log`);
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });

  const built = buildArgs(opts);
  lastArgs = built.args.slice();

  const p = spawn(FFMPEG, built.args, { stdio: ['ignore','pipe','pipe'] });
  p.on('error', (err) => console.error('[ffmpeg spawn error]', err));

  status.running = true;
  status.startTime = Date.now();
  status.logFile = logFile;
  status.frame = 0; status.fps = 0; status.bitrate = '0kbits/s';
  status.sdi = 'unknown'; status.live = false;

  p.stdout.on('data', (d) => logStream.write(d.toString()));
  p.stderr.on('data', (d) => {
    const s = d.toString();
    status.lastMsg = s.trim();
    logStream.write(s);

    if (/No input signal detected/i.test(s)) status.sdi = 'no_signal';
    if (/Input returned/i.test(s)) status.sdi = 'ok';

    const mFrame = s.match(/frame=\s*(\d+)/);
    const mFps   = s.match(/fps=\s*([\d.]+)/);
    const mBr    = s.match(/bitrate=\s*([^\s]+)/);
    if (mFrame) { status.frame = parseInt(mFrame[1],10); if (status.frame>0){ status.live=true; if(status.sdi==='unknown') status.sdi='ok'; } }
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

// ---------- API (protected) ----------
app.post('/api/start', requireAuth, (req, res) => {
  try {
    if (panelLocked) return res.status(423).json({ ok:false, error:'Panel is locked' });
    if (proc) return res.status(409).json({ ok:false, error:'Already running' });

    const { ytUrl, ytKey, fbUrl, fbKey } = req.body || {};
    const ytOk = !!(ytUrl && ytKey);
    const fbOk = !!(fbUrl && fbKey);
    if (!ytOk && !fbOk) return res.status(400).json({ ok:false, error:'Provide YouTube or Facebook URL+Key' });
    const isBase = (u) => /^rtmps?:\/\//.test(u);
    if (ytOk && !isBase(ytUrl)) return res.status(400).json({ ok:false, error:'YouTube URL must start with rtmp(s)://' });
    if (fbOk && !isBase(fbUrl)) return res.status(400).json({ ok:false, error:'Facebook URL must start with rtmps://' });

    startFFmpeg({ ytUrl, ytKey, fbUrl, fbKey });
    return res.json({ ok:true });
  } catch (e) { return res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/stop', requireAuth, async (_req, res) => {
  try { await stopFFmpeg(); return res.json({ ok:true }); }
  catch (e) { return res.status(500).json({ ok:false, error:e.message }); }
});

app.post('/api/lock', requireAuth, (_req, res) => { panelLocked = true; status.locked = true; return res.json({ ok:true }); });
app.post('/api/unlock', requireAuth, (req, res) => {
  const { password } = req.body || {};
  if (password !== ADMIN_PASS) return res.status(401).json({ ok:false, error:'Invalid password' });
  panelLocked = false; status.locked = false; return res.json({ ok:true });
});

app.get('/api/status', requireAuth, (_req, res) => {
  const now = Date.now();
  if (status.running && status.startTime) status.uptimeSec = Math.floor((now - status.startTime)/1000);
  status.locked = panelLocked;
  res.json({ ...status, device: DEVICE });
});

// Debug helpers
app.get('/api/args', requireAuth, (_req, res) => res.json({ ffmpeg: FFMPEG, device: DEVICE, args: lastArgs }));
app.get('/api/log', requireAuth, (_req, res) => {
  if (!status.logFile || !fs.existsSync(status.logFile)) return res.status(404).send('No log yet');
  try {
    const raw = fs.readFileSync(status.logFile, 'utf8');
    res.type('text/plain').send(raw.split('\n').slice(-300).join('\n'));
  } catch (e) { res.status(500).send(String(e)); }
});

io.on('connection', (socket) => {
  const t = setInterval(() => {
    const now = Date.now();
    if (status.running && status.startTime) status.uptimeSec = Math.floor((now - status.startTime)/1000);
    socket.emit('status', { ...status, locked: panelLocked, device: DEVICE });
  }, 1000);
  socket.on('disconnect', () => clearInterval(t));
});

server.listen(PORT, () => {
  console.log(`DeckLink Stream UI at http://0.0.0.0:${PORT}`);
  console.log(`Using device: "${DEVICE}" | FFmpeg: ${FFMPEG}`);
});
