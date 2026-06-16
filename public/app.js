// View switcher
const views = ["live","url","resolution","network","device","signal","admin"];
document.querySelectorAll(".item").forEach(btn => {
  btn.addEventListener("click", () => {
    views.forEach(v => document.getElementById(`view-${v}`).classList.add("hidden"));
    document.getElementById(`view-${btn.dataset.view}`).classList.remove("hidden");
  });
});

// Uptime clock
const start = Date.now();
setInterval(() => {
  const s = Math.floor((Date.now() - start)/1000);
  const mm = String(Math.floor(s/60)).padStart(2,"0");
  const ss = String(s%60).padStart(2,"0");
  document.getElementById("uptime").textContent = `${mm}:${ss}`;
}, 1000);

// Elements
const runStatus = document.getElementById("runStatus");
const startBtn = document.getElementById("startBtn");
const stopBtn  = document.getElementById("stopBtn");
const autoRestart = document.getElementById("autoRestart");
const logPre = document.getElementById("logs");
const clearLogs = document.getElementById("clearLogs");
const sigDot = document.getElementById("signalDot");
const sigText = document.getElementById("signalText");

// CONFIG LOAD
async function loadConfig() {
  const r = await fetch("/api/config");
  const cfg = await r.json();

  document.getElementById("protocol").value = cfg.protocol || "RTMP_MULTI";
  document.getElementById("playMode").value = cfg.playMode || "Live";

  document.getElementById("youtubeEnabled").checked = cfg.youtubeEnabled !== false;
  document.getElementById("ytServerUrl").value = cfg.youtubeServerUrl || "";
  document.getElementById("ytStreamKey").value = cfg.youtubeStreamKey || "";
  document.getElementById("facebookEnabled").checked = cfg.facebookEnabled !== false;
  document.getElementById("fbServerUrl").value = cfg.facebookServerUrl || "";
  document.getElementById("fbStreamKey").value = cfg.facebookStreamKey || "";

  document.getElementById("port").value = cfg.port || "";
  document.getElementById("ttl").value = cfg.ttl || "";
  document.getElementById("resolution").value = cfg.resolution || "1080i50";
  document.getElementById("decklinkDevice").value = cfg.decklinkDevice || "DeckLink Mini Recorder HD";
  document.getElementById("vbitrate").value = cfg.vbitrate || "2500k";

  // codec fields
  document.getElementById("videoCodec").value = cfg.videoCodec || "libx264";
  document.getElementById("audioCodec").value = cfg.audioCodec || "aac";

  autoRestart.checked = !!cfg.autoRestart;

  // Networking: single NIC
  renderSingleNic(cfg.net || (cfg.net && cfg.net[0]) ? cfg.net[0] : null);
}
loadConfig();

// Save URL + codec settings (includes vbitrate)
document.getElementById("saveUrl").addEventListener("click", async () => {
  const payload = {
    protocol: document.getElementById("protocol").value,
    playMode: document.getElementById("playMode").value,
    youtubeEnabled: document.getElementById("youtubeEnabled").checked,
    youtubeServerUrl: document.getElementById("ytServerUrl").value.trim(),
    youtubeStreamKey: document.getElementById("ytStreamKey").value.trim(),
    facebookEnabled: document.getElementById("facebookEnabled").checked,
    facebookServerUrl: document.getElementById("fbServerUrl").value.trim(),
    facebookStreamKey: document.getElementById("fbStreamKey").value.trim(),
    port: document.getElementById("port").value.trim(),
    ttl: document.getElementById("ttl").value.trim(),
    vbitrate: document.getElementById("vbitrate").value,
    videoCodec: document.getElementById("videoCodec").value,
    audioCodec: document.getElementById("audioCodec").value
  };
  const r = await fetch("/api/config", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
  const msg = document.getElementById("saveUrlMsg");
  if (r.ok) { msg.textContent = "Saved"; msg.classList.remove("error"); } else { msg.textContent = "Error saving"; msg.classList.add("error"); }
});

// Save device settings
document.getElementById("saveRes").addEventListener("click", async () => {
  const payload = {
    resolution: document.getElementById("resolution").value,
    decklinkDevice: document.getElementById("decklinkDevice").value
  };
  const r = await fetch("/api/config", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify(payload) });
  const msg = document.getElementById("saveResMsg");
  if (r.ok) { msg.textContent = "Saved"; msg.classList.remove("error"); } else { msg.textContent = "Error saving"; msg.classList.add("error"); }
});

// Multi-NIC -> Single NIC rendering (unchanged)
function renderSingleNic(nic) {
  const n = nic || {
    interface: "",
    mode: "dhcp",
    address: "",
    gateway: "",
    dns: "8.8.8.8,8.8.4.4"
  };
  const wrap = document.getElementById("nicList");

  wrap.innerHTML = `
    <div class="nic-head">
      <div>Interface</div><div>Mode</div><div>Address (CIDR)</div><div>Gateway</div><div>DNS</div>
    </div>
    <div class="nic-row single">
      <div class="nic-col"><input id="nicInterface" value="${n.interface || ''}" /></div>
      <div class="nic-col">
        <select id="nicMode">
          <option value="dhcp" ${n.mode === "dhcp" ? "selected" : ""}>DHCP</option>
          <option value="static" ${n.mode === "static" ? "selected" : ""}>Static</option>
        </select>
      </div>
      <div class="nic-col"><input id="nicAddress" value="${n.address || ''}" placeholder="192.168.x.x/24" /></div>
      <div class="nic-col"><input id="nicGateway" value="${n.gateway || ''}" placeholder="192.168.x.1" /></div>
      <div class="nic-col"><input id="nicDns" value="${n.dns || '8.8.8.8,8.8.4.4'}" /></div>
    </div>
    <div class="nic-actions">
      <button class="btn" id="saveNic">Save NIC</button>
    </div>
  `;

  document.getElementById("saveNic").onclick = async () => {
    const newNic = {
      interface: document.getElementById("nicInterface").value.trim(),
      mode: document.getElementById("nicMode").value,
      address: document.getElementById("nicAddress").value.trim(),
      gateway: document.getElementById("nicGateway").value.trim(),
      dns: document.getElementById("nicDns").value.trim()
    };
    await fetch("/api/config", { method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ net: newNic }) });
  };
}

// Apply for selected NIC
document.getElementById("applySelectedNic").addEventListener("click", async () => {
  const nic = {
    interface: document.getElementById("nicInterface").value.trim(),
    mode: document.getElementById("nicMode").value,
    address: document.getElementById("nicAddress").value.trim(),
    gateway: document.getElementById("nicGateway").value.trim(),
    dns: document.getElementById("nicDns").value.trim()
  };
  const r = await fetch("/api/network/apply", {
    method: "POST", headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ nic })
  });
  const msg = document.getElementById("applyNetMsg");
  const data = await r.json().catch(()=>({}));
  if (r.ok && data.ok) { msg.textContent = `Applied for ${nic.interface}`; msg.classList.remove("error"); }
  else { msg.textContent = (data.error || "Error applying"); msg.classList.add("error"); }
});

// Device & Hardware info
async function refreshDevice() {
  const r = await fetch("/api/device-info");
  const d = await r.json();

  document.getElementById("authorLine").textContent = `SWIFT-ENCODER Author: ${d.author || "-"}`;
  document.getElementById("copyrightLine").textContent = d.copyright || "Copyright SWIFT-ENCODER";

  const cfgText = [
    `Protocol: ${d.currentConfig?.protocol || "-"}`,
    `URL: ${d.currentConfig?.url || "-"}`,
    `Resolution: ${d.currentConfig?.resolution || "-"}`,
    `DeckLink Card: ${d.currentConfig?.decklinkDevice || "-"}`,
    `Bitrate: ${d.currentConfig?.vbitrate || "-"}`,
    `AutoRestart: ${d.currentConfig?.autoRestart ? "ON" : "OFF"}`
  ].join("\n");
  document.getElementById("currentCfg").textContent = cfgText;

  const hwText = [
    `CPU:\n${d.cpu || "-"}`,
    `\nMemory:\n${d.memory || "-"}`,
    `\nDisk (/):\n${d.disk || "-"}`,
    `\nKernel: ${d.kernel || "-"}`,
    `FFmpeg: ${d.ffmpeg || "-"}`,
    `\nPCI (DeckLink):\n${d.pci || "-"}`
  ].join("\n");
  document.getElementById("hwCfg").textContent = hwText;

  document.getElementById("deviceOut").textContent = d.decklinkDevices || "(No output)";
}
document.getElementById("refreshDevice").addEventListener("click", refreshDevice);
refreshDevice();

// Signal (header dot + view)
async function refreshSignal() {
  const r = await fetch("/api/video-signal");
  const data = await r.json();
  if (data.detected) { sigDot.classList.remove("red"); sigDot.classList.add("green"); sigText.textContent = "SDI LIVE"; }
  else { sigDot.classList.remove("green"); sigDot.classList.add("red"); sigText.textContent = "NO SIGNAL"; }
  document.getElementById("signalSummary").textContent = `Detected: ${data.detected ? "YES" : "NO"} | Mode: ${data.mode}`;
  document.getElementById("signalRaw").textContent = data.raw || "";
}
document.getElementById("refreshSignal").addEventListener("click", refreshSignal);
setInterval(refreshSignal, 4000);
refreshSignal();

// Encoder controller
async function updateStatus() {
  const r = await fetch("/api/status");
  const st = await r.json();
  if (st.running) {
    runStatus.textContent = "RUNNING";
    runStatus.classList.remove("off");
    runStatus.classList.add("on");
  } else {
    runStatus.textContent = "READY";
    runStatus.classList.remove("on");
    runStatus.classList.add("off");
  }
  autoRestart.checked = !!st.autoRestart;
}
setInterval(updateStatus, 3000);
updateStatus();

startBtn.addEventListener("click", async () => {
  const r = await fetch("/api/encode/start", { method:"POST" });
  if (!r.ok) alert("Failed to start (check config).");
  updateStatus();
});
stopBtn.addEventListener("click", async () => {
  const r = await fetch("/api/encode/stop", { method:"POST" });
  if (!r.ok) alert("Failed to stop.");
  updateStatus();
});
autoRestart.addEventListener("change", async () => {
  await fetch("/api/autorestart", {
    method:"POST", headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({ autoRestart: autoRestart.checked })
  });
});

// Live logs via SSE
const es = new EventSource("/api/logs");
es.onmessage = (e) => {
  const { line } = JSON.parse(e.data);
  logPre.textContent += (logPre.textContent ? "\n" : "") + line;
  logPre.scrollTop = logPre.scrollHeight;
};
clearLogs.addEventListener("click", async () => { await fetch("/api/logs/clear"); logPre.textContent = ""; });

// Admin password
document.getElementById("changePasswordBtn").addEventListener("click", async () => {
  const currentPassword = document.getElementById("currentPassword").value;
  const newPassword = document.getElementById("newPassword").value;
  const confirmPassword = document.getElementById("confirmPassword").value;
  const msg = document.getElementById("changePasswordMsg");

  const r = await fetch("/api/admin/password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ currentPassword, newPassword, confirmPassword })
  });
  const data = await r.json().catch(() => ({}));
  if (r.ok && data.ok) {
    msg.textContent = "Password changed";
    msg.classList.remove("error");
    document.getElementById("currentPassword").value = "";
    document.getElementById("newPassword").value = "";
    document.getElementById("confirmPassword").value = "";
  } else {
    msg.textContent = data.error || "Error changing password";
    msg.classList.add("error");
  }
});
