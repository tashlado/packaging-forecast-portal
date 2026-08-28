/************************************************************
 * bulk.gs — one rate change across many lines at once
 *
 * The case this exists for: a component's cost changes, and that
 * one change lands on every line carrying it — every brand, every
 * geo, cold chain and ambient, new and repeat. Editing those one
 * at a time is where mistakes come from.
 *
 * Selection is by DIMENSION, never by picking rows: tick the
 * component, leave brand and geo alone, and every rate under it
 * moves. Values inside one dimension are ORed, the dimensions are
 * ANDed with each other, and an empty dimension means "all of
 * them" — never a magic 'ALL' string, because a component or brand
 * literally named ALL is one data entry away, and a wildcard that
 * a data entry can impersonate is a wildcard waiting to widen
 * somebody's price change.
 *
 * Two things keep it honest:
 *   - It is preview-first. bulkUpdateRates previews unless it is
 *     given preview:false AND the planKey the preview issued. If
 *     the matched rows moved in between, the write is refused.
 *   - It only ever SUPERSEDES a rate that already exists. It will
 *     not invent one for a line that has none — that gap belongs
 *     on the preview, not silently filled in.
 *
 * A change is a new period, exactly as a single save makes one:
 * whatever is running on each matching line is closed the day
 * before, and the new value runs from the effective date. §6.1
 * (no overlapping rows once CC_Flag and Customer_Type are
 * expanded) is re-checked per row against the batch's own working
 * copy, so rows written earlier in the batch are visible to the
 * rows after them.
 ************************************************************/

/* The dimensions a selection can name. `on` says where the value is read from:
   'line' walks Modelling_Lines → Components / High_Level_IDs, 'rate' is a column
   on the rate row itself. */
const BULK_DIMS = [
  { key: 'highLevelComponent', on: 'line', label: 'High Level Component' },
  { key: 'component',          on: 'line', label: 'Component' },
  { key: 'brand',              on: 'line', label: 'Brand' },
  { key: 'geo',                on: 'line', label: 'Geo' },
  { key: 'treatmentType',      on: 'line', label: 'Treatment type' },
  { key: 'wlDetail',           on: 'line', label: 'WL detail' },
  { key: 'ccFlag',             on: 'rate', label: 'CC flag',       col: 'CC_Flag' },
  { key: 'customerType',       on: 'rate', label: 'Customer type', col: 'Customer_Type' }
];

/* A dimension's selection as a lookup, or null for "every value". Comparison is
   on the trimmed, upper-cased string so a stray case difference in the sheet
   cannot quietly drop a line out of a selection. */
function bulkPicked_(sel) {
  const list = (sel === null || sel === undefined) ? []
             : (Array.isArray(sel) ? sel : [sel]);
  const vals = list.map(v => safeStr(v).toUpperCase()).filter(s => s !== '');
  if (!vals.length) return null;
  const set = {};
  vals.forEach(v => set[v] = true);
  return set;
}
function bulkMatches_(picked, value) {
  return !picked || !!picked[safeStr(value).toUpperCase()];
}

/* Every active line, with the dimension values a selection can test, plus the
   Area_ID its edit rights hang off and the customer types its area defines. */
function bulkLineIndex_() {
  const areas = {};
  tableToObjects_(SHEET.AREAS).forEach(a => {
    const types = safeStr(a.Customer_Types).split(',').map(s => s.trim()).filter(Boolean);
    areas[a.Area_ID] = types.length ? types : ['New', 'Repeat', 'OTC'];
  });
  const hl = {};
  tableToObjects_(SHEET.HL).filter(h => isActive(h.Active)).forEach(h => hl[h.High_Level_ID] = h);
  const comps = {};
  tableToObjects_(SHEET.COMPONENTS).filter(c => isActive(c.Active))
    .forEach(c => comps[c.Component_ID] = c);

  const out = {};
  tableToObjects_(SHEET.LINES).filter(l => isActive(l.Active)).forEach(l => {
    const h = hl[l.High_Level_ID], c = comps[l.Component_ID];
    if (!h || !c) return;                       // a line pointing at an inactive parent
    out[l.Modelling_ID] = {
      modellingId: Number(l.Modelling_ID),
      areaId: Number(h.Area_ID) || 1,
      types: areas[h.Area_ID] || ['New', 'Repeat', 'OTC'],
      label: [h.Brand, h.Geo, h.Treatment_Type, h.WL_Detail].filter(x => x && x !== '*').join(' ') +
             ' — ' + safeStr(c.Component),
      dims: {
        highLevelComponent: c.High_Level_Component,
        component: c.Component,
        brand: h.Brand, geo: h.Geo,
        treatmentType: h.Treatment_Type, wlDetail: h.WL_Detail
      }
    };
  });
  return out;
}

/* The options the client offers, straight from the data rather than a hardcoded
   list, so a component or brand added later needs no change here. */
function bulkRateOptions() {
  requireViewer();
  prewarmSheetCache_([SHEET.AREAS, SHEET.HL, SHEET.COMPONENTS, SHEET.LINES, SHEET.RATES]);
  const lines = bulkLineIndex_();
  const vals = {};
  BULK_DIMS.filter(d => d.on === 'line').forEach(d => vals[d.key] = {});
  Object.keys(lines).forEach(mid => {
    BULK_DIMS.filter(d => d.on === 'line').forEach(d => {
      const v = safeStr(lines[mid].dims[d.key]);
      if (v) vals[d.key][v] = true;
    });
  });
  const types = {};
  Object.keys(lines).forEach(mid => lines[mid].types.forEach(t => types[t] = true));
  const out = {};
  Object.keys(vals).forEach(k => out[k] = Object.keys(vals[k]).sort());
  out.ccFlag = ['Both', 'CC', 'Ambient'];
  out.customerType = ['All'].concat(Object.keys(types).sort());
  return out;
}

/* §6.1's expansion, shared with saveRate: a 'Both' row occupies both the CC and
   the Ambient slot, an 'All' row every customer type of its area. Two rows
   conflict only if they share a slot on both axes AND their dates overlap. */
function bulkSlotsClash_(aCC, aCT, bCC, bCT, types) {
  const cc = expandCC_(safeStr(aCC)), oCC = expandCC_(safeStr(bCC));
  if (!cc.some(x => oCC.indexOf(x) >= 0)) return false;
  const ct = expandCT_(safeStr(aCT), types), oCT = expandCT_(safeStr(bCT), types);
  return ct.some(x => oCT.indexOf(x) >= 0);
}

function bulkRound_(v) { return Math.round(v * 1000000) / 1000000; }

/* Work out what a bulk change would do, touching nothing.
 *
 * For every (line × CC flag × customer type) the selection matches, this finds
 * the row a new period would supersede — the one in force on the effective date,
 * or failing that the latest one starting before it. Everything it cannot act on
 * is counted rather than dropped: no rate to supersede, outside the user's areas,
 * or blocked by a row already sitting in the new date range. */
function planBulkRateChange_(p, perms) {
  const field = safeStr(p.field).toUpperCase() === 'QTY' ? 'QTY' : 'CPU';
  const mode  = safeStr(p.mode).toUpperCase() === 'PCT' ? 'PCT' : 'SET';
  const entered = Number(p.value);
  if (isNaN(entered)) throw new Error('Enter a number for the new value.');
  if (mode === 'SET' && entered < 0) throw new Error(field + ' cannot be negative.');
  if (mode === 'PCT' && entered <= -100) {
    throw new Error('A change of -100% or less would take every rate to zero or below. ' +
                    'Enter a percentage above -100.');
  }

  const from = normDate(p.fromDate), to = normDate(p.toDate);
  if (!from || !to) throw new Error('Effective from and until dates are required (yyyy-mm-dd).');
  if (from.getTime() > to.getTime()) throw new Error('Effective from must be on or before until.');
  const fromKey = dayStr(from), toKey = dayStr(to);
  const dayBefore = addDays(from, -1);

  const dims = p.dimensions || {};
  const picked = {};
  BULK_DIMS.forEach(d => picked[d.key] = bulkPicked_(dims[d.key]));

  const lines = bulkLineIndex_();
  const linesMatched = {};
  Object.keys(lines).forEach(mid => {
    const ok = BULK_DIMS.filter(d => d.on === 'line')
      .every(d => bulkMatches_(picked[d.key], lines[mid].dims[d.key]));
    if (ok) linesMatched[mid] = true;
  });

  /* Active rate rows of the matched lines, kept as {i, ...} so apply can find the
     same row again by its index in the same cached read. */
  const data = getAllData(SHEET.RATES);
  const c = H(SHEET.RATES);
  const rows = [];
  for (let i = 1; i < data.length; i++) {
    const mid = safeStr(data[i][c.Modelling_ID]);
    if (mid === '' || !linesMatched[mid]) continue;
    if (!isActive(data[i][c.Active])) continue;
    const f = normDate(data[i][c.From_Date]), t = normDate(data[i][c.To_Date]);
    if (!f || !t) continue;
    rows.push({
      dataIndex: i,
      rateId: Number(data[i][c.Rate_ID]),
      modellingId: Number(data[i][c.Modelling_ID]),
      ccFlag: safeStr(data[i][c.CC_Flag]),
      customerType: safeStr(data[i][c.Customer_Type]),
      fromKey: dayStr(f), toKey: dayStr(t),
      cpu: safeNum(data[i][c.CPU]), qty: safeNum(data[i][c.QTY])
    });
  }

  /* One move per distinct (line, CC flag, customer type) the selection names, and
     only those the selection actually names — a row's own CC flag and customer
     type have to pass the picked lists too. */
  const groups = {};
  rows.forEach(r => {
    if (!bulkMatches_(picked.ccFlag, r.ccFlag)) return;
    if (!bulkMatches_(picked.customerType, r.customerType)) return;
    const k = r.modellingId + '|' + r.ccFlag + '|' + r.customerType;
    (groups[k] = groups[k] || []).push(r);
  });

  const items = [];
  let skippedNoRate = 0, skippedNoScope = 0, skippedBlocked = 0;
  const blockedExamples = [];

  Object.keys(groups).forEach(k => {
    const candidates = groups[k];
    let cur = null;
    for (let n = 0; n < candidates.length; n++) {
      const r = candidates[n];
      if (r.fromKey > fromKey) continue;                                  // starts later
      if (r.toKey >= fromKey) { cur = r; break; }                         // in force — done
      if (!cur || r.fromKey > cur.fromKey) cur = r;                       // latest before
    }
    if (!cur) { skippedNoRate++; return; }

    const line = lines[cur.modellingId];
    if (perms.rank < ROLE_RANK.Admin && !canAccessArea_(perms, line.areaId)) {
      skippedNoScope++; return;
    }

    /* Anything else of this line already sitting in the new range, once §6.1's
       expansion is applied, would make the write illegal. Report it, do not
       silently write over it. */
    const clash = rows.find(r =>
      r.rateId !== cur.rateId &&
      r.modellingId === cur.modellingId &&
      r.fromKey <= toKey && r.toKey >= fromKey &&
      bulkSlotsClash_(cur.ccFlag, cur.customerType, r.ccFlag, r.customerType, line.types));
    if (clash) {
      skippedBlocked++;
      if (blockedExamples.length < 3) {
        blockedExamples.push('#' + clash.rateId + ' (' + clash.ccFlag + '/' +
          clash.customerType + ', ' + clash.fromKey + ' → ' + clash.toKey + ')');
      }
      return;
    }

    const was = field === 'QTY' ? cur.qty : cur.cpu;
    const now = bulkRound_(mode === 'PCT' ? was * (1 + entered / 100) : entered);
    if (now < 0) {
      throw new Error('That change takes ' + line.label + ' to ' + now +
                      ', which is negative. Check the percentage.');
    }
    items.push({
      modellingId: cur.modellingId, rateId: cur.rateId, dataIndex: cur.dataIndex,
      ccFlag: cur.ccFlag, customerType: cur.customerType,
      label: line.label, areaId: line.areaId,
      currentFrom: cur.fromKey, currentTo: cur.toKey,
      cpu: cur.cpu, qty: cur.qty,
      was: was, now: now,
      /* A row starting on the effective date itself is a revision of that period,
         not something to close and follow — closing it would invert its dates. */
      revise: cur.fromKey === fromKey
    });
  });

  items.sort((a, b) => a.modellingId - b.modellingId ||
    a.ccFlag.localeCompare(b.ccFlag) || a.customerType.localeCompare(b.customerType));

  return {
    field: field, mode: mode, entered: entered,
    from: from, to: to, fromKey: fromKey, toKey: toKey, dayBefore: dayBefore,
    items: items, distinct: bulkDistinct_(items),
    linesMatched: Object.keys(linesMatched).length,
    skippedNoRate: skippedNoRate, skippedNoScope: skippedNoScope,
    skippedBlocked: skippedBlocked, blockedExamples: blockedExamples,
    selection: bulkDescribe_(picked),
    planKey: bulkPlanKey_(field, mode, items)
  };
}

/* The distinct was → now moves, commonest first. Selection is by dimension, so
   showing the spread of what is about to be overwritten is the safeguard rather
   than a filter on it: in set-to mode this reads as "what is being flattened". */
function bulkDistinct_(items) {
  const seen = {};
  items.forEach(it => {
    const k = it.was + '>' + it.now;
    if (!seen[k]) seen[k] = { was: it.was, now: it.now, rows: 0 };
    seen[k].rows++;
  });
  return Object.keys(seen).map(k => seen[k])
    .sort((a, b) => b.rows - a.rows || a.was - b.was);
}

/* A fingerprint of the matched rows and their current values. The client
   previews, the user confirms, and the apply sends this back; if the matched set
   has moved in between — someone else edited a rate, a line was deactivated —
   the recomputed key differs and the write is refused, so a confirmation can
   only ever apply the set that was actually shown. */
function bulkPlanKey_(field, mode, items) {
  const s = field + ':' + mode + ':' + items.map(it =>
    it.rateId + ':' + Math.round(it.was * 1000000) + ':' + Math.round(it.now * 1000000)
  ).sort().join('|');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s || 'empty');
  return bytes.map(b => ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2)).join('').slice(0, 12);
}

function bulkDescribe_(picked) {
  const parts = BULK_DIMS.map(d => {
    if (!picked[d.key]) return null;
    return d.label + ' ' + Object.keys(picked[d.key]).join('/');
  }).filter(Boolean);
  return parts.length ? parts.join('; ') : 'every rate';
}

function bulkBatchRef_(when) {
  const p2 = n => ('0' + n).slice(-2);
  return 'BULK-' + when.getFullYear() + p2(when.getMonth() + 1) + p2(when.getDate()) +
         '-' + p2(when.getHours()) + p2(when.getMinutes()) + p2(when.getSeconds());
}

/**
 * Preview or apply a bulk rate change.
 *
 * Previews by default. Pass preview:false together with the planKey the preview
 * returned to actually write.
 *
 * @param {Object} p { dimensions: {highLevelComponent, component, brand, geo,
 *                                  treatmentType, wlDetail, ccFlag, customerType},
 *                     field: 'CPU' | 'QTY',
 *                     mode:  'SET' | 'PCT',
 *                     value, fromDate, toDate, comment, preview, planKey }
 */
function bulkUpdateRates(p) {
  prewarmForWrite_([SHEET.RATES, SHEET.RATES_AM]);
  /* The capability, not the per-area gate: which areas a row belongs to is
     decided per row further down (planBulkRateChange_ counts them as
     skippedNoScope, applyBulkRateChange_ re-checks them inside the lock), and
     Can_Edit_Rates is a property of the person rather than of any one row. */
  const perms = requireCapability_(requireEditor(), 'editRates');
  const plan = planBulkRateChange_(p, perms);

  if (p.preview !== false) {
    return {
      preview: true, field: plan.field, mode: plan.mode, value: plan.entered,
      count: plan.items.length, distinct: plan.distinct,
      linesMatched: plan.linesMatched, skippedNoRate: plan.skippedNoRate,
      skippedNoScope: plan.skippedNoScope, skippedBlocked: plan.skippedBlocked,
      blockedExamples: plan.blockedExamples,
      revisions: plan.items.filter(it => it.revise).length,
      fromDate: plan.fromKey, toDate: plan.toKey,
      selection: plan.selection, planKey: plan.planKey,
      sample: plan.items.slice(0, 12).map(it => ({
        rateId: it.rateId, label: it.label, ccFlag: it.ccFlag,
        customerType: it.customerType, was: it.was, now: it.now
      }))
    };
  }

  if (!plan.items.length) {
    throw new Error('Nothing matches that selection, so there is nothing to update. ' +
      plan.skippedNoRate + ' had no rate to supersede, ' + plan.skippedBlocked +
      ' were blocked by a later rate, and ' + plan.skippedNoScope +
      ' are outside the areas you can edit.');
  }
  if (safeStr(p.planKey) !== plan.planKey) {
    throw new Error('These rates have changed since the preview was taken, so nothing ' +
      'was applied. Run the preview again and check it still says what you expect.');
  }
  return withLock(() => applyBulkRateChange_(p, plan, perms));
}

/* Write a planned change. Assumes the caller holds the lock.
 *
 * One working copy of Rate_Card, mutated as it goes, then two writes: a single
 * ranged setValues over the existing rows and one append for the new ones. Per
 * row it does what saveRate does — close the running period, stamp the editor,
 * snapshot to Rate_Card_Amends — but in a handful of calls instead of two per
 * row, all under one batch reference so History can show them as one action. */
function applyBulkRateChange_(p, plan, perms) {
  const sh = getSheet(SHEET.RATES);
  const c = H(SHEET.RATES);
  const width = HEADERS[SHEET.RATES].length;
  const now = new Date();
  const batchRef = bulkBatchRef_(now);
  const note = safeStr(p.comment);

  const source = getAllData(SHEET.RATES);
  const originalRows = source.length - 1;
  const data = source.map(r => padTo_(r, width));
  const amends = [];
  const creates = [];
  /* Collected, not written per row. A bulk change produces one audit row per
     changed field per rate, which is hundreds — appendRow each would be hundreds
     of round trips, the same reason appendAmendsBatch_ exists. */
  const auditRows = [];
  let closed = 0, revised = 0;

  plan.items.forEach(it => {
    const i = it.dataIndex;
    /* The row as it stands before this item touches it. Read once, because the
       close overwrites data[i] and the create then has to diff against what was
       there rather than against the row it just closed. */
    const wasRow = data[i].slice();
    const scope = it.label + ' ' + it.ccFlag + '/' + it.customerType;
    /* Re-checked here rather than trusted from the plan: the plan ran outside the
       lock, and a per-row rights check is what every single save does. */
    if (perms.rank < ROLE_RANK.Admin && !canAccessArea_(perms, it.areaId)) {
      throw new Error('You do not have edit access to modelling area ' + it.areaId + '.');
    }
    if (String(data[i][c.Rate_ID]) !== String(it.rateId)) {
      throw new Error('Rate #' + it.rateId + ' is no longer where the preview found it. ' +
                      'Nothing was applied — run the preview again.');
    }

    if (it.revise) {
      /* The period already starts on the effective date: revise it in place. */
      const row = data[i].slice();
      row[c.To_Date] = plan.to;
      row[plan.field === 'QTY' ? c.QTY : c.CPU] = it.now;
      if (note) row[c.Comment] = truncateComment_(note);
      row[c.Updated_At] = now;
      row[c.Updated_By] = perms.email;
      data[i] = row;
      amends.push({ type: 'UPDATE', rowValues: row });
      logFieldChanges_(perms, 'BULK_REVISE_RATE', SHEET.RATES, it.rateId, wasRow, row,
                       HEADERS[SHEET.RATES],
                       { ref: batchRef, summary: scope + ' — period revised in place',
                         into: auditRows });
      revised++;
      return;
    }

    /* Close the running period the day before, then add the new one. */
    const closeRow = data[i].slice();
    closeRow[c.To_Date] = plan.dayBefore;
    closeRow[c.Updated_At] = now;
    closeRow[c.Updated_By] = perms.email;
    data[i] = closeRow;
    amends.push({ type: 'UPDATE', rowValues: closeRow });
    logFieldChanges_(perms, 'BULK_CLOSE_RATE', SHEET.RATES, it.rateId, wasRow, closeRow,
                     HEADERS[SHEET.RATES],
                     { ref: batchRef, summary: scope + ' — period closed the day before ' + plan.fromKey,
                       into: auditRows });
    closed++;

    const fresh = padTo_([], width);
    fresh[c.Rate_ID] = getNextId(SHEET.RATES, 'Rate_ID');
    fresh[c.Modelling_ID] = it.modellingId;
    fresh[c.CC_Flag] = it.ccFlag;
    fresh[c.Customer_Type] = it.customerType;
    fresh[c.From_Date] = plan.from;
    fresh[c.To_Date] = plan.to;
    fresh[c.CPU] = plan.field === 'CPU' ? it.now : it.cpu;
    fresh[c.QTY] = plan.field === 'QTY' ? it.now : it.qty;
    fresh[c.Comment] = truncateComment_((note ? note + ' — ' : '') + batchRef + ': ' +
      bulkMoveText_(plan, it));
    fresh[c.Active] = 'Y';
    fresh[c.Updated_At] = now;
    fresh[c.Updated_By] = perms.email;
    creates.push(fresh);
    data.push(fresh);
    amends.push({ type: 'CREATE', rowValues: fresh });
    /* Diffed against the row it supersedes rather than logged as a bare create:
       what a reader wants from a bulk change is "this rate went from X to Y", and
       that sentence only exists across the two rows. Rate_ID is skipped — a new
       row having a new id is not a field that changed — and the id it replaces is
       named in the summary instead. */
    logFieldChanges_(perms, 'BULK_SUPERSEDE_RATE', SHEET.RATES, fresh[c.Rate_ID],
                     wasRow, fresh, HEADERS[SHEET.RATES],
                     { ref: batchRef, skip: ['Rate_ID'],
                       summary: scope + ' — supersedes rate #' + it.rateId,
                       into: auditRows });
  });

  if (closed || revised) {
    sh.getRange(2, 1, originalRows, width).setValues(data.slice(1, 1 + originalRows));
  }
  if (creates.length) {
    sh.getRange(sh.getLastRow() + 1, 1, creates.length, width).setValues(creates);
  }
  invalidateSheetCache(SHEET.RATES);

  appendAmendsBatch_(SHEET.RATES, amends, perms);
  appendAuditRows_(auditRows);
  /* The batch summary is written last so it is the newest row in Audit_Log, and
     so lands at the top of History above the field rows it accounts for. Its
     Target_ID is the batch reference; every field row carries the same reference
     as the first token of its Summary, which is what lets one bulk action be
     collected back together. */
  logAction_(perms, 'BULK_UPDATE_RATES', SHEET.RATES, batchRef,
    batchRef + ' · ' + plan.items.length + ' rates, ' + bulkChangeText_(plan) + ', from ' +
    plan.fromKey + ' — ' + plan.selection);

  return {
    preview: false, batchRef: batchRef, written: plan.items.length,
    field: plan.field, mode: plan.mode,
    rowsClosed: closed, rowsCreated: creates.length, rowsRevised: revised,
    skippedNoRate: plan.skippedNoRate, skippedNoScope: plan.skippedNoScope,
    skippedBlocked: plan.skippedBlocked
  };
}

/* Rate_Card.Comment is a free-text cell people read; keep it a line, not a page. */
function truncateComment_(s) {
  const t = safeStr(s);
  return t.length <= 240 ? t : t.slice(0, 237) + '...';
}
function bulkMoveText_(plan, it) {
  if (plan.mode === 'SET') return plan.field + ' set to ' + it.now;
  return plan.field + ' ' + it.was + ' ' + (plan.entered >= 0 ? '+' : '') +
         plan.entered + '% → ' + it.now;
}
function bulkChangeText_(plan) {
  if (plan.mode === 'SET') return plan.field + ' set to ' + plan.entered;
  return plan.field + ' ' + (plan.entered >= 0 ? '+' : '') + plan.entered + '%';
}

/************************************************************
 * testBulkRateChange — run from the editor. Previews only, so it
 * writes nothing; proves the planner agrees with the sheet.
 ************************************************************/
function testBulkRateChange() {
  const perms = getUserPermissions();
  if (perms.rank < ROLE_RANK.Editor) throw new Error('Editor access needed to test this.');
  const opts = bulkRateOptions();
  const cfg = getConfig_();
  const req = {
    dimensions: {}, field: 'CPU', mode: 'PCT', value: 10,
    fromDate: dayStr(normDate(cfg.HORIZON_START)),
    toDate: dayStr(normDate(cfg.HORIZON_END)),
    preview: true
  };
  const all = bulkUpdateRates(req);
  Logger.log('Every rate, +10%: ' + all.count + ' matched, ' + all.skippedNoRate +
             ' with no rate to supersede, ' + all.skippedBlocked + ' blocked, ' +
             all.skippedNoScope + ' out of scope');
  Logger.log('  distinct moves: ' + all.distinct.length);
  all.sample.slice(0, 5).forEach(s => Logger.log('  ' + s.label + ' ' + s.ccFlag + '/' +
    s.customerType + ': ' + s.was + ' → ' + s.now));

  if (opts.highLevelComponent.length) {
    const one = opts.highLevelComponent[0];
    const scoped = bulkUpdateRates({
      dimensions: { highLevelComponent: [one] }, field: 'CPU', mode: 'SET', value: 0.5,
      fromDate: req.fromDate, toDate: req.toDate, preview: true
    });
    Logger.log('"' + one + '" set to 0.5: ' + scoped.count + ' matched across ' +
               scoped.linesMatched + ' lines, flattening ' + scoped.distinct.length +
               ' distinct value(s)');
    if (scoped.count > all.count) throw new Error('A narrower selection matched more rows.');
  }
  Logger.log('testBulkRateChange complete — nothing was written.');
  return all;
}
