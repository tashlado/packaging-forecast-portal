/************************************************************
 * engine.gs — the forecast calculation (§7 of the spec)
 *
 * Segment-based and exact under mid-period changes to rates,
 * component mix, or cold chain mix. Verified cell-for-cell
 * against the RFQ4 workbook (1,560/1,560 within 1e-4).
 *
 * cost(line, month, type) =
 *   Σ over segments S of the month (constant assumptions within S):
 *     [ Σ rate rows covering S where type matches:
 *         CPU × QTY × (cc if CC | 1−cc if Ambient | 1 if Both) ]
 *     × componentMix(S) × days(S)/daysInMonth
 ************************************************************/

const DAY_MS = 86400000;

/* All engine date maths is done in UTC-day milliseconds so results are
   identical in any script timezone (local-midnight maths breaks on the
   March/October daylight-saving transitions). */
function utcDay_(d) { return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()); }

function recalculate() {
  prewarmForWrite_([SHEET.RATES, SHEET.COMP_MIX, SHEET.CC_MIX, SHEET.FX,
                    SHEET.MODELLING, SHEET.OUTPUT, SHEET.SNAPSHOTS]);
  const perms = requireEditor();
  const t0 = Date.now();
  const result = withLock(() => {
    const computed = computeAll_();
    writeModelling_(computed);
    writeOutput_(computed);
    const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone() || 'Europe/London', 'dd MMM yyyy HH:mm');
    setConfig_('LAST_RECALC', stamp + ' by ' + perms.portalName);
    return { lines: computed.lineCount, months: computed.months.length, outputRows: computed.outputRows.length, lastRecalc: stamp + ' by ' + perms.portalName };
  });
  logAction_(perms, 'RECALCULATE', SHEET.OUTPUT, '', result.lines + ' lines × ' + result.months + ' months in ' + (Date.now() - t0) + 'ms');
  return result;
}

function computeAll_() {
  const cfg = getConfig_();
  const hStart = normDate(cfg.HORIZON_START), hEnd = normDate(cfg.HORIZON_END);
  if (!hStart || !hEnd) throw new Error('Config HORIZON_START / HORIZON_END missing.');

  const months = [];
  let m = new Date(hStart.getFullYear(), hStart.getMonth(), 1);
  while (m.getTime() <= hEnd.getTime()) {
    months.push(new Date(m));
    m = new Date(m.getFullYear(), m.getMonth() + 1, 1);
  }

  const areas = tableToObjects_(SHEET.AREAS).filter(a => isActive(a.Active));
  const areaTypes = {};
  areas.forEach(a => {
    areaTypes[a.Area_ID] = safeStr(a.Customer_Types).split(',').map(s => s.trim()).filter(Boolean);
  });

  const hlById = {};
  tableToObjects_(SHEET.HL).filter(h => isActive(h.Active)).forEach(h => hlById[h.High_Level_ID] = h);

  const dated = (rows, fromKey, toKey) => rows.map(r => {
    const f = normDate(r[fromKey]), t = normDate(r[toKey]);
    return f && t ? Object.assign({}, r, { _f: utcDay_(f), _t: utcDay_(t) + DAY_MS }) : null; // [_f, _t) in UTC
  }).filter(Boolean);

  const ratesByMid = {}, mixByMid = {}, ccByHl = {};
  dated(tableToObjects_(SHEET.RATES).filter(r => isActive(r.Active)), 'From_Date', 'To_Date')
    .forEach(r => (ratesByMid[r.Modelling_ID] = ratesByMid[r.Modelling_ID] || []).push(r));
  dated(tableToObjects_(SHEET.COMP_MIX).filter(r => isActive(r.Active)), 'From_Date', 'To_Date')
    .forEach(r => (mixByMid[r.Modelling_ID] = mixByMid[r.Modelling_ID] || []).push(r));
  dated(tableToObjects_(SHEET.CC_MIX).filter(r => isActive(r.Active)), 'From_Date', 'To_Date')
    .forEach(r => (ccByHl[r.High_Level_ID] = ccByHl[r.High_Level_ID] || []).push(r));

  const lines = tableToObjects_(SHEET.LINES).filter(l => isActive(l.Active) && hlById[l.High_Level_ID]);

  const modellingRows = [];               // per line × month
  const agg = {};                         // hl|monthMs|type → cost
  const allTypesUsed = {};

  lines.forEach(line => {
    const mid = line.Modelling_ID, hl = hlById[line.High_Level_ID];
    const types = areaTypes[hl.Area_ID] || ['New', 'Repeat', 'OTC'];
    types.forEach(t => allTypesUsed[t] = true);
    const rates = ratesByMid[mid] || [], mixes = mixByMid[mid] || [], ccs = ccByHl[hl.High_Level_ID] || [];

    months.forEach(mStart => {
      const mS = Date.UTC(mStart.getFullYear(), mStart.getMonth(), 1);
      const mE = Date.UTC(mStart.getFullYear(), mStart.getMonth() + 1, 1);   // [mS, mE) in UTC
      const dim = (mE - mS) / DAY_MS;
      const bset = { [mS]: 1, [mE]: 1 };
      [rates, mixes, ccs].forEach(coll => coll.forEach(x => {
        if (x._f > mS && x._f < mE) bset[x._f] = 1;
        if (x._t > mS && x._t < mE) bset[x._t] = 1;
      }));
      const bounds = Object.keys(bset).map(Number).sort((a, b) => a - b);

      const cost = {}; types.forEach(t => cost[t] = 0);
      let ccW = 0, cmW = 0;
      for (let i = 0; i < bounds.length - 1; i++) {
        const s = bounds[i], days = (bounds[i + 1] - s) / DAY_MS;
        let cc = 0;
        for (const x of ccs) if (x._f <= s && s < x._t) { cc = safeNum(x.CC_Mix); break; }
        let cm = 0;
        for (const x of mixes) if (x._f <= s && s < x._t) cm += safeNum(x.Mix);
        ccW += cc * days / dim; cmW += cm * days / dim;
        for (const t of types) {
          let base = 0;
          for (const r of rates) {
            if (!(r._f <= s && s < r._t)) continue;
            const ct = safeStr(r.Customer_Type);
            if (ct !== 'All' && ct !== t) continue;
            const flag = safeStr(r.CC_Flag);
            const w = flag === 'CC' ? cc : flag === 'Ambient' ? (1 - cc) : 1;
            base += safeNum(r.CPU) * safeNum(r.QTY) * w;
          }
          cost[t] += base * cm * days / dim;
        }
      }
      modellingRows.push({ mid: mid, hl: hl.High_Level_ID, month: mStart, ccW: ccW, cmW: cmW, cost: cost });
      types.forEach(t => {
        const key = hl.High_Level_ID + '|' + mS + '|' + t;
        agg[key] = (agg[key] || 0) + cost[t];
      });
    });
  });

  // FX map: 'yyyy-mm' → {CCY: rateToGBP}
  const fxMap = {};
  tableToObjects_(SHEET.FX).forEach(r => {
    const d = normDate(r.Month);
    if (!d) return;
    fxMap[monthKey(d)] = { GBP: safeNum(r.GBP) || 1, USD: safeNum(r.USD), EUR: safeNum(r.EUR), CAD: safeNum(r.CAD) };
  });

  // Snapshot comparison
  const cfgSnap = safeStr(getConfig_().COMPARE_SNAPSHOT);
  const snapMap = {};
  if (cfgSnap) {
    tableToObjects_(SHEET.SNAPSHOTS).forEach(r => {
      if (safeStr(r.Snapshot_Name) !== cfgSnap) return;
      const d = normDate(r.Month);
      if (!d) return;
      snapMap[r.High_Level_ID + '|' + utcDay_(d) + '|' + safeStr(r.Customer_Type)] = safeNum(r.Cost_Local);
    });
  }

  const outputRows = [];
  Object.keys(agg).sort().forEach(key => {
    const parts = key.split('|');
    const hlId = parts[0], mMs = Number(parts[1]), type = parts[2];
    const hl = hlById[hlId];
    if (!hl) return;
    const u = new Date(mMs);                                   // UTC first-of-month
    const month = new Date(u.getUTCFullYear(), u.getUTCMonth(), 1); // local Date for the sheet
    const ccy = safeStr(hl.Currency) || 'GBP';
    const fx = (fxMap[monthKey(month)] || {})[ccy];
    const local = agg[key];
    const snapVal = snapMap[key];
    outputRows.push([
      Number(hlId), month, type, hl.Brand, hl.Geo, hl.Treatment_Type, hl.WL_Detail, ccy,
      local, fx || '', fx ? local * fx : '',
      cfgSnap || '', snapVal !== undefined ? snapVal : '', snapVal !== undefined ? local - snapVal : ''
    ]);
  });

  return { months: months, lineCount: lines.length, modellingRows: modellingRows,
           outputRows: outputRows, types: Object.keys(allTypesUsed) };
}

function writeModelling_(computed) {
  const sh = getSheet(SHEET.MODELLING);
  const hdr = HEADERS[SHEET.MODELLING];
  const rows = computed.modellingRows.map(r => [
    r.mid, r.hl, r.month, r.ccW, r.cmW,
    r.cost['New'] || 0, r.cost['Repeat'] || 0, r.cost['OTC'] || 0
  ]);
  sh.clearContents();
  sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
  if (rows.length) sh.getRange(2, 1, rows.length, hdr.length).setValues(rows);
  invalidateSheetCache(SHEET.MODELLING);
}

function writeOutput_(computed) {
  const sh = getSheet(SHEET.OUTPUT);
  const hdr = HEADERS[SHEET.OUTPUT];
  sh.clearContents();
  sh.getRange(1, 1, 1, hdr.length).setValues([hdr]).setFontWeight('bold');
  if (computed.outputRows.length) {
    sh.getRange(2, 1, computed.outputRows.length, hdr.length).setValues(computed.outputRows);
  }
  invalidateSheetCache(SHEET.OUTPUT);
}

/************************************************************
 * parityCheck — run from the editor (or Dashboard button) after
 * migration. Compares the engine against Parity_Expected (the
 * RFQ4 workbook's Output) and writes a Parity_Report tab.
 ************************************************************/
function parityCheck() {
  prewarmForWrite_([SHEET.RATES, SHEET.COMP_MIX, SHEET.CC_MIX, SHEET.FX, SHEET.PARITY]);
  const perms = requireEditor();
  const computed = computeAll_();
  const got = {};
  computed.outputRows.forEach(r => { got[r[0] + '|' + utcDay_(r[1]) + '|' + r[2]] = r[8]; });

  const expected = tableToObjects_(SHEET.PARITY);
  let checked = 0, failures = 0, worst = 0;
  const failRows = [];
  expected.forEach(e => {
    const d = normDate(e.Month);
    if (!d) return;
    const key = e.High_Level_ID + '|' + utcDay_(d) + '|' + safeStr(e.Customer_Type);
    const g = got[key] !== undefined ? got[key] : 0;
    const diff = Math.abs(g - safeNum(e.Expected_Cost_Local));
    checked++;
    if (diff > worst) worst = diff;
    if (diff > 0.0001) { failures++; failRows.push([e.High_Level_ID, d, e.Customer_Type, safeNum(e.Expected_Cost_Local), g, diff]); }
  });

  const ss = _getSs_();
  let rep = ss.getSheetByName('Parity_Report');
  if (!rep) rep = ss.insertSheet('Parity_Report');
  rep.clearContents();
  rep.getRange(1, 1, 2, 4).setValues([
    ['Checked', 'Failures (>0.0001)', 'Worst diff', 'Run at'],
    [checked, failures, worst, new Date()]
  ]);
  if (failRows.length) {
    rep.getRange(4, 1, 1, 6).setValues([['High_Level_ID', 'Month', 'Customer_Type', 'Expected', 'Engine', 'Diff']]).setFontWeight('bold');
    rep.getRange(5, 1, failRows.length, 6).setValues(failRows);
  }
  logAction_(perms, 'PARITY_CHECK', 'Parity_Report', '', checked + ' checked, ' + failures + ' failures');
  return { checked: checked, failures: failures, worst: worst };
}
