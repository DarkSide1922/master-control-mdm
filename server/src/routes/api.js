const express = require('express');
const bcrypt = require('bcryptjs');
const { db, generateToken, getSetting, setSetting } = require('../db');
const { login, requireAuth, requireLimited, requireMaster } = require('../auth');
const { sendCommandToDevice, syncControlList, isDeviceConnected } = require('../wsHub');
const { ALLOWED_ACTIONS, canRunAction, minRoleForAction, ROLES } = require('../permissions');

const router = express.Router();

// ============================================================
// Auth
// ============================================================

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  const result = login(username, password);
  if (!result) return res.status(401).json({ error: 'invalid username or password' });
  res.json(result);
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.sub, username: req.user.username, role: req.user.role });
});

// ============================================================
// Device enrollment (Android registration screen; guarded by ENROLLMENT_SECRET)
// ============================================================

function resolveSchool(schoolName) {
  let school = db.prepare(`SELECT * FROM schools WHERE name = ? COLLATE NOCASE`).get(schoolName);
  if (!school) {
    const info = db.prepare(`INSERT INTO schools (name) VALUES (?)`).run(schoolName);
    school = { id: info.lastInsertRowid, name: schoolName };
  }
  return school;
}

router.post('/enroll', (req, res) => {
  const { enrollmentSecret, schoolName, tabletNumber, tabletName, deviceUid, hardwareId, macAddress, model, agentVersion } = req.body;

  if (!process.env.ENROLLMENT_SECRET || enrollmentSecret !== process.env.ENROLLMENT_SECRET) {
    return res.status(401).json({ error: 'invalid enrollment secret' });
  }
  if (!schoolName?.trim() || !tabletNumber?.trim() || !deviceUid?.trim()) {
    return res.status(400).json({ error: 'schoolName, tabletNumber, and deviceUid are all required' });
  }

  const school = resolveSchool(schoolName.trim());
  const cleanName = tabletName?.trim() || null;
  const hwId = hardwareId?.trim() || null;

  const existing =
    (hwId && db.prepare(`SELECT * FROM devices WHERE hardware_id = ?`).get(hwId)) ||
    db.prepare(`SELECT * FROM devices WHERE device_uid = ?`).get(deviceUid.trim());

  if (existing) {
    const clash = db.prepare(
      `SELECT 1 FROM devices WHERE school_id = ? AND tablet_number = ? AND id != ?`
    ).get(school.id, tabletNumber.trim(), existing.id);
    if (clash) {
      return res.status(409).json({ error: `Tablet number "${tabletNumber.trim()}" is already used at ${school.name}` });
    }

    const newToken = generateToken();
    db.prepare(
      `UPDATE devices
         SET school_id = ?, tablet_number = ?, tablet_name = ?,
             hardware_id = COALESCE(?, hardware_id), mac_address = COALESCE(?, mac_address),
             model = COALESCE(?, model), agent_version = COALESCE(?, agent_version), token = ?
       WHERE id = ?`
    ).run(school.id, tabletNumber.trim(), cleanName, hwId, macAddress?.trim() || null,
          model?.trim() || null, agentVersion?.trim() || null, newToken, existing.id);

    return res.json({
      deviceId: existing.id, deviceToken: newToken,
      schoolName: school.name, tabletNumber: tabletNumber.trim(), tabletName: cleanName || '',
      updated: true,
    });
  }

  const clash = db.prepare(`SELECT 1 FROM devices WHERE school_id = ? AND tablet_number = ?`)
    .get(school.id, tabletNumber.trim());
  if (clash) {
    return res.status(409).json({ error: `Tablet number "${tabletNumber.trim()}" is already registered at ${school.name}` });
  }

  const token = generateToken();
  const info = db.prepare(
    `INSERT INTO devices (school_id, tablet_number, tablet_name, device_uid, hardware_id, mac_address, model, agent_version, token)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(school.id, tabletNumber.trim(), cleanName, deviceUid.trim(), hwId,
        macAddress?.trim() || null, model?.trim() || null, agentVersion?.trim() || null, token);

  res.json({
    deviceId: info.lastInsertRowid, deviceToken: token,
    schoolName: school.name, tabletNumber: tabletNumber.trim(), tabletName: cleanName || '',
  });
});

// ============================================================
// Schools  (structure changes = master; nothing here for limited/viewer to write)
// ============================================================

router.get('/schools', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT s.id, s.name, s.created_at,
           COUNT(d.id) AS deviceCount,
           SUM(CASE WHEN d.online = 1 THEN 1 ELSE 0 END) AS onlineCount
    FROM schools s
    LEFT JOIN devices d ON d.school_id = s.id
    GROUP BY s.id
    ORDER BY s.name COLLATE NOCASE
  `).all();
  res.json(rows);
});

router.post('/schools', requireMaster, (req, res) => {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  try {
    const info = db.prepare(`INSERT INTO schools (name) VALUES (?)`).run(name.trim());
    res.json({ id: info.lastInsertRowid, name: name.trim() });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'a school with that name already exists' });
    throw e;
  }
});

router.patch('/schools/:id', requireMaster, (req, res) => {
  const id = Number(req.params.id);
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });
  const school = db.prepare(`SELECT * FROM schools WHERE id = ?`).get(id);
  if (!school) return res.status(404).json({ error: 'school not found' });
  try {
    db.prepare(`UPDATE schools SET name = ? WHERE id = ?`).run(name.trim(), id);
    res.json({ id, name: name.trim() });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'a school with that name already exists' });
    throw e;
  }
});

router.delete('/schools/:id', requireMaster, (req, res) => {
  const id = Number(req.params.id);
  const school = db.prepare(`SELECT * FROM schools WHERE id = ?`).get(id);
  if (!school) return res.status(404).json({ error: 'school not found' });
  db.prepare(`DELETE FROM schools WHERE id = ?`).run(id);
  res.json({ ok: true });
});

// ============================================================
// Devices
// ============================================================

function deviceRowToJson(d) {
  const data = d.status_json ? JSON.parse(d.status_json) : {};
  return {
    id: d.id,
    schoolId: d.school_id,
    tabletNumber: d.tablet_number,
    tabletName: d.tablet_name || '',
    model: d.model || '',
    macAddress: d.mac_address || '',
    agentVersion: d.agent_version || (data.agentVersion || ''),
    isDeviceOwner: data.isDeviceOwner === true,
    online: isDeviceConnected(d.id),
    lastSeen: d.last_seen,
    battery: d.battery,
    data,
  };
}

router.get('/devices', requireAuth, (req, res) => {
  const schoolId = req.query.schoolId ? Number(req.query.schoolId) : null;
  const rows = schoolId
    ? db.prepare(`SELECT * FROM devices WHERE school_id = ? ORDER BY tablet_number COLLATE NOCASE`).all(schoolId)
    : db.prepare(`SELECT * FROM devices ORDER BY school_id, tablet_number COLLATE NOCASE`).all();
  res.json(rows.map(deviceRowToJson));
});

router.get('/devices/:id/status', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id);
  if (!row) return res.status(404).json({ error: 'device not found' });
  res.json({
    online: isDeviceConnected(id),
    lastSeen: row.last_seen,
    battery: row.battery,
    agentVersion: row.agent_version || '',
    data: row.status_json ? JSON.parse(row.status_json) : {},
  });
});

router.delete('/devices/:id', requireMaster, (req, res) => {
  db.prepare(`DELETE FROM devices WHERE id = ?`).run(Number(req.params.id));
  res.json({ ok: true });
});

router.patch('/devices/:id', requireLimited, (req, res) => {
  const id = Number(req.params.id);
  const { tabletNumber, tabletName } = req.body;
  if (!tabletNumber?.trim()) return res.status(400).json({ error: 'tabletNumber is required' });
  const device = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id);
  if (!device) return res.status(404).json({ error: 'device not found' });

  const clash = db.prepare(`SELECT 1 FROM devices WHERE school_id = ? AND tablet_number = ? AND id != ?`)
    .get(device.school_id, tabletNumber.trim(), id);
  if (clash) {
    return res.status(409).json({ error: `Tablet number "${tabletNumber.trim()}" is already used at this school` });
  }

  db.prepare(`UPDATE devices SET tablet_number = ?, tablet_name = ? WHERE id = ?`)
    .run(tabletNumber.trim(), tabletName?.trim() || null, id);
  res.json({ id, tabletNumber: tabletNumber.trim(), tabletName: tabletName?.trim() || '' });
});

// ============================================================
// Fleet-wide stats (for the dashboard overview charts)
// ============================================================

router.get('/stats', requireAuth, (req, res) => {
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM schools) AS schools,
      (SELECT COUNT(*) FROM devices) AS tablets,
      (SELECT COUNT(*) FROM devices WHERE online = 1) AS online
  `).get();

  const perSchool = db.prepare(`
    SELECT s.name AS school,
           COUNT(d.id) AS tablets,
           SUM(CASE WHEN d.online = 1 THEN 1 ELSE 0 END) AS online
    FROM schools s
    LEFT JOIN devices d ON d.school_id = s.id
    GROUP BY s.id
    ORDER BY tablets DESC, s.name COLLATE NOCASE
  `).all();

  res.json({
    schools: totals.schools || 0,
    tablets: totals.tablets || 0,
    online: totals.online || 0,
    offline: (totals.tablets || 0) - (totals.online || 0),
    perSchool: perSchool.map((r) => ({ school: r.school, tablets: r.tablets || 0, online: r.online || 0 })),
  });
});

// ============================================================
// Commands (scoped to one device) — authorised per-action by the caller's role
// ============================================================

router.get('/devices/:id/commands', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT * FROM commands WHERE device_id = ? ORDER BY id DESC LIMIT 60`)
    .all(Number(req.params.id));
  res.json(rows.map(r => ({
    ...r,
    params: r.params_json ? JSON.parse(r.params_json) : {},
    result: r.result_json ? JSON.parse(r.result_json) : null,
  })));
});

router.post('/devices/:id/commands', requireAuth, (req, res) => {
  const deviceId = Number(req.params.id);
  const { action, params } = req.body;
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: `unknown action: ${action}` });
  }
  // Requirement 6: the caller's tier decides whether this specific action is allowed.
  if (!canRunAction(req.user.role, action)) {
    return res.status(403).json({
      error: `"${action}" needs ${minRoleForAction(action)} access; your account is ${req.user.role}`,
    });
  }
  const device = db.prepare(`SELECT id FROM devices WHERE id = ?`).get(deviceId);
  if (!device) return res.status(404).json({ error: 'device not found' });

  const delivered = isDeviceConnected(deviceId);
  const commandId = sendCommandToDevice(deviceId, action, params ?? {}, req.user.username);
  res.json({ commandId, delivered });
});

// ============================================================
// App watch list (limited+)  — "keep an eye on these apps"
// ============================================================

router.get('/devices/:id/watchlist', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT id, package_name AS packageName, label, note, created_at
                           FROM app_watchlist WHERE device_id = ? ORDER BY label COLLATE NOCASE, package_name`)
    .all(Number(req.params.id));
  res.json(rows);
});

router.post('/devices/:id/watchlist', requireLimited, (req, res) => {
  const deviceId = Number(req.params.id);
  const { packageName, label, note } = req.body;
  if (!packageName?.trim()) return res.status(400).json({ error: 'packageName is required' });
  try {
    db.prepare(`INSERT INTO app_watchlist (device_id, package_name, label, note) VALUES (?, ?, ?, ?)`)
      .run(deviceId, packageName.trim(), label?.trim() || packageName.trim(), note?.trim() || null);
    res.json({ ok: true });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'that app is already on the watch list' });
    throw e;
  }
});

router.delete('/devices/:id/watchlist/:wid', requireLimited, (req, res) => {
  db.prepare(`DELETE FROM app_watchlist WHERE id = ? AND device_id = ?`)
    .run(Number(req.params.wid), Number(req.params.id));
  res.json({ ok: true });
});

// ============================================================
// App control list (limited+)  — allow / block decisions that persist
// ============================================================

router.get('/devices/:id/controllist', requireAuth, (req, res) => {
  const rows = db.prepare(`SELECT id, package_name AS packageName, label, policy, created_at
                           FROM app_controllist WHERE device_id = ? ORDER BY label COLLATE NOCASE, package_name`)
    .all(Number(req.params.id));
  res.json(rows);
});

// Upsert a control-list decision, and immediately push it to the device.
router.put('/devices/:id/controllist', requireLimited, (req, res) => {
  const deviceId = Number(req.params.id);
  const { packageName, label, policy } = req.body;
  if (!packageName?.trim()) return res.status(400).json({ error: 'packageName is required' });
  if (!['allow', 'block'].includes(policy)) return res.status(400).json({ error: `policy must be "allow" or "block"` });

  db.prepare(`INSERT INTO app_controllist (device_id, package_name, label, policy) VALUES (?, ?, ?, ?)
              ON CONFLICT(device_id, package_name) DO UPDATE SET policy = excluded.policy, label = excluded.label`)
    .run(deviceId, packageName.trim(), label?.trim() || packageName.trim(), policy);

  // Apply straight away (queued if the tablet is asleep).
  const commandId = sendCommandToDevice(deviceId, 'set_app_hidden',
    { packageName: packageName.trim(), hidden: policy === 'block' }, req.user.username);
  res.json({ ok: true, commandId });
});

router.delete('/devices/:id/controllist/:cid', requireLimited, (req, res) => {
  const deviceId = Number(req.params.id);
  const row = db.prepare(`SELECT * FROM app_controllist WHERE id = ? AND device_id = ?`)
    .get(Number(req.params.cid), deviceId);
  if (row) {
    // Removing a "block" entry unblocks the app so it isn't silently left hidden.
    if (row.policy === 'block') {
      sendCommandToDevice(deviceId, 'set_app_hidden', { packageName: row.package_name, hidden: false }, req.user.username);
    }
    db.prepare(`DELETE FROM app_controllist WHERE id = ?`).run(row.id);
  }
  res.json({ ok: true });
});

// Re-push every control-list decision to the device now.
router.post('/devices/:id/controllist/sync', requireLimited, (req, res) => {
  const n = syncControlList(Number(req.params.id), req.user.username);
  res.json({ ok: true, pushed: n });
});

// ============================================================
// Software update manifest + push (master only) — requirement 7
// ============================================================

router.get('/update-manifest', requireAuth, (req, res) => {
  res.json({
    version: getSetting('update_version') || '',
    url: getSetting('update_apk_url') || '',
    autoUpdate: getSetting('auto_update_enabled') === '1',
  });
});

router.put('/update-manifest', requireMaster, (req, res) => {
  const { version, url, autoUpdate } = req.body;
  if (version !== undefined) setSetting('update_version', String(version || '').trim());
  if (url !== undefined) setSetting('update_apk_url', String(url || '').trim());
  if (autoUpdate !== undefined) setSetting('auto_update_enabled', autoUpdate ? '1' : '0');
  res.json({
    version: getSetting('update_version') || '',
    url: getSetting('update_apk_url') || '',
    autoUpdate: getSetting('auto_update_enabled') === '1',
  });
});

// Push the published update to one device right now.
router.post('/devices/:id/update', requireMaster, (req, res) => {
  const deviceId = Number(req.params.id);
  const url = (req.body.url || getSetting('update_apk_url') || '').trim();
  const version = (req.body.version || getSetting('update_version') || '').trim();
  if (!url) return res.status(400).json({ error: 'no update URL set (publish one in the update manifest first)' });
  const commandId = sendCommandToDevice(deviceId, 'update_agent', { url, version }, req.user.username);
  res.json({ ok: true, commandId, delivered: isDeviceConnected(deviceId) });
});

// Push the published update to an entire school.
router.post('/schools/:id/update', requireMaster, (req, res) => {
  const schoolId = Number(req.params.id);
  const url = (getSetting('update_apk_url') || '').trim();
  const version = (getSetting('update_version') || '').trim();
  if (!url) return res.status(400).json({ error: 'no update URL set (publish one in the update manifest first)' });
  const rows = db.prepare(`SELECT id FROM devices WHERE school_id = ?`).all(schoolId);
  for (const r of rows) sendCommandToDevice(r.id, 'update_agent', { url, version }, req.user.username);
  res.json({ ok: true, pushed: rows.length });
});

// ============================================================
// User accounts (viewer / limited / master) — master only
// ============================================================

router.get('/users', requireMaster, (req, res) => {
  const rows = db.prepare(`SELECT id, username, role, created_at FROM users ORDER BY username COLLATE NOCASE`).all();
  res.json(rows);
});

router.post('/users', requireMaster, (req, res) => {
  const { username, password, role } = req.body;
  if (!username?.trim() || !password || password.length < 8) {
    return res.status(400).json({ error: 'username and a password of at least 8 characters are required' });
  }
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
  }
  try {
    const hash = bcrypt.hashSync(password, 10);
    const info = db.prepare(`INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)`)
      .run(username.trim(), hash, role);
    res.json({ id: info.lastInsertRowid, username: username.trim(), role });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'that username is already taken' });
    throw e;
  }
});

router.patch('/users/:id', requireMaster, (req, res) => {
  const id = Number(req.params.id);
  const { role, password } = req.body;
  const target = db.prepare(`SELECT * FROM users WHERE id = ?`).get(id);
  if (!target) return res.status(404).json({ error: 'account not found' });

  if (role !== undefined) {
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${ROLES.join(', ')}` });
    }
    // Don't let the last master account drop itself below master and lock everyone out.
    if (id === req.user.sub && role !== 'master') {
      const masters = db.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'master'`).get().n;
      if (masters <= 1) {
        return res.status(400).json({ error: "you're the only master-control account — promote someone else first" });
      }
    }
    db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(role, id);
  }

  if (password !== undefined) {
    if (!password || password.length < 8) {
      return res.status(400).json({ error: 'password must be at least 8 characters' });
    }
    db.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).run(bcrypt.hashSync(password, 10), id);
  }

  const updated = db.prepare(`SELECT id, username, role FROM users WHERE id = ?`).get(id);
  res.json(updated);
});

router.delete('/users/:id', requireMaster, (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.sub) {
    return res.status(400).json({ error: "you can't delete your own account while logged in as it" });
  }
  db.prepare(`DELETE FROM users WHERE id = ?`).run(id);
  res.json({ ok: true });
});

module.exports = router;
