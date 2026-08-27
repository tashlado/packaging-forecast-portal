/************************************************************
 * mixes.gs — Component Mix + Cold Chain Mix writes
 *
 * Component Mix (Q2 hard block, refined):
 *  A "group" = all modelling lines of one High Level ID sharing a
 *  High Level Component (e.g. the 5 GB Core Rx carton sizes).
 *  Edits are saved as a GROUP so users can rebalance a split in one save.
 *  Validation per date segment across the group's active rows:
 *   - 2+ lines with non-zero mix  → mixes must total 100% (±0.05%)
 *   - exactly 1 line non-zero     → any value 0–1 (an attach rate,
 *     e.g. 10% of orders include a needle bag)
 *   - all zero / no rows          → component switched off, fine
 *
 * Cold Chain Mix (Q3): any day boundaries; no overlapping ranges
 * per High Level ID; gaps allowed (treated as 0% CC) but reported.
 ************************************************************/

const MIX_TOL = 0.0005;

/* payload = { highLevelId, hlComponent,
     rows: [{mixId?, modellingId, fromDate, toDate, mix, comment, deleted?}] } */
function saveComponentMixGroup(payload) {
  prewarmForWrite_([SHEET.COMP_MIX, SHEET.COMP_MIX_AM]);
  const lines = tableToObjects_(SHEET.LINES);
  const comps = tableToObjects_(SHEET.COMPONENTS);
  const hlRows = tableToObjects_(SHEET.HL);
  const hl = hlRows.find(h => String(h.High_Level_ID) === String(payload.highLevelId));
  if (!hl) throw new Error('High Level ID not found.');
  const perms = requireEditorForArea_(hl.Area_ID);

  const compById = {};
  comps.forEach(cp => compById[cp.Component_ID] = cp);
  const groupLineIds = {};
  lines.forEach(l => {
    if (String(l.High_Level_ID) !== String(payload.highLevelId)) return;
    const cp = compById[l.Component_ID];
    if (cp && safeStr(cp.High_Level_Component) === safeStr(payload.hlComponent)) groupLineIds[l.Modelling_ID] = true;
  });

  // sanitise + validate rows belong to the group
  const rows = (payload.rows || []).map(r => {
    if (!groupLineIds[r.modellingId]) {
      throw new Error('Line ' + r.modellingId + ' is not part of the ' + payload.hlComponent + ' group for this High Level ID.');
    }
    const from = normDate(r.fromDate), to = normDate(r.toDate);
    if (!r.deleted) {
      if (!from || !to) throw new Error('Every mix row needs From and To dates.');
      if (from.getTime() > to.getTime()) throw new Error('From must be on or before To.');
      const m = Number(r.mix);
      if (isNaN(m) || m < 0 || m > 1) throw new Error('Mix must be between 0 and 1 (e.g. 0.25 for 25%).');
    }
    return { mixId: r.mixId || null, modellingId: Number(r.modellingId), from: from, to: to,
             mix: Number(r.mix) || 0, comment: safeStr(r.comment), deleted: !!r.deleted };
  });

  const active = rows.filter(r => !r.deleted);

  // per-line: no overlapping ranges within the same modelling line
  const byLine = {};
  active.forEach(r => { (byLine[r.modellingId] = byLine[r.modellingId] || []).push(r); });
  Object.keys(byLine).forEach(mid => {
    const rs = byLine[mid].slice().sort((a, b) => a.from - b.from);
    for (let i = 1; i < rs.length; i++) {
      if (rs[i].from.getTime() <= rs[i - 1].to.getTime()) {
        throw new Error('Line ' + mid + ' has overlapping mix date ranges (' +
          dayStr(rs[i - 1].from) + '→' + dayStr(rs[i - 1].to) + ' and ' + dayStr(rs[i].from) + '→' + dayStr(rs[i].to) + ').');
      }
    }
  });

  // §6.2 segment validation across the whole group
  if (active.length) {
    const bset = {};
    active.forEach(r => { bset[r.from.getTime()] = true; bset[addDays(r.to, 1).getTime()] = true; });
    const bounds = Object.keys(bset).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = bounds[i];
      const covering = active.filter(r => r.from.getTime() <= s && addDays(r.to, 1).getTime() > s);
      const nonZero = covering.filter(r => r.mix > 0);
      if (nonZero.length >= 2) {
        const sum = covering.reduce((t, r) => t + r.mix, 0);
        if (Math.abs(sum - 1) > MIX_TOL) {
          throw new Error('Mix for ' + hl.Brand + ' ' + hl.Geo + ' ' + hl.Treatment_Type + ' · ' + payload.hlComponent +
            ' totals ' + (sum * 100).toFixed(2) + '% between ' + dayStr(new Date(s)) + ' and ' +
            dayStr(addDays(new Date(bounds[i + 1]), -1)) + ' — a split across multiple components must total 100%.');
        }
      }
    }
  }

  // apply
  return withLock(() => {
    const sh = getSheet(SHEET.COMP_MIX);
    const data = getAllData(SHEET.COMP_MIX);
    const c = H(SHEET.COMP_MIX);
    const now = new Date();
    const rowByMixId = {};
    for (let i = 1; i < data.length; i++) rowByMixId[String(data[i][c.Mix_ID])] = i;

    const results = [];
    /* Collected rather than written per mix row: a group edit touches every line
       of a split at once, and one setValues at the end beats one per row. */
    const auditRows = [];
    const groupLabel = 'HL ' + payload.highLevelId + ' · ' + payload.hlComponent;
    rows.forEach(r => {
      if (r.mixId && rowByMixId[String(r.mixId)] !== undefined) {
        const i = rowByMixId[String(r.mixId)];
        const before = data[i].slice();          // captured before rowVals is mutated
        const rowVals = data[i].slice();
        if (r.deleted) {
          rowVals[c.Active] = 'N';
        } else {
          rowVals[c.Modelling_ID] = r.modellingId;
          rowVals[c.From_Date] = r.from;
          rowVals[c.To_Date] = r.to;
          rowVals[c.Mix] = r.mix;
          rowVals[c.Comment] = r.comment;
          rowVals[c.Active] = 'Y';
        }
        rowVals[c.Updated_At] = now;
        rowVals[c.Updated_By] = perms.email;
        sh.getRange(i + 1, 1, 1, rowVals.length).setValues([rowVals]);
        appendAmend_(SHEET.COMP_MIX, r.deleted ? 'DELETE' : 'UPDATE', rowVals, perms);
        logFieldChanges_(perms, r.deleted ? 'DELETE_MIX' : 'UPDATE_MIX', SHEET.COMP_MIX,
                         r.mixId, before, rowVals, HEADERS[SHEET.COMP_MIX],
                         { summary: groupLabel, into: auditRows });
        results.push({ mixId: Number(r.mixId) });
      } else if (!r.deleted) {
        const newId = getNextId(SHEET.COMP_MIX, 'Mix_ID');
        const rowVals = [newId, r.modellingId, r.from, r.to, r.mix, r.comment, 'Y', now, perms.email];
        sh.appendRow(rowVals);
        appendAmend_(SHEET.COMP_MIX, 'CREATE', rowVals, perms);
        results.push({ mixId: newId, tempKey: r.mixId || null });
      }
    });
    appendAuditRows_(auditRows);
    /* The group summary stays alongside the per-field rows: the rebalance is one
       action, and the field rows on their own do not say that five lines moved
       together on purpose. */
    logAction_(perms, 'SAVE_MIX_GROUP', SHEET.COMP_MIX, '',
               groupLabel + ' (' + rows.length + ' rows)');
    return { saved: results, updatedAt: dayStr(now) };
  });
}

/* ---------------- Cold Chain Mix ---------------- */

/* cc = {ccMixId?, highLevelId, fromDate, toDate, mix, comment} */
function saveCCMix(cc) {
  prewarmForWrite_([SHEET.CC_MIX, SHEET.CC_MIX_AM]);
  const hl = tableToObjects_(SHEET.HL).find(h => String(h.High_Level_ID) === String(cc.highLevelId));
  if (!hl) throw new Error('High Level ID not found.');
  const perms = requireEditorForArea_(hl.Area_ID);

  const from = normDate(cc.fromDate), to = normDate(cc.toDate);
  if (!from || !to) throw new Error('From and To dates are required.');
  if (from.getTime() > to.getTime()) throw new Error('From must be on or before To.');
  const mix = Number(cc.mix);
  if (isNaN(mix) || mix < 0 || mix > 1) throw new Error('CC mix must be between 0 and 1.');

  return withLock(() => {
    const sh = getSheet(SHEET.CC_MIX);
    const data = getAllData(SHEET.CC_MIX);
    const c = H(SHEET.CC_MIX);

    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (String(row[c.High_Level_ID]) !== String(cc.highLevelId)) continue;
      if (!isActive(row[c.Active])) continue;
      if (cc.ccMixId && String(row[c.CC_Mix_ID]) === String(cc.ccMixId)) continue;
      const oF = normDate(row[c.From_Date]), oT = normDate(row[c.To_Date]);
      if (!oF || !oT) continue;
      if (from.getTime() <= oT.getTime() && to.getTime() >= oF.getTime()) {
        throw new Error('Cold chain conflict: overlaps row #' + row[c.CC_Mix_ID] + ' (' + dayStr(oF) + ' → ' + dayStr(oT) + ').');
      }
    }

    const now = new Date();
    if (cc.ccMixId) {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][c.CC_Mix_ID]) !== String(cc.ccMixId)) continue;
        const before = data[i].slice();          // captured before rowVals is mutated
        const rowVals = data[i].slice();
        rowVals[c.From_Date] = from; rowVals[c.To_Date] = to; rowVals[c.CC_Mix] = mix;
        rowVals[c.Comment] = safeStr(cc.comment); rowVals[c.Active] = 'Y';
        rowVals[c.Updated_At] = now; rowVals[c.Updated_By] = perms.email;
        sh.getRange(i + 1, 1, 1, rowVals.length).setValues([rowVals]);
        appendAmend_(SHEET.CC_MIX, 'UPDATE', rowVals, perms);
        logFieldChanges_(perms, 'UPDATE_CC_MIX', SHEET.CC_MIX, cc.ccMixId, before, rowVals,
                         HEADERS[SHEET.CC_MIX], { summary: 'HL ' + cc.highLevelId });
        return { ccMixId: Number(cc.ccMixId) };
      }
      throw new Error('Cold chain row #' + cc.ccMixId + ' not found.');
    }
    const newId = getNextId(SHEET.CC_MIX, 'CC_Mix_ID');
    const rowVals = [newId, Number(cc.highLevelId), from, to, mix, safeStr(cc.comment), 'Y', now, perms.email];
    sh.appendRow(rowVals);
    appendAmend_(SHEET.CC_MIX, 'CREATE', rowVals, perms);
    logAction_(perms, 'CREATE_CC_MIX', SHEET.CC_MIX, newId, 'HL ' + cc.highLevelId);
    return { ccMixId: newId };
  });
}

function deleteCCMix(ccMixId) {
  prewarmForWrite_([SHEET.CC_MIX, SHEET.CC_MIX_AM]);
  return withLock(() => {
    const sh = getSheet(SHEET.CC_MIX);
    const data = getAllData(SHEET.CC_MIX);
    const c = H(SHEET.CC_MIX);
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][c.CC_Mix_ID]) !== String(ccMixId)) continue;
      const hl = tableToObjects_(SHEET.HL).find(h => String(h.High_Level_ID) === String(data[i][c.High_Level_ID]));
      const perms = requireEditorForArea_(hl ? hl.Area_ID : -1);
      sh.getRange(i + 1, c.Active + 1).setValue('N');
      sh.getRange(i + 1, c.Updated_At + 1).setValue(new Date());
      sh.getRange(i + 1, c.Updated_By + 1).setValue(perms.email);
      const rowVals = data[i].slice(); rowVals[c.Active] = 'N';
      appendAmend_(SHEET.CC_MIX, 'DELETE', rowVals, perms);
      logAction_(perms, 'DELETE_CC_MIX', SHEET.CC_MIX, ccMixId, '');
      return { ccMixId: Number(ccMixId) };
    }
    throw new Error('Cold chain row #' + ccMixId + ' not found.');
  });
}
