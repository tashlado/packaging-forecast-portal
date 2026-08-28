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

  ruleMixSum_(input, findings);
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
function vHlLabel_(h) {
  if (!h) return '?';
  return [h.Brand, h.Geo, h.Treatment_Type, h.WL_Detail].filter(x => x && x !== '*').join(' ');
}

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

      /* Nothing anywhere in the horizon. Not a gap — the line contributes nothing
         at all — but an active line with no assumptions is worth saying out loud.
         Overlaps computeCompleteness_ on the dashboard, deliberately: this one is
         horizon-aware, that one is not. */
      if (first < 0) {
        out.push({
          rule: 'RANGE_GAP', severity: SEVERITY.WARN,
          hlId: line.hlId, modellingId: line.mid, month: input.months[0].date,
          message: 'Line ' + line.mid + ' (' + line.label + ') has no active ' + k.what +
                   ' anywhere in the horizon, so it contributes nothing to the forecast.'
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
