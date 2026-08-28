/************************************************************
 * validate.gs — the rule pack
 *
 * Runs on demand from the Validation tab, and again inside
 * recalculate() on the numbers it has just computed, before any
 * of them are written.
 *
 *   ERROR  the forecast would be wrong — blocks the recalculation
 *   WARN   worth a look; the maths still works
 *   INFO   noted, no action needed
 *
 * The rules deliberately re-derive their invariants from the whole
 * table rather than trusting the write-time checks in rates.js and
 * mixes.js. Those run on one payload at a time and only on the path
 * that goes through them — a bulk change, a hand edit in the Google
 * Sheet, or an import can all leave the data in a state no single
 * save would have accepted. This is what notices.
 *
 * Everything here is read-only apart from Validation_Results and the
 * LAST_VALIDATION config key.
 *
 * Config keys read:
 *   VALIDATION_SWING_PCT      OUTPUT_SWING threshold, percent month
 *                             on month. Default 20.
 *   VALIDATION_BLOCKS_RECALC  anything other than the literal FALSE
 *                             means an ERROR stops recalculate()
 *                             writing. Absent counts as blocking —
 *                             the gate has to be turned off on
 *                             purpose, never by omission.
 ************************************************************/

const SEVERITY = { ERROR: 'ERROR', WARN: 'WARN', INFO: 'INFO' };

const VALIDATION_SWING_PCT_DEFAULT = 20;
/* A rule that fires on every line of a broken table would bury the other rules
   under itself. Past this, the rest are counted and reported as one INFO. */
const VALIDATION_MAX_PER_RULE = 500;

/**
 * Re-run every rule and write Validation_Results.
 *
 * Editor rather than Viewer: it is read-only over the forecast data, but it
 * rewrites the Validation_Results tab, and a tab anyone can rewrite is a tab
 * nobody can trust the timestamp on.
 */
function runValidation() {
  prewarmSheetCache_([SHEET.PERMISSIONS, SHEET.AREAS, SHEET.HL, SHEET.COMPONENTS, SHEET.LINES,
                      SHEET.RATES, SHEET.COMP_MIX, SHEET.CC_MIX, SHEET.OUTPUT, SHEET.CONFIG]);
  const perms = requireEditor();
  return withLock(() => {
    const report = runValidationCore_(null);
    logAction_(perms, 'RUN_VALIDATION', SHEET.VALIDATION, '',
      report.status + ' — ' + report.counts.ERROR + ' error(s), ' + report.counts.WARN +
      ' warning(s), ' + report.counts.INFO + ' note(s) in ' + report.ms + 'ms');
    return report;
  });
}

/**
 * The rules themselves. Assumes the caller holds the script lock.
 *
 * computedOutputRows, when given, is the freshly computed Output — rows in
 * HEADERS['Output'] order, exactly as computeAll_ returns them. OUTPUT_SWING is
 * then checked against the numbers about to be written rather than against the
 * stale ones still on the tab, which is the whole point of validating inside
 * recalculate(). Pass null to read the Output tab as it stands.
 */
function runValidationCore_(computedOutputRows) {
  const t0 = Date.now();
  const input = validationInput_();
  const findings = [];

  /* Structure first, then assumptions, then the shape of the answer. A table
     with a dangling foreign key or a duplicate line makes every rule after it
     report nonsense, so those findings want to be the ones read first. */
  ruleOrphanFk_(input, findings);
  ruleDupModelling_(input, findings);
  ruleRateNeg_(input, findings);
  ruleRangeOverlap_(input, findings);
  ruleCompleteness_(input, findings);
  ruleMixSum_(input, findings);
  ruleMixOverlap_(input, findings);
  ruleRateMissing_(input, findings);
  ruleRangeGap_(input, findings);
  ruleOutputSwing_(input, computedOutputRows, findings);

  const kept = capFindings_(findings);
  const ranAt = new Date();
  writeValidationResults_(kept, ranAt);
  const report = summariseFindings_(kept, ranAt, Date.now() - t0);
  setConfig_('LAST_VALIDATION', report.ranAt + ' — ' + report.counts.ERROR + ' error(s), ' +
             report.counts.WARN + ' warning(s)');
  return report;
}

/**
 * The gate recalculate() runs itself through.
 *
 * Reads VALIDATION_BLOCKS_RECALC before the run, because runValidationCore_
 * writes LAST_VALIDATION and appending a new config key drops the Config cache.
 */
function validateForRecalc_(computed) {
  const blocks = safeStr(getConfig_().VALIDATION_BLOCKS_RECALC).toUpperCase() !== 'FALSE';
  const report = runValidationCore_(computed.outputRows);
  report.blocksRecalc = blocks;
  report.blocked = !!(report.counts.ERROR && blocks);
  return report;
}

/* ---------------- input ---------------- */

/* [_f, _t) in UTC-day milliseconds, the same convention as the engine — local
   midnight arithmetic gives the wrong day counts across the DST transitions. */
function vDated_(rows) {
  return rows.map(r => {
    const f = normDate(r.From_Date), t = normDate(r.To_Date);
    if (!f || !t) return null;
    return Object.assign({}, r, { _f: utcDay_(f), _t: utcDay_(t) + DAY_MS });
  }).filter(Boolean);
}

function vP2_(n) { return ('0' + n).slice(-2); }
function vDayStr_(ms) {
  const d = new Date(ms);
  return d.getUTCFullYear() + '-' + vP2_(d.getUTCMonth() + 1) + '-' + vP2_(d.getUTCDate());
}
function vMonthLabel_(ms) { return vDayStr_(ms).slice(0, 7); }
/* The local first-of-month Date the results tab stores, from UTC-day ms. */
function vMonthOf_(ms) {
  const d = new Date(ms);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
/* hlLabel_ with a '?' for a High Level ID that is not there at all, which in a
   validation message is itself the finding. */
function vHlLabel_(h) { return h ? hlLabel_(h) : '?'; }

function validationInput_() {
  const cfg = getConfig_();
  const hStart = normDate(cfg.HORIZON_START), hEnd = normDate(cfg.HORIZON_END);
  if (!hStart || !hEnd) {
    throw new Error('Config HORIZON_START / HORIZON_END missing — validation needs the horizon to know which months to check.');
  }

  const months = [];
  let m = new Date(hStart.getFullYear(), hStart.getMonth(), 1);
  while (m.getTime() <= hEnd.getTime()) {
    months.push({
      date: new Date(m),
      label: m.getFullYear() + '-' + vP2_(m.getMonth() + 1),
      ms: Date.UTC(m.getFullYear(), m.getMonth(), 1),
      me: Date.UTC(m.getFullYear(), m.getMonth() + 1, 1)
    });
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }

  const hlById = {};
  tableToObjects_(SHEET.HL).filter(h => isActive(h.Active)).forEach(h => hlById[h.High_Level_ID] = h);
  const compById = {};
  tableToObjects_(SHEET.COMPONENTS).forEach(c => compById[c.Component_ID] = c);

  /* Built exactly as computeAll_ builds it, including the fallback, so a line's
     customer types here are the ones it is actually costed against. */
  const areaTypes = {};
  tableToObjects_(SHEET.AREAS).filter(a => isActive(a.Active)).forEach(a => {
    areaTypes[a.Area_ID] = safeStr(a.Customer_Types).split(',').map(x => x.trim()).filter(Boolean);
  });

  /* Same population the engine costs: active lines whose High Level ID is active.
     A line hanging off a deactivated parent is not in the forecast, so a gap in
     its assumptions is not a defect. */
  const lines = tableToObjects_(SHEET.LINES)
    .filter(l => isActive(l.Active) && hlById[l.High_Level_ID])
    .map(l => {
      const c = compById[l.Component_ID];
      const hl = hlById[l.High_Level_ID];
      const types = areaTypes[hl.Area_ID];
      return {
        mid: l.Modelling_ID,
        hlId: l.High_Level_ID,
        types: (types && types.length) ? types : ['New', 'Repeat', 'OTC'],
        hlComponent: safeStr(c && c.High_Level_Component),
        label: vHlLabel_(hlById[l.High_Level_ID]) + ' — ' +
               (c ? safeStr(c.Component) : 'component ' + l.Component_ID)
      };
    });

  const ratesByMid = {}, mixByMid = {};
  vDated_(tableToObjects_(SHEET.RATES).filter(r => isActive(r.Active)))
    .forEach(r => (ratesByMid[r.Modelling_ID] = ratesByMid[r.Modelling_ID] || []).push(r));
  vDated_(tableToObjects_(SHEET.COMP_MIX).filter(r => isActive(r.Active)))
    .forEach(r => (mixByMid[r.Modelling_ID] = mixByMid[r.Modelling_ID] || []).push(r));

  /* The tables as they actually are, unfiltered.

     Everything above is the population the ENGINE costs — active lines under
     active parents, rows whose dates parse. That is the right lens for asking
     whether the forecast is wrong, and the wrong one for asking whether the
     data is intact: a line pointing at a High Level ID that does not exist is
     precisely the row the filter above throws away, so a rule reading only
     input.lines can never see it. ORPHAN_FK, DUP_MODELLING, RATE_NEG and
     RANGE_OVERLAP read these instead. */
  const raw = {
    areas:  tableToObjects_(SHEET.AREAS),
    hl:     tableToObjects_(SHEET.HL),
    comps:  tableToObjects_(SHEET.COMPONENTS),
    lines:  tableToObjects_(SHEET.LINES),
    rates:  tableToObjects_(SHEET.RATES),
    mixes:  tableToObjects_(SHEET.COMP_MIX),
    ccMix:  tableToObjects_(SHEET.CC_MIX)
  };

  /* Customer types per modelling line, over the RAW tables, because
     RANGE_OVERLAP has to expand an 'All' row on a line whose parent may be
     inactive. Same fallback the engine and rates.js use. */
  const rawAreaTypes = {};
  raw.areas.forEach(a => {
    const t = safeStr(a.Customer_Types).split(',').map(x => x.trim()).filter(Boolean);
    rawAreaTypes[a.Area_ID] = t.length ? t : ['New', 'Repeat', 'OTC'];
  });
  const rawHlById = {};
  raw.hl.forEach(h => rawHlById[h.High_Level_ID] = h);
  const typesByMid = {}, hlByMid = {};
  raw.lines.forEach(l => {
    const h = rawHlById[l.High_Level_ID];
    hlByMid[l.Modelling_ID] = l.High_Level_ID;
    typesByMid[l.Modelling_ID] = (h && rawAreaTypes[h.Area_ID]) || ['New', 'Repeat', 'OTC'];
  });

  /* A month with a rate or component-mix boundary inside it is a TRANSITION
     month. The engine day-weights it — a line starting on the 20th bills 12/31 of
     January — so its total is a fraction of a monthly run rate rather than a run
     rate, and comparing one against a full month measures the calendar rather
     than the assumptions. Keyed High_Level_ID|monthStart, because Output is
     aggregated to the High Level ID and any one of its lines moving mid-month is
     enough to make that month partial. */
  const partialMonths = {};
  lines.forEach(line => {
    (ratesByMid[line.mid] || []).concat(mixByMid[line.mid] || []).forEach(r => {
      months.forEach(mo => {
        if ((r._f > mo.ms && r._f < mo.me) || (r._t > mo.ms && r._t < mo.me)) {
          partialMonths[String(line.hlId) + '|' + mo.ms] = true;
        }
      });
    });
  });

  const swingRaw = Number(cfg.VALIDATION_SWING_PCT);
  return {
    partialMonths: partialMonths,
    raw: raw, rawHlById: rawHlById, typesByMid: typesByMid, hlByMid: hlByMid,
    months: months, lines: lines, hlById: hlById, compById: compById,
    ratesByMid: ratesByMid, mixByMid: mixByMid,
    /* The forecast window as [hStartMs, hEndMs) in UTC-day ms. Rules that walk
       raw row dates rather than input.months clip to it — nothing outside the
       horizon reaches Output, so nothing outside it can make Output wrong. */
    hStartMs: utcDay_(hStart), hEndMs: utcDay_(hEnd) + DAY_MS,
    swingPct: (isNaN(swingRaw) || swingRaw <= 0) ? VALIDATION_SWING_PCT_DEFAULT : swingRaw
  };
}

/* ---------------- rules ---------------- */

/**
 * ORPHAN_FK — an active row pointing at a dimension that is gone or switched off.
 *
 * Every table here refers to another by id, and nothing in the Sheet enforces
 * that the other end exists. Two ways it breaks, both ERROR, both silent:
 *
 *   MISSING — the id is not in the parent table at all. A typed id, a row
 *     deleted by hand rather than deactivated, a half-finished import.
 *
 *   INACTIVE — the parent is there but switched off. This is the one people do
 *     not expect, because it looks deliberate. computeAll_ builds hlById from
 *     ACTIVE High Level IDs only and then filters lines to `hlById[...]`, so
 *     deactivating a High Level ID silently drops every line under it — and
 *     those lines still say Active = Y, still show in the portal, and still
 *     look costed. The rates hanging off them are the same story one level
 *     down.
 *
 * The fix is always the same shape and the message says it: switch the children
 * off too, or switch the parent back on.
 *
 * Reported at the BOUNDARY of a switched-off region, once, and not all the way
 * down it. Deactivating a High Level ID is a normal thing to do and the portal's
 * soft delete has never cascaded, so a segment that is properly off still has
 * its lines, their rates, their mixes and its cold chain rows sitting there. If
 * every one of those counted, retiring one High Level ID would raise a dozen
 * errors and block the next recalculation until somebody had ticked through all
 * of them — which is how a rule pack teaches people to set
 * VALIDATION_BLOCKS_RECALC to FALSE.
 *
 * So a row is reported when its own parent is off and that parent's ancestors
 * are fine — the parent was retired on its own and this row is a straggler — and
 * passed over when the break is further up, because the row above it already
 * carries the finding. A parent that is MISSING rather than inactive is always
 * reported: a dangling id is never somebody's deliberate act.
 *
 * Not checked here: Rate_Card.Customer_Type against its area's list. That is a
 * value rather than an id, 'All' is legal for every area, and RATE_MISSING
 * already reports the consequence — a customer type nothing prices.
 */
function ruleOrphanFk_(input, out) {
  const raw = input.raw;
  const by = (rows, key) => {
    const m = {};
    rows.forEach(r => { const k = safeStr(r[key]); if (k !== '') m[k] = r; });
    return m;
  };
  const areas = by(raw.areas, 'Area_ID');
  const hls   = by(raw.hl, 'High_Level_ID');
  const comps = by(raw.comps, 'Component_ID');
  const lines = by(raw.lines, 'Modelling_ID');

  /* Is something ABOVE this row already switched off? Not the row itself — that
     is what the check below tests — but its parents. True means the row sits
     inside a region somebody turned off on purpose, and its own children are
     therefore not stragglers worth reporting. */
  const areaOff = id => { const a = areas[safeStr(id)]; return !a || !isActive(a.Active); };
  const ancestorOff = {};
  ancestorOff.hl = h => !!h && areaOff(h.Area_ID);
  ancestorOff.comp = c => !!c && areaOff(c.Area_ID);
  ancestorOff.line = l => {
    if (!l) return false;
    const h = hls[safeStr(l.High_Level_ID)], c = comps[safeStr(l.Component_ID)];
    if (h && (!isActive(h.Active) || ancestorOff.hl(h))) return true;
    return !!(c && (!isActive(c.Active) || ancestorOff.comp(c)));
  };
  const parentInsideOffRegion = (parent, parentKind) =>
    parentKind === 'hl'   ? ancestorOff.hl(parent) :
    parentKind === 'comp' ? ancestorOff.comp(parent) :
    parentKind === 'line' ? ancestorOff.line(parent) : false;

  /* child rows, the column holding the foreign key, the parent index, and how to
     name both ends in the message. */
  const checks = [
    { rows: raw.lines,  fk: 'High_Level_ID', parents: hls,   childWhat: 'Modelling line',
      idKey: 'Modelling_ID', parentWhat: 'High Level ID', parentKind: 'hl' },
    { rows: raw.lines,  fk: 'Component_ID',  parents: comps, childWhat: 'Modelling line',
      idKey: 'Modelling_ID', parentWhat: 'component', parentKind: 'comp' },
    { rows: raw.hl,     fk: 'Area_ID',       parents: areas, childWhat: 'High Level ID',
      idKey: 'High_Level_ID', parentWhat: 'modelling area', parentKind: 'area' },
    { rows: raw.comps,  fk: 'Area_ID',       parents: areas, childWhat: 'Component',
      idKey: 'Component_ID', parentWhat: 'modelling area', parentKind: 'area' },
    { rows: raw.rates,  fk: 'Modelling_ID',  parents: lines, childWhat: 'Rate card row',
      idKey: 'Rate_ID', parentWhat: 'modelling line', parentKind: 'line' },
    { rows: raw.mixes,  fk: 'Modelling_ID',  parents: lines, childWhat: 'Component mix row',
      idKey: 'Mix_ID', parentWhat: 'modelling line', parentKind: 'line' },
    { rows: raw.ccMix,  fk: 'High_Level_ID', parents: hls,   childWhat: 'Cold chain mix row',
      idKey: 'CC_Mix_ID', parentWhat: 'High Level ID', parentKind: 'hl' }
  ];

  checks.forEach(chk => {
    chk.rows.forEach(r => {
      if (!isActive(r.Active)) return;                 // a switched-off child is nobody's problem
      const fkVal = safeStr(r[chk.fk]);
      const parent = fkVal === '' ? null : chk.parents[fkVal];
      if (parent && isActive(parent.Active)) return;
      /* The parent is off, but so is something above it — the break is reported
         higher up the chain and repeating it here adds rows, not information. */
      if (parent && parentInsideOffRegion(parent, chk.parentKind)) return;

      const childId = safeStr(r[chk.idKey]);
      const hlId = chk.fk === 'High_Level_ID' ? fkVal
                 : (r.High_Level_ID !== undefined ? safeStr(r.High_Level_ID)
                 : (input.hlByMid[r.Modelling_ID] !== undefined ? input.hlByMid[r.Modelling_ID] : ''));
      const mid = r.Modelling_ID !== undefined ? safeStr(r.Modelling_ID)
                : (chk.idKey === 'Modelling_ID' ? childId : '');

      out.push({
        rule: 'ORPHAN_FK', severity: SEVERITY.ERROR,
        hlId: hlId, modellingId: mid, month: '',
        message: chk.childWhat + ' #' + childId + ' is active but its ' + chk.parentWhat + ' ' +
          (fkVal === ''
            ? 'is blank, so nothing links it to the rest of the model.'
            : (!parent
                ? '#' + fkVal + ' does not exist, so every reference to it goes nowhere.'
                : '#' + fkVal + ' is switched off. The engine only costs rows whose parents ' +
                  'are active, so this one contributes nothing while still reading as live.')) +
          ' Switch it off too, or switch ' +
          (fkVal === '' ? 'a ' + chk.parentWhat + ' in' : 'the ' + chk.parentWhat + ' back on') + '.'
      });
    });
  });
}

/**
 * DUP_MODELLING — two active lines for the same High Level ID and component.
 *
 * saveLine refuses this, so a duplicate arrived some other way. It matters
 * because computeAll_ walks lines and ADDS each one's contribution: two lines
 * for the same carton both carry a mix and both get costed, so the component is
 * counted twice. MIX_SUM does not catch it — each line's mix is read
 * separately, and two rows at 0.7 and 0.3 under one High Level Component still
 * total 100% while pricing 200% of the orders.
 */
function ruleDupModelling_(input, out) {
  const groups = {};
  input.raw.lines.forEach(l => {
    if (!isActive(l.Active)) return;
    const hl = safeStr(l.High_Level_ID), cp = safeStr(l.Component_ID);
    if (hl === '' || cp === '') return;                // ORPHAN_FK's business
    (groups[hl + '||' + cp] = groups[hl + '||' + cp] || []).push(l);
  });
  Object.keys(groups).sort().forEach(k => {
    const g = groups[k];
    if (g.length < 2) return;
    const parts = k.split('||');
    const comp = input.compById[parts[1]];
    out.push({
      rule: 'DUP_MODELLING', severity: SEVERITY.ERROR,
      hlId: parts[0], modellingId: g[0].Modelling_ID, month: '',
      message: vHlLabel_(input.rawHlById[parts[0]]) + ' has ' + g.length + ' active lines for ' +
        (comp ? safeStr(comp.Component) : 'component ' + parts[1]) + ' — lines ' +
        g.map(l => l.Modelling_ID).join(', ') + '. The engine costs each line separately and ' +
        'adds them, so this component is being counted ' + g.length + ' times over. ' +
        'Deactivate all but one and move its assumptions across.'
    });
  });
}

/**
 * RATE_NEG — a CPU or QTY that is negative, or that is not a number at all.
 *
 * saveRate checks isNaN and stops there, so a negative price passes it. Nothing
 * downstream objects either: cost = CPU x QTY x mix x days, and a negative CPU
 * simply produces a negative cost that nets off against the rest of the High
 * Level ID in Output, where it is invisible.
 *
 * Non-numeric is the same failure with a different cause. safeNum turns
 * anything unreadable into 0, so a cell holding "0.40 " with a stray character,
 * or a formula that errored, prices the component at nothing rather than
 * refusing to price it — and RATE_MISSING will not see it, because a row IS in
 * force.
 */
function ruleRateNeg_(input, out) {
  input.raw.rates.forEach(r => {
    if (!isActive(r.Active)) return;
    const bad = [];
    [['CPU', r.CPU], ['QTY', r.QTY]].forEach(pair => {
      const name = pair[0], v = pair[1];
      if (v === '' || v === null || v === undefined) { bad.push(name + ' is blank'); return; }
      const n = Number(v);
      if (isNaN(n)) { bad.push(name + ' reads "' + safeStr(v) + '", which is not a number'); return; }
      if (n < 0) bad.push(name + ' is ' + n);
    });
    if (!bad.length) return;
    const mid = safeStr(r.Modelling_ID);
    out.push({
      rule: 'RATE_NEG', severity: SEVERITY.ERROR,
      hlId: input.hlByMid[mid] === undefined ? '' : input.hlByMid[mid], modellingId: mid, month: '',
      message: 'Rate #' + safeStr(r.Rate_ID) + ' on line ' + mid + ' (' + safeStr(r.CC_Flag) + '/' +
        safeStr(r.Customer_Type) + ', ' + safeStr(r.From_Date) + ' to ' + safeStr(r.To_Date) +
        '): ' + bad.join('; ') + '. A negative value nets off against the rest of the High Level ' +
        'ID in Output and a blank or unreadable one is costed as zero, so neither shows up as ' +
        'a missing rate.'
    });
  });
}

/**
 * RANGE_OVERLAP — two active rows of one thing covering the same day.
 *
 * saveRate enforces this per payload (spec 6.1) and saveCCMix does the same for
 * cold chain, but only on the row in front of them. A bulk change, an import or
 * a hand edit can leave a pair no single save would have accepted, and the
 * engine does not resolve an overlap in anybody's favour: it adds every rate row
 * in force, and takes the FIRST cold chain row it finds, which is whichever the
 * sheet happens to list first.
 *
 * Rates are compared slot by slot, reusing rates.js's own expansion — a 'Both'
 * row occupies the CC and the Ambient slot, an 'All' row every customer type of
 * its area. Exact-key matching would miss that a Both/All row and a CC/New row
 * are the same slot, which is the overlap most likely to be made.
 *
 * Component mix has its own rule (MIX_OVERLAP) because the consequence there is
 * different enough to need its own explanation.
 *
 * Clipped to the horizon, like MIX_SUM: an overlap between two rows that both
 * expired in 2024 cannot make a 2026 number wrong, and left in it errors on
 * every run forever.
 *
 * One finding per line and per High Level ID. A line with a run of overlaps has
 * one thing wrong with it, and listing every pair buries the other lines.
 */
function ruleRangeOverlap_(input, out) {
  const inHorizon = r => r._f < input.hEndMs && r._t > input.hStartMs;

  /* ---- rate card, per line, per expanded slot ---- */
  const ratesByMid = {};
  vDated_(input.raw.rates.filter(r => isActive(r.Active)))
    .filter(inHorizon)
    .forEach(r => (ratesByMid[r.Modelling_ID] = ratesByMid[r.Modelling_ID] || []).push(r));

  Object.keys(ratesByMid).sort((a, b) => safeNum(a) - safeNum(b)).forEach(mid => {
    const types = input.typesByMid[mid] || ['New', 'Repeat', 'OTC'];
    const slots = {};
    ratesByMid[mid].forEach(r => {
      expandCC_(safeStr(r.CC_Flag)).forEach(cc => {
        expandCT_(safeStr(r.Customer_Type), types).forEach(ct => {
          (slots[cc + '|' + ct] = slots[cc + '|' + ct] || []).push(r);
        });
      });
    });
    let found = null;
    Object.keys(slots).sort().forEach(slot => {
      if (found) return;
      const rs = slots[slot].slice().sort((a, b) => a._f - b._f || a._t - b._t);
      for (let i = 1; i < rs.length; i++) {
        if (rs[i]._f >= rs[i - 1]._t) continue;
        found = { slot: slot, a: rs[i - 1], b: rs[i] };
        return;
      }
    });
    if (!found) return;
    const hlId = input.hlByMid[mid] === undefined ? '' : input.hlByMid[mid];
    const span = r => safeStr(r.CC_Flag) + '/' + safeStr(r.Customer_Type) + ', ' +
                      vDayStr_(r._f) + ' to ' + vDayStr_(r._t - DAY_MS);
    out.push({
      rule: 'RANGE_OVERLAP', severity: SEVERITY.ERROR,
      hlId: hlId, modellingId: mid,
      month: vMonthOf_(Math.max(found.b._f, input.hStartMs)),
      message: 'Line ' + mid + ' (' + vHlLabel_(input.rawHlById[hlId]) + '): rates #' +
        found.a.Rate_ID + ' (' + span(found.a) + ') and #' + found.b.Rate_ID + ' (' +
        span(found.b) + ') both cover ' + found.slot.replace('|', ' / ') + ' from ' +
        vDayStr_(found.b._f) + '. The engine adds every rate in force rather than picking one, ' +
        'so those days are costed at both. Close #' + found.a.Rate_ID + ' the day before #' +
        found.b.Rate_ID + ' starts.'
    });
  });

  /* ---- cold chain mix, per High Level ID ---- */
  const ccByHl = {};
  vDated_(input.raw.ccMix.filter(r => isActive(r.Active)))
    .filter(inHorizon)
    .forEach(r => (ccByHl[r.High_Level_ID] = ccByHl[r.High_Level_ID] || []).push(r));

  Object.keys(ccByHl).sort((a, b) => safeNum(a) - safeNum(b)).forEach(hlId => {
    const rs = ccByHl[hlId].slice().sort((a, b) => a._f - b._f || a._t - b._t);
    for (let i = 1; i < rs.length; i++) {
      const a = rs[i - 1], b = rs[i];
      if (b._f >= a._t) continue;
      out.push({
        rule: 'RANGE_OVERLAP', severity: SEVERITY.ERROR,
        hlId: hlId, modellingId: '', month: vMonthOf_(Math.max(b._f, input.hStartMs)),
        message: vHlLabel_(input.rawHlById[hlId]) + ': cold chain rows #' + a.CC_Mix_ID + ' (' +
          vDayStr_(a._f) + ' to ' + vDayStr_(a._t - DAY_MS) + ' at ' + safeNum(a.CC_Mix) +
          ') and #' + b.CC_Mix_ID + ' (' + vDayStr_(b._f) + ' to ' + vDayStr_(b._t - DAY_MS) +
          ' at ' + safeNum(b.CC_Mix) + ') both cover ' + vDayStr_(b._f) + '. The engine takes ' +
          'the first row it finds rather than the later one, so which share applies depends on ' +
          'the order of the tab. Close #' + a.CC_Mix_ID + ' the day before #' + b.CC_Mix_ID +
          ' starts.'
      });
      return;
    }
  });
}

/**
 * NO_RATE / NO_COMP_MIX / NO_CC_MIX — an active line with nothing to cost it.
 *
 * This is the Dashboard's old completeness check, folded into the rule pack so
 * there is one severity-ranked report rather than two mechanisms answering
 * overlapping questions in different words. The severities are the point of
 * folding it in, because the three gaps are not equally bad:
 *
 *   NO_RATE      ERROR  cost = rate x mix x days. No rate at all means the line
 *                       is costed at zero, and in Output that is indistinguishable
 *                       from a component switched off on purpose.
 *   NO_COMP_MIX  WARN   also costs zero, but "no mix" is a legitimate way to say
 *                       the component is not shipping yet. Worth a look, not a
 *                       reason to stop a recalculation.
 *   NO_CC_MIX    INFO   a missing cold chain share is read as 0%, which is a
 *                       correct answer for everything that ships ambient. Only
 *                       a High Level ID with a CC or Ambient rate is affected at
 *                       all, and that is a question rather than a defect.
 *
 * Deliberately NOT horizon-clipped, unlike RANGE_GAP. "This line has never had a
 * rate" is worth saying whatever the horizon is set to, and it is the check
 * somebody wants the moment they add a line. RANGE_GAP answers the narrower and
 * horizon-shaped question of a hole between two covered months.
 *
 * The rows-exist-but-no-readable-dates case gets its own sentence. The engine
 * drops a row whose From/To will not parse, so the line really is uncosted —
 * but telling somebody they have no rate card row when they can see one on the
 * tab sends them looking in the wrong place.
 */
function ruleCompleteness_(input, out) {
  const countActive = (rows, key, val) =>
    rows.filter(r => isActive(r.Active) && String(r[key]) === String(val)).length;

  input.lines.forEach(line => {
    const rateRows = countActive(input.raw.rates, 'Modelling_ID', line.mid);
    const dated = (input.ratesByMid[line.mid] || []).length;
    if (!dated) {
      out.push({
        rule: 'NO_RATE', severity: SEVERITY.ERROR,
        hlId: line.hlId, modellingId: line.mid, month: '',
        message: 'Line ' + line.mid + ' (' + line.label + ') has ' +
          (rateRows
            ? rateRows + ' active rate card row(s), none with a From and To date the portal can ' +
              'read. The engine skips a row it cannot date, so this line is costed at zero.'
            : 'no active rate card row at all, so it is costed at zero — which in Output looks ' +
              'exactly like a component switched off on purpose.')
      });
    }

    const mixRows = countActive(input.raw.mixes, 'Modelling_ID', line.mid);
    const datedMix = (input.mixByMid[line.mid] || []).length;
    if (!datedMix) {
      out.push({
        rule: 'NO_COMP_MIX', severity: SEVERITY.WARN,
        hlId: line.hlId, modellingId: line.mid, month: '',
        message: 'Line ' + line.mid + ' (' + line.label + ') has ' +
          (mixRows
            ? mixRows + ' active component mix row(s), none with a readable From and To date, ' +
              'so none of them is applied.'
            : 'no active component mix row, so nothing of it ships and it costs nothing. ' +
              'That is correct if the component is not in use yet.')
      });
    }
  });

  /* Per High Level ID rather than per line: cold chain is a property of the High
     Level ID, and reporting it once per line under it says the same thing five
     times. Only High Level IDs that actually have a live line are worth asking
     about. */
  const hlWithLines = {};
  input.lines.forEach(l => hlWithLines[l.hlId] = true);
  Object.keys(hlWithLines).sort((a, b) => safeNum(a) - safeNum(b)).forEach(hlId => {
    if (countActive(input.raw.ccMix, 'High_Level_ID', hlId)) return;
    out.push({
      rule: 'NO_CC_MIX', severity: SEVERITY.INFO,
      hlId: hlId, modellingId: '', month: '',
      message: vHlLabel_(input.hlById[hlId]) + ' has no active cold chain mix row, so it is ' +
        'treated as 0% cold chain. Correct if everything under it ships ambient; if not, any ' +
        'rate flagged CC is being weighted to nothing.'
    });
  });
}

/**
 * MIX_SUM — a split that does not total 100%.
 *
 * The same invariant saveComponentMixGroup enforces, re-derived over every
 * Component_Mix row in the table: per group (one High Level ID × one High Level
 * Component) and per date segment, two or more components carrying a non-zero
 * mix must total 100% ± MIX_TOL. One non-zero line is an attach rate and may be
 * anything from 0 to 1; all zero means the component is switched off.
 *
 * saveComponentMixGroup only ever sees one group's payload. This sees the table,
 * so a row edited in the Sheet by hand, or a line moved between groups, is
 * caught even though no save ever refused it.
 */
function ruleMixSum_(input, out) {
  const groups = {};
  input.lines.forEach(line => {
    if (!line.hlComponent) return;
    const key = line.hlId + '||' + line.hlComponent;
    if (!groups[key]) groups[key] = { hlId: line.hlId, hlComponent: line.hlComponent, rows: [] };
    (input.mixByMid[line.mid] || []).forEach(r => groups[key].rows.push(r));
  });

  Object.keys(groups).sort().forEach(key => {
    const g = groups[key];
    if (!g.rows.length) return;
    const bset = {};
    g.rows.forEach(r => { bset[r._f] = 1; bset[r._t] = 1; });
    const bounds = Object.keys(bset).map(Number).sort((a, b) => a - b);
    for (let i = 0; i < bounds.length - 1; i++) {
      const s = bounds[i];
      /* Segments wholly outside the horizon are history. saveComponentMixGroup
         checks them because it is validating one payload a person just typed;
         this is asking whether the FORECAST is wrong, and a split that was 90%
         in 2024 cannot make a 2026 number wrong. Left in, an archive of superseded
         rows reports as an error every run and nobody can act on it. */
      if (bounds[i + 1] <= input.hStartMs || s >= input.hEndMs) continue;
      const covering = g.rows.filter(r => r._f <= s && s < r._t);
      const nonZero = covering.filter(r => safeNum(r.Mix) > 0);
      if (nonZero.length < 2) continue;
      const sum = covering.reduce((t, r) => t + safeNum(r.Mix), 0);
      if (Math.abs(sum - 1) <= MIX_TOL) continue;
      out.push({
        rule: 'MIX_SUM', severity: SEVERITY.ERROR,
        hlId: g.hlId, modellingId: '', month: vMonthOf_(s),
        message: vHlLabel_(input.hlById[g.hlId]) + ' · ' + g.hlComponent + ': ' + nonZero.length +
                 ' components split the mix between ' + vDayStr_(s) + ' and ' +
                 vDayStr_(bounds[i + 1] - DAY_MS) + ', totalling ' + (sum * 100).toFixed(2) +
                 '% instead of 100%. Mix IDs ' +
                 covering.map(r => r.Mix_ID).join(', ') + '.'
      });
    }
  });
}

/**
 * MIX_OVERLAP — two active mix rows of one line covering the same day.
 *
 * saveComponentMixGroup refuses this outright ("Line X has overlapping mix date
 * ranges"), so anything here arrived by a route that does not go through it: an
 * import, a migration, or somebody typing in the Sheet.
 *
 * It matters because the engine ADDS overlapping mix rows rather than replacing
 * them — computeAll_ does `cm += safeNum(x.Mix)` — so an overlap does not mean
 * "the later row wins", it means the component is costed at the sum of both.
 *
 * MIX_SUM catches this only when the sum lands away from 100%. The case it
 * cannot see is the one that matters most: an old row at 1.0 left open under a
 * new row at 0, which sums to 1.0 and looks perfectly valid, while what the
 * person meant was to switch the component OFF. It stays on, silently, and no
 * total anywhere looks wrong.
 */
function ruleMixOverlap_(input, out) {
  input.lines.forEach(line => {
    const rows = (input.mixByMid[line.mid] || [])
      .filter(r => r._f < input.hEndMs && r._t > input.hStartMs)
      .slice().sort((a, b) => a._f - b._f);
    /* Adjacent pairs after sorting by start, exactly as mixes.js checks them —
       the point is to re-derive the same invariant, not a stricter one. One
       finding per line: a line with a run of overlaps has one thing wrong with
       it, and listing every pair buries the other lines. */
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      if (b._f >= a._t) continue;
      const span = r => vDayStr_(r._f) + ' → ' + vDayStr_(r._t - DAY_MS) + ' at ' + safeNum(r.Mix);
      out.push({
        rule: 'MIX_OVERLAP', severity: SEVERITY.ERROR,
        hlId: line.hlId, modellingId: line.mid, month: vMonthOf_(Math.max(b._f, input.hStartMs)),
        message: 'Line ' + line.mid + ' (' + line.label + '): mix #' + a.Mix_ID + ' (' + span(a) +
                 ') and mix #' + b.Mix_ID + ' (' + span(b) + ') both cover ' + vDayStr_(b._f) +
                 ' onwards. The engine adds overlapping mix rows rather than replacing them, so ' +
                 'this line is costed at ' + (safeNum(a.Mix) + safeNum(b.Mix)) + ' from that date. ' +
                 'Close mix #' + a.Mix_ID + ' the day before mix #' + b.Mix_ID + ' starts.'
      });
      return;
    }
  });
}

/**
 * RATE_MISSING — mix above zero with nothing to price it.
 *
 * cost = rate × mix × days, so a segment where the mix says the component ships
 * but no Rate_Card row is in force costs exactly nothing and looks, in Output,
 * identical to a component that was switched off on purpose. This is the rule
 * that tells the two apart.
 *
 * Segment-based for the same reason the engine is: a rate that lapses on the
 * 14th leaves half a month uncosted, and a whole-month check would call that
 * covered.
 */
function ruleRateMissing_(input, out) {
  input.lines.forEach(line => {
    const mixes = input.mixByMid[line.mid] || [];
    if (!mixes.length) return;                  // no mix at all is RANGE_GAP's business
    const rates = input.ratesByMid[line.mid] || [];
    let days = 0, monthsHit = 0, firstMonth = null;
    const typesHit = {};

    input.months.forEach(mo => {
      const bset = {};
      bset[mo.ms] = 1; bset[mo.me] = 1;
      [rates, mixes].forEach(coll => coll.forEach(x => {
        if (x._f > mo.ms && x._f < mo.me) bset[x._f] = 1;
        if (x._t > mo.ms && x._t < mo.me) bset[x._t] = 1;
      }));
      const bounds = Object.keys(bset).map(Number).sort((a, b) => a - b);

      let hit = 0;
      for (let i = 0; i < bounds.length - 1; i++) {
        const s = bounds[i];
        let cm = 0;
        for (const x of mixes) if (x._f <= s && s < x._t) cm += safeNum(x.Mix);
        if (cm <= 0) continue;

        /* Coverage is per CUSTOMER TYPE, matched the way computeAll_ matches it:
           an 'All' row serves every type of the area, anything else only its own.
           A line priced for New but not Repeat costs Repeat nothing, and asking
           only "is there any rate at all" would call that covered.

           CC_Flag is deliberately NOT part of this. In the engine it is a weight,
           not a filter — w = cc | 1-cc | 1 — so a CC row and a Both row are both
           present. A CC-only rate under 0% cold chain does compute zero, but that
           is the cold chain mix saying nothing shipped cold, which is an answer,
           not a missing rate. */
        const inForce = rates.filter(r => r._f <= s && s < r._t);
        const uncovered = line.types.filter(t => !inForce.some(r => {
          const ct = safeStr(r.Customer_Type);
          return ct === 'All' || ct === t;
        }));
        if (!uncovered.length) continue;
        uncovered.forEach(t => typesHit[t] = true);
        hit += (bounds[i + 1] - s) / DAY_MS;
      }
      if (hit) { days += hit; monthsHit++; if (!firstMonth) firstMonth = mo; }
    });

    if (!monthsHit) return;
    const missing = Object.keys(typesHit);
    const whose = missing.length === line.types.length
      ? 'no rate card row in force'
      : 'no rate card row covering ' + missing.sort().join('/');
    out.push({
      rule: 'RATE_MISSING', severity: SEVERITY.ERROR,
      hlId: line.hlId, modellingId: line.mid, month: firstMonth.date,
      message: 'Line ' + line.mid + ' (' + line.label + ') has a component mix above zero for ' +
               days + ' day(s) across ' + monthsHit + ' month(s) with ' + whose + ', starting ' +
               firstMonth.label + '. Those days cost nothing in the forecast.'
    });
  });
}

/**
 * RANGE_GAP — a month in the horizon with no assumption covering it at all.
 *
 * A warning rather than an error, and independent of RATE_MISSING on purpose:
 * a line can be legitimately dormant for part of the horizon (a component that
 * starts shipping in April), so an uncovered month is a question, not a defect.
 * A line with neither rate nor mix will show under both rules; the ERROR is the
 * one that means the numbers are wrong.
 */
function ruleRangeGap_(input, out) {
  const kinds = [
    { rows: input.ratesByMid, what: 'rate card row' },
    { rows: input.mixByMid,   what: 'component mix row' }
  ];
  input.lines.forEach(line => {
    kinds.forEach(k => {
      const rows = k.rows[line.mid] || [];
      const covered = input.months.map(mo => rows.some(r => r._f < mo.me && r._t > mo.ms));
      const first = covered.indexOf(true), last = covered.lastIndexOf(true);

      /* A line with NO rows of this kind at all belongs to NO_RATE / NO_COMP_MIX,
         which say the same thing with the severity the gap deserves — an ERROR
         for a missing rate, a WARN for a missing mix. Reporting it here as well
         would give one line two findings for one problem. */
      if (!rows.length) return;

      /* Rows exist, but every one of them falls outside the horizon. Not a gap —
         there is nothing to have a gap between — and not the same thing as having
         none at all: the assumptions were written, for a period the forecast no
         longer covers. Usually a horizon that moved on and a rate card that did
         not follow it. */
      if (first < 0) {
        out.push({
          rule: 'RANGE_GAP', severity: SEVERITY.WARN,
          hlId: line.hlId, modellingId: line.mid, month: input.months[0].date,
          message: 'Line ' + line.mid + ' (' + line.label + ') has ' + rows.length + ' active ' +
                   k.what + '(s), but every one of them is outside the forecast horizon (' +
                   input.months[0].label + ' to ' + input.months[input.months.length - 1].label +
                   '), so the line contributes nothing.'
        });
        return;
      }

      /* Only the holes BETWEEN the first and last covered month. Months before a
         line starts or after it ends are its scope, not a defect: a component
         that begins shipping in April is supposed to have no April-preceding rate,
         and reporting that every month of every deliberately-scoped line buries
         the real holes under an unreadable pile of them.

         A hole in the middle is different — the line was priced, stopped being
         priced, and was priced again, which is either an expiry nobody renewed or
         a date typed wrong. */
      const holes = [];
      for (let i = first + 1; i < last; i++) if (!covered[i]) holes.push(input.months[i]);
      if (!holes.length) return;
      out.push({
        rule: 'RANGE_GAP', severity: SEVERITY.WARN,
        hlId: line.hlId, modellingId: line.mid, month: holes[0].date,
        message: 'Line ' + line.mid + ' (' + line.label + ') has no active ' + k.what + ' for ' +
                 holes.length + ' month(s) inside its own covered period (' +
                 input.months[first].label + ' to ' + input.months[last].label + '), starting ' +
                 holes[0].label + '.'
      });
    });
  });
}

/**
 * OUTPUT_SWING — a cost jumping month on month by more than the threshold.
 *
 * The rule that catches a fat-finger. A CPU typed as 3.20 instead of 0.32 passes
 * every structural check above — positive number, valid dates, mix totals 100% —
 * and moves the forecast tenfold. Only the shape of the answer gives it away.
 *
 * One series per High Level ID × customer type, which is how Output is keyed. A
 * month with no baseline to move from is skipped rather than reported as an
 * infinite jump: a component that starts shipping is not a defect.
 */
function ruleOutputSwing_(input, computedOutputRows, out) {
  const rows = computedOutputRows ? vSwingFromComputed_(computedOutputRows) : vSwingFromSheet_();
  const threshold = input.swingPct / 100;
  const series = {};
  rows.forEach(r => {
    const k = r.hlId + '|' + r.type;
    (series[k] = series[k] || []).push(r);
  });

  let skipped = 0;
  Object.keys(series).sort().forEach(k => {
    const s = series[k].sort((a, b) => a.ms - b.ms);
    for (let i = 1; i < s.length; i++) {
      const prev = s[i - 1].cost, cur = s[i].cost;
      /* Nothing to move from. A component that starts shipping is not a defect. */
      if (!(prev > 0)) continue;

      /* Neither month may be a transition month. Without this the rule reports
         every launch twice over: the zero-to-partial step is caught by the guard
         above, but the partial-to-first-full-month step right after it is not,
         and it is enormous — a line starting 20 Jan reads +158%, one starting
         28 Feb reads +2700%. Both are the calendar, not a price.

         A mid-month change that IS wrong still surfaces, one month later, in the
         first full-month comparison after it. Losing the transition month itself
         is the price of not drowning every real finding in launches. */
      if (input.partialMonths[s[i - 1].hlId + '|' + s[i - 1].ms] ||
          input.partialMonths[s[i].hlId + '|' + s[i].ms]) { skipped++; continue; }

      const move = (cur - prev) / prev;
      if (Math.abs(move) <= threshold) continue;
      out.push({
        rule: 'OUTPUT_SWING', severity: SEVERITY.WARN,
        hlId: s[i].hlId, modellingId: '', month: vMonthOf_(s[i].ms),
        message: vHlLabel_(input.hlById[s[i].hlId]) + ' (' + s[i].type + '): cost moves ' +
                 (move >= 0 ? '+' : '') + (move * 100).toFixed(1) + '% into ' +
                 vMonthLabel_(s[i].ms) + ' (' + prev.toFixed(4) + ' → ' + cur.toFixed(4) +
                 '), past the ' + input.swingPct + '% threshold.'
      });
    }
  });

  /* Said out loud rather than left implicit: a rule that quietly declines to look
     at part of the data reads as a clean bill of health for it. */
  if (skipped) {
    out.push({
      rule: 'SWING_SKIPPED', severity: SEVERITY.INFO, hlId: '', modellingId: '', month: '',
      message: skipped + ' month-on-month comparison(s) were not checked for a swing because ' +
               'one of the two months has a rate or mix change part-way through it, so its ' +
               'total is a part month rather than a run rate. Full months either side of it ' +
               'are still checked.'
    });
  }
}

/* Rows straight from computeAll_ — positional, so read the positions from
   HEADERS rather than counting columns by hand. */
function vSwingFromComputed_(outputRows) {
  const hdr = HEADERS[SHEET.OUTPUT];
  const iHl = hdr.indexOf('High_Level_ID'), iMonth = hdr.indexOf('Month'),
        iType = hdr.indexOf('Customer_Type'), iCost = hdr.indexOf('Cost_Local');
  return outputRows.map(r => {
    const d = normDate(r[iMonth]);
    return d ? { hlId: safeStr(r[iHl]), type: safeStr(r[iType]),
                 ms: utcDay_(d), cost: safeNum(r[iCost]) } : null;
  }).filter(Boolean);
}
function vSwingFromSheet_() {
  return tableToObjects_(SHEET.OUTPUT).map(r => {
    const d = normDate(r.Month);
    return d ? { hlId: safeStr(r.High_Level_ID), type: safeStr(r.Customer_Type),
                 ms: utcDay_(d), cost: safeNum(r.Cost_Local) } : null;
  }).filter(Boolean);
}

/* ---------------- output ---------------- */

/* A cap that hides its own truncation reads as "all clear", so what it dropped
   is reported as a finding of its own. */
function capFindings_(findings) {
  const seen = {}, dropped = {}, kept = [];
  findings.forEach(f => {
    seen[f.rule] = (seen[f.rule] || 0) + 1;
    if (seen[f.rule] <= VALIDATION_MAX_PER_RULE) kept.push(f);
    else dropped[f.rule] = (dropped[f.rule] || 0) + 1;
  });
  Object.keys(dropped).sort().forEach(rule => {
    kept.push({
      rule: 'TRUNCATED', severity: SEVERITY.INFO, hlId: '', modellingId: '', month: '',
      message: rule + ' found ' + seen[rule] + ' problems; only the first ' +
               VALIDATION_MAX_PER_RULE + ' are listed. Fix these and re-run to see the rest.'
    });
  });
  return kept;
}

function writeValidationResults_(findings, ranAt) {
  const sh = getSheet(SHEET.VALIDATION);
  const hdr = HEADERS[SHEET.VALIDATION];
  const order = { ERROR: 0, WARN: 1, INFO: 2 };
  const sorted = findings.slice().sort((a, b) =>
    (order[a.severity] - order[b.severity]) ||
    (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) ||
    (safeNum(a.modellingId) - safeNum(b.modellingId)));

  const rows = sorted.map((f, i) => [
    i + 1, ranAt, f.rule, f.severity,
    f.hlId === undefined || f.hlId === null ? '' : f.hlId,
    f.modellingId === undefined || f.modellingId === null ? '' : f.modellingId,
    f.month || '', f.message
  ]);

  sh.clearContents();
  sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, hdr.length).setValues(rows);
  invalidateSheetCache(SHEET.VALIDATION);
  return rows.length;
}

/* The client gets the counts and enough findings to show without a reload; the
   full set is always on the tab. */
function summariseFindings_(findings, ranAt, ms) {
  const counts = { ERROR: 0, WARN: 0, INFO: 0 }, byRule = {};
  findings.forEach(f => {
    counts[f.severity] = (counts[f.severity] || 0) + 1;
    byRule[f.rule] = (byRule[f.rule] || 0) + 1;
  });
  return {
    status: counts.ERROR ? 'FAIL' : counts.WARN ? 'WARN' : 'PASS',
    counts: counts, byRule: byRule, ms: ms, total: findings.length,
    ranAt: Utilities.formatDate(ranAt, Session.getScriptTimeZone() || 'Europe/London',
                                'dd MMM yyyy HH:mm'),
    findings: findings.slice(0, 200).map(f => ({
      rule: f.rule, severity: f.severity,
      highLevelId: f.hlId === undefined || f.hlId === null ? '' : f.hlId,
      modellingId: f.modellingId === undefined || f.modellingId === null ? '' : f.modellingId,
      month: f.month ? dayStr(f.month) : '',
      message: f.message
    }))
  };
}
