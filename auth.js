/************************************************************
 * auth.gs — who is the user, what may they do
 * Roles: Viewer < Editor < Admin. Areas: CSV of Area_IDs or ALL.
 * Every endpoint re-checks server-side; the UI hiding a button
 * is cosmetic only.
 *
 * On top of the rank sit four CAPABILITY columns on the
 * Permissions tab. They exist because one rank was doing too
 * many jobs at once: every Editor for an area could move rates,
 * component mixes and the dimension tables, and only an Admin
 * could read the change history. See CAPS below for the rules
 * that keep adding them safe.
 ************************************************************/

const ROLE_RANK = { 'Viewer': 1, 'Editor': 2, 'Admin': 3 };

/**
 * The capability columns, and what a BLANK cell means for each.
 *
 * Two rules make these safe to bolt onto a Permissions tab that already has
 * people on it:
 *
 *   1. A capability can only ever take rights AWAY. Every gate still runs the
 *      rank and area check it ran before, and the capability is an extra
 *      condition on top. Ticking Can_Edit_Dims does not make a Viewer an Admin.
 *
 *   2. A blank cell means "whatever the rank already said". verifySetup() fills
 *      a new header in but leaves the cells under it empty, so on the run after
 *      these columns are added every existing row keeps behaving exactly as it
 *      did. Nothing has to be backfilled before the deploy, and nothing breaks
 *      if it never is.
 *
 * `dflt` is what a blank cell resolves to, as a function of the row's rank:
 *
 *   editRates / editMixes / editDims  → true. The rank gate in front of them is
 *       what admits an Editor at all, so defaulting these on reproduces today's
 *       behaviour exactly: an Editor for an area gets all three, until somebody
 *       writes N in one of the cells.
 *
 *   viewAudit → Admin only. Defaulting it on would hand every Viewer the change
 *       history on the deploy that adds the column, which is a widening nobody
 *       asked for. Blank reproduces the Admin-only History tab of today; an
 *       explicit Y is how a non-Admin is granted it, which is the whole point of
 *       having the column.
 *
 * A cell is read as false only when it says so — N, NO, FALSE or 0. Anything
 * else legible (Y, TRUE, a ticked checkbox) is true. A Google Sheets checkbox
 * arrives as a real boolean, and an unticked one arrives as `false`, not blank,
 * so ticking the column on and off works as expected once somebody uses it.
 */
const CAPS = {
  editRates: { col: 'Can_Edit_Rates',  dflt: () => true,                what: 'edit rate card rows' },
  editMixes: { col: 'Can_Edit_Mixes',  dflt: () => true,                what: 'edit component or cold chain mixes' },
  editDims:  { col: 'Can_Edit_Dims',   dflt: () => true,                what: 'change the dimension tables' },
  viewAudit: { col: 'Can_View_Audit',  dflt: rank => rank >= ROLE_RANK.Admin, what: 'view the change history' }
};

/* One capability cell → boolean. `false` is a value, not an absence: an unticked
   Sheets checkbox is `false` and must not be mistaken for "not filled in". */
function capOf_(cell, rank, spec) {
  if (cell === '' || cell === null || cell === undefined) return spec.dflt(rank);
  if (cell === true) return true;
  if (cell === false) return false;
  const s = safeStr(cell).toUpperCase();
  if (s === '') return spec.dflt(rank);
  return ['N', 'NO', 'FALSE', '0'].indexOf(s) < 0;
}

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
    _userPermsCache_ = { email: email, portalName: email, role: 'None', rank: 0,
                         areas: [], allAreas: false, caps: noCaps_() };
    return _userPermsCache_;
  }
  const role = safeStr(found[c.Role]);
  const rank = ROLE_RANK[role] || 0;
  const areasRaw = safeStr(found[c.Areas]).toUpperCase();
  const caps = {};
  Object.keys(CAPS).forEach(k => {
    /* A tab that predates the columns has no index for them at all, which reads
       the same as a blank cell — the default for the rank. */
    const idx = c[CAPS[k].col];
    caps[k] = capOf_(idx === undefined ? '' : found[idx], rank, CAPS[k]);
  });
  _userPermsCache_ = {
    email: email,
    portalName: safeStr(found[c.Portal_Name]) || email,
    role: role,
    rank: rank,
    caps: caps,
    allAreas: areasRaw === 'ALL',
    areas: areasRaw === 'ALL' ? [] : areasRaw.split(',').map(s => parseInt(s, 10)).filter(n => !isNaN(n))
  };
  return _userPermsCache_;
}

function noCaps_() {
  const o = {};
  Object.keys(CAPS).forEach(k => o[k] = false);
  return o;
}

function canAccessArea_(perms, areaId) {
  return perms.allAreas || perms.areas.indexOf(Number(areaId)) >= 0;
}

/* ---------------- refusals are recorded ----------------
 *
 * Each gate below logs before it throws. logDenied_ never throws and never gates
 * (see utils.js), so the message the caller gets is unchanged and a logging
 * failure cannot mask a permission failure.
 *
 * Exactly one row per refused call, because the gates nest rather than sit side
 * by side: requireEditRatesForArea_ is requireEditorForArea_ is requireEditor,
 * and the first to say no is the one that throws. The row that lands is
 * therefore the innermost reason — "not an Editor" rather than "no editRates"
 * for somebody who is neither, which is the one an Admin can act on.
 *
 * What is deliberately NOT logged is initApp returning {authorised:false} for an
 * unknown email. That is the shell saying "you are not set up", not an action
 * being refused, and it fires on every page load — a row per refresh would bury
 * the refusals worth reading. Such a person cannot reach a gate anyway: the
 * client draws the not-in-Permissions panel and calls nothing else.
 */
function requireRole_(minRole) {
  const perms = getUserPermissions();
  if (perms.rank < ROLE_RANK[minRole]) {
    logDenied_(perms, 'PORTAL', minRole,
      'needs ' + minRole + ' access; this account is ' + roleText_(perms));
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
    logDenied_(perms, 'AREA', areaId, 'edit refused — scoped to ' + areasText_(perms));
    throw new Error('You do not have edit access to this modelling area.');
  }
  return perms;
}

/* What a refusal row should say the account actually is. Rank 0 has two causes
   worth telling apart, because they are fixed differently: no matching active
   row at all (getUserPermissions calls that role 'None'), or a row whose Role
   cell holds something ROLE_RANK does not recognise — a typo, which reads as no
   access and is invisible on the tab itself. */
function roleText_(perms) {
  if (perms.rank) return perms.role;
  const r = safeStr(perms.role);
  return (r && r !== 'None')
    ? 'set to an unrecognised role "' + r + '"'
    : 'not in the Permissions tab, or its row is switched off';
}

/* And what its area scope is, so the refusal is readable without opening the
   Permissions tab alongside it. */
function areasText_(perms) {
  if (perms.allAreas) return 'ALL';
  return perms.areas.length ? 'areas ' + perms.areas.join(',') : 'no areas';
}

/* ---------------- capability gates ----------------
 *
 * Each is the rank-and-area check the call site already had, plus one column.
 * Kept thin on purpose: the interesting decision is which capability a call site
 * needs, and that belongs at the call site, not buried in a branch here.
 */
function requireCapability_(perms, cap) {
  const spec = CAPS[cap];
  if (!spec) throw new Error('Unknown capability "' + cap + '".');
  if (perms.caps && perms.caps[cap]) return perms;
  /* An unknown capability is a programming error and threw above. This is the
     real refusal, so this is the one that leaves a row. */
  logDenied_(perms, 'CAPABILITY', cap, spec.col + ' is N — cannot ' + spec.what);
  throw new Error('Your access does not let you ' + spec.what + '. ' +
    'The ' + spec.col + ' column on the Permissions tab is set to N for ' + perms.email +
    ' — ask an Admin to change it.');
}

function requireEditRatesForArea_(areaId) {
  return requireCapability_(requireEditorForArea_(areaId), 'editRates');
}
function requireEditMixesForArea_(areaId) {
  return requireCapability_(requireEditorForArea_(areaId), 'editMixes');
}
/**
 * Dimension edits.
 *
 * The rank floor here is ADMIN, not Editor, because that is what dimensions.js
 * has always required — the dimension tables define what every area is made of,
 * and _upsertDim_ has never been open to an area Editor. Capability columns
 * narrow, so this one narrows Admin: it cannot be the route by which an Editor
 * gains dimension rights they did not have yesterday.
 *
 * areaId is still checked for the sake of the shape, and because an Admin
 * scoped to specific areas is a configuration this portal permits even if
 * requireEditorForArea_ waves Admins through today.
 */
function requireEditDimsForArea_(areaId) {
  const perms = requireAdmin();
  if (perms.rank < ROLE_RANK.Admin && !canAccessArea_(perms, areaId)) {
    logDenied_(perms, 'AREA', areaId, 'dimension edit refused — scoped to ' + areasText_(perms));
    throw new Error('You do not have edit access to this modelling area.');
  }
  return requireCapability_(perms, 'editDims');
}

/**
 * Read the change history.
 *
 * Viewer rank plus the capability, so history can be granted to somebody who
 * should not be made an Admin — which is the reason the column exists. Blank
 * still resolves to Admin-only, so nobody gains sight of it by this deploy.
 */
function requireViewAudit_() {
  return requireCapability_(requireViewer(), 'viewAudit');
}
