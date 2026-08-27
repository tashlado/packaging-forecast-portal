/************************************************************
 * snapshots.gs — named forecast versions (Q7: ad-hoc allowed)
 ************************************************************/

/* Admin, not Editor. A snapshot copies the whole Output tab — every area — under
   one name, and that name is what the variance columns are then read against. An
   Editor scoped to one area has no business freezing, or naming, the rest of the
   book. */
function createSnapshot(name) {
  prewarmForWrite_([SHEET.OUTPUT, SHEET.SNAPSHOTS]);
  const perms = requireAdmin();
  const clean = safeStr(name);
  if (!clean) throw new Error('Snapshot name is required.');
  if (clean.length > 60) throw new Error('Snapshot name too long (max 60 characters).');

  return withLock(() => {
    const snapData = getAllData(SHEET.SNAPSHOTS);
    const sc = H(SHEET.SNAPSHOTS);
    for (let i = 1; i < snapData.length; i++) {
      if (safeStr(snapData[i][sc.Snapshot_Name]).toLowerCase() === clean.toLowerCase()) {
        throw new Error('A snapshot called "' + clean + '" already exists. Snapshot names must be unique.');
      }
    }
    const out = tableToObjects_(SHEET.OUTPUT);
    if (!out.length) throw new Error('Output is empty — run Recalculate first.');
    const now = new Date();
    const rows = out.map(r => [clean, now, perms.email, Number(r.High_Level_ID),
                               normDate(r.Month), safeStr(r.Customer_Type), safeNum(r.Cost_Local)]);
    const sh = getSheet(SHEET.SNAPSHOTS);
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    invalidateSheetCache(SHEET.SNAPSHOTS);
    logAction_(perms, 'CREATE_SNAPSHOT', SHEET.SNAPSHOTS, clean, rows.length + ' rows');
    return { name: clean, rows: rows.length };
  });
}

/* Admin for the same reason: COMPARE_SNAPSHOT is one portal-wide config key, so
   changing it re-baselines the variance every area reads, not just the caller's. */
function setCompareSnapshot(name) {
  prewarmForWrite_([SHEET.SNAPSHOTS, SHEET.CONFIG]);
  const perms = requireAdmin();
  const clean = safeStr(name);
  return withLock(() => {
    setConfig_('COMPARE_SNAPSHOT', clean);
    logAction_(perms, 'SET_COMPARE_SNAPSHOT', SHEET.CONFIG, clean, '');
    return { compareSnapshot: clean };
  });
}
