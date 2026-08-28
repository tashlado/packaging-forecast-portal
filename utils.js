/************************************************************
 * utils.gs — schema, caching, dates, locks, audit helpers
 ************************************************************/

// >>>>>> STEP 6 OF SETUP: paste your Spreadsheet ID between the quotes <<<<<<
const SPREADSHEET_ID = '1ebSW_kjgsedyHyVpXsEqHtkzyKt5CeLcWRrTQMkYv20';

const SHEET = {
  AREAS:        'Modelling_Areas',
  HL:           'High_Level_IDs',
  COMPONENTS:   'Components',
  LINES:        'Modelling_Lines',
  RATES:        'Rate_Card',
  COMP_MIX:     'Component_Mix',
  CC_MIX:       'Cold_Chain_Mix',
  FX:           'FX_Rates',
  CONFIG:       'Config',
  PERMISSIONS:  'Permissions',
  AUDIT:        'Audit_Log',
  MODELLING:    'Modelling',
  OUTPUT:       'Output',
  SNAPSHOTS:    'Forecast_Snapshots',
  PARITY:       'Parity_Expected',
  VALIDATION:   'Validation_Results',
  RATES_AM:     'Rate_Card_Amends',
  COMP_MIX_AM:  'Component_Mix_Amends',
  CC_MIX_AM:    'Cold_Chain_Mix_Amends',
  DIM_AM:       'Dimension_Amends'
};

// Canonical headers — single source of truth for tab layout.
const HEADERS = {
  'Modelling_Areas':     ['Area_ID','Area_Name','Output_Metric_Name','Customer_Types','Active'],
  'High_Level_IDs':      ['High_Level_ID','Area_ID','Brand','Geo','Treatment_Type','WL_Detail','Currency','Active','Comment'],
  'Components':          ['Component_ID','Area_ID','High_Level_Component','Component','Active','Comment'],
  'Modelling_Lines':     ['Modelling_ID','High_Level_ID','Component_ID','Active','Comment'],
  'Rate_Card':           ['Rate_ID','Modelling_ID','CC_Flag','Customer_Type','From_Date','To_Date','CPU','QTY','Comment','Active','Updated_At','Updated_By'],
  'Component_Mix':       ['Mix_ID','Modelling_ID','From_Date','To_Date','Mix','Comment','Active','Updated_At','Updated_By'],
  'Cold_Chain_Mix':      ['CC_Mix_ID','High_Level_ID','From_Date','To_Date','CC_Mix','Comment','Active','Updated_At','Updated_By'],
  'FX_Rates':            ['Month','GBP','USD','EUR','CAD'],
  'Config':              ['Key','Value'],
  /* Can_Edit_Rates / Can_Edit_Mixes / Can_Edit_Dims / Can_View_Audit are capability
     columns. They NARROW what a rank already allows and never widen it, and a blank
     cell means "whatever the rank said" — which is what makes them safe to append to
     a live Permissions tab. See capOf_ in auth.js. */
  'Permissions':         ['Email','Portal_Name','Role','Areas','Active',
                          'Can_Edit_Rates','Can_Edit_Mixes','Can_Edit_Dims','Can_View_Audit'],
  'Audit_Log':           ['Log_ID','Timestamp','Email','Action','Target_Table','Target_ID','Summary','Field','Old_Value','New_Value'],
  'Modelling':           ['Modelling_ID','High_Level_ID','Month','CC_Mix_Applied','Component_Mix_Applied','New','Repeat','OTC'],
  'Output':              ['High_Level_ID','Month','Customer_Type','Brand','Geo','Treatment_Type','WL_Detail','Currency','Cost_Local','FX_to_GBP','Cost_GBP','Compare_Snapshot','Snapshot_Cost_Local','Variance_Local'],
  'Forecast_Snapshots':  ['Snapshot_Name','Created_At','Created_By','High_Level_ID','Month','Customer_Type','Cost_Local'],
  'Parity_Expected':     ['High_Level_ID','Month','Customer_Type','Expected_Cost_Local'],
  'Validation_Results':  ['Result_ID','Run_At','Rule_Code','Severity','High_Level_ID','Modelling_ID','Month','Message']
};
// Amends tables mirror their source, prefixed with the amend columns.
const AMEND_PREFIX = ['Amend_ID','Amend_Type','Amend_Timestamp','Amend_Email','Amend_Name'];
HEADERS[SHEET.RATES_AM]    = AMEND_PREFIX.concat(HEADERS[SHEET.RATES]);
HEADERS[SHEET.COMP_MIX_AM] = AMEND_PREFIX.concat(HEADERS[SHEET.COMP_MIX]);
HEADERS[SHEET.CC_MIX_AM]   = AMEND_PREFIX.concat(HEADERS[SHEET.CC_MIX]);
HEADERS[SHEET.DIM_AM]      = AMEND_PREFIX.concat(['Table_Name','Row_ID','Row_JSON']);

/* ---------- per-execution caches ---------- */
let _ssCache_ = null;
function _getSs_() {
  if (!_ssCache_) _ssCache_ = SpreadsheetApp.openById(SPREADSHEET_ID);
  return _ssCache_;
}
const _sheetCache_ = {};
function getSheet(name) {
  if (_sheetCache_[name]) return _sheetCache_[name];
  const sh = _getSs_().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" not found. Run verifySetup() from the editor.');
  _sheetCache_[name] = sh;
  return sh;
}
const _sheetDataCache_ = {};
function getAllData(sheetName) {
  if (_sheetDataCache_[sheetName]) return _sheetDataCache_[sheetName];
  const data = getSheet(sheetName).getDataRange().getValues();
  const result = data.length ? data : [[]];
  _sheetDataCache_[sheetName] = result;
  return result;
}
function invalidateSheetCache(sheetName) { delete _sheetDataCache_[sheetName]; }

/* One HTTP call for many sheets via the Advanced Sheets Service. */
function prewarmSheetCache_(sheetNames) {
  const toFetch = sheetNames.filter(n => !_sheetDataCache_[n]);
  if (!toFetch.length) return;
  if (typeof Sheets === 'undefined' || !Sheets.Spreadsheets || !Sheets.Spreadsheets.Values) return;
  let resp;
  try {
    resp = Sheets.Spreadsheets.Values.batchGet(SPREADSHEET_ID, {
      ranges: toFetch.map(n => "'" + n.replace(/'/g, "\\'") + "'"),
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER'
    });
  } catch (err) { Logger.log('prewarm failed: ' + err.message); return; }
  const vrs = resp.valueRanges || [];
  for (let i = 0; i < toFetch.length; i++) {
    let values = (vrs[i] && vrs[i].values) || [];
    if (!values.length) values = [[]];
    // pad ragged rows to header width
    const w = values[0].length;
    for (let r = 1; r < values.length; r++) while (values[r].length < w) values[r].push('');
    _sheetDataCache_[toFetch[i]] = values;
  }
}
function prewarmForWrite_(extraSheets) {
  const sheets = [SHEET.PERMISSIONS, SHEET.AUDIT, SHEET.AREAS, SHEET.HL, SHEET.COMPONENTS, SHEET.LINES, SHEET.CONFIG];
  (extraSheets || []).forEach(s => { if (sheets.indexOf(s) < 0) sheets.push(s); });
  prewarmSheetCache_(sheets);
  _getSs_();
}

/* ---------- header lookup ---------- */
const _hdrCache_ = {};
function H(sheetName) {
  if (_hdrCache_[sheetName]) return _hdrCache_[sheetName];
  const hdr = getAllData(sheetName)[0];
  const map = {};
  hdr.forEach((h, i) => { if (h !== '' && h != null) map[String(h)] = i; });
  _hdrCache_[sheetName] = map;
  return map;
}

/* ---------- value + date helpers ---------- */
function safeStr(v) { return (v === null || v === undefined) ? '' : String(v).trim(); }
function safeNum(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
function isActive(v) { return safeStr(v).toUpperCase() !== 'N'; }

// Accepts Date, Sheets serial number, or 'yyyy-mm-dd' string → Date @ midnight, or null.
function normDate(val) {
  if (val === '' || val === null || val === undefined) return null;
  let d;
  if (val instanceof Date) d = new Date(val);
  else if (typeof val === 'number') {
    if (val < 20000 || val > 80000) return null;                 // not a plausible serial date
    d = new Date(Math.round((val - 25569) * 86400 * 1000));
  } else if (typeof val === 'string' && /^\d{4}-\d{2}-\d{2}/.test(val.trim())) {
    const p = val.trim().slice(0, 10).split('-').map(Number);
    d = new Date(p[0], p[1] - 1, p[2]);
  } else d = new Date(val);
  if (!d || isNaN(d.getTime())) return null;
  d.setHours(0, 0, 0, 0);
  return d;
}
function dayStr(d) {
  if (!d) return '';
  return Utilities.formatDate(d, Session.getScriptTimeZone() || 'Europe/London', 'yyyy-MM-dd');
}
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function monthKey(d) { return dayStr(d).slice(0, 7); }

/* "Brand A GB Weight Loss" from a High_Level_IDs row. A '*' means the dimension
   does not apply to this segment rather than being unset, so it is dropped
   rather than printed. Lives here because validate.js, snapshots.js, bulk.js and
   the client all need the same sentence, and three of them had their own copy. */
function hlLabel_(h) {
  if (!h) return '';
  return [h.Brand, h.Geo, h.Treatment_Type, h.WL_Detail].filter(x => x && x !== '*').join(' ');
}

/* ---------- locking & IDs ---------- */
function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20 * 1000);
  try { return fn(); } finally { lock.releaseLock(); }
}
const _nextIdCache_ = {};
function getNextId(sheetName, idHeader) {
  if (_nextIdCache_[sheetName] !== undefined) return ++_nextIdCache_[sheetName];
  const data = getAllData(sheetName);
  const col = H(sheetName)[idHeader];
  let max = 0;
  for (let i = 1; i < data.length; i++) {
    const v = parseInt(data[i][col], 10);
    if (!isNaN(v) && v > max) max = v;
  }
  _nextIdCache_[sheetName] = max + 1;
  return max + 1;
}

/* ---------- audit ---------- */
function appendAmend_(srcSheetName, amendType, rowValues, perms) {
  const amSheetName = srcSheetName + '_Amends';
  const sh = getSheet(amSheetName);
  const row = [getNextId(amSheetName, 'Amend_ID'), amendType, new Date(), perms.email, perms.portalName]
              .concat(rowValues);
  sh.appendRow(row);
}
/* Many amend rows in one write.
   appendAmend_ costs an appendRow per row, which a bulk change makes hundreds of.
   Same rows, same columns — one setValues instead. entries: [{type, rowValues}]. */
function appendAmendsBatch_(srcSheetName, entries, perms) {
  if (!entries || !entries.length) return 0;
  const amSheetName = srcSheetName + '_Amends';
  const sh = getSheet(amSheetName);
  const now = new Date();
  const width = HEADERS[amSheetName].length;
  const rows = entries.map(e =>
    padTo_([getNextId(amSheetName, 'Amend_ID'), e.type, now, perms.email, perms.portalName]
           .concat(e.rowValues), width));
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, width).setValues(rows);
  return rows.length;
}
/* Rows read through prewarmSheetCache_ come back with trailing empties dropped,
   so anything written back has to be padded to the table's full width. */
function padTo_(row, width) {
  const out = (row || []).slice(0, width);
  while (out.length < width) out.push('');
  return out;
}
function appendDimAmend_(tableName, amendType, rowId, rowObj, perms) {
  const sh = getSheet(SHEET.DIM_AM);
  sh.appendRow([getNextId(SHEET.DIM_AM, 'Amend_ID'), amendType, new Date(), perms.email, perms.portalName,
                tableName, rowId, JSON.stringify(rowObj)]);
}
/* Many dimension amends in one write, for the same reason appendAmendsBatch_
   exists: a segment copy creates a line per component, and appendRow is a round
   trip each. entries: [{type, rowId, rowObj}]. */
function appendDimAmendsBatch_(tableName, entries, perms) {
  if (!entries || !entries.length) return 0;
  const sh = getSheet(SHEET.DIM_AM);
  const now = new Date();
  const width = HEADERS[SHEET.DIM_AM].length;
  const rows = entries.map(e =>
    padTo_([getNextId(SHEET.DIM_AM, 'Amend_ID'), e.type, now, perms.email, perms.portalName,
            tableName, e.rowId, JSON.stringify(e.rowObj)], width));
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, width).setValues(rows);
  return rows.length;
}
function logAction_(perms, action, targetTable, targetId, summary) {
  appendAuditRows_([auditRow_(perms, action, targetTable, targetId, summary, '', '', '')]);
}

/* One setValues rather than an appendRow per row. A single save writes one or two
   rows and would not care, but a bulk change writes hundreds, and appendRow costs
   an HTTP round trip each — the same reason appendAmendsBatch_ exists. */
function appendAuditRows_(rows) {
  if (!rows || !rows.length) return 0;
  const sh = getSheet(SHEET.AUDIT);
  const width = HEADERS[SHEET.AUDIT].length;
  const padded = rows.map(r => padTo_(r, width));
  sh.getRange(sh.getLastRow() + 1, 1, padded.length, width).setValues(padded);
  return padded.length;
}
function auditRow_(perms, action, targetTable, targetId, summary, field, oldVal, newVal) {
  return [getNextId(SHEET.AUDIT, 'Log_ID'), new Date(), perms.email, action,
          targetTable || '', (targetId === undefined || targetId === null) ? '' : targetId,
          summary || '', field || '',
          oldVal === undefined ? '' : oldVal, newVal === undefined ? '' : newVal];
}

/**
 * A refusal, written down.
 *
 * Every gate in auth.js used to do one thing when it said no: throw. That tells
 * the person standing in front of it and nobody else. The signal an Admin
 * actually needs — somebody reaching repeatedly for an area they are not scoped
 * to, or a capability column sitting at N that was never meant to be — only
 * exists if the refusal leaves a row behind. So it does, under the action
 * DENIED, in the same Audit_Log the History screen already reads.
 *
 * Three properties, all load-bearing:
 *
 *   It never throws. A refusal is already the unhappy path. A logging failure on
 *   top of it must not replace the readable "you cannot do this" with a
 *   spreadsheet error, and must not stop the throw that follows — so the caller
 *   logs and then throws, and this swallows everything.
 *
 *   It never gates. It reads the perms object the caller already resolved and
 *   calls no require* function of its own, so recording a refusal cannot recurse
 *   into a second one.
 *
 *   It writes outside the lock, because that is where the gates run — every
 *   entry point checks rights before withLock. Taking the script lock to record
 *   a refusal would queue refused calls behind real writes, and releasing it
 *   mid-write would be worse. The cost is that two refusals in the same instant
 *   can be allotted the same Log_ID: getNextId is a per-execution max+1 rather
 *   than a reservation. Nothing keys on Log_ID — it only has to be roughly
 *   ascending — so a collision is a dent in the numbering, not a lost row.
 *
 * scope says what kind of check refused, and is one of:
 *   'PORTAL'      a rank floor  — targetId is the role that was needed
 *   'AREA'        a scope check — targetId is the Area_ID
 *   'CAPABILITY'  a column on Permissions — targetId is the capability key
 * They land in Target_Table and Target_ID, which is what the History screen
 * shows as Table and Target. Field, Old_Value and New_Value stay empty: nothing
 * changed, which is the point.
 */
function logDenied_(perms, scope, targetId, reason) {
  try {
    appendAuditRows_([auditRow_(perms || { email: '(unknown)' }, 'DENIED',
      scope, targetId, reason, '', '', '')]);
    invalidateSheetCache(SHEET.AUDIT);
  } catch (err) {
    Logger.log('DENIED audit write failed (continuing): ' + err.message);
  }
}

/* Columns every save touches by definition. Both are already on the audit row
   itself — Timestamp and Email say the same thing — so diffing them would double
   the row count to record nothing. */
const AUDIT_SKIP_FIELDS = ['Updated_At', 'Updated_By'];

/* A cell's value as the audit trail should read it.
 *
 * Normalised by column name rather than by JavaScript type, because the same
 * date arrives as three different things depending on how it was read: a Date
 * from getValues, a serial number from the Advanced Sheets Service (which
 * prewarmSheetCache_ asks for as SERIAL_NUMBER), or a 'yyyy-mm-dd' string. Diff
 * those raw and every date column looks changed on every save. */
function auditValue_(header, v) {
  if (v === null || v === undefined || v === '') return '';
  if (/(_Date|^Month$|_At$|Timestamp)/.test(String(header))) {
    const d = normDate(v);
    return d ? dayStr(d) : String(v).trim();
  }
  if (Object.prototype.toString.call(v) === '[object Date]') return dayStr(v);
  if (typeof v === 'number') return String(Math.round(v * 1e9) / 1e9);
  return String(v).trim();
}
/* 0.4 and '0.40' are the same rate. A cell formatted as text against one written
   as a number is a formatting difference, not an amendment. */
function auditSame_(a, b) {
  if (a === b) return true;
  if (a === '' || b === '') return false;
  const na = Number(a), nb = Number(b);
  return !isNaN(na) && !isNaN(nb) && na === nb;
}

/**
 * One Audit_Log row per field that actually changed, with its old and new value.
 *
 * logAction_ writes a one-line summary and nothing else, which answers "who
 * touched this" but never "what did it say before" — and the full before/after
 * row is sitting at every call site already. This is the diff of it.
 *
 * The *_Amends tabs keep the whole post-change row, which is the authoritative
 * record; this is the readable one, the one History can show and a person can
 * scan for the CPU that moved.
 *
 * beforeRow absent (a create) writes one summary row rather than a row per
 * populated column: nothing changed, a record appeared, and Amends already holds
 * it in full. A save that changed nothing still writes its summary row — the
 * action happened, and an audit trail that silently omits it is one you cannot
 * reconcile against.
 *
 * opts = { summary, ref, skip, into }
 *   summary  the context line every row of this action carries.
 *   ref      groups the rows one action wrote — a bulk batch reference. Written
 *            as the first token of Summary, so rows from one batch stay findable.
 *   skip     extra header names to leave out of the diff.
 *   into     collect rows into this array instead of writing them, so a caller
 *            touching many rows can flush them in one appendAuditRows_.
 */
function logFieldChanges_(perms, action, table, targetId, beforeRow, afterRow, headers, opts) {
  const o = opts || {};
  const summary = (o.ref ? o.ref + ' · ' : '') + safeStr(o.summary);
  const emit = rows => {
    if (o.into) { o.into.push.apply(o.into, rows); return rows.length; }
    return appendAuditRows_(rows);
  };

  if (!beforeRow) {
    emit([auditRow_(perms, action, table, targetId, summary, '', '', '')]);
    return 0;
  }

  const skip = AUDIT_SKIP_FIELDS.concat(o.skip || []);
  const rows = [];
  (headers || []).forEach((h, i) => {
    const name = safeStr(h);
    if (!name || skip.indexOf(name) >= 0) return;
    const was = auditValue_(name, beforeRow[i]);
    const now = auditValue_(name, afterRow[i]);
    if (auditSame_(was, now)) return;
    rows.push(auditRow_(perms, action, table, targetId, summary, name, was, now));
  });

  if (!rows.length) {
    rows.push(auditRow_(perms, action, table, targetId,
      (summary ? summary + ' — ' : '') + 'saved, no field changed', '', '', ''));
  }
  emit(rows);
  return rows.length;
}

/* ---------- config ---------- */
function getConfig_() {
  const data = getAllData(SHEET.CONFIG);
  const c = H(SHEET.CONFIG);
  const out = {};
  for (let i = 1; i < data.length; i++) {
    const k = safeStr(data[i][c.Key]);
    if (k) out[k] = data[i][c.Value];
  }
  return out;
}
function setConfig_(key, value) {
  const sh = getSheet(SHEET.CONFIG);
  const data = getAllData(SHEET.CONFIG);
  const c = H(SHEET.CONFIG);
  for (let i = 1; i < data.length; i++) {
    if (safeStr(data[i][c.Key]) === key) {
      sh.getRange(i + 1, c.Value + 1).setValue(value);
      data[i][c.Value] = value;
      return;
    }
  }
  sh.appendRow([key, value]);
  invalidateSheetCache(SHEET.CONFIG);
}
