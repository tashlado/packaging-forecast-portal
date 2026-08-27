/************************************************************
 * rates.gs — Rate Card writes
 * Q1: CC_Flag ∈ {CC, Ambient, Both}; Customer_Type ∈ area types + 'All'.
 * §6.1: no two active rows may cover the same expanded
 * (CC/Ambient × customer type) combination on overlapping dates.
 ************************************************************/

function expandCC_(flag) { return flag === 'Both' ? ['CC', 'Ambient'] : [flag]; }
function expandCT_(ct, areaTypes) { return ct === 'All' ? areaTypes.slice() : [ct]; }

function areaTypesForLine_(modellingId) {
  const lines = tableToObjects_(SHEET.LINES);
  const line = lines.find(l => String(l.Modelling_ID) === String(modellingId));
  if (!line) throw new Error('Modelling line ' + modellingId + ' not found.');
  const hl = tableToObjects_(SHEET.HL).find(h => String(h.High_Level_ID) === String(line.High_Level_ID));
  if (!hl) throw new Error('High Level ID ' + line.High_Level_ID + ' not found for line ' + modellingId + '.');
  const area = tableToObjects_(SHEET.AREAS).find(a => String(a.Area_ID) === String(hl.Area_ID));
  const types = safeStr(area && area.Customer_Types).split(',').map(s => s.trim()).filter(Boolean);
  return { line: line, hl: hl, areaId: hl.Area_ID, types: types.length ? types : ['New', 'Repeat', 'OTC'] };
}

/* rate = {rateId?, modellingId, ccFlag, customerType, fromDate, toDate, cpu, qty, comment} */
function saveRate(rate) {
  prewarmForWrite_([SHEET.RATES, SHEET.RATES_AM]);
  const ctx = areaTypesForLine_(rate.modellingId);
  const perms = requireEditorForArea_(ctx.areaId);

  const from = normDate(rate.fromDate), to = normDate(rate.toDate);
  if (!from || !to) throw new Error('From and To dates are required (yyyy-mm-dd).');
  if (from.getTime() > to.getTime()) throw new Error('From date must be on or before To date.');
  if (['CC', 'Ambient', 'Both'].indexOf(rate.ccFlag) < 0) throw new Error('CC flag must be CC, Ambient or Both.');
  const validCTs = ctx.types.concat(['All']);
  if (validCTs.indexOf(rate.customerType) < 0) throw new Error('Customer type must be one of: ' + validCTs.join(', '));
  const cpu = Number(rate.cpu), qty = Number(rate.qty);
  if (isNaN(cpu) || isNaN(qty)) throw new Error('CPU and QTY must be numbers.');

  return withLock(() => {
    const sh = getSheet(SHEET.RATES);
    const data = getAllData(SHEET.RATES);
    const c = H(SHEET.RATES);

    // §6.1 overlap check against every OTHER active row of this line
    const myCC = expandCC_(rate.ccFlag), myCT = expandCT_(rate.customerType, ctx.types);
    for (let i = 1; i < data.length; i++) {
      const row = data[i];
      if (safeStr(row[c.Modelling_ID]) === '' ) continue;
      if (String(row[c.Modelling_ID]) !== String(rate.modellingId)) continue;
      if (!isActive(row[c.Active])) continue;
      if (rate.rateId && String(row[c.Rate_ID]) === String(rate.rateId)) continue; // skip self on update
      const oCC = expandCC_(safeStr(row[c.CC_Flag]));
      const oCT = expandCT_(safeStr(row[c.Customer_Type]), ctx.types);
      const shareCC = myCC.some(x => oCC.indexOf(x) >= 0);
      const shareCT = myCT.some(x => oCT.indexOf(x) >= 0);
      if (!shareCC || !shareCT) continue;
      const oF = normDate(row[c.From_Date]), oT = normDate(row[c.To_Date]);
      if (!oF || !oT) continue;
      if (from.getTime() <= oT.getTime() && to.getTime() >= oF.getTime()) {
        throw new Error('Rate conflict: this overlaps rate #' + row[c.Rate_ID] + ' (' +
          safeStr(row[c.CC_Flag]) + '/' + safeStr(row[c.Customer_Type]) + ', ' +
          dayStr(oF) + ' → ' + dayStr(oT) + '). Adjust the dates or edit that row instead.');
      }
    }

    const now = new Date();
    if (rate.rateId) {
      // update in place
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][c.Rate_ID]) !== String(rate.rateId)) continue;
        const before = data[i].slice();          // captured before rowVals is mutated
        const rowVals = data[i].slice();
        rowVals[c.Modelling_ID] = Number(rate.modellingId);
        rowVals[c.CC_Flag] = rate.ccFlag;
        rowVals[c.Customer_Type] = rate.customerType;
        rowVals[c.From_Date] = from;
        rowVals[c.To_Date] = to;
        rowVals[c.CPU] = cpu;
        rowVals[c.QTY] = qty;
        rowVals[c.Comment] = safeStr(rate.comment);
        rowVals[c.Active] = 'Y';
        rowVals[c.Updated_At] = now;
        rowVals[c.Updated_By] = perms.email;
        sh.getRange(i + 1, 1, 1, rowVals.length).setValues([rowVals]);
        appendAmend_(SHEET.RATES, 'UPDATE', rowVals, perms);
        logFieldChanges_(perms, 'UPDATE_RATE', SHEET.RATES, rate.rateId, before, rowVals,
                         HEADERS[SHEET.RATES], { summary: 'MID ' + rate.modellingId });
        return { rateId: Number(rate.rateId), updatedAt: dayStr(now) };
      }
      throw new Error('Rate #' + rate.rateId + ' not found.');
    }
    // insert
    const newId = getNextId(SHEET.RATES, 'Rate_ID');
    const rowVals = [newId, Number(rate.modellingId), rate.ccFlag, rate.customerType, from, to,
                     cpu, qty, safeStr(rate.comment), 'Y', now, perms.email];
    sh.appendRow(rowVals);
    appendAmend_(SHEET.RATES, 'CREATE', rowVals, perms);
    logAction_(perms, 'CREATE_RATE', SHEET.RATES, newId, 'MID ' + rate.modellingId);
    return { rateId: newId, updatedAt: dayStr(now) };
  });
}

function deleteRate(rateId) {
  prewarmForWrite_([SHEET.RATES, SHEET.RATES_AM]);
  return withLock(() => {
    const sh = getSheet(SHEET.RATES);
    const data = getAllData(SHEET.RATES);
    const c = H(SHEET.RATES);
    for (let i = 1; i < data.length; i++) {
      if (String(data[i][c.Rate_ID]) !== String(rateId)) continue;
      const ctx = areaTypesForLine_(data[i][c.Modelling_ID]);
      const perms = requireEditorForArea_(ctx.areaId);
      sh.getRange(i + 1, c.Active + 1).setValue('N');
      sh.getRange(i + 1, c.Updated_At + 1).setValue(new Date());
      sh.getRange(i + 1, c.Updated_By + 1).setValue(perms.email);
      const rowVals = data[i].slice();
      rowVals[c.Active] = 'N';
      appendAmend_(SHEET.RATES, 'DELETE', rowVals, perms);
      logAction_(perms, 'DELETE_RATE', SHEET.RATES, rateId, 'MID ' + rowVals[c.Modelling_ID]);
      return { rateId: Number(rateId) };
    }
    throw new Error('Rate #' + rateId + ' not found.');
  });
}
