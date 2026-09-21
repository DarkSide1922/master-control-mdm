const { WebSocketServer } = require('ws');
const url = require('url');
const { db, getSetting } = require('./db');
const { findDeviceByToken, verifyUserToken } = require('./auth');
const { canRunAction } = require('./permissions');

// Multi-device: each connected tablet gets its own socket, keyed by its device row id.
const deviceSockets = new Map();     // deviceId -> ws
const dashboardSockets = new Map();  // ws -> { watchingDeviceId: number|null, role: string }

function setupWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const { pathname, query } = url.parse(req.url, true);

    if (pathname === '/ws/device') {
      const device = findDeviceByToken(query.token);
      if (!device) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => handleDeviceConnection(ws, device));
      return;
    }

    if (pathname === '/ws/dashboard') {
      const user = verifyUserToken(query.token);
      if (!user) { socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => handleDashboardConnection(ws, user));
      return;
    }

    socket.destroy();
  });
}

// ---------- Device connections ----------

function handleDeviceConnection(ws, device) {
  const existing = deviceSockets.get(device.id);
  if (existing) { try { existing.close(); } catch {} }
  deviceSockets.set(device.id, ws);
  setDeviceOnline(device.id, true);
  broadcastFleetEvent({ type: 'device_online', deviceId: device.id });
  deliverQueuedCommands(device.id);

  ws.on('message', (raw, isBinary) => {
    if (isBinary) { broadcastFrameToWatchers(device.id, raw); return; }
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleDeviceMessage(device.id, msg);
  });

  ws.on('close', () => {
    if (deviceSockets.get(device.id) === ws) {
      deviceSockets.delete(device.id);
      setDeviceOnline(device.id, false);
      broadcastFleetEvent({ type: 'device_offline', deviceId: device.id });
    }
  });

  ws.on('error', () => {});
}

function deliverQueuedCommands(deviceId) {
  const queued = db.prepare(`SELECT * FROM commands WHERE device_id = ? AND status = 'pending' ORDER BY id ASC`)
    .all(deviceId);
  for (const cmd of queued) {
    sendToDevice(deviceId, {
      type: 'command',
      commandId: cmd.id,
      action: cmd.action,
      params: cmd.params_json ? JSON.parse(cmd.params_json) : {},
    });
    db.prepare(`UPDATE commands SET status='sent', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(cmd.id);
  }
}

function handleDeviceMessage(deviceId, msg) {
  switch (msg.type) {
    case 'status': {
      const data = msg.data ?? {};
      const agentVersion = data.agentVersion || null;
      db.prepare(
        `UPDATE devices SET online=1, last_seen=CURRENT_TIMESTAMP, battery=?, status_json=?,
                            agent_version=COALESCE(?, agent_version) WHERE id=?`
      ).run(msg.battery ?? null, JSON.stringify(data), agentVersion, deviceId);

      broadcastToWatchers(deviceId, { type: 'status', deviceId, battery: msg.battery, data });
      broadcastFleetEvent({ type: 'device_status_summary', deviceId, battery: msg.battery, online: true });

      // Requirement 7: silent, in-place OTA. If a newer build is published for the
      // fleet and auto-update is on, hand the device an update_agent command. Because
      // the agent is Device Owner and the update is an in-place install of the same
      // signed package, Device-Owner status and every previously-granted permission
      // survive the update -- nothing needs to be re-granted by hand.
      maybeAutoUpdate(deviceId, agentVersion);

      sendToDevice(deviceId, { type: 'session_policy', keepAlive: deviceShouldStayAwake(deviceId) });
      break;
    }
    case 'command_ack': {
      db.prepare(`UPDATE commands SET status=?, result_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND device_id=?`)
        .run(msg.success ? 'acked' : 'failed', JSON.stringify(msg.result ?? {}), msg.commandId, deviceId);
      broadcastToWatchers(deviceId, {
        type: 'command_result', deviceId, commandId: msg.commandId, success: msg.success, result: msg.result,
      });
      break;
    }
    case 'webrtc_answer':
    case 'webrtc_ice_from_device':
      broadcastToWatchers(deviceId, { ...msg, deviceId });
      break;
    default:
      break;
  }
}

/** Auto-push the published software update to a device that is out of date. */
function maybeAutoUpdate(deviceId, agentVersion) {
  try {
    if (getSetting('auto_update_enabled') !== '1') return;
    const url = getSetting('update_apk_url');
    const target = getSetting('update_version');
    if (!url || !target) return;
    if (agentVersion && agentVersion === target) return; // already up to date

    // Don't stack duplicate updates: skip if one is already queued or in flight.
    const inflight = db.prepare(
      `SELECT COUNT(*) AS n FROM commands WHERE device_id=? AND action='update_agent' AND status IN ('pending','sent')`
    ).get(deviceId).n;
    if (inflight > 0) return;

    sendCommandToDevice(deviceId, 'update_agent', { url, version: target }, 'auto-update');
  } catch {}
}

function deviceShouldStayAwake(deviceId) {
  const isWatched = [...dashboardSockets.values()].some((conn) => conn.watchingDeviceId === deviceId);
  if (isWatched) return true;
  const outstanding = db.prepare(`SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND status = 'sent'`)
    .get(deviceId).n;
  return outstanding > 0;
}

// ---------- Dashboard connections ----------

function handleDashboardConnection(ws, user) {
  dashboardSockets.set(ws, { watchingDeviceId: null, role: user.role });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleDashboardMessage(ws, user, msg);
  });

  ws.on('close', () => dashboardSockets.delete(ws));
  ws.on('error', () => {});
}

function handleDashboardMessage(ws, user, msg) {
  const conn = dashboardSockets.get(ws);
  if (!conn) return;

  switch (msg.type) {
    case 'watch_device': {
      const deviceId = Number(msg.deviceId);
      conn.watchingDeviceId = Number.isFinite(deviceId) ? deviceId : null;
      ws.send(JSON.stringify({
        type: deviceSockets.has(conn.watchingDeviceId) ? 'device_online' : 'device_offline',
        deviceId: conn.watchingDeviceId,
      }));
      if (conn.watchingDeviceId && deviceSockets.has(conn.watchingDeviceId)) {
        sendToDevice(conn.watchingDeviceId, { type: 'session_policy', keepAlive: true });
      }
      break;
    }
    case 'send_command': {
      // Central authorization: the exact same table the REST layer uses.
      if (!canRunAction(user.role, msg.action)) return;
      if (!conn.watchingDeviceId) return;
      sendCommandToDevice(conn.watchingDeviceId, msg.action, msg.params ?? {}, user.username);
      break;
    }
    case 'webrtc_offer':
    case 'webrtc_ice_from_dashboard':
      if (conn.watchingDeviceId) sendToDevice(conn.watchingDeviceId, msg);
      break;
    default:
      break;
  }
}

// ---------- Command dispatch ----------

function sendCommandToDevice(deviceId, action, params, issuedBy = null) {
  const info = db.prepare(
    `INSERT INTO commands (device_id, action, params_json, status, issued_by) VALUES (?, ?, ?, 'pending', ?)`
  ).run(deviceId, action, JSON.stringify(params), issuedBy);
  const commandId = info.lastInsertRowid;

  if (deviceSockets.has(deviceId)) {
    sendToDevice(deviceId, { type: 'command', commandId, action, params });
    db.prepare(`UPDATE commands SET status='sent', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(commandId);
  }
  return commandId;
}

/** Push the persisted control-list decisions to a device (used when it comes online
 *  or when an operator hits "sync"). Small lists, so this stays cheap. */
function syncControlList(deviceId, issuedBy = null) {
  const entries = db.prepare(`SELECT package_name, policy FROM app_controllist WHERE device_id = ?`).all(deviceId);
  let n = 0;
  for (const e of entries) {
    sendCommandToDevice(deviceId, 'set_app_hidden',
      { packageName: e.package_name, hidden: e.policy === 'block' }, issuedBy);
    n++;
  }
  return n;
}

function sendToDevice(deviceId, obj) {
  const ws = deviceSockets.get(deviceId);
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- Broadcasting ----------

function broadcastToWatchers(deviceId, obj) {
  const payload = JSON.stringify(obj);
  for (const [ws, conn] of dashboardSockets) {
    if (conn.watchingDeviceId === deviceId && ws.readyState === 1) ws.send(payload);
  }
}

function broadcastFrameToWatchers(deviceId, buf) {
  for (const [ws, conn] of dashboardSockets) {
    if (conn.watchingDeviceId === deviceId && ws.readyState === 1) ws.send(buf, { binary: true });
  }
}

function broadcastFleetEvent(obj) {
  const payload = JSON.stringify(obj);
  for (const ws of dashboardSockets.keys()) {
    if (ws.readyState === 1) ws.send(payload);
  }
}

function setDeviceOnline(deviceId, online) {
  db.prepare(`UPDATE devices SET online=?, last_seen=CURRENT_TIMESTAMP WHERE id=?`).run(online ? 1 : 0, deviceId);
}

function isDeviceConnected(deviceId) {
  return deviceSockets.has(deviceId);
}

module.exports = { setupWebSocketServer, sendCommandToDevice, syncControlList, isDeviceConnected };
