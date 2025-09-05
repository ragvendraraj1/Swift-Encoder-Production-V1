const $ = (sel) => document.querySelector(sel);
const ioClient = io();
let lastRunning = false;
let locked = false;

function hhmmss(sec){
  const s = Number(sec||0);
  const h = Math.floor(s/3600);
  const m = Math.floor((s%3600)/60);
  const ss = s%60;
  return [h,m,ss].map(v => String(v).padStart(2,'0')).join(':');
}

function setStatusPill(running){
  const pill = $('#statusPill');
  if (running) {
    pill.textContent = 'ONLINE';
    pill.classList.remove('danger');
    pill.classList.add('ok');
  } else {
    pill.textContent = 'OFFLINE';
    pill.classList.remove('ok');
    pill.classList.add('danger');
  }
}

function setSdiBadge(state){
  const el = $('#sdiBadge');
  el.classList.remove('grey','ok','warn');
  if (state === 'ok') { el.textContent = 'LOCKED'; el.classList.add('ok'); }
  else if (state === 'no_signal') { el.textContent = 'NO SIGNAL'; el.classList.add('warn'); }
  else { el.textContent = 'UNKNOWN'; el.classList.add('grey'); }
}

function setLiveBadge(live){
  const el = $('#liveBadge');
  el.classList.remove('grey','ok','warn');
  if (live) { el.textContent = 'YES'; el.classList.add('ok'); }
  else { el.textContent = 'NO'; el.classList.add('grey'); }
}

function updateDateBox(){
  const now = new Date();
  const str = now.toLocaleString(undefined, { year:'numeric', month:'short', day:'2-digit', hour:'2-digit', minute:'2-digit' });
  $('#dateBox').textContent = str;
}
setInterval(updateDateBox, 1000); updateDateBox();

async function call(path, body){
  const r = await fetch(path, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body||{})
  });
  if (r.status === 401) { location.href = '/login'; return { ok:false, error:'Unauthorized' }; }
  return r.json();
}

function setButtonState(running){
  const btn = $('#startStopBtn');
  if (running) {
    btn.textContent = 'Stop';
    btn.classList.remove('primary'); // green
    btn.classList.add('danger');     // red
    btn.dataset.running = 'true';
    $('#lockBtn').classList.remove('hidden');
  } else {
    btn.textContent = 'Start';
    btn.classList.remove('danger');
    btn.classList.add('primary');
    btn.dataset.running = 'false';
    $('#lockBtn').classList.add('hidden');
  }
  // Disable when locked
  btn.disabled = locked;
  for (const id of ['ytUrl','ytKey','fbUrl','fbKey']) {
    const el = $('#'+id);
    if (el) el.disabled = running || locked;
  }
}

$('#startStopBtn').addEventListener('click', async () => {
  if (locked) { $('#msg').textContent = 'Panel is locked'; $('#msg').className = 'msg err'; return; }
  const running = $('#startStopBtn').dataset.running === 'true';
  $('#msg').textContent = '';

  if (!running) {
    const payload = {
      ytUrl:  $('#ytUrl').value.trim(),
      ytKey:  $('#ytKey').value.trim(),
      fbUrl:  $('#fbUrl').value.trim(),
      fbKey:  $('#fbKey').value.trim()
    };
    const res = await call('/api/start', payload);
    if (res.ok) {
      $('#msg').textContent = 'Starting...';
      $('#msg').className = 'msg ok';
    } else {
      $('#msg').textContent = res.error || 'Failed to start';
      $('#msg').className = 'msg err';
    }
  } else {
    const res = await call('/api/stop');
    if (res.ok) {
      $('#msg').textContent = 'Stopped.';
      $('#msg').className = 'msg ok';
    } else {
      $('#msg').textContent = res.error || 'Failed to stop';
      $('#msg').className = 'msg err';
    }
  }
});

$('#lockBtn').addEventListener('click', async () => {
  if (!locked) {
    const res = await call('/api/lock');
    if (res.ok) {
      locked = true;
      $('#msg').textContent = 'Panel locked';
      $('#msg').className = 'msg ok';
      setButtonState($('#startStopBtn').dataset.running === 'true');
      $('#lockBtn').textContent = '🔓 Unlock';
      $('#lockBtn').title = 'Unlock control panel';
    }
  } else {
    const pwd = prompt('Enter admin password to unlock:');
    if (pwd == null) return;
    const res = await call('/api/unlock', { password: pwd });
    if (res.ok) {
      locked = false;
      $('#msg').textContent = 'Panel unlocked';
      $('#msg').className = 'msg ok';
      setButtonState($('#startStopBtn').dataset.running === 'true');
      $('#lockBtn').textContent = '🔒 Lock';
      $('#lockBtn').title = 'Lock control panel';
    } else {
      $('#msg').textContent = res.error || 'Unlock failed';
      $('#msg').className = 'msg err';
    }
  }
});

$('#logoutBtn').addEventListener('click', async (e) => {
  e.preventDefault();
  await fetch('/auth/logout', { method:'POST' });
  location.href = '/login';
});

ioClient.on('status', (s) => {
  locked = !!s.locked;
  setStatusPill(s.running);
  setButtonState(s.running);
  setSdiBadge(s.sdi || 'unknown');
  setLiveBadge(!!s.live);

  $('#timer').textContent = hhmmss(s.uptimeSec||0);
  $('#metaDevice').textContent = 'Device: ' + (s.device || '—');
  $('#metaStats').textContent = `FPS ${s.fps || '—'} | Bitrate ${s.bitrate || '—'} | Frames ${s.frame || '—'}`;
});
