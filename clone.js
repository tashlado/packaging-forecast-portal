/************************************************************
 * clone.gs — stand a new segment up from one that already works
 *
 * Onboarding a brand or a geo means the same components, the same
 * splits and usually the same prices as the segment next to it,
 * and today that is typed in one row at a time. The Lookups tab
 * has said so in a note for as long as it has existed. Twenty
 * rows entered by hand is where a wrong Modelling_ID comes from.
 *
 * Four properties, borrowed from bulk.js because they are what
 * make a tool that writes in bulk safe to hand to somebody:
 *
 *   1. PREVIEW FIRST. copySegment previews unless given
 *      preview:false AND the planKey the preview returned. The
 *      key fingerprints the rows on both sides, so a confirmation
 *      can only ever apply the plan that was actually shown.
 *
 *   2. IT ONLY FILLS GAPS. A target line that already has rates
 *      keeps them; a target High Level ID that already has a cold
 *      chain share keeps it. Nothing is ever overwritten, and
 *      nothing is copied ALONGSIDE what is there either — two
 *      overlapping rate periods is a RANGE_OVERLAP error, and a
 *      tool whose whole purpose is saving typing should not leave
 *      an error behind. Everything skipped is counted and shown.
 *
 *   3. LINES ARE PAIRED BY COMPONENT, never by position. A source
 *      line and a target line correspond when they carry the same
 *      Component_ID. Anything that does not pair up is listed
 *      rather than guessed at.
 *
 *   4. EVERY COPIED ROW SAYS SO, in its Comment, with the High
 *      Level ID it came from and the date. A rate nobody ever
 *      actually negotiated has to be findable later.
 *
 * What it does NOT do: change anything that already exists. It
 * creates modelling lines, rate rows, component mix rows and cold
 * chain rows, and it touches nothing else.
 ************************************************************/

/* A fingerprint of both sides of the copy. The client previews, the user
   confirms, and the apply sends this back; if either side moved in between —
   somebody added a rate to the target, a line was deactivated — the recomputed
   key differs and the write is refused. Same idea as bulkPlanKey_, and kept
   separate from it because what identifies a plan is different for each. */
function copyPlanKey_(parts) {
  const s = parts.join('|');
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, s || 'empty');
  return bytes.map(b => ('0' + (b < 0 ? b + 256 : b).toString(16)).slice(-2)).join('').slice(0, 12);
}

/* The four things a copy can carry. Kept as a list so the gate, the plan, the
   preview and the summary all walk the same set and cannot drift apart. */
const COPY_PARTS = [
  { key: 'lines',   label: 'modelling line' },
  { key: 'rates',   label: 'rate card row' },
  { key: 'compMix', label: 'component mix row' },
  { key: 'ccMix',   label: 'cold chain mix row' }
];

function copyWanted_(p) {
  const w = {};
  /* Absent means yes, so the simplest possible call copies everything, and a
     caller narrows by saying no. */
  COPY_PARTS.forEach(part => w[part.key] = p[part.key] !== false);
  return w;
}

/**
 * Preview or apply a segment copy.
 *
 * @param {Object} p { fromHlId, toHlId,
 *                     lines, rates, compMix, ccMix,   (each defaults to true)
 *                     preview, planKey }
 */
function copySegment(p) {
  prewarmForWrite_([SHEET.LINES, SHEET.RATES, SHEET.COMP_MIX, SHEET.CC_MIX,
                    SHEET.RATES_AM, SHEET.COMP_MIX_AM, SHEET.CC_MIX_AM, SHEET.DIM_AM]);
  const want = copyWanted_(p);

  const fromHlId = safeStr(p.fromHlId), toHlId = safeStr(p.toHlId);
  if (!fromHlId || !toHlId) throw new Error('Pick a High Level ID to copy from and one to copy into.');
  if (fromHlId === toHlId) throw new Error('Those are the same High Level ID.');
  if (!COPY_PARTS.some(part => want[part.key])) {
    throw new Error('Nothing was selected to copy.');
  }

  const hlRows = tableToObjects_(SHEET.HL);
  const fromHl = hlRows.find(h => String(h.High_Level_ID) === fromHlId);
  const toHl   = hlRows.find(h => String(h.High_Level_ID) === toHlId);
  if (!fromHl) throw new Error('High Level ID ' + fromHlId + ' does not exist.');
  if (!toHl) throw new Error('High Level ID ' + toHlId + ' does not exist.');

  /* Gated per part, against the TARGET's area — this writes there and only reads
     the source. Copying rates needs the rate capability, copying either mix
     needs the mix one, and creating lines needs the dimension one, which carries
     the Admin floor. Somebody who may only move rates can still use this to fill
     a target whose lines already exist. */
  let perms = null;
  const need = [];
  if (want.lines)                  { perms = requireEditDimsForArea_(toHl.Area_ID);  need.push('lines'); }
  if (want.rates)                  { perms = requireEditRatesForArea_(toHl.Area_ID); need.push('rates'); }
  if (want.compMix || want.ccMix)  { perms = requireEditMixesForArea_(toHl.Area_ID); need.push('mixes'); }
  if (!perms) perms = requireViewer();

  const plan = planCopySegment_(fromHl, toHl, want);

  if (p.preview !== false) {
    plan.preview = true;
    return plan;
  }
  if (!plan.total) {
    throw new Error('There is nothing to copy: ' + copyNothingReason_(plan));
  }
  if (safeStr(p.planKey) !== plan.planKey) {
    throw new Error('One of these two High Level IDs has changed since the preview was taken, ' +
      'so nothing was copied. Run the preview again and check it still says what you expect.');
  }
  return withLock(() => applyCopySegment_(fromHl, toHl, want, plan, perms));
}

function copyNothingReason_(plan) {
  const bits = [];
  if (!plan.pairs.length && !plan.newLines.length) {
    bits.push('no component on ' + plan.fromLabel + ' pairs up with one here, and no new lines ' +
              'were selected');
  }
  COPY_PARTS.forEach(part => {
    const s = plan.skipped[part.key];
    if (s) bits.push(s + ' ' + part.label + (s === 1 ? '' : 's') + ' already covered here');
  });
  return bits.length ? bits.join('; ') + '.' : 'everything selected is already in place.';
}

/**
 * Work out what a copy would create, touching nothing.
 *
 * Pairing is by Component_ID: a source line and a target line correspond when
 * they carry the same component. A component the target does not have yet
 * becomes a new line if lines were selected, and is listed as unpaired if they
 * were not — because the rates under it have nowhere to go, and quietly
 * dropping them is exactly the kind of silence this tool exists to avoid.
 */
function planCopySegment_(fromHl, toHl, want) {
  const lines = tableToObjects_(SHEET.LINES);
  const srcLines = lines.filter(l => isActive(l.Active) &&
                                     String(l.High_Level_ID) === String(fromHl.High_Level_ID));
  const tgtByComp = {};
  lines.forEach(l => {
    if (!isActive(l.Active)) return;
    if (String(l.High_Level_ID) !== String(toHl.High_Level_ID)) return;
    tgtByComp[String(l.Component_ID)] = l;
  });

  const comps = {};
  tableToObjects_(SHEET.COMPONENTS).forEach(c => comps[String(c.Component_ID)] = c);
  const compName = id => {
    const c = comps[String(id)];
    return c ? (safeStr(c.High_Level_Component) + ' / ' + safeStr(c.Component)) : 'component ' + id;
  };
  const groupOf = id => {
    const c = comps[String(id)];
    return c ? safeStr(c.High_Level_Component) : '';
  };

  const pairs = [], newLines = [], unpaired = [];
  srcLines.forEach(l => {
    const cid = String(l.Component_ID);
    if (tgtByComp[cid]) {
      pairs.push({ fromMid: String(l.Modelling_ID), toMid: String(tgtByComp[cid].Modelling_ID),
                   componentId: cid, label: compName(cid) });
    } else if (want.lines) {
      newLines.push({ componentId: cid, fromMid: String(l.Modelling_ID), label: compName(cid) });
      /* A line that is about to exist pairs like one that already does — so a
         single call can stand the segment up and price it in one go. */
      pairs.push({ fromMid: String(l.Modelling_ID), toMid: null, componentId: cid, label: compName(cid) });
    } else {
      unpaired.push({ componentId: cid, label: compName(cid) });
    }
  });

  /* Components on the target that the source does not have. Not a problem —
     they simply get nothing — but worth saying, because somebody expecting the
     two segments to end up identical should know they will not. */
  const srcComps = {};
  srcLines.forEach(l => srcComps[String(l.Component_ID)] = true);
  const extra = Object.keys(tgtByComp).filter(cid => !srcComps[cid])
    .map(cid => ({ componentId: cid, label: compName(cid) }));

  const counts = { lines: newLines.length, rates: 0, compMix: 0, ccMix: 0 };
  const skipped = { lines: 0, rates: 0, compMix: 0, ccMix: 0 };
  const rowPlan = { rates: [], compMix: [], ccMix: [] };
  const fingerprint = [String(fromHl.High_Level_ID), String(toHl.High_Level_ID),
                       COPY_PARTS.filter(part => want[part.key]).map(part => part.key).join(',')];

  /* ---- rates: skipped per LINE ----
     A target line that already has rates keeps them. Copying alongside would
     leave two periods covering the same days, which RANGE_OVERLAP calls an
     error, and a tool for saving typing must not leave one behind. */
  if (want.rates) {
    const rows = tableToObjects_(SHEET.RATES).filter(r => isActive(r.Active));
    const byMid = {};
    rows.forEach(r => (byMid[String(r.Modelling_ID)] = byMid[String(r.Modelling_ID)] || []).push(r));
    pairs.forEach(pair => {
      const src = byMid[pair.fromMid] || [];
      if (!src.length) return;
      /* toMid null means the line is being created in this same call, so it
         cannot have anything yet. */
      const existing = pair.toMid ? (byMid[pair.toMid] || []).length : 0;
      if (existing) { skipped.rates += src.length; return; }
      src.forEach(r => {
        rowPlan.rates.push({ src: r, componentId: pair.componentId, toMid: pair.toMid });
        fingerprint.push('rates:' + r.Rate_ID);
      });
      counts.rates += src.length;
    });
    /* What the target already holds is part of the fingerprint too: adding a
       rate to the target between preview and apply changes what would be
       skipped, so the plan shown is no longer the plan that would run. */
    pairs.forEach(pair => {
      if (!pair.toMid) return;
      (byMid[pair.toMid] || []).forEach(r => fingerprint.push('have:rates:' + r.Rate_ID));
    });
  }

  /* ---- component mix: skipped per GROUP, not per line ----
     A mix is a share of a 100% split across every line of one High Level
     Component, so the unit that is either empty or not is the GROUP. Skipping
     per line would copy a 30% share into a group whose other line already holds
     100%, and hand back a segment that fails MIX_SUM — created by the tool, in
     the state it just wrote. So if any line of the group on the target already
     carries a mix, the whole group is left alone and counted as skipped.

     The consequence is honest and visible: a newly created line in a group that
     was already populated ends up with no mix, which is NO_COMP_MIX (a warning)
     telling somebody to rebalance the split by hand — which is the only place
     that decision can be made. */
  if (want.compMix) {
    const rows = tableToObjects_(SHEET.COMP_MIX).filter(r => isActive(r.Active));
    const byMid = {};
    rows.forEach(r => (byMid[String(r.Modelling_ID)] = byMid[String(r.Modelling_ID)] || []).push(r));

    const groupHasMix = {};
    Object.keys(tgtByComp).forEach(cid => {
      if ((byMid[String(tgtByComp[cid].Modelling_ID)] || []).length) groupHasMix[groupOf(cid)] = true;
    });

    pairs.forEach(pair => {
      const src = byMid[pair.fromMid] || [];
      if (!src.length) return;
      if (groupHasMix[groupOf(pair.componentId)]) { skipped.compMix += src.length; return; }
      src.forEach(r => {
        rowPlan.compMix.push({ src: r, componentId: pair.componentId, toMid: pair.toMid });
        fingerprint.push('compMix:' + r.Mix_ID);
      });
      counts.compMix += src.length;
    });
    pairs.forEach(pair => {
      if (!pair.toMid) return;
      (byMid[pair.toMid] || []).forEach(r => fingerprint.push('have:compMix:' + r.Mix_ID));
    });
  }

  if (want.ccMix) {
    const cc = tableToObjects_(SHEET.CC_MIX).filter(r => isActive(r.Active));
    const src = cc.filter(r => String(r.High_Level_ID) === String(fromHl.High_Level_ID));
    const have = cc.filter(r => String(r.High_Level_ID) === String(toHl.High_Level_ID));
    if (have.length) skipped.ccMix = src.length;
    else {
      src.forEach(r => { rowPlan.ccMix.push({ src: r }); fingerprint.push('cc:' + r.CC_Mix_ID); });
      counts.ccMix = src.length;
    }
    have.forEach(r => fingerprint.push('have:cc:' + r.CC_Mix_ID));
  }

  newLines.forEach(l => fingerprint.push('newline:' + l.componentId));

  const total = counts.lines + counts.rates + counts.compMix + counts.ccMix;
  return {
    fromHlId: fromHl.High_Level_ID, toHlId: toHl.High_Level_ID,
    fromLabel: copyHlLabel_(fromHl), toLabel: copyHlLabel_(toHl),
    sameArea: String(fromHl.Area_ID) === String(toHl.Area_ID),
    counts: counts, skipped: skipped, total: total,
    pairs: pairs.map(x => ({ label: x.label, isNew: !x.toMid })),
    newLines: newLines.map(x => ({ componentId: x.componentId, label: x.label })),
    unpaired: unpaired, extra: extra,
    _rowPlan: rowPlan, _pairs: pairs, _newLines: newLines,
    planKey: copyPlanKey_(fingerprint)
  };
}

function copyHlLabel_(h) {
  return [h.Brand, h.Geo, h.Treatment_Type, h.WL_Detail].filter(x => x && x !== '*').join(' ') ||
         ('High Level ID ' + h.High_Level_ID);
}

/* Write a planned copy. Assumes the caller holds the lock.
 *
 * One append per table rather than one per row, with the amends batched the same
 * way, because a segment copy is the same shape of write a bulk rate change is:
 * a few hundred rows, and appendRow costs a round trip each. */
function applyCopySegment_(fromHl, toHl, want, plan, perms) {
  const stamp = dayStr(new Date());
  const note = 'Copied from ' + plan.fromLabel + ' (HL ' + fromHl.High_Level_ID + ') on ' + stamp;
  const now = new Date();
  const written = { lines: 0, rates: 0, compMix: 0, ccMix: 0 };

  /* ---- new modelling lines first: the rows below need their ids ---- */
  const midByComp = {};
  plan._pairs.forEach(pair => { if (pair.toMid) midByComp[pair.componentId] = pair.toMid; });

  if (plan._newLines.length) {
    const sh = getSheet(SHEET.LINES);
    const c = H(SHEET.LINES);
    const width = HEADERS[SHEET.LINES].length;
    const rows = plan._newLines.map(l => {
      const row = padTo_([], width);
      row[c.Modelling_ID] = getNextId(SHEET.LINES, 'Modelling_ID');
      row[c.High_Level_ID] = Number(toHl.High_Level_ID);
      row[c.Component_ID] = Number(l.componentId);
      row[c.Active] = 'Y';
      row[c.Comment] = note;
      midByComp[l.componentId] = String(row[c.Modelling_ID]);
      return row;
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, width).setValues(rows);
    invalidateSheetCache(SHEET.LINES);
    appendDimAmendsBatch_(SHEET.LINES, rows.map(r =>
      ({ type: 'CREATE', rowId: r[c.Modelling_ID], rowObj: r })), perms);
    written.lines = rows.length;
  }

  /* ---- per-line tables ---- */
  const perLine = [
    { key: 'rates',   sheet: SHEET.RATES,    idHeader: 'Rate_ID' },
    { key: 'compMix', sheet: SHEET.COMP_MIX, idHeader: 'Mix_ID' }
  ];
  perLine.forEach(t => {
    const planned = plan._rowPlan[t.key];
    if (!planned.length) return;
    const sh = getSheet(t.sheet);
    const c = H(t.sheet);
    const width = HEADERS[t.sheet].length;
    const hdr = HEADERS[t.sheet];
    const rows = planned.map(item => {
      /* Built from the header names rather than by copying a raw row: the source
         came through tableToObjects_, whose dates are 'yyyy-mm-dd' strings, and
         a positional copy of a cached read would carry those straight back into
         cells the engine has to date. */
      const row = padTo_([], width);
      hdr.forEach((h, i) => {
        const name = safeStr(h);
        if (!name) return;
        if (/_Date$/.test(name)) { row[i] = normDate(item.src[name]); return; }
        row[i] = item.src[name] === undefined ? '' : item.src[name];
      });
      row[c[t.idHeader]] = getNextId(t.sheet, t.idHeader);
      row[c.Modelling_ID] = Number(midByComp[item.componentId]);
      row[c.Comment] = truncateComment_(
        (safeStr(item.src.Comment) ? safeStr(item.src.Comment) + ' — ' : '') + note);
      row[c.Active] = 'Y';
      row[c.Updated_At] = now;
      row[c.Updated_By] = perms.email;
      return row;
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, width).setValues(rows);
    invalidateSheetCache(t.sheet);
    appendAmendsBatch_(t.sheet, rows.map(r => ({ type: 'CREATE', rowValues: r })), perms);
    written[t.key] = rows.length;
  });

  /* ---- cold chain, which hangs off the High Level ID rather than a line ---- */
  if (plan._rowPlan.ccMix.length) {
    const sh = getSheet(SHEET.CC_MIX);
    const c = H(SHEET.CC_MIX);
    const width = HEADERS[SHEET.CC_MIX].length;
    const rows = plan._rowPlan.ccMix.map(item => {
      const row = padTo_([], width);
      row[c.CC_Mix_ID] = getNextId(SHEET.CC_MIX, 'CC_Mix_ID');
      row[c.High_Level_ID] = Number(toHl.High_Level_ID);
      row[c.From_Date] = normDate(item.src.From_Date);
      row[c.To_Date] = normDate(item.src.To_Date);
      row[c.CC_Mix] = safeNum(item.src.CC_Mix);
      row[c.Comment] = truncateComment_(
        (safeStr(item.src.Comment) ? safeStr(item.src.Comment) + ' — ' : '') + note);
      row[c.Active] = 'Y';
      row[c.Updated_At] = now;
      row[c.Updated_By] = perms.email;
      return row;
    });
    sh.getRange(sh.getLastRow() + 1, 1, rows.length, width).setValues(rows);
    invalidateSheetCache(SHEET.CC_MIX);
    appendAmendsBatch_(SHEET.CC_MIX, rows.map(r => ({ type: 'CREATE', rowValues: r })), perms);
    written.ccMix = rows.length;
  }

  const total = written.lines + written.rates + written.compMix + written.ccMix;
  logAction_(perms, 'COPY_SEGMENT', SHEET.HL, toHl.High_Level_ID,
    total + ' rows copied from HL ' + fromHl.High_Level_ID + ' (' + plan.fromLabel + '): ' +
    COPY_PARTS.filter(part => written[part.key])
      .map(part => written[part.key] + ' ' + part.label + (written[part.key] === 1 ? '' : 's'))
      .join(', '));

  /* Nothing here creates a mix row on a line whose group total it has not
     checked, so say so rather than implying the copy is finished business. */
  return {
    preview: false, written: written, total: total,
    fromHlId: fromHl.High_Level_ID, toHlId: toHl.High_Level_ID,
    fromLabel: plan.fromLabel, toLabel: plan.toLabel,
    skipped: plan.skipped,
    note: 'Every copied row says where it came from in its Comment. Run Validation before ' +
          'recalculating — a mix carried across from a segment with different components may ' +
          'not total 100% here.'
  };
}
