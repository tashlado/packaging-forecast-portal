/************************************************************
 * Code.gs — entry point and the two-phase load
 ************************************************************/

/* How much of Audit_Log the History tab gets in the phase-2 payload. A bulk
   change writes about five rows per rate, so this is a few dozen bulk batches
   rather than a few hundred edits — hence the batch grouping on the client. */
const AUDIT_PAGE_ROWS = 300;

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Packaging Forecast Portal')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/* Phase 1 — minimal payload so the shell renders fast. */
function initApp() {
  prewarmSheetCache_([SHEET.PERMISSIONS, SHEET.AREAS, SHEET.HL, SHEET.COMPONENTS, SHEET.LINES, SHEET.CONFIG, SHEET.SNAPSHOTS]);
  const perms = getUserPermissions();
  if (perms.rank === 0) {
    return { authorised: false, email: perms.email };
  }
  return {
    authorised: true,
    user: { email: perms.email, portalName: perms.portalName, role: perms.role,
            allAreas: perms.allAreas, areas: perms.areas,
            /* The capability columns, so the client can hide what the server would
               refuse anyway. Hiding a control is cosmetic — every endpoint re-checks. */
            caps: perms.caps },
    ref: loadReferenceData_(),
    config: publicConfig_()
  };
}

function publicConfig_() {
  const cfg = getConfig_();
  return {
    horizonStart: dayStr(normDate(cfg.HORIZON_START)),
    horizonEnd:   dayStr(normDate(cfg.HORIZON_END)),
    compareSnapshot: safeStr(cfg.COMPARE_SNAPSHOT),
    lastRecalc: safeStr(cfg.LAST_RECALC),
    lastValidation: safeStr(cfg.LAST_VALIDATION),
    validationBlocksRecalc: safeStr(cfg.VALIDATION_BLOCKS_RECALC).toUpperCase() !== 'FALSE'
  };
}

let _refCache_ = null;
function loadReferenceData_() {
  if (_refCache_) return _refCache_;
  const areas = tableToObjects_(SHEET.AREAS);
  const hl = tableToObjects_(SHEET.HL);
  const comps = tableToObjects_(SHEET.COMPONENTS);
  const lines = tableToObjects_(SHEET.LINES);
  const snapData = getAllData(SHEET.SNAPSHOTS);
  const sc = H(SHEET.SNAPSHOTS);
  const snapNames = {};
  for (let i = 1; i < snapData.length; i++) {
    const n = safeStr(snapData[i][sc.Snapshot_Name]);
    if (n) snapNames[n] = true;
  }
  _refCache_ = { areas: areas, highLevelIds: hl, components: comps, lines: lines, snapshots: Object.keys(snapNames) };
  return _refCache_;
}

/* Generic sheet → array of objects keyed by header name; dates → 'yyyy-mm-dd'. */
function tableToObjects_(sheetName) {
  const data = getAllData(sheetName);
  const hdr = data[0] || [];
  const dateCols = {};
  hdr.forEach((h, i) => {
    if (/(_Date|^Month$|_At$|Timestamp)/.test(String(h))) dateCols[i] = true;
  });
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row.every(v => v === '' || v === null)) continue;
    const o = { _row: i + 1 };
    for (let cidx = 0; cidx < hdr.length; cidx++) {
      const h = String(hdr[cidx] || '');
      if (!h) continue;
      let v = row[cidx];
      if (dateCols[cidx]) v = dayStr(normDate(v));
      o[h] = (v === null || v === undefined) ? '' : v;
    }
    out.push(o);
  }
  return out;
}

/* Phase 2 — everything else in one round-trip. */
function loadAllAppData() {
  prewarmSheetCache_([SHEET.RATES, SHEET.COMP_MIX, SHEET.CC_MIX, SHEET.FX, SHEET.OUTPUT, SHEET.SNAPSHOTS, SHEET.AUDIT,
                      SHEET.PERMISSIONS, SHEET.AREAS, SHEET.HL, SHEET.COMPONENTS, SHEET.LINES, SHEET.CONFIG,
                      SHEET.VALIDATION]);
  const perms = requireViewer();
  const payload = {
    rates:    tableToObjects_(SHEET.RATES),
    compMix:  tableToObjects_(SHEET.COMP_MIX),
    ccMix:    tableToObjects_(SHEET.CC_MIX),
    fx:       tableToObjects_(SHEET.FX),
    output:   tableToObjects_(SHEET.OUTPUT),
    validation: validationRows_(),
    completeness: computeCompleteness_(),
    config:   publicConfig_()
  };
  /* Can_View_Audit rather than Admin rank: the history is a read, and somebody
     can now be given sight of it without being made an Admin. A blank column
     still resolves to Admin-only, so this deploy widens nothing by itself. */
  if (perms.caps && perms.caps.viewAudit) {
    const audit = tableToObjects_(SHEET.AUDIT);
    payload.audit = audit.slice(Math.max(0, audit.length - AUDIT_PAGE_ROWS)).reverse();
  }
  return payload;
}

/* Validation_Results arrived after the first release, so a spreadsheet whose owner
   has not re-run verifySetup() since will not have the tab yet. Missing means
   "nothing has been validated", not "the portal is broken" — the whole two-phase
   load should not fail over a tab that one editor menu click creates. */
function validationRows_() {
  try {
    return tableToObjects_(SHEET.VALIDATION);
  } catch (err) {
    Logger.log('Validation_Results unavailable: ' + err.message);
    return [];
  }
}

/* Dashboard completeness: per active line, does it have any rates / any mix,
   and does its High Level ID have any CC mix rows? Cheap but catches the
   "added a line, forgot the assumptions" gap immediately. */
function computeCompleteness_() {
  const lines = tableToObjects_(SHEET.LINES).filter(l => isActive(l.Active));
  const rates = tableToObjects_(SHEET.RATES).filter(r => isActive(r.Active));
  const mixes = tableToObjects_(SHEET.COMP_MIX).filter(m => isActive(m.Active));
  const ccs   = tableToObjects_(SHEET.CC_MIX).filter(c => isActive(c.Active));
  const hasRate = {}, hasMix = {}, hasCC = {};
  rates.forEach(r => hasRate[r.Modelling_ID] = true);
  mixes.forEach(m => hasMix[m.Modelling_ID] = true);
  ccs.forEach(c => hasCC[c.High_Level_ID] = true);
  const gaps = [];
  lines.forEach(l => {
    const missing = [];
    if (!hasRate[l.Modelling_ID]) missing.push('rates');
    if (!hasMix[l.Modelling_ID]) missing.push('component mix');
    if (!hasCC[l.High_Level_ID]) missing.push('cold chain mix');
    if (missing.length) gaps.push({ modellingId: l.Modelling_ID, highLevelId: l.High_Level_ID, missing: missing });
  });
  return { totalLines: lines.length, gaps: gaps };
}
