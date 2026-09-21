const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { db } = require('./db');
const { normaliseRole, roleAtLeast } = require('./permissions');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;

// ---------- Dashboard user accounts (viewer / limited / master) ----------

function login(username, password) {
  const user = db.prepare(`SELECT * FROM users WHERE username = ?`).get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password_hash)) return null;
  const role = normaliseRole(user.role);
  const token = jwt.sign(
    { sub: user.id, username: user.username, role },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
  return { token, username: user.username, role };
}

function verifyUserToken(token) {
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    if (!payload.sub || !payload.role) return null;
    payload.role = normaliseRole(payload.role);
    return payload; // { sub, username, role }
  } catch {
    return null;
  }
}

/** Any logged-in account (viewer, limited or master) may pass. */
function requireAuth(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const payload = token ? verifyUserToken(token) : null;
  if (!payload) return res.status(401).json({ error: 'unauthorized' });
  req.user = payload;
  next();
}

/** Middleware factory: require at least `minRole` (viewer < limited < master). */
function requireRole(minRole) {
  return (req, res, next) => {
    requireAuth(req, res, () => {
      if (!roleAtLeast(req.user.role, minRole)) {
        return res.status(403).json({
          error: `this action needs ${minRole} access; your account is ${req.user.role}`,
        });
      }
      next();
    });
  };
}

/** Limited control OR master. */
const requireLimited = requireRole('limited');
/** Master control only (the IT / root tier). */
const requireMaster = requireRole('master');

// ---------- Device auth (per-device token issued at enrollment) ----------

function findDeviceByToken(token) {
  if (!token) return null;
  return db.prepare(`SELECT * FROM devices WHERE token = ?`).get(token) || null;
}

module.exports = {
  login,
  verifyUserToken,
  requireAuth,
  requireRole,
  requireLimited,
  requireMaster,
  findDeviceByToken,
};
