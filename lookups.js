/************************************************************
 * lookups.gs — what refers to a dimension row, and what that
 * therefore forbids.
 *
 * Nothing in a Google Sheet enforces a foreign key. Every table
 * here points at another by id, and the portal has always let an
 * Admin rename or switch off the far end of one of those pointers
 * with no idea how many rows were relying on it. ORPHAN_FK now
 * reports the wreckage after the fact; this stops it happening.
 *
 * Two kinds of guard, and the difference between them is the whole
 * design:
 *
 *   RELINKING — changing a value that other rows are matched on.
 *     Rare, and always destructive: a Component's High Level
 *     Component is what groups mix rows into a 100% split, and a
 *     Modelling Line's High_Level_ID / Component_ID are what its
 *     rates and mixes hang off. Move one while rows point at it and
 *     they end up describing something nobody meant.
 *
 *   DEACTIVATING a parent that still has active children. Legal in
 *     the data, and exactly the state ORPHAN_FK calls an error, so
 *     allowing it would let one click create a finding that blocks
 *     the next recalculation.
 *
 * Everything else stays editable, and that is deliberate. A High
 * Level ID's Brand, Geo, Treatment Type and WL Detail are labels:
 * Output re-derives them on every recalculation and nothing matches
 * on them, so a typo in a brand name can always be corrected. Saying
 * which fields are safe is as much the point as blocking the ones
 * that are not.
 ************************************************************/

/* Child tables per dimension: where its id is used, and what to call it.
   `activeOnly` counts only live rows — the count that decides whether a
   deactivation is refused. The total is what the screen shows. */
const DIM_USES = {
  area: {
    label: 'modelling area', idHeader: 'Area_ID', sheet: () => SHEET.AREAS,
    children: [
      { sheet: () => SHEET.HL,         col: 'Area_ID',        what: 'High Level ID' },
      { sheet: () => SHEET.COMPONENTS, col: 'Area_ID',        what: 'component' }
    ]
  },
  hl: {
    label: 'High Level ID', idHeader: 'High_Level_ID', sheet: () => SHEET.HL,
    children: [
      { sheet: () => SHEET.LINES,   col: 'High_Level_ID', what: 'modelling line' },
      { sheet: () => SHEET.CC_MIX,  col: 'High_Level_ID', what: 'cold chain mix row' }
    ]
  },
  comp: {
    label: 'component', idHeader: 'Component_ID', sheet: () => SHEET.COMPONENTS,
    children: [
      { sheet: () => SHEET.LINES,   col: 'Component_ID',  what: 'modelling line' }
    ]
  },
  line: {
    label: 'modelling line', idHeader: 'Modelling_ID', sheet: () => SHEET.LINES,
    children: [
      { sheet: () => SHEET.RATES,    col: 'Modelling_ID', what: 'rate card row' },
      { sheet: () => SHEET.COMP_MIX, col: 'Modelling_ID', what: 'component mix row' }
    ]
  }
};

/* Every dimension's usage counts, in one pass per child table.
 *
 * Bucketed by parent id rather than asked per row: counting for one High Level
 * ID means walking Modelling_Lines and Cold_Chain_Mix, and asking that question
 * once per High Level ID would walk them once per High Level ID.
 *
 * Per execution — a save that then reads its own counts back has to
 * invalidateSheetCache and call dimUsageInvalidate_ first. */
let _dimUsageCache_ = null;
function dimUsageInvalidate_() { _dimUsageCache_ = null; }

function dimUsageAll_() {
  if (_dimUsageCache_) return _dimUsageCache_;
  const out = {};
  Object.keys(DIM_USES).forEach(kind => {
    const spec = DIM_USES[kind];
    const bucket = {};
    spec.children.forEach(child => {
      const name = child.sheet();
      const data = getAllData(name);
      const c = H(name);
      const col = c[child.col];
      if (col === undefined) return;
      const activeCol = c.Active;
      const seen = {};
      for (let i = 1; i < data.length; i++) {
        const key = safeStr(data[i][col]);
        if (key === '') continue;
        const live = activeCol === undefined ? true : isActive(data[i][activeCol]);
        const e = seen[key] || (seen[key] = { total: 0, active: 0 });
        e.total++;
        if (live) e.active++;
      }
      Object.keys(seen).forEach(key => {
        const b = bucket[key] || (bucket[key] = { total: 0, active: 0, where: [] });
        b.total += seen[key].total;
        b.active += seen[key].active;
        b.where.push({ what: child.what, count: seen[key].total, active: seen[key].active });
      });
    });
    out[kind] = bucket;
  });
  _dimUsageCache_ = out;
  return out;
}

function dimUsage_(kind, id) {
  const b = dimUsageAll_()[kind] || {};
  return b[safeStr(id)] || { total: 0, active: 0, where: [] };
}

/* "3 modelling lines, 1 cold chain mix row" — active counts, because those are
   the ones a refusal is about. */
function dimUsageText_(usage) {
  const parts = (usage.where || []).filter(w => w.active > 0).map(w =>
    w.active + ' ' + w.what + (w.active === 1 ? '' : 's'));
  return parts.length ? parts.join(' and ') : 'nothing';
}

/**
 * Usage counts for every dimension row, for the Lookups screen.
 *
 * Viewer, not Admin: it is a read, the numbers are already derivable from the
 * reference data the client holds, and the screen that shows them is Admin-only
 * anyway. Keeping the gate low means the count can also be shown beside a rate
 * or a mix later without a second endpoint.
 */
function getDimensionUsage() {
  requireViewer();
  prewarmSheetCache_([SHEET.AREAS, SHEET.HL, SHEET.COMPONENTS, SHEET.LINES,
                      SHEET.RATES, SHEET.COMP_MIX, SHEET.CC_MIX, SHEET.PERMISSIONS]);
  const all = dimUsageAll_();
  /* Flattened to one map so the client can look a row up by kind and id without
     caring how the buckets are shaped. */
  const out = {};
  Object.keys(all).forEach(kind => {
    Object.keys(all[kind]).forEach(id => {
      out[kind + '|' + id] = all[kind][id];
    });
  });
  return out;
}

/* ---------------- the guards ----------------
 *
 * Each throws with a message that says what is in the way and what to do about
 * it, because "cannot delete: in use" sends somebody to the Sheet to work it out
 * by hand, which is the thing this file exists to stop.
 */

/** Refuse to switch off a row that still has live children. */
function guardDeactivate_(kind, id, label) {
  const usage = dimUsage_(kind, id);
  if (!usage.active) return;
  const spec = DIM_USES[kind];
  throw new Error('"' + label + '" cannot be switched off: ' + dimUsageText_(usage) +
    ' still point' + (usage.active === 1 ? 's' : '') + ' at it. Leaving them would make every ' +
    'one of them an ORPHAN_FK error, which blocks the next recalculation. Switch those off ' +
    'first, then this ' + spec.label + '.');
}

/** Refuse to move a row's pointers while rows are matched on where it points. */
function guardRelink_(kind, id, label, fieldLabel, was, now) {
  if (safeStr(was) === safeStr(now)) return;
  const usage = dimUsage_(kind, id);
  if (!usage.active) return;
  throw new Error('The ' + fieldLabel + ' of "' + label + '" cannot be changed from "' +
    safeStr(was) + '" to "' + safeStr(now) + '" while ' + dimUsageText_(usage) +
    ' point' + (usage.active === 1 ? 's' : '') + ' at it — they would silently start ' +
    'describing something else. Add a new one and move the rows across, or switch those ' +
    'rows off first.');
}

/**
 * Refuse to remove a customer type an active rate row is filed under.
 *
 * Modelling_Areas.Customer_Types is not a label. rates.js validates a rate's
 * Customer_Type against it, expandCT_ turns an 'All' row into exactly this list,
 * and computeAll_ costs one column per entry. Dropping "OTC" from an area does
 * not delete the rows filed under OTC; it leaves them pointing at a type the
 * area no longer has, where they are validated by nothing and costed into a
 * column that no longer exists.
 *
 * Adding a type is always allowed — it widens what 'All' covers, which shows up
 * as RATE_MISSING on any line that does not price the new one, which is the
 * correct thing to be told.
 */
function guardCustomerTypes_(areaId, areaName, was, now) {
  const split = s => safeStr(s).split(',').map(x => x.trim()).filter(Boolean);
  const before = split(was), after = split(now);
  const afterUp = {};
  after.forEach(t => afterUp[t.toUpperCase()] = true);
  const removed = before.filter(t => !afterUp[t.toUpperCase()]);
  if (!removed.length) return;

  /* Which High Level IDs, and therefore which lines, belong to this area. */
  const hlIds = {};
  tableToObjects_(SHEET.HL).forEach(h => {
    if (String(h.Area_ID) === String(areaId)) hlIds[String(h.High_Level_ID)] = true;
  });
  const mids = {};
  tableToObjects_(SHEET.LINES).forEach(l => {
    if (hlIds[String(l.High_Level_ID)]) mids[String(l.Modelling_ID)] = true;
  });

  const counts = {};
  tableToObjects_(SHEET.RATES).forEach(r => {
    if (!isActive(r.Active)) return;
    if (!mids[String(r.Modelling_ID)]) return;
    const ct = safeStr(r.Customer_Type);
    removed.forEach(t => { if (t.toUpperCase() === ct.toUpperCase()) counts[t] = (counts[t] || 0) + 1; });
  });

  const blocked = Object.keys(counts);
  if (!blocked.length) return;
  throw new Error('"' + areaName + '" cannot drop the customer type' +
    (blocked.length === 1 ? ' ' : 's ') + blocked.map(t => '"' + t + '"').join(', ') +
    ': ' + blocked.map(t => counts[t] + ' active rate card row' + (counts[t] === 1 ? '' : 's')).join(' and ') +
    ' ' + (blocked.length === 1 && counts[blocked[0]] === 1 ? 'is' : 'are') + ' filed under ' +
    (blocked.length === 1 ? 'it' : 'them') + '. Those rows would be costed into a column the ' +
    'area no longer has. Move them to another customer type first.');
}
