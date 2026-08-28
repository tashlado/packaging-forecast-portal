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

/**
 * The snapshots that exist, newest first.
 *
 * Forecast_Snapshots is one row per High Level ID x month x customer type, so a
 * snapshot is not a row but a NAME repeated across a few hundred of them. This
 * collapses it back to the thing a person picks from a list, and counts the rows
 * because a snapshot taken against a half-built Output is worth spotting before
 * anybody compares against it.
 */
function listSnapshots() {
  requireViewer();
  prewarmSheetCache_([SHEET.SNAPSHOTS, SHEET.PERMISSIONS]);
  const data = getAllData(SHEET.SNAPSHOTS);
  const c = H(SHEET.SNAPSHOTS);
  const byName = {};
  for (let i = 1; i < data.length; i++) {
    const name = safeStr(data[i][c.Snapshot_Name]);
    if (!name) continue;
    const s = byName[name] || (byName[name] = {
      name: name, createdAt: '', createdBy: safeStr(data[i][c.Created_By]),
      rows: 0, total: 0, months: {}, hlIds: {}
    });
    s.rows++;
    s.total += safeNum(data[i][c.Cost_Local]);
    const m = normDate(data[i][c.Month]);
    if (m) s.months[monthKey(m)] = true;
    s.hlIds[safeStr(data[i][c.High_Level_ID])] = true;
    /* The whole snapshot is written in one call, so every row carries the same
       stamp; taking the latest is only a guard against a hand-edited tab. */
    const at = dayStr(normDate(data[i][c.Created_At]));
    if (at > s.createdAt) s.createdAt = at;
  }
  return Object.keys(byName).map(n => {
    const s = byName[n];
    const months = Object.keys(s.months).sort();
    return {
      name: s.name, createdAt: s.createdAt, createdBy: s.createdBy, rows: s.rows,
      total: s.total, segments: Object.keys(s.hlIds).length,
      firstMonth: months[0] || '', lastMonth: months[months.length - 1] || ''
    };
  }).sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0) ||
                    (a.name < b.name ? -1 : 1));
}

/**
 * Two snapshots, or one snapshot against the forecast as it stands.
 *
 * An empty toName means the live Output tab, which is the comparison people
 * actually want most of the time: "what has moved since we froze this".
 *
 * Both sides are keyed High Level ID | month | customer type, the grain Output
 * is written at. A key present on one side only is reported as added or removed
 * rather than as a change from zero — a segment that did not exist in January
 * has not gone up by infinity, and folding it into the percentages would make
 * every other number in the table unreadable.
 *
 * Viewer: it reads two things a Viewer can already see. Taking a snapshot is
 * Admin, because that writes; reading one back is not.
 */
function compareSnapshots(fromName, toName) {
  requireViewer();
  prewarmSheetCache_([SHEET.SNAPSHOTS, SHEET.OUTPUT, SHEET.HL, SHEET.PERMISSIONS]);
  const from = safeStr(fromName), to = safeStr(toName);
  if (!from) throw new Error('Pick a snapshot to compare from.');
  if (from === to) throw new Error('Those are the same snapshot.');

  const snapData = getAllData(SHEET.SNAPSHOTS);
  const sc = H(SHEET.SNAPSHOTS);
  const known = {};
  for (let i = 1; i < snapData.length; i++) {
    const n = safeStr(snapData[i][sc.Snapshot_Name]);
    if (n) known[n] = true;
  }
  if (!known[from]) throw new Error('There is no snapshot called "' + from + '".');
  if (to && !known[to]) throw new Error('There is no snapshot called "' + to + '".');

  const valuesOf = name => {
    const map = {};
    if (!name) {
      tableToObjects_(SHEET.OUTPUT).forEach(r => {
        const m = normDate(r.Month);
        if (!m) return;
        map[snapKey_(r.High_Level_ID, m, r.Customer_Type)] = safeNum(r.Cost_Local);
      });
      return map;
    }
    for (let i = 1; i < snapData.length; i++) {
      if (safeStr(snapData[i][sc.Snapshot_Name]) !== name) continue;
      const m = normDate(snapData[i][sc.Month]);
      if (!m) continue;
      map[snapKey_(snapData[i][sc.High_Level_ID], m, snapData[i][sc.Customer_Type])] =
        safeNum(snapData[i][sc.Cost_Local]);
    }
    return map;
  };

  const a = valuesOf(from), b = valuesOf(to);
  const hlById = {};
  tableToObjects_(SHEET.HL).forEach(h => hlById[safeStr(h.High_Level_ID)] = h);

  const diffs = [];
  let unchanged = 0, added = 0, removed = 0, totalA = 0, totalB = 0;

  const rowOf = (key, before, after) => {
    const p = key.split('|');
    return { hlId: p[0], month: p[1], customerType: p[2],
             label: hlLabel_(hlById[p[0]]) || ('High Level ID ' + p[0]),
             before: before, after: after,
             diff: (before === null || after === null) ? null : after - before,
             pct: (before === null || after === null || !before) ? null
                  : (after - before) / before * 100 };
  };

  Object.keys(b).forEach(k => {
    totalB += b[k];
    if (a[k] === undefined) { added++; diffs.push(rowOf(k, null, b[k])); return; }
    /* Half a millionth of a penny apart is the same number written twice. */
    if (Math.abs(a[k] - b[k]) <= 0.0000005) { unchanged++; return; }
    diffs.push(rowOf(k, a[k], b[k]));
  });
  Object.keys(a).forEach(k => {
    totalA += a[k];
    if (b[k] !== undefined) return;
    removed++;
    diffs.push(rowOf(k, a[k], null));
  });

  /* Biggest movers first: a diff list nobody scrolls is a diff list nobody
     reads, and the row that matters is almost always the largest. */
  diffs.sort((x, y) => Math.abs(y.diff || 0) - Math.abs(x.diff || 0) ||
                       safeNum(x.hlId) - safeNum(y.hlId) ||
                       (x.month < y.month ? -1 : 1));

  /* Rolled up per High Level ID, because "which segment moved" is the question
     asked before "which month of it". */
  const bySeg = {};
  diffs.forEach(d => {
    if (d.diff === null) return;
    const s = bySeg[d.hlId] || (bySeg[d.hlId] = { months: {}, total: 0, base: 0, label: d.label });
    s.months[d.month] = true;
    s.total += d.diff;
    s.base += d.before;
  });
  const segments = Object.keys(bySeg).map(id => {
    const s = bySeg[id];
    const n = Object.keys(s.months).length;
    return { hlId: id, label: s.label, months: n, totalDiff: s.total,
             meanDiff: s.total / n, pct: s.base ? (s.total / s.base * 100) : null };
  }).sort((x, y) => Math.abs(y.totalDiff) - Math.abs(x.totalDiff));

  return {
    fromName: from, toName: to,
    toLabel: to || 'the forecast as it stands now',
    changed: diffs.length, unchanged: unchanged, added: added, removed: removed,
    totalFrom: totalA, totalTo: totalB, totalDiff: totalB - totalA,
    segments: segments,
    /* Capped, and the cap says so: the full picture is the Forecast_Snapshots
       and Output tabs, and 300 rows is already more than anybody reads. */
    diffs: diffs.slice(0, SNAP_DIFF_ROWS),
    truncated: Math.max(0, diffs.length - SNAP_DIFF_ROWS)
  };
}

const SNAP_DIFF_ROWS = 300;

/* Month as 'yyyy-mm': the snapshot and Output store a first-of-month Date, and
   comparing those raw depends on which of the three shapes each was read as. */
function snapKey_(hlId, monthDate, customerType) {
  return safeStr(hlId) + '|' + monthKey(monthDate) + '|' + safeStr(customerType);
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
