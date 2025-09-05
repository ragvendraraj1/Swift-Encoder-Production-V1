const $ = (sel) => document.querySelector(sel);
const ioClient = io();
let lastRunning = false;

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
  return r.json();
}

// Start/Stop toggle button
$('#startStopBtn').addEventListener('click', async () => {
  const running = $('#startStopBtn').dataset.running === 'true';
  $('#msg').textContent = '';

  if (!running) {
    const payload = {
      ytUrl:  $('#ytUrl').value.trim(),
      ytKey:  $('#ytKey').value.trim(),
      fbUrl:  $('#fbUrl').value.trim(),
      fbKey:  $('#fbKey').value.trim()
    };
    $('#startStopBtn').disabled = true;
    const res = await call('/api/start', payload);
    if (res.ok) {
      $('#msg').textContent = 'Starting...';
      $('#msg').className = 'msg ok';
    } else {
      $('#msg').textContent = res.error || 'Failed to start';
      $('#msg').className = 'msg err';
    }
    $('#startStopBtn').disabled = false;
  } else {
    $('#startStopBtn').disabled = true;
    const res = await call('/api/stop');
    if (res.ok) {
      $('#msg').textContent = 'Stopped.';
      $('#msg').className = 'msg ok';
    } else {
      $('#msg').textContent = res.error || 'Failed to stop';
      $('#msg').className = 'msg err';
    }
    $('#startStopBtn').disabled = false;
  }
});

function setButtonState(running){
  const btn = $('#startStopBtn');
  if (running) {
    btn.textContent = 'Stop';
    btn.classList.remove('primary'); // green
    btn.classList.add('danger');     // red
    btn.dataset.running = 'true';
  } else {
    btn.textContent = 'Start';
    btn.classList.remove('danger');  // red
    btn.classList.add('primary');    // green
    btn.dataset.running = 'false';
  }
}

ioClient.on('status', (s) => {
  setStatusPill(s.running);
  setButtonState(s.running);
  setSdiBadge(s.sdi || 'unknown');
  setLiveBadge(!!s.live);

  $('#timer').textContent = hhmmss(s.uptimeSec||0);
  $('#metaDevice').textContent = 'Device: ' + (s.device || '—');
  $('#metaStreams').textContent = 'Endpoints: ' + (s.endpoints && s.endpoints.length ? s.endpoints.join(', ') : '—');
  $('#metaStats').textContent = `FPS ${s.fps || '—'} | Bitrate ${s.bitrate || '—'} | Frames ${s.frame || '—'}`;

  lastRunning = s.running;
});
