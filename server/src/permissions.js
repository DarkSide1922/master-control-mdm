// ============================================================
// Access model — the single source of truth for the three tiers
// ============================================================
//
// The whole app now has THREE access levels instead of two. This module is
// imported by both the REST layer (routes/api.js) and the WebSocket layer
// (wsHub.js) so a command can never be authorised in one place and rejected in
// the other — there is exactly one table that decides who may do what.
//
//   viewer  — "view only":        watch screens/status, read lists. No changes.
//   limited — "limited control":  the safe classroom/administration subset —
//                                  lock, volume, navigation, open/close & block
//                                  apps, keep-awake, wake, screen stream, and
//                                  editing the watch/control lists. Cannot do
//                                  anything destructive or root-level.
//   master  — "master control":   everything limited can do PLUS the IT/root
//                                  tier: reboot, wipe, install/uninstall, camera
//                                  disable, lockdown, kiosk, the settings
//                                  deadlock, the root/shell console, and pushing
//                                  software updates.
//
// Older databases used the two roles 'viewer' and 'full'. 'full' is migrated to
// 'master' on boot (see db.js), and 'full' is still accepted as an alias here so
// nothing breaks mid-upgrade.

const ROLE_RANK = {
  viewer: 0,
  limited: 1,
  master: 2,
  full: 2, // legacy alias for master
};

const ROLES = ['viewer', 'limited', 'master'];

/** True if `role` is at least as privileged as `min`. */
function roleAtLeast(role, min) {
  return (ROLE_RANK[role] ?? -1) >= (ROLE_RANK[min] ?? 99);
}

/** Normalise a stored/legacy role string to one of the three canonical roles. */
function normaliseRole(role) {
  if (role === 'full') return 'master';
  return ROLES.includes(role) ? role : 'viewer';
}

// ---- What minimum role each device command requires ----
// Anything NOT listed here defaults to 'master' (fail-closed): a new command a
// future version adds is locked to master until someone deliberately loosens it.
const ACTION_MIN_ROLE = {
  // read-only / harmless — available to limited control and up
  get_status: 'viewer',
  list_apps: 'viewer',
  start_screen_stream: 'viewer',
  stop_screen_stream: 'viewer',

  // classroom / administration control — limited and up
  lock_now: 'limited',
  set_volume: 'limited',
  set_muted: 'limited',
  wake_device: 'limited',
  set_keep_awake: 'limited',
  launch_app: 'limited',
  close_app: 'limited',
  set_app_hidden: 'limited', // block/unblock a distracting app
  tap: 'limited',
  swipe: 'limited',
  page_swipe: 'limited',
  go_home: 'limited',
  go_back: 'limited',
  show_recents: 'limited',
  show_notifications: 'limited',
  show_quick_settings: 'limited',
  set_settings_lock: 'limited', // settings "deadlock": allow / limit / block

  // IT / root tier — master only
  reboot_device: 'master',
  wipe_device: 'master',
  install_apk: 'master',
  uninstall_app: 'master',
  set_camera_disabled: 'master',
  lockdown_on: 'master',
  lockdown_off: 'master',
  set_kiosk: 'master',
  run_shell: 'master',      // the root / shell command console
  update_agent: 'master',   // push an in-place software update
};

/** Minimum role needed to issue `action`; unknown actions require master. */
function minRoleForAction(action) {
  return ACTION_MIN_ROLE[action] || 'master';
}

/** True if a user with `role` is allowed to issue `action`. */
function canRunAction(role, action) {
  return roleAtLeast(normaliseRole(role), minRoleForAction(action));
}

const ALLOWED_ACTIONS = new Set(Object.keys(ACTION_MIN_ROLE));

module.exports = {
  ROLES,
  ROLE_RANK,
  ALLOWED_ACTIONS,
  ACTION_MIN_ROLE,
  roleAtLeast,
  normaliseRole,
  minRoleForAction,
  canRunAction,
};
