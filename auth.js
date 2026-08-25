/************************************************************
 * auth.gs — who is the user, what may they do
 * Roles: Viewer < Editor < Admin. Areas: CSV of Area_IDs or ALL.
 * Every endpoint re-checks server-side; the UI hiding a button
 * is cosmetic only.
 ************************************************************/

const ROLE_RANK = { 'Viewer': 1, 'Editor': 2, 'Admin': 3 };

let _userPermsCache_ = null;
function getUserPermissions() {
  if (_userPermsCache_) return _userPermsCache_;
  const email = safeStr(Session.getActiveUser().getEmail()).toLowerCase();
  const data = getAllData(SHEET.PERMISSIONS);
  const c = H(SHEET.PERMISSIONS);
  let found = null;
  for (let i = 1; i < data.length; i++) {
    if (!isActive(data[i][c.Active])) continue;
    if (safeStr(data[i][c.Email]).toLowerCase() === email) { found = data[i]; break; }
  }
  if (!found) {
    _userPermsCache_ = { email: email, portalName: email, role: 'None', rank: 0, areas: [], allAreas: false };
    return _userPermsCache_;
  }
  const role = safeStr(found[c.Role]);
  const areasRaw = safeStr(found[c.Areas]).toUpperCase();
  _userPermsCache_ = {
    email: email,
    portalName: safeStr(found[c.Portal_Name]) || email,
    role: role,
    rank: ROLE_RANK[role] || 0,
    allAreas: areasRaw === 'ALL',
    areas: areasRaw === 'ALL' ? [] : areasRaw.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n))
  };
  return _userPermsCache_;
}

function canAccessArea_(perms, areaId) {
  return perms.allAreas || perms.areas.indexOf(Number(areaId)) >= 0;
}

function requireRole_(minRole) {
  const perms = getUserPermissions();
  if (perms.rank < ROLE_RANK[minRole]) {
    throw new Error('You do not have ' + minRole + ' access to this portal. Ask an Admin to update the Permissions tab.');
  }
  return perms;
}
function requireViewer() { return requireRole_('Viewer'); }
function requireEditor() { return requireRole_('Editor'); }
function requireAdmin()  { return requireRole_('Admin'); }

function requireEditorForArea_(areaId) {
  const perms = requireEditor();
  if (perms.rank < ROLE_RANK.Admin && !canAccessArea_(perms, areaId)) {
    throw new Error('You do not have edit access to this modelling area.');
  }
  return perms;
}
