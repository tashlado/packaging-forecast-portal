/************************************************************
 * history.gs — what did this row say on a given day
 *
 * The *_Amends tabs have always held the whole post-change row
 * for every save: Rate_Card_Amends, Component_Mix_Amends,
 * Cold_Chain_Mix_Amends and Dimension_Amends. Nothing has ever
 * read them back. They are the authoritative record — Audit_Log
 * is the readable summary, and it is capped at the last 300 rows
 * in the client and gets no per-row detail at all before phase 1
 * — so "what was this rate in March, before the change" has only
 * ever been answerable by scrolling a hidden tab.
 *
 * This reconstructs a record's state as of a chosen date, and the
 * sequence of amendments that got it there.
 *
 * Reconstruction is a LAST-WRITE-WINS replay, not a diff replay:
 * each amend row is a complete copy of the record after that
 * save, so the state on a date is simply the latest amend at or
 * before the end of that day. That makes the answer correct even
 * where the amend chain has a gap — an import, a hand edit, a row
 * that predates the mechanism — which a diff replay would carry
 * forward as a silent error.
 ************************************************************/

/* The tables that keep a row-level history, and how to find one row in them. */
const HISTORY_TABLES = {
  'Rate_Card':      { idHeader: 'Rate_ID',    label: 'rate',            areaVia: 'line' },
  'Component_Mix':  { idHeader: 'Mix_ID',     label: 'component mix',   areaVia: 'line' },
  'Cold_Chain_Mix': { idHeader: 'CC_Mix_ID',  label: 'cold chain mix',  areaVia: 'hl' }
};

/**
 * Who may read one record's history.
 *
 * Can_View_Audit, or the right to edit the area the record belongs to.
 *
 * The second half is the point. Can_View_Audit governs the History SCREEN, which
 * is a list of what everybody in the portal has been doing — it is about people,
 * and defaults to Admin only. This is about one row, shown next to that row, to
 * somebody who can change it. Being able to see what a rate you may edit used to
 * say is part of editing it, not surveillance of a colleague, and refusing it
 * would leave the person most likely to need the answer as the only one who
 * cannot get it.
 */
function requireRecordHistory_(areaId) {
  const perms = requireViewer();
  if (perms.caps && perms.caps.viewAudit) return perms;
  if (perms.rank >= ROLE_RANK.Editor && (perms.rank >= ROLE_RANK.Admin || canAccessArea_(perms, areaId))) {
    return perms;
  }
  throw new Error('Reading a record\'s history needs either edit access to its modelling area ' +
    'or Can_View_Audit on the Permissions tab.');
}

/* Which area a record belongs to, so the gate above has something to check. */
function historyAreaOf_(table, recordId) {
  const spec = HISTORY_TABLES[table];
  const row = tableToObjects_(table).find(r => String(r[spec.idHeader]) === String(recordId));
  if (!row) return null;
  const hlById = {};
  tableToObjects_(SHEET.HL).forEach(h => hlById[String(h.High_Level_ID)] = h);
  if (spec.areaVia === 'hl') {
    const hl = hlById[String(row.High_Level_ID)];
    return hl ? hl.Area_ID : null;
  }
  const line = tableToObjects_(SHEET.LINES).find(l => String(l.Modelling_ID) === String(row.Modelling_ID));
  if (!line) return null;
  const hl = hlById[String(line.High_Level_ID)];
  return hl ? hl.Area_ID : null;
}

/**
 * One record's amend history, and its state on a chosen date.
 *
 * @param {Object} p { table, recordId, asOf }  asOf is 'yyyy-mm-dd'; absent
 *                   means today, which reads as "and what does it say now".
 */
function recordHistory(p) {
  const table = safeStr(p && p.table);
  const spec = HISTORY_TABLES[table];
  if (!spec) {
    throw new Error('No row-level history is kept for "' + table + '". ' +
      'It exists for: ' + Object.keys(HISTORY_TABLES).join(', ') + '.');
  }
  const recordId = safeStr(p.recordId);
  if (!recordId) throw new Error('Which record?');

  const amendTable = table + '_Amends';
  prewarmSheetCache_([SHEET.PERMISSIONS, SHEET.AREAS, SHEET.HL, SHEET.COMPONENTS, SHEET.LINES,
                      table, amendTable]);

  const areaId = historyAreaOf_(table, recordId);
  const perms = requireRecordHistory_(areaId);

  /* The end of the chosen day, so "as of 14 March" includes everything saved on
     the 14th. A save at 16:20 on the day you are asking about is part of what
     the record said that day. */
  const asOfDate = normDate(p.asOf) || new Date();
  const cutoff = addDays(asOfDate, 1).getTime();

  const hdr = HEADERS[table];
  const amends = tableToObjects_(amendTable)
    .filter(r => String(r[spec.idHeader]) === recordId)
    .map(r => ({
      amendId: safeNum(r.Amend_ID),
      type: safeStr(r.Amend_Type),
      /* Amend_Timestamp is normalised to 'yyyy-mm-dd' by tableToObjects_ — the
         time of day is lost on the way through, which is why ordering falls back
         to Amend_ID, an increasing counter, for two saves on one day. */
      at: safeStr(r.Amend_Timestamp),
      by: safeStr(r.Amend_Email),
      byName: safeStr(r.Amend_Name),
      row: r
    }))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0) || (a.amendId - b.amendId));

  /* Consecutive amends, diffed, so the timeline reads as what changed rather
     than as a stack of identical-looking rows. Normalised by column name for the
     same reason logFieldChanges_ does it: the same date arrives as a Date, a
     serial or a string depending on how it was read. */
  const timeline = amends.map((a, i) => {
    const prev = i > 0 ? amends[i - 1].row : null;
    const changes = [];
    if (prev) {
      hdr.forEach(h => {
        const name = safeStr(h);
        if (!name || AUDIT_SKIP_FIELDS.indexOf(name) >= 0) return;
        const was = auditValue_(name, prev[name]);
        const now = auditValue_(name, a.row[name]);
        if (auditSame_(was, now)) return;
        changes.push({ field: name, from: was, to: now });
      });
    }
    return {
      amendId: a.amendId, type: a.type, at: a.at, by: a.by, byName: a.byName,
      /* An amend that changed nothing is worth showing rather than hiding — a
         save that touched no field still happened, and an audit trail that
         silently drops it is one nobody can reconcile. */
      changes: changes,
      values: historyValues_(hdr, a.row)
    };
  });

  const upTo = amends.filter(a => {
    const d = normDate(a.at);
    return d && d.getTime() < cutoff;
  });
  const at = upTo.length ? upTo[upTo.length - 1] : null;

  const live = tableToObjects_(table).find(r => String(r[spec.idHeader]) === recordId) || null;

  return {
    table: table, label: spec.label, recordId: recordId,
    asOf: dayStr(asOfDate),
    /* null means the record has no amend at or before that date: either it did
       not exist yet, or its history starts later than the question. The client
       has to tell those apart, so both facts are here. */
    state: at ? {
      amendId: at.amendId, type: at.type, at: at.at, by: at.by, byName: at.byName,
      deleted: at.type === 'DELETE' || safeStr(at.row.Active).toUpperCase() === 'N',
      values: historyValues_(hdr, at.row)
    } : null,
    firstAmendAt: amends.length ? amends[0].at : '',
    amendCount: amends.length,
    /* Newest first: a history is read from the top. */
    timeline: timeline.slice().reverse(),
    current: live ? { values: historyValues_(hdr, live),
                      deleted: safeStr(live.Active).toUpperCase() === 'N' } : null,
    /* Rows written before the Amends tabs existed, or imported straight into the
       sheet, have no history at all. Saying so beats an empty panel that reads
       as "nothing ever changed". */
    noHistory: !amends.length,
    readBy: perms.email
  };
}

/* One amend row as {field: displayValue} in header order, using the same
   normalisation the audit trail uses so a date reads the same everywhere. */
function historyValues_(hdr, row) {
  const out = [];
  hdr.forEach(h => {
    const name = safeStr(h);
    if (!name) return;
    out.push({ field: name, value: auditValue_(name, row[name]) });
  });
  return out;
}
