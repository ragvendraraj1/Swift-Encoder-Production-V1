const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const { spawn, exec } = require("child_process");
const helmet = require("helmet");

const app = express();
const PORT = process.env.PORT || 5000;
const CONFIG_PATH = path.join(__dirname, "config", "config.json");

// Log directory (can be overridden via env)
const LOG_DIR = process.env.SWIFT_ENCODER_LOG_DIR || "/var/log/swift-encoder";
const STDERR_LOG = path.join(LOG_DIR, "ffmpeg-stderr.log");

// Ensure log directory exists (best-effort)
try {
  fs.mkdirSync(LOG_DIR, { recursive: true });
} catch (e) {
  console.error(`Failed to create log dir ${LOG_DIR}: ${e.message}`);
}

function appendStderrLog(data) {
  try {
    fs.appendFileSync(STDERR_LOG, data);
  } catch (e) {
    // If writing to /var/log fails (permission), still continue — we surface to in-memory logs/SSE
    console.error("Failed to append ffmpeg stderr to log file:", e.message);
  }
}

// SAFETY SWITCHES (require sudoers if you enable them)
const ALLOW_NET_CHANGES = process.env.ALLOW_NET_CHANGES === "1";

const FFMPEG = process.env.FFMPEG_PATH || "/usr/local/bin/ffmpeg";
const DEFAULT_DECK_NAME = process.env.DECK_NAME || "DeckLink Mini Recorder HD";
const DECKLINK_DEVICES = [
  "DeckLink Mini Recorder HD",
  "DeckLink Mini Recorder 4K",
  "DeckLink SDI 4K",
  "DeckLink Studio 4K",
  "DeckLink Duo 2"
];
const AUTHOR = "S S Raghavendra";

// runtime state
let ffmpegProc = null;
let ffmpegStartedAt = null;
let unexpectedExit = false;
let restartAttempts = 0;
const MAX_RESTARTS = 10;
let backoffMs = 2000;

// log ring buffer + SSE clients
const LOG_MAX = 2000;
let LOGS = [];
const clients = new Set();
function logPush(line) {
  const ts = new Date().toISOString();
  const entry = `[${ts}] ${line}`;
  LOGS.push(entry);
  if (LOGS.length > LOG_MAX) LOGS = LOGS.slice(LOGS.length - LOG_MAX);
  clients.forEach((res) => res.write(`data: ${JSON.stringify({ line: entry })}\n\n`));
  // Also append raw ffmpeg stderr lines to persistent stderr log
  // We only append ffmpeg lines in the stderr handler below, so this is safe to call here too.
  // appendStderrLog(entry + "\n");
}

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}
function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function getDeckName(cfg) {
  return cfg.decklinkDevice || DEFAULT_DECK_NAME;
}

function getAdminCredentials(cfg) {
  return {
    username: cfg.adminUsername || "admin",
    password: cfg.adminPassword || "admin"
  };
}

// Helpers: build full URLs from server+key pairs
function buildPlatformUrl(base, key) {
  const server = (base || "").trim();
  const streamKey = (key || "").trim();
  if (!server) return "";
  if (!streamKey) return server;
  return server.replace(/\/+$/, "") + "/" + streamKey.replace(/^\/+/, "");
}

function enforceUrlProtocol(url, protocol) {
  const value = (url || "").trim();
  if (!value) return "";
  if (/^rtmps?:\/\//i.test(value)) {
    return value.replace(/^rtmps?:\/\//i, `${protocol}://`);
  }
  return value;
}

function isPlatformEnabled(cfg, field) {
  return cfg[field] !== false;
}

function deriveUrls(cfg) {
  // Backwards compatible legacy single target
  const legacy = (cfg.targetUrl || "").trim();

  const yt = isPlatformEnabled(cfg, "youtubeEnabled")
    ? buildPlatformUrl(enforceUrlProtocol(cfg.youtubeServerUrl, "rtmp"), cfg.youtubeStreamKey)
    : "";
  const fb = isPlatformEnabled(cfg, "facebookEnabled")
    ? buildPlatformUrl(enforceUrlProtocol(cfg.facebookServerUrl, "rtmps"), cfg.facebookStreamKey)
    : "";

  // If nothing new is configured, fall back to legacy for "primary"
  const primary = yt || fb || legacy;

  return { primary, youtube: yt, facebook: fb };
}

// Build ffmpeg command from config
function buildFfmpegArgs(cfg) {
  const modeMap = {
    "1080i50": { format: "Hi50", fps: 25, interlaced: true },
    "1080i59.94": { format: "Hi59", fps: 29.97, interlaced: true },
    "1080p25": { format: "Hp25", fps: 25, interlaced: false },
    "1080p29.97": { format: "Hp29", fps: 29.97, interlaced: false },
    "720p50": { format: "Hp50", fps: 50, interlaced: false },
    "720p59.94": { format: "Hp59", fps: 59.94, interlaced: false },
    "625iPAL": { format: "pal", fps: 25, interlaced: true },
    "576i50": { format: "Hi25", fps: 25, interlaced: true },
    "480i59.94": { format: "Hi29", fps: 29.97, interlaced: true }
  };
  const sel = modeMap[cfg.resolution] || modeMap["1080i50"];
  const gop = Math.round((sel.fps || 25) * 2);

  const vbit = (cfg.vbitrate || process.env.VBITRATE || "2500k").toString();

  // choose codecs from config (fallbacks)
  const videoCodec = cfg.videoCodec || "libx264";
  const audioCodec = cfg.audioCodec || "aac";

  // Input (DeckLink)
  const baseArgs = [
    "-hide_banner",
    "-loglevel",
    "info",
    "-f",
    "decklink",
    "-video_input",
    "sdi",
    "-audio_input",
    "embedded",
    "-format_code",
    sel.format,
    "-i",
    getDeckName(cfg)
  ];

  // Per-output Video args (we'll duplicate per output for RTMP_MULTI)
  const vArgs = [
    "-c:v",
    videoCodec,
    "-pix_fmt",
    "yuv420p",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-b:v",
    vbit,
    "-maxrate",
    vbit,
    "-bufsize",
    (parseInt(vbit) * 2 || 5000) + "k",
    "-g",
    String(gop)
  ];

  // x264 specific params only when using libx264
  if (videoCodec === "libx264") {
    vArgs.push("-x264-params", `scenecut=0:open_gop=0:keyint=${gop}:min-keyint=${gop}`);
    if (sel.interlaced) vArgs.push("-flags", "+ilme+ildct", "-top", "1");
  } else {
    // keep interlaced flags for others if needed
    if (sel.interlaced) vArgs.push("-flags", "+ilme+ildct", "-top", "1");
  }

  // Per-output audio args
  const aArgs = ["-c:a", audioCodec, "-b:a", "128k", "-ar", "48000", "-ac", "2"];

  const urls = deriveUrls(cfg);
  const proto = (cfg.protocol || "RTMP_MULTI").toUpperCase();
  const port = (cfg.port || "").trim();
  const ttl = (cfg.ttl || "").trim();

  const args = [...baseArgs];

  // Media RTMP outputs: duplicate encoders per enabled output for reliability.
  if (proto === "RTMP_MULTI" || proto === "RTMP" || proto === "RTMPLIVE" || proto === "RTMPS") {
    const outputs = [];
    if (urls.youtube) outputs.push(urls.youtube);
    if (urls.facebook) outputs.push(urls.facebook);
    if (!outputs.length) {
      throw new Error("At least one media URL (YouTube or Facebook) is required for RTMP multi-output");
    }

    // For each output append encoder options followed by url
    outputs.forEach((outUrl) => {
      args.push(...vArgs, ...aArgs, "-f", "flv", outUrl);
    });

  } else if (proto === "HLS") {
    const target = urls.primary || "/var/www/html/stream.m3u8";
    args.push(...vArgs, ...aArgs, "-f", "hls", "-hls_time", "2", "-hls_list_size", "6", "-hls_flags", "delete_segments+append_list", target);

  } else if (proto === "HTTP" || proto === "HTTPS") {
    const target = urls.primary || "/tmp/stream.ts";
    const outArgs = target.startsWith("http://") || target.startsWith("https://") ? ["-method", "PUT", "-f", "mpegts", target] : ["-f", "mpegts", target];
    args.push(...vArgs, ...aArgs, ...outArgs);

  } else if (proto === "UDP") {
    if (!urls.primary || !port) throw new Error("UDP requires IP and Port");
    const out = `udp://${urls.primary}:${port}${ttl ? `?ttl=${ttl}` : ""}`;
    args.push(...vArgs, ...aArgs, "-f", "mpegts", out);

  } else if (proto === "RTP") {
    if (!urls.primary || !port) throw new Error("RTP requires IP and Port");
    const out = `rtp://${urls.primary}:${port}`;
    args.push(...vArgs, ...aArgs, "-f", "rtp_mpegts", out);

  } else if (proto === "SRT") {
    let srtOut = urls.primary;
    if (!srtOut.startsWith("srt://")) {
      if (!urls.primary || !port) throw new Error("SRT requires host/IP and Port (or a full srt:// URL)");
      srtOut = `srt://${urls.primary}:${port}?mode=caller&latency=120&rcvlatency=120&pkt_size=1316`;
    }
    args.push(...vArgs, ...aArgs, "-f", "mpegts", srtOut);

  } else {
    throw new Error(`Unsupported protocol: ${proto}`);
  }

  return args;
}

// Middleware / static
app.use(helmet({ contentSecurityPolicy: false }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || "swift-encoder-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));
app.use("/public", express.static(path.join(__dirname, "public")));

function requireAuth(req, res, next) {
  if (req.session && req.session.authed) return next();
  return res.redirect("/login");
}

// Views / auth
app.get("/login", (req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  const cfg = readConfig();
  const admin = getAdminCredentials(cfg);
  if (username === admin.username && password === admin.password) {
    req.session.authed = true;
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Invalid credentials" });
});
app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
app.get("/", requireAuth, (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

// Config APIs
app.get("/api/config", requireAuth, (req, res) => {
  try {
    const cfg = readConfig();
    const urls = deriveUrls(cfg);
    return res.json({ ...cfg, primaryUrl: urls.primary });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});
app.post("/api/config", requireAuth, (req, res) => {
  try {
    const old = readConfig();
    const merged = { ...old, ...req.body };

    // normalize net to single-nic array
    if (req.body.net && !Array.isArray(req.body.net)) merged.net = [req.body.net];
    else if (Array.isArray(req.body.net)) merged.net = req.body.net;

    if (req.body.decklinkDevice && !DECKLINK_DEVICES.includes(req.body.decklinkDevice)) {
      return res.status(400).json({ ok: false, error: "Unsupported DeckLink device." });
    }

    if ("youtubeEnabled" in req.body) merged.youtubeEnabled = !!req.body.youtubeEnabled;
    if ("facebookEnabled" in req.body) merged.facebookEnabled = !!req.body.facebookEnabled;

    if ("youtubeServerUrl" in req.body) {
      merged.youtubeServerUrl = enforceUrlProtocol(req.body.youtubeServerUrl, "rtmp");
    }
    if ("facebookServerUrl" in req.body) {
      merged.facebookServerUrl = enforceUrlProtocol(req.body.facebookServerUrl, "rtmps");
    }

    // maintain targetUrl for legacy
    const urls = deriveUrls(merged);
    merged.targetUrl = urls.primary || merged.targetUrl || "";

    writeConfig(merged);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Device info (rich)
app.get("/api/device-info", requireAuth, (req, res) => {
  const cfg = readConfig();
  const urls = deriveUrls(cfg);
  const info = {
    author: AUTHOR,
    copyright: "Copyright SWIFT-ENCODER",
    currentConfig: {
      protocol: cfg.protocol,
      url: urls.primary,
      resolution: cfg.resolution,
      decklinkDevice: getDeckName(cfg),
      vbitrate: cfg.vbitrate,
      autoRestart: !!cfg.autoRestart
    }
  };
  const commands = [
    `${FFMPEG} -hide_banner -f decklink -list_devices 1 -i dummy 2>&1`,
    "lscpu | sed -n '1,10p'",
    "free -h",
    "df -h / | tail -n +2",
    "uname -r",
    `${FFMPEG} -version | head -n 1`,
    "lspci | grep -i -E 'blackmagic|decklink' || true"
  ];
  exec(commands.join(" ; echo '---SEP---'; "), (err, stdout, stderr) => {
    const out = (stdout || stderr || "").split("---SEP---");
    info.decklinkDevices = out[0]?.trim();
    info.cpu = out[1]?.trim();
    info.memory = out[2]?.trim();
    info.disk = out[3]?.trim();
    info.kernel = out[4]?.trim();
    info.ffmpeg = out[5]?.trim();
    info.pci = out[6]?.trim();
    return res.json(info);
  });
});

// Video signal probe
app.get("/api/video-signal", requireAuth, (req, res) => {
  const deckName = getDeckName(readConfig()).replace(/"/g, '\\"');
  const cmd = `${FFMPEG} -hide_banner -nostdin -loglevel info -f decklink -i "${deckName}" -t 1 -vframes 1 -f null - 2>&1`;
  exec(cmd, { timeout: 6000 }, (err, stdout, stderr) => {
    const out = stdout || stderr || "";
    const hasNoSignal = /No input signal/i.test(out) || /Could not/gi.test(out);
    const modeMatch = out.match(/Input.*?format.*?:\s*([A-Za-z0-9pif\.]+).*?(\d+(?:\.\d+)?)\s?Hz/i) || out.match(/video:\s*([0-9xip\.]+)/i);
    return res.json({
      detected: !hasNoSignal,
      mode: modeMatch ? modeMatch[1] || modeMatch[0] : "Unknown",
      raw: out.slice(-2000)
    });
  });
});

// Networking: single NIC settings
app.get("/api/network", requireAuth, (req, res) => {
  const cfg = readConfig();
  const netArray = cfg.net || [];
  const nic = netArray[0] || { interface: "", mode: "dhcp", address: "", gateway: "", dns: "8.8.8.8,8.8.4.4" };
  return res.json({ net: nic });
});
app.post("/api/network/apply", requireAuth, (req, res) => {
  if (!ALLOW_NET_CHANGES) return res.status(403).json({ ok: false, error: "Network changes disabled by server." });
  const { nic } = req.body;
  if (!nic || !nic.interface) return res.status(400).json({ ok: false, error: "Missing NIC payload." });
  try {
    const file = `/etc/netplan/99-swift-encoder-${nic.interface}.yaml`;
    let yaml;
    if (nic.mode === "dhcp") {
      yaml = `network:
  version: 2
  renderer: networkd
  ethernets:
    ${nic.interface}:
      dhcp4: true
      nameservers:
        addresses: [${(nic.dns || "8.8.8.8,8.8.4.4").split(",").join(", ")}]
`;
    } else {
      yaml = `network:
  version: 2
  renderer: networkd
  ethernets:
    ${nic.interface}:
      dhcp4: false
      addresses: [${nic.address}]
      gateway4: ${nic.gateway}
      nameservers:
        addresses: [${(nic.dns || "8.8.8.8,8.8.4.4").split(",").join(", ")}]
`;
    }
    const tmp = path.join(__dirname, "config", `99-swift-encoder-${nic.interface}.yaml`);
    fs.writeFileSync(tmp, yaml);
    exec(`sudo mv "${tmp}" "${file}" && sudo netplan apply`, (err, stdout, stderr) => {
      if (err) return res.status(500).json({ ok: false, error: stderr || err.message });
      return res.json({ ok: true, message: `Netplan applied for ${nic.interface}`, stdout, stderr });
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Encoder controller
function startFfmpeg() {
  if (ffmpegProc) return { ok: true, already: true };
  const cfg = readConfig();
  let args;
  try {
    args = buildFfmpegArgs(cfg);
  } catch (e) {
    logPush(`[config] ${e.message}`);
    return { ok: false, error: e.message };
  }

  logPush(`[ffmpeg] launching: ${FFMPEG} ${args.join(" ")}`);

  try {
    ffmpegProc = spawn(FFMPEG, args, { stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    logPush(`[ffmpeg] spawn error: ${err.message}`);
    return { ok: false, error: err.message };
  }

  ffmpegStartedAt = Date.now();
  unexpectedExit = true;

  ffmpegProc.stdout.on("data", (d) => {
    const s = d.toString().trimEnd();
    logPush(s);
    // we don't append stdout to the stderr file
  });

  ffmpegProc.stderr.on("data", (d) => {
    const s = d.toString();
    // push to UI logs
    logPush(s.trimEnd());
    // append to persistent stderr file for later inspection
    appendStderrLog(s);
  });

  ffmpegProc.on("error", (err) => {
    logPush(`[ffmpeg] process error: ${err.message}`);
    appendStderrLog(`[ffmpeg error] ${err.message}\n`);
  });

  ffmpegProc.on("close", (code, signal) => {
    logPush(`[ffmpeg] exited (code=${code} signal=${signal})`);
    const wasUnexpected = unexpectedExit;
    ffmpegProc = null;
    ffmpegStartedAt = null;
    if (wasUnexpected && readConfig().autoRestart) {
      if (restartAttempts < MAX_RESTARTS) {
        restartAttempts++;
        const wait = Math.min(backoffMs * restartAttempts, 15000);
        logPush(`[watchdog] restarting in ${wait} ms (attempt ${restartAttempts}/${MAX_RESTARTS})`);
        setTimeout(() => startFfmpeg(), wait);
      } else {
        logPush("[watchdog] max restart attempts reached; holding.");
      }
    } else {
      restartAttempts = 0;
    }
  });

  return { ok: true };
}
function stopFfmpeg() {
  if (!ffmpegProc) return { ok: true, already: true };
  unexpectedExit = false;
  try {
    ffmpegProc.kill("SIGTERM");
    setTimeout(() => ffmpegProc && ffmpegProc.kill("SIGKILL"), 4000);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

app.post("/api/encode/start", requireAuth, (req, res) => {
  const r = startFfmpeg();
  if (!r.ok) return res.status(400).json(r);
  return res.json({ ok: true });
});
app.post("/api/encode/stop", requireAuth, (req, res) => {
  const r = stopFfmpeg();
  if (!r.ok) return res.status(400).json(r);
  return res.json({ ok: true });
});
app.get("/api/status", requireAuth, (req, res) => {
  res.json({ running: !!ffmpegProc, pid: ffmpegProc?.pid || null, startedAt: ffmpegStartedAt, autoRestart: !!readConfig().autoRestart });
});
app.post("/api/autorestart", requireAuth, (req, res) => {
  try { const cfg = readConfig(); cfg.autoRestart = !!req.body.autoRestart; writeConfig(cfg); return res.json({ ok: true, autoRestart: cfg.autoRestart }); }
  catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
});

app.post("/api/admin/password", requireAuth, (req, res) => {
  try {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    if (!newPassword || newPassword.length < 4) {
      return res.status(400).json({ ok: false, error: "New password must be at least 4 characters." });
    }
    if (newPassword !== confirmPassword) {
      return res.status(400).json({ ok: false, error: "Confirm password does not match." });
    }

    const cfg = readConfig();
    const admin = getAdminCredentials(cfg);
    if (currentPassword !== admin.password) {
      return res.status(401).json({ ok: false, error: "Current password is incorrect." });
    }

    cfg.adminUsername = admin.username;
    cfg.adminPassword = newPassword;
    writeConfig(cfg);
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// Logs SSE
app.get("/api/logs", requireAuth, (req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  LOGS.slice(-300).forEach(line => res.write(`data: ${JSON.stringify({ line })}\n\n`));
  clients.add(res);
  req.on("close", () => clients.delete(res));
});
app.get("/api/logs/clear", requireAuth, (req, res) => { LOGS = []; return res.json({ ok: true }); });

app.listen(PORT, () => console.log(`Swift Encoder UI running at http://0.0.0.0:${PORT}`));
