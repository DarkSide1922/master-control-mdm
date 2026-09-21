let token = localStorage.getItem('mdm_token') || '';
let me = { username: '', role: 'viewer' };
let ws = null;

let schools = [];
let devices = [];
let selectedDeviceId = null;
let currentView = 'overview';
let currentSub = 'control';

let apps = [];
let watchlist = [];
let controllist = [];
const pendingCommands = {};
let currentMuted = false;
let volumeDragging = false;
let publishedManifest = { version: '', url: '', autoUpdate: false };

const ROLE_RANK = { viewer: 0, limited: 1, master: 2, full: 2 };
function roleAtLeast(role, min) { return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[min] ?? 99); }
function myRoleAtLeast(min) { return roleAtLeast(me.role, min); }

// ============================================================
// Auth / boot
// ============================================================

function log(msg) {
  const el = document.getElementById('log');
  if (!el) return;
  const time = new Date().toLocaleTimeString();
  el.textContent += `[${time}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) { document.getElementById('login-error').textContent = 'Wrong username or password'; return; }
  const data = await res.json();
  token = data.token;
  localStorage.setItem('mdm_token', token);
  await boot();
}

function authHeader() { return { Authorization: `Bearer ${token}` }; }

async function boot() {
  const meRes = await fetch('/api/me', { headers: authHeader() });
  if (!meRes.ok) { logout(); return; }
  me = await meRes.json();

  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('me-username').textContent = me.username;

  const tier = document.getElementById('me-tier');
  const label = me.role === 'master' ? 'Master control' : me.role === 'limited' ? 'Limited control' : 'View only';
  tier.className = 'tier-badge tier-' + me.role;
  tier.innerHTML = `<span class="d"></span>${label}`;

  if (me.role === 'master') {
    document.getElementById('add-school-box').style.display = 'block';
    document.getElementById('nav-master').style.display = 'inline-block';
    document.getElementById('nav-accounts').style.display = 'inline-block';
    loadUsers();
    loadManifest();
  }

  applyRoleToControls();
  connectWs();
  await loadFleet();
  await loadStats();
}

function logout() { localStorage.removeItem('mdm_token'); location.reload(); }

// Mirror the server's per-action gating in the UI: disable controls above the
// operator's tier (present-but-locked, so they can see the capability exists),
// and hide tier-only navigation entirely.
function applyRoleToControls() {
  document.querySelectorAll('[data-min-role]').forEach((el) => {
    const need = el.getAttribute('data-min-role');
    const allowed = myRoleAtLeast(need);
    const isNav = el.closest('.subtabs') || el.closest('.nav');
    if (isNav) {
      el.style.display = allowed ? '' : 'none';
    } else {
      el.disabled = !allowed;
      el.classList.toggle('locked', !allowed);
      if (!allowed) el.title = `Needs ${need} access`;
    }
  });
}

// ============================================================
// View switching
// ============================================================

function switchView(view) {
  currentView = view;
  for (const v of ['overview', 'fleet', 'master', 'accounts']) {
    document.getElementById(`view-${v}`).style.display = v === view ? 'block' : 'none';
    const nav = document.getElementById(`nav-${v}`);
    if (nav) nav.classList.toggle('active', v === view);
  }
  if (view === 'overview') loadStats();
  if (view === 'accounts') loadUsers();
  if (view === 'master') { loadManifest(); populateSchoolDropdown(); }
}

function switchSub(sub) {
  currentSub = sub;
  document.querySelectorAll('#device-subtabs button').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  document.querySelectorAll('.subpane').forEach((p) => p.classList.remove('active'));
  document.getElementById(`sub-${sub}`).classList.add('active');
  if (sub === 'activity') loadCommandHistory();
}

// ============================================================
// Overview stats + charts
// ============================================================

async function loadStats() {
  const res = await fetch('/api/stats', { headers: authHeader() });
  if (!res.ok) return;
  const s = await res.json();
  document.getElementById('stat-schools').textContent = s.schools;
  document.getElementById('stat-tablets').textContent = s.tablets;
  document.getElementById('stat-online').textContent = s.online;
  document.getElementById('stat-offline').textContent = s.offline;
  const pct = s.tablets ? Math.round((s.online / s.tablets) * 100) : 0;
  document.getElementById('stat-online-sub').textContent = `${pct}% of fleet`;
  renderDonut(s.online, s.offline);
  renderSchoolBars(s.perSchool);
}

function renderDonut(online, offline) {
  const total = online + offline;
  const el = document.getElementById('donut');
  const r = 52, c = 2 * Math.PI * r, size = 136, cx = size / 2, cy = size / 2;
  const onlineLen = total ? (online / total) * c : 0;
  el.innerHTML = `
    <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--faint)" stroke-width="16" opacity="0.3"/>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--ok)" stroke-width="16"
              stroke-dasharray="${onlineLen} ${c - onlineLen}" stroke-dashoffset="${c / 4}"
              transform="rotate(-90 ${cx} ${cy})" stroke-linecap="round"/>
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" fill="var(--text)" font-size="27" font-weight="700">${online}</text>
      <text x="${cx}" y="${cy + 18}" text-anchor="middle" fill="var(--muted)" font-size="11">of ${total} online</text>
    </svg>`;
  document.getElementById('legend-online').textContent = String(online);
  document.getElementById('legend-offline').textContent = String(offline);
}

function renderSchoolBars(perSchool) {
  const el = document.getElementById('school-bars');
  el.innerHTML = '';
  if (!perSchool || perSchool.length === 0) { el.innerHTML = '<div class="meta-line">No schools yet.</div>'; return; }
  const max = Math.max(...perSchool.map((s) => s.tablets), 1);
  for (const s of perSchool) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const widthPct = (s.tablets / max) * 100;
    const onlinePct = s.tablets ? (s.online / s.tablets) * widthPct : 0;
    row.innerHTML = `
      <div class="bar-name" title="${escapeHtml(s.school)}">${escapeHtml(s.school)}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${widthPct}%"></div><div class="bar-online" style="width:${onlinePct}%"></div></div>
      <div class="bar-val">${s.online}/${s.tablets}</div>`;
    el.appendChild(row);
  }
}

// ============================================================
// WebSocket
// ============================================================

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/dashboard?token=${encodeURIComponent(token)}`);
  ws.binaryType = 'arraybuffer';
  ws.onmessage = (evt) => {
    if (evt.data instanceof ArrayBuffer) { renderFrame(evt.data); return; }
    handleWsMessage(JSON.parse(evt.data));
  };
  ws.onclose = () => { log('Dashboard socket closed, retrying in 3s…'); setTimeout(connectWs, 3000); };
  ws.onopen = () => { if (selectedDeviceId) ws.send(JSON.stringify({ type: 'watch_device', deviceId: selectedDeviceId })); };
}

function handleWsMessage(msg) {
  switch (msg.type) {
    case 'device_online':
    case 'device_offline':
    case 'device_status_summary': {
      updateSidebarDeviceStatus(msg.deviceId, msg.type !== 'device_offline', msg.battery);
      if (msg.deviceId === selectedDeviceId) setDeviceOnlineUI(msg.type !== 'device_offline');
      if (currentView === 'overview') loadStats();
      break;
    }
    case 'status': {
      if (msg.deviceId !== selectedDeviceId) break;
      document.getElementById('battery').textContent = msg.battery != null ? `Battery ${msg.battery}%` : '';
      if (msg.data) { updateVolumeUI(msg.data.volumePercent, msg.data.muted); updateDeviceMeta(msg.data); }
      break;
    }
    case 'command_result': {
      if (msg.deviceId !== selectedDeviceId) break;
      const action = pendingCommands[msg.commandId];
      delete pendingCommands[msg.commandId];
      handleCommandResult(action, msg);
      break;
    }
    default: break;
  }
}

function handleCommandResult(action, msg) {
  if (action === 'list_apps' && msg.success) {
    apps = (msg.result?.apps || []).sort((a, b) => a.label.localeCompare(b.label));
    renderApps(); renderWatchlist(); renderControllist(); log(`App list refreshed (${apps.length} apps)`); return;
  }
  if (action === 'run_shell') { printShellResult(msg); return; }
  if (action === 'set_app_hidden' && msg.success) { log(`App block/allow applied`); loadApps(); loadControllist(); return; }
  if (action === 'set_settings_lock') { log(msg.success ? `Settings lock: ${msg.result?.mode}` : `Settings lock failed: ${msg.result?.error}`); return; }
  if (action === 'update_agent') { log(msg.success ? 'Update sent — tablet will install and relaunch itself' : `Update failed: ${msg.result?.error}`); return; }
  if (action === 'install_apk') { log(msg.success ? 'APK install started on tablet' : `Install failed: ${msg.result?.error}`); return; }
  if (action === 'uninstall_app') { log(msg.success ? 'Uninstall started on tablet' : `Uninstall failed: ${msg.result?.error}`); return; }
  if (action === 'launch_app') { log(msg.success ? `Opened ${msg.result?.launched}` : `Couldn't open app: ${msg.result?.error}`); return; }
  if (action === 'close_app') { log(msg.success ? `Closed ${msg.result?.closed}` : `Couldn't close app: ${msg.result?.error}`); return; }
  if (action === 'reboot_device') { log(msg.success ? 'Restart sent' : `Couldn't restart: ${msg.result?.error}`); return; }
  if (action === 'wake_device') { log(msg.success ? 'Wake sent' : `Wake failed: ${msg.result?.error}`); return; }
  if (action === 'set_keep_awake') { log(msg.success ? `Keep-awake ${msg.result?.keepAwake ? 'ON' : 'OFF'}` : `Keep-awake failed: ${msg.result?.error}`); return; }
  if (action === 'lockdown_on' || action === 'lockdown_off') { log(msg.success ? `Lockdown ${msg.result?.lockdown ? 'ON' : 'OFF'}` : `Lockdown failed: ${msg.result?.error}`); return; }
  if (action === 'set_volume' || action === 'set_muted') {
    if (msg.success && msg.result) updateVolumeUI(msg.result.volumePercent, msg.result.muted);
    else if (!msg.success) log(`Volume command failed: ${msg.result?.error}`);
    return;
  }
  if (['page_swipe','go_home','go_back','show_recents','show_notifications','show_quick_settings'].includes(action)) {
    if (!msg.success) log(`Navigation failed: ${msg.result?.error}`); return;
  }
  log(`Command #${msg.commandId} ${msg.success ? 'succeeded' : 'failed'}: ${JSON.stringify(msg.result)}`);
}

function renderFrame(buf) {
  const blob = new Blob([buf], { type: 'image/jpeg' });
  const url = URL.createObjectURL(blob);
  const img = document.getElementById('screen');
  const old = img.src;
  img.src = url;
  if (old) URL.revokeObjectURL(old);
}

// ============================================================
// Fleet sidebar
// ============================================================

async function loadFleet() {
  const [schoolsRes, devicesRes] = await Promise.all([
    fetch('/api/schools', { headers: authHeader() }),
    fetch('/api/devices', { headers: authHeader() }),
  ]);
  if (schoolsRes.status === 401 || devicesRes.status === 401) { logout(); return; }
  schools = await schoolsRes.json();
  devices = await devicesRes.json();
  renderFleet();
  populateSchoolDropdown();
}

function renderFleet() {
  const el = document.getElementById('school-list');
  el.innerHTML = '';
  const isMaster = me.role === 'master';
  const canEdit = myRoleAtLeast('limited');
  if (schools.length === 0) { el.innerHTML = '<div class="meta-line" style="padding:8px;">No schools yet.</div>'; return; }

  for (const school of schools) {
    const group = document.createElement('div');
    group.className = 'school-group';
    const header = document.createElement('div');
    header.className = 'school-header';
    const headerLabel = document.createElement('span');
    headerLabel.textContent = school.name;
    header.appendChild(headerLabel);
    const headerRight = document.createElement('span');
    headerRight.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const countSpan = document.createElement('span');
    countSpan.className = 'school-count';
    countSpan.textContent = `${school.onlineCount || 0}/${school.deviceCount || 0}`;
    headerRight.appendChild(countSpan);
    if (isMaster) {
      headerRight.appendChild(makeIconButton('✎', 'Rename school', (e) => { e.stopPropagation(); renameSchool(school.id, school.name); }));
      headerRight.appendChild(makeIconButton('🗑', 'Delete school and all its tablets', (e) => { e.stopPropagation(); deleteSchool(school.id, school.name); }));
    }
    header.appendChild(headerRight);
    group.appendChild(header);

    const deviceListEl = document.createElement('div');
    const schoolDevices = devices.filter((d) => d.schoolId === school.id)
      .sort((a, b) => a.tabletNumber.localeCompare(b.tabletNumber, undefined, { numeric: true }));
    for (const d of schoolDevices) {
      const item = document.createElement('div');
      item.className = 'device-item' + (d.id === selectedDeviceId ? ' selected' : '');
      item.dataset.deviceId = d.id;
      const labelWrap = document.createElement('span');
      labelWrap.style.cssText = 'display:flex;align-items:center;gap:8px;flex:1;min-width:0;';
      const nameSuffix = d.tabletName ? ` · ${escapeHtml(d.tabletName)}` : '';
      labelWrap.innerHTML = `<span class="status-dot ${d.online ? 'online' : 'offline'}"></span>
        <span class="device-item-label">Tablet ${escapeHtml(d.tabletNumber)}${nameSuffix}</span>`;
      item.appendChild(labelWrap);
      if (canEdit) item.appendChild(makeIconButton('✎', 'Rename tablet', (e) => { e.stopPropagation(); renameDevice(d.id, d.tabletNumber, d.tabletName); }));
      if (isMaster) item.appendChild(makeIconButton('🗑', 'Delete tablet', (e) => { e.stopPropagation(); deleteDevice(d.id, d.tabletNumber, school.name); }));
      item.onclick = () => selectDevice(d.id);
      deviceListEl.appendChild(item);
    }
    if (schoolDevices.length === 0) deviceListEl.innerHTML = '<div class="meta-line" style="padding:6px 10px 6px 22px;">No tablets registered yet</div>';
    group.appendChild(deviceListEl);
    el.appendChild(group);
  }
}

function makeIconButton(symbol, title, onClick) {
  const btn = document.createElement('button');
  btn.textContent = symbol; btn.title = title; btn.className = 'icon-btn'; btn.onclick = onClick;
  return btn;
}

function updateSidebarDeviceStatus(deviceId, online, battery) {
  const device = devices.find((d) => d.id === deviceId);
  if (device) { device.online = online; if (battery != null) device.battery = battery; }
  const item = document.querySelector(`.device-item[data-device-id="${deviceId}"]`);
  if (item) { const dot = item.querySelector('.status-dot'); if (dot) dot.className = 'status-dot ' + (online ? 'online' : 'offline'); }
  const school = schools.find((s) => s.id === device?.schoolId);
  if (school) { school.onlineCount = devices.filter((d) => d.schoolId === school.id && d.online).length; renderFleet(); }
}

async function createSchool() {
  const name = document.getElementById('new-school-name').value.trim();
  if (!name) return;
  const res = await fetch('/api/schools', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ name }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not create school'); return; }
  document.getElementById('new-school-name').value = '';
  loadFleet(); loadStats();
}
async function renameSchool(schoolId, currentName) {
  const name = prompt('Rename school to:', currentName);
  if (!name || !name.trim() || name.trim() === currentName) return;
  const res = await fetch(`/api/schools/${schoolId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ name: name.trim() }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not rename school'); return; }
  loadFleet();
}
async function deleteSchool(schoolId, name) {
  if (!confirm(`Delete "${name}" and ALL of its registered tablets? This can't be undone.`)) return;
  const res = await fetch(`/api/schools/${schoolId}`, { method: 'DELETE', headers: authHeader() });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not delete school'); return; }
  if (devices.some((d) => d.schoolId === schoolId && d.id === selectedDeviceId)) clearDeviceSelection();
  loadFleet(); loadStats();
}
async function renameDevice(deviceId, currentNumber, currentName) {
  const tabletNumber = prompt('Tablet number:', currentNumber);
  if (tabletNumber === null) return;
  if (!tabletNumber.trim()) { alert('Tablet number cannot be empty'); return; }
  const tabletName = prompt('Tablet name (optional):', currentName || '');
  if (tabletName === null) return;
  const res = await fetch(`/api/devices/${deviceId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ tabletNumber: tabletNumber.trim(), tabletName: tabletName.trim() }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not rename tablet'); return; }
  loadFleet();
  if (deviceId === selectedDeviceId) selectDevice(deviceId);
}
async function deleteDevice(deviceId, tabletNumber, schoolName) {
  if (!confirm(`Remove Tablet ${tabletNumber} (${schoolName}) from the fleet? It will need to be re-registered to come back.`)) return;
  const res = await fetch(`/api/devices/${deviceId}`, { method: 'DELETE', headers: authHeader() });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not delete tablet'); return; }
  if (deviceId === selectedDeviceId) clearDeviceSelection();
  loadFleet(); loadStats();
}
function clearDeviceSelection() {
  selectedDeviceId = null;
  document.getElementById('device-view').style.display = 'none';
  document.getElementById('no-device-msg').style.display = 'block';
}

// ============================================================
// Device selection
// ============================================================

function selectDevice(deviceId) {
  selectedDeviceId = deviceId;
  apps = []; watchlist = []; controllist = []; currentMuted = false;
  document.getElementById('no-device-msg').style.display = 'none';
  document.getElementById('device-view').style.display = 'block';

  const device = devices.find((d) => d.id === deviceId);
  const school = schools.find((s) => s.id === device?.schoolId);
  const nameSuffix = device?.tabletName ? ` · ${device.tabletName}` : '';
  document.getElementById('device-title').textContent =
    device ? `${school ? school.name + ' — ' : ''}Tablet ${device.tabletNumber}${nameSuffix}` : `Device #${deviceId}`;
  updateDeviceMeta(device?.data || {});
  document.getElementById('dev-agent-version').textContent = device?.agentVersion || 'unknown';
  document.getElementById('dev-published-version').textContent = publishedManifest.version || 'none published';

  renderFleet();
  renderApps();
  document.getElementById('screen').src = '';
  document.getElementById('log').textContent = '';
  switchSub('control');

  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'watch_device', deviceId }));
  refreshDeviceStatus();
  loadWatchlist();
  loadControllist();
}

function updateDeviceMeta(data) {
  const parts = [];
  if (data.model) parts.push(data.model);
  if (data.androidVersion) parts.push('Android ' + data.androidVersion);
  if (data.agentVersion) parts.push('agent v' + data.agentVersion);
  if (data.macAddress) parts.push('MAC ' + data.macAddress);
  document.getElementById('device-subtitle').textContent = parts.join(' · ');

  const owner = data.isDeviceOwner === true;
  const ownerEl = document.getElementById('owner-state');
  if (ownerEl) ownerEl.innerHTML = owner
    ? '<span style="color:var(--ok)">● Master control active</span> — this tablet is a Device Owner. All commands available.'
    : '<span style="color:var(--warn)">● Not provisioned</span> — run the command above to enable master control.';

  if (data.agentVersion) document.getElementById('dev-agent-version').textContent = data.agentVersion;
  if (data.settingsLock) updateSettingsLockUI(data.settingsLock);
}

async function refreshDeviceStatus() {
  if (!selectedDeviceId) return;
  const res = await fetch(`/api/devices/${selectedDeviceId}/status`, { headers: authHeader() });
  if (res.status === 401) { logout(); return; }
  const data = await res.json();
  setDeviceOnlineUI(data.online);
  if (data.battery != null) document.getElementById('battery').textContent = `Battery ${data.battery}%`;
  if (data.agentVersion) document.getElementById('dev-agent-version').textContent = data.agentVersion;
  if (data.data) { updateVolumeUI(data.data.volumePercent, data.data.muted); updateDeviceMeta(data.data); }
}

function setDeviceOnlineUI(online) {
  document.getElementById('status-dot').className = 'status-dot ' + (online ? 'online' : 'offline');
  document.getElementById('status-text').textContent = online
    ? 'Connected'
    : 'Sleeping — checks in about once a minute; commands you send now run at its next check-in.';
}

// ============================================================
// Commands
// ============================================================

async function sendCmd(action, params = {}) {
  if (!selectedDeviceId) return;
  const res = await fetch(`/api/devices/${selectedDeviceId}/commands`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() },
    body: JSON.stringify({ action, params }),
  });
  const data = await res.json();
  if (!res.ok) { log(`Error sending ${action}: ${data.error}`); return; }
  pendingCommands[data.commandId] = action;
  log(data.delivered ? `Sent ${action} (#${data.commandId})` : `Queued ${action} (#${data.commandId}) — tablet asleep, runs at next check-in`);
  return data.commandId;
}

function confirmWipe() { if (confirm('This will FACTORY RESET the tablet. Are you sure?')) sendCmd('wipe_device'); }
function confirmReboot() { if (confirm('Restart the tablet now, interrupting whatever the student is doing?')) sendCmd('reboot_device'); }
function confirmLockdown() { if (confirm('Turn on lockdown? Blocks factory reset, safe boot, the status bar and account changes. Requires Device Owner.')) sendCmd('lockdown_on'); }
function pageSwipe(direction) { sendCmd('page_swipe', { direction }); }

function updateVolumeUI(percent, muted) {
  if (percent == null) return;
  currentMuted = Boolean(muted);
  if (!volumeDragging) document.getElementById('volume-slider').value = percent;
  document.getElementById('volume-label').textContent = currentMuted ? `${percent}% (muted)` : `${percent}%`;
  document.getElementById('mute-btn').textContent = currentMuted ? 'Unmute' : 'Mute';
}
function onVolumeSliderInput() { volumeDragging = true; document.getElementById('volume-label').textContent = `${document.getElementById('volume-slider').value}%`; }
function onVolumeSliderCommit() { volumeDragging = false; sendCmd('set_volume', { level: parseInt(document.getElementById('volume-slider').value, 10) }); }
function toggleMute() { sendCmd('set_muted', { muted: !currentMuted }); }

// ============================================================
// Settings deadlock
// ============================================================

function setSettingsLock(mode) { sendCmd('set_settings_lock', { mode }); updateSettingsLockUI(mode); }
function updateSettingsLockUI(mode) {
  document.querySelectorAll('#settings-lock-seg button').forEach((b) => {
    b.classList.toggle('on', b.dataset.mode === mode);
  });
}

// ============================================================
// Shell console
// ============================================================

function runShell() {
  const input = document.getElementById('shell-cmd');
  const cmd = input.value.trim();
  if (!cmd) return;
  appendShell(`$ ${cmd}`, 'cmd');
  input.value = '';
  sendCmd('run_shell', { cmd });
}
function appendShell(text, cls) {
  const out = document.getElementById('shell-out');
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.textContent = text + '\n';
  out.appendChild(span);
  out.scrollTop = out.scrollHeight;
}
function printShellResult(msg) {
  if (!msg.success) { appendShell(msg.result?.error || 'command failed', 'err'); return; }
  const r = msg.result || {};
  appendShell(`[ran as ${r.rooted ? 'root (su)' : 'agent'}${r.exitCode != null ? `, exit ${r.exitCode}` : ''}]`, 'sys');
  if (r.stdout) appendShell(r.stdout.trimEnd());
  if (r.stderr) appendShell(r.stderr.trimEnd(), 'err');
  if (!r.stdout && !r.stderr) appendShell('(no output)', 'sys');
}

// ============================================================
// Install / uninstall / update
// ============================================================

function installApk() {
  const url = document.getElementById('install-url').value.trim();
  if (!url) { alert('Enter an APK download URL'); return; }
  sendCmd('install_apk', { url });
}
function uninstallPkg() {
  const pkg = document.getElementById('uninstall-pkg').value.trim();
  if (!pkg) { alert('Enter a package name'); return; }
  if (!confirm(`Uninstall ${pkg} from this tablet?`)) return;
  sendCmd('uninstall_app', { packageName: pkg });
}
async function pushUpdateToDevice() {
  if (!selectedDeviceId) return;
  if (!publishedManifest.url) { alert('No update is published yet. Set one under "Master control → Fleet software update".'); return; }
  if (!confirm(`Update this tablet to version ${publishedManifest.version || '(latest)'} now?`)) return;
  const res = await fetch(`/api/devices/${selectedDeviceId}/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({}) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not push update'); return; }
  log('Software update pushed to this tablet');
}

// ============================================================
// Apps list
// ============================================================

function loadApps() { sendCmd('list_apps'); }
function isInstalled(pkg) { return apps.some((a) => a.packageName === pkg); }

function renderApps() {
  const listEl = document.getElementById('apps-list');
  const emptyEl = document.getElementById('apps-empty');
  const search = document.getElementById('app-search').value.trim().toLowerCase();
  const showSystem = document.getElementById('show-system').checked;
  if (apps.length === 0) { emptyEl.style.display = 'block'; emptyEl.textContent = 'No app list loaded yet — click "Refresh apps".'; listEl.innerHTML = ''; return; }
  const filtered = apps.filter((a) => {
    if (!showSystem && a.system) return false;
    if (search && !a.label.toLowerCase().includes(search) && !a.packageName.toLowerCase().includes(search)) return false;
    return true;
  });
  if (filtered.length === 0) { emptyEl.style.display = 'block'; emptyEl.textContent = 'No apps match your search/filter.'; listEl.innerHTML = ''; return; }
  emptyEl.style.display = 'none';
  listEl.innerHTML = '';
  const canControl = myRoleAtLeast('limited');
  const watched = new Set(watchlist.map((w) => w.packageName));
  for (const app of filtered) {
    const row = document.createElement('div');
    row.className = 'app-row';
    const initial = (app.label || app.packageName || '?').trim().charAt(0).toUpperCase();
    row.innerHTML = `
      <div class="app-avatar">${escapeHtml(initial)}</div>
      <div class="app-info">
        <div class="app-name">${escapeHtml(app.label)}
          ${app.system ? '<span class="chip">system</span>' : ''}
          ${app.hidden ? '<span class="chip blocked">blocked</span>' : ''}
          ${watched.has(app.packageName) ? '<span class="chip watch">watched</span>' : ''}
        </div>
        <div class="app-pkg">${escapeHtml(app.packageName)}</div>
      </div>`;
    const btnGroup = document.createElement('div');
    btnGroup.style.cssText = 'display:flex;gap:6px;flex-shrink:0;flex-wrap:wrap;';
    const mk = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn small' + cls; b.textContent = label; b.disabled = !canControl; b.onclick = fn; return b; };
    btnGroup.appendChild(mk('Open', '', () => sendCmd('launch_app', { packageName: app.packageName })));
    btnGroup.appendChild(mk('Close', '', () => sendCmd('close_app', { packageName: app.packageName })));
    btnGroup.appendChild(mk(app.hidden ? 'Unblock' : 'Block', app.hidden ? '' : ' danger',
      () => setControl(app.packageName, app.label, app.hidden ? 'allow' : 'block')));
    btnGroup.appendChild(mk(watched.has(app.packageName) ? 'Unwatch' : 'Watch', '',
      () => watched.has(app.packageName) ? removeWatchByPkg(app.packageName) : addWatchPkg(app.packageName, app.label)));
    row.appendChild(btnGroup);
    listEl.appendChild(row);
  }
}

// ============================================================
// Watch list
// ============================================================

async function loadWatchlist() {
  if (!selectedDeviceId) return;
  const res = await fetch(`/api/devices/${selectedDeviceId}/watchlist`, { headers: authHeader() });
  if (!res.ok) return;
  watchlist = await res.json();
  renderWatchlist(); renderApps();
}
function renderWatchlist() {
  const el = document.getElementById('watchlist');
  if (!el) return;
  if (watchlist.length === 0) { el.innerHTML = '<div class="meta-line">No apps on the watch list yet.</div>'; return; }
  const canEdit = myRoleAtLeast('limited');
  el.innerHTML = '';
  for (const w of watchlist) {
    const installed = isInstalled(w.packageName);
    const row = document.createElement('div');
    row.className = 'app-row'; row.style.marginBottom = '7px';
    row.innerHTML = `<span class="status-dot ${installed ? 'online' : 'offline'}" title="${installed ? 'Installed' : 'Not installed'}"></span>
      <div class="app-info"><div class="app-name">${escapeHtml(w.label || w.packageName)}
        <span class="chip ${installed ? 'running' : ''}">${installed ? 'installed' : 'not installed'}</span></div>
        <div class="app-pkg">${escapeHtml(w.packageName)}</div></div>`;
    if (canEdit) { const b = makeIconButton('✕', 'Remove from watch list', () => removeWatch(w.id)); row.appendChild(b); }
    el.appendChild(row);
  }
}
function addWatch() {
  const v = document.getElementById('watch-add').value.trim();
  if (!v) return;
  addWatchPkg(v, v);
  document.getElementById('watch-add').value = '';
}
async function addWatchPkg(packageName, label) {
  const res = await fetch(`/api/devices/${selectedDeviceId}/watchlist`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ packageName, label }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not add to watch list'); return; }
  loadWatchlist();
}
async function removeWatch(id) {
  await fetch(`/api/devices/${selectedDeviceId}/watchlist/${id}`, { method: 'DELETE', headers: authHeader() });
  loadWatchlist();
}
function removeWatchByPkg(pkg) { const w = watchlist.find((x) => x.packageName === pkg); if (w) removeWatch(w.id); }

// ============================================================
// Control list
// ============================================================

async function loadControllist() {
  if (!selectedDeviceId) return;
  const res = await fetch(`/api/devices/${selectedDeviceId}/controllist`, { headers: authHeader() });
  if (!res.ok) return;
  controllist = await res.json();
  renderControllist();
}
function renderControllist() {
  const el = document.getElementById('controllist');
  if (!el) return;
  if (controllist.length === 0) { el.innerHTML = '<div class="meta-line">No allow/block decisions yet. Use "Block" on any app in the list below.</div>'; return; }
  const canEdit = myRoleAtLeast('limited');
  el.innerHTML = '';
  for (const c of controllist) {
    const row = document.createElement('div');
    row.className = 'app-row'; row.style.marginBottom = '7px';
    row.innerHTML = `<div class="app-info"><div class="app-name">${escapeHtml(c.label || c.packageName)}
        <span class="chip ${c.policy === 'block' ? 'blocked' : 'running'}">${c.policy === 'block' ? 'blocked' : 'allowed'}</span></div>
        <div class="app-pkg">${escapeHtml(c.packageName)}</div></div>`;
    if (canEdit) {
      const btns = document.createElement('div');
      btns.style.cssText = 'display:flex;gap:6px;flex-shrink:0;';
      const toggle = document.createElement('button');
      toggle.className = 'btn small' + (c.policy === 'block' ? '' : ' danger');
      toggle.textContent = c.policy === 'block' ? 'Allow' : 'Block';
      toggle.onclick = () => setControl(c.packageName, c.label, c.policy === 'block' ? 'allow' : 'block');
      btns.appendChild(toggle);
      btns.appendChild(makeIconButton('✕', 'Remove from control list', () => removeControl(c.id)));
      row.appendChild(btns);
    }
    el.appendChild(row);
  }
}
async function setControl(packageName, label, policy) {
  const res = await fetch(`/api/devices/${selectedDeviceId}/controllist`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ packageName, label, policy }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not update control list'); return; }
  log(`${policy === 'block' ? 'Blocked' : 'Allowed'} ${label || packageName}`);
  loadControllist(); loadApps();
}
async function removeControl(id) {
  await fetch(`/api/devices/${selectedDeviceId}/controllist/${id}`, { method: 'DELETE', headers: authHeader() });
  loadControllist();
}
async function syncControl() {
  const res = await fetch(`/api/devices/${selectedDeviceId}/controllist/sync`, { method: 'POST', headers: authHeader() });
  const data = await res.json();
  if (res.ok) log(`Re-applied ${data.pushed} control-list decisions`);
}

// ============================================================
// Command history (audit)
// ============================================================

async function loadCommandHistory() {
  if (!selectedDeviceId) return;
  const res = await fetch(`/api/devices/${selectedDeviceId}/commands`, { headers: authHeader() });
  if (!res.ok) return;
  const rows = await res.json();
  const el = document.getElementById('cmd-history');
  el.innerHTML = '';
  if (rows.length === 0) { el.innerHTML = '<div class="meta-line">No commands sent yet.</div>'; return; }
  for (const r of rows.slice(0, 30)) {
    const div = document.createElement('div');
    const who = r.issued_by || 'system';
    const when = r.created_at ? new Date(r.created_at.replace(' ', 'T') + 'Z').toLocaleString() : '';
    div.innerHTML = `<span class="kv-k">${escapeHtml(r.action)} · ${escapeHtml(who)} · ${r.status}</span><span class="kv-v">${escapeHtml(when)}</span>`;
    el.appendChild(div);
  }
}

// ============================================================
// Provisioning
// ============================================================

function copyProvision() {
  const text = document.getElementById('provision-cmd').textContent;
  navigator.clipboard?.writeText(text).then(() => log('Provisioning command copied to clipboard'),
    () => alert('Copy failed — select the command manually.'));
}

// ============================================================
// Master control: fleet update manifest
// ============================================================

async function loadManifest() {
  const res = await fetch('/api/update-manifest', { headers: authHeader() });
  if (!res.ok) return;
  publishedManifest = await res.json();
  const v = document.getElementById('mf-version'); if (v) v.value = publishedManifest.version || '';
  const u = document.getElementById('mf-url'); if (u) u.value = publishedManifest.url || '';
  const a = document.getElementById('mf-auto'); if (a) a.checked = !!publishedManifest.autoUpdate;
  const pv = document.getElementById('dev-published-version'); if (pv) pv.textContent = publishedManifest.version || 'none published';
}
async function saveManifest() {
  const body = {
    version: document.getElementById('mf-version').value.trim(),
    url: document.getElementById('mf-url').value.trim(),
    autoUpdate: document.getElementById('mf-auto').checked,
  };
  const res = await fetch('/api/update-manifest', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify(body) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not save'); return; }
  publishedManifest = data;
  alert('Update settings saved. Out-of-date tablets will update ' + (data.autoUpdate ? 'automatically on next check-in.' : 'when you push to them.'));
}
function populateSchoolDropdown() {
  const sel = document.getElementById('mf-school');
  if (!sel) return;
  sel.innerHTML = schools.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
}
async function pushUpdateToSchool() {
  const schoolId = document.getElementById('mf-school').value;
  if (!schoolId) return;
  if (!confirm('Push the published update to every tablet at this school?')) return;
  const res = await fetch(`/api/schools/${schoolId}/update`, { method: 'POST', headers: authHeader() });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not push update'); return; }
  alert(`Update queued for ${data.pushed} tablet(s).`);
}

// ============================================================
// Accounts
// ============================================================

async function loadUsers() {
  const res = await fetch('/api/users', { headers: authHeader() });
  if (!res.ok) return;
  const users = await res.json();
  const el = document.getElementById('user-list');
  el.innerHTML = '';
  for (const u of users) {
    const row = document.createElement('div');
    row.className = 'user-row';
    const nameEl = document.createElement('span');
    nameEl.style.cssText = 'flex:1;min-width:120px;font-weight:600;';
    nameEl.textContent = u.username + (u.id === me.id ? ' (you)' : '');
    row.appendChild(nameEl);

    const roleSelect = document.createElement('select');
    roleSelect.className = 'form-input';
    roleSelect.style.cssText = 'width:auto;margin:0;padding:7px 9px;';
    roleSelect.innerHTML = `
      <option value="viewer" ${u.role === 'viewer' ? 'selected' : ''}>View only</option>
      <option value="limited" ${u.role === 'limited' ? 'selected' : ''}>Limited control</option>
      <option value="master" ${u.role === 'master' ? 'selected' : ''}>Master control</option>`;
    roleSelect.onchange = () => changeUserRole(u.id, roleSelect.value, u.role, roleSelect);
    row.appendChild(roleSelect);

    const resetBtn = document.createElement('button');
    resetBtn.className = 'btn small'; resetBtn.textContent = 'Reset password';
    resetBtn.onclick = () => resetUserPassword(u.id, u.username);
    row.appendChild(resetBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn small danger'; delBtn.textContent = 'Remove';
    delBtn.onclick = () => deleteUser(u.id, u.username);
    row.appendChild(delBtn);
    el.appendChild(row);
  }
}
async function changeUserRole(id, role, previousRole, selectEl) {
  const labels = { viewer: 'view only', limited: 'limited control', master: 'master control' };
  if (!confirm(`Change access to ${labels[role]}?`)) { if (selectEl) selectEl.value = previousRole; return; }
  const res = await fetch(`/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ role }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not change access level'); if (selectEl) selectEl.value = previousRole; return; }
  loadUsers();
}
async function resetUserPassword(id, username) {
  const password = prompt(`New password for "${username}" (min 8 characters):`);
  if (password === null) return;
  if (password.length < 8) { alert('Password must be at least 8 characters'); return; }
  const res = await fetch(`/api/users/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ password }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not reset password'); return; }
  alert(`Password updated for ${username}.`);
}
async function createUser() {
  const username = document.getElementById('new-username').value.trim();
  const password = document.getElementById('new-password').value;
  const role = document.getElementById('new-role').value;
  if (!username || password.length < 8) { alert('Enter a username and a password of at least 8 characters'); return; }
  const res = await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', ...authHeader() }, body: JSON.stringify({ username, password, role }) });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not create account'); return; }
  document.getElementById('new-username').value = '';
  document.getElementById('new-password').value = '';
  loadUsers();
}
async function deleteUser(id, username) {
  if (!confirm(`Remove account "${username}"?`)) return;
  const res = await fetch(`/api/users/${id}`, { method: 'DELETE', headers: authHeader() });
  const data = await res.json();
  if (!res.ok) { alert(data.error || 'Could not remove account'); return; }
  loadUsers();
}

// ============================================================
// Misc
// ============================================================

function escapeHtml(str) { const div = document.createElement('div'); div.textContent = str ?? ''; return div.innerHTML; }

document.addEventListener('DOMContentLoaded', () => {
  const img = document.getElementById('screen');
  img.addEventListener('click', (e) => {
    if (!myRoleAtLeast('limited')) return;
    const rect = img.getBoundingClientRect();
    const scaleX = img.naturalWidth / rect.width;
    const scaleY = img.naturalHeight / rect.height;
    const x = Math.round((e.clientX - rect.left) * scaleX);
    const y = Math.round((e.clientY - rect.top) * scaleY);
    sendCmd('tap', { x, y });
  });
  document.getElementById('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  if (token) boot();
});
