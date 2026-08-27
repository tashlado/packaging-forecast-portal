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
  'Permissions':         ['Email','Portal_Name','Role','Areas','Active'],
  'Audit_Log':           ['Log_ID','Timestamp','Email','Action','Target_Table','Target_ID','Summary'],
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
function logAction_(perms, action, targetTable, targetId, summary) {
  const sh = getSheet(SHEET.AUDIT);
  sh.appendRow([getNextId(SHEET.AUDIT, 'Log_ID'), new Date(), perms.email, action,
                targetTable || '', targetId === undefined ? '' : targetId, summary || '']);
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
