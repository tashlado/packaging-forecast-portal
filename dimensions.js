/************************************************************
 * dimensions.gs — Admin-only edits to the dimension tables.
 * All saves are upserts (id present = update, absent = create).
 * Deletes are soft (Active = N) — never remove rows with history.
 * Every change lands in Dimension_Amends as a JSON snapshot.
 *
 * An update runs its guard (lookups.js) inside the lock, against
 * the row as it stands, before anything is written: nothing in a
 * Google Sheet enforces a foreign key, and both a relink and a
 * deactivation can silently orphan rows that point here.
 ************************************************************/

/* opts = { areaId, guard }
 *   areaId  the modelling area the row being written belongs to, or null where
 *           the row IS an area (saveArea) or has no area column.
 *           requireEditDimsForArea_ keeps the Admin rank floor this function has
 *           always had and adds the Can_Edit_Dims column on top.
 *   guard   guard(beforeRow, columnMap) for an UPDATE. Runs inside the lock and
 *           throws to refuse. Never called for a create: a row nothing points at
 *           yet cannot orphan anything.
 */
function _upsertDim_(sheetName, idHeader, obj, buildRow, summary, opts) {
  const o = opts || {};
  prewarmForWrite_([sheetName, SHEET.DIM_AM, SHEET.RATES, SHEET.COMP_MIX, SHEET.CC_MIX]);
  const perms = requireEditDimsForArea_(o.areaId);
  return withLock(() => {
    const sh = getSheet(sheetName);
    const data = getAllData(sheetName);
    const c = H(sheetName);
    const now = new Date();
    if (obj.id) {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][c[idHeader]]) !== String(obj.id)) continue;
        const before = data[i].slice();          // buildRow mutates the copy it is given
        if (o.guard) o.guard(before, c);
        const rowVals = buildRow(Number(obj.id), data[i].slice(), c);
        sh.getRange(i + 1, 1, 1, rowVals.length).setValues([rowVals]);
        /* A save changes what points where, so the counts the guards just read
           are stale from here on. Same contract as invalidateSheetCache. */
        invalidateSheetCache(sheetName);
        dimUsageInvalidate_();
        appendDimAmend_(sheetName, 'UPDATE', obj.id, rowVals, perms);
        logFieldChanges_(perms, 'UPDATE_DIM', sheetName, obj.id, before, rowVals,
                         HEADERS[sheetName], { summary: summary });
        return { id: Number(obj.id) };
      }
      throw new Error(idHeader + ' ' + obj.id + ' not found.');
    }
    const newId = getNextId(sheetName, idHeader);
    const rowVals = buildRow(newId, new Array(Object.keys(c).length).fill(''), c);
    sh.appendRow(rowVals);
    invalidateSheetCache(sheetName);
    dimUsageInvalidate_();
    appendDimAmend_(sheetName, 'CREATE', newId, rowVals, perms);
    logAction_(perms, 'CREATE_DIM', sheetName, newId, summary);
    return { id: newId };
  });
}

/* Is this save switching the row off? */
function _turningOff_(before, c, o) {
  return o.active === 'N' && isActive(before[c.Active]);
}

/* {id?, brand, geo, treatmentType, wlDetail, currency, areaId, active, comment} */
function saveHighLevelId(o) {
  const label = safeStr(o.brand) + ' ' + safeStr(o.geo) + ' ' + safeStr(o.wlDetail);
  return _upsertDim_(SHEET.HL, 'High_Level_ID', o, (id, row, c) => {
    row[c.High_Level_ID] = id;
    row[c.Area_ID] = Number(o.areaId) || 1;
    row[c.Brand] = safeStr(o.brand);
    row[c.Geo] = safeStr(o.geo);
    row[c.Treatment_Type] = safeStr(o.treatmentType);
    row[c.WL_Detail] = safeStr(o.wlDetail);
    row[c.Currency] = safeStr(o.currency).toUpperCase();
    row[c.Active] = o.active === 'N' ? 'N' : 'Y';
    row[c.Comment] = safeStr(o.comment);
    return row;
  }, label, {
    areaId: Number(o.areaId) || 1,
    /* Brand, Geo, Treatment Type and WL Detail are deliberately NOT guarded.
       Nothing matches on them — every reference is by High_Level_ID, and Output
       re-derives the labels on each recalculation — so a typo in a brand name
       is always correctable. Only switching the row off can orphan anything. */
    guard: (before, c) => {
      if (_turningOff_(before, c, o)) guardDeactivate_('hl', o.id, label);
      /* Moving a High Level ID to another modelling area changes which customer
         types its rates are validated against and which types 'All' expands to,
         so it is a relink even though the column looks like a label. */
      guardRelink_('hl', o.id, label, 'modelling area',
                   before[c.Area_ID], Number(o.areaId) || 1);
    }
  });
}

/* {id?, areaId, highLevelComponent, component, active, comment} */
function saveComponent(o) {
  if (!safeStr(o.highLevelComponent) || !safeStr(o.component)) {
    throw new Error('High Level Component and Component names are required.');
  }
  const label = safeStr(o.highLevelComponent) + ' / ' + safeStr(o.component);
  return _upsertDim_(SHEET.COMPONENTS, 'Component_ID', o, (id, row, c) => {
    row[c.Component_ID] = id;
    row[c.Area_ID] = Number(o.areaId) || 1;
    row[c.High_Level_Component] = safeStr(o.highLevelComponent);
    row[c.Component] = safeStr(o.component);
    row[c.Active] = o.active === 'N' ? 'N' : 'Y';
    row[c.Comment] = safeStr(o.comment);
    return row;
  }, label, {
    areaId: Number(o.areaId) || 1,
    guard: (before, c) => {
      if (_turningOff_(before, c, o)) guardDeactivate_('comp', o.id, label);
      /* High_Level_Component is the mix GROUP key: saveComponentMixGroup gathers
         every line of one High Level ID sharing this string and requires their
         mixes to total 100%. Renaming it moves this component's lines out of one
         split and into another, breaking the total on both sides at once —
         which is why it is guarded and the Component name beside it is not. */
      guardRelink_('comp', o.id, label, 'High Level Component',
                   before[c.High_Level_Component], safeStr(o.highLevelComponent));
      guardRelink_('comp', o.id, label, 'modelling area',
                   before[c.Area_ID], Number(o.areaId) || 1);
    }
  });
}

/* {id?, highLevelId, componentId, active, comment} */
function saveLine(o) {
  /* Gated before anything is read back, unlike the other three, because the
     duplicate-line check below runs on the sheet's contents and reports what it
     finds there — "an active line already exists (line 1003)". Somebody who may
     not edit dimensions at all should be told that, not told about line 1003.
     _upsertDim_ re-runs the gate with the real area once it is known. */
  prewarmForWrite_([SHEET.LINES, SHEET.HL, SHEET.COMPONENTS]);
  requireEditDimsForArea_(null);
  const hl = tableToObjects_(SHEET.HL).find(h => String(h.High_Level_ID) === String(o.highLevelId));
  if (!hl) throw new Error('High Level ID ' + o.highLevelId + ' does not exist.');
  const cp = tableToObjects_(SHEET.COMPONENTS).find(x => String(x.Component_ID) === String(o.componentId));
  if (!cp) throw new Error('Component ' + o.componentId + ' does not exist.');
  // prevent duplicate ACTIVE line for the same HL × component
  // (only when this save leaves the row active - deactivating a duplicate must be allowed)
  const dupe = (o.active === 'N') ? null : tableToObjects_(SHEET.LINES).find(l =>
    isActive(l.Active) &&
    String(l.High_Level_ID) === String(o.highLevelId) &&
    String(l.Component_ID) === String(o.componentId) &&
    (!o.id || String(l.Modelling_ID) !== String(o.id)));
  if (dupe) throw new Error('An active line already exists for that High Level ID and component (line ' + dupe.Modelling_ID + ').');
  const label = 'line ' + (o.id || 'new') + ' (' + safeStr(cp.Component) + ')';
  return _upsertDim_(SHEET.LINES, 'Modelling_ID', o, (id, row, c) => {
    row[c.Modelling_ID] = id;
    row[c.High_Level_ID] = Number(o.highLevelId);
    row[c.Component_ID] = Number(o.componentId);
    row[c.Active] = o.active === 'N' ? 'N' : 'Y';
    row[c.Comment] = safeStr(o.comment);
    return row;
  }, 'HL ' + o.highLevelId + ' × comp ' + o.componentId, {
    areaId: Number(hl.Area_ID) || 1,
    guard: (before, c) => {
      if (_turningOff_(before, c, o)) guardDeactivate_('line', o.id, label);
      /* Both pointers are what a rate or a mix row means. Repointing the line
         moves every one of them to a different High Level ID or a different
         component without touching a single one of their own rows. */
      guardRelink_('line', o.id, label, 'High Level ID',
                   before[c.High_Level_ID], Number(o.highLevelId));
      guardRelink_('line', o.id, label, 'component',
                   before[c.Component_ID], Number(o.componentId));
    }
  });
}

/* {id?, areaName, outputMetricName, customerTypes, active} */
function saveArea(o) {
  const label = safeStr(o.areaName);
  return _upsertDim_(SHEET.AREAS, 'Area_ID', o, (id, row, c) => {
    row[c.Area_ID] = id;
    row[c.Area_Name] = safeStr(o.areaName);
    row[c.Output_Metric_Name] = safeStr(o.outputMetricName);
    row[c.Customer_Types] = safeStr(o.customerTypes) || 'New,Repeat,OTC';
    row[c.Active] = o.active === 'N' ? 'N' : 'Y';
    return row;
  }, label, {
    areaId: o.id ? Number(o.id) : null,
    guard: (before, c) => {
      if (_turningOff_(before, c, o)) guardDeactivate_('area', o.id, label);
      /* Area_Name and Output_Metric_Name are labels and stay free to edit.
         Customer_Types is not — see guardCustomerTypes_. */
      guardCustomerTypes_(o.id, label, before[c.Customer_Types],
                          safeStr(o.customerTypes) || 'New,Repeat,OTC');
    }
  });
}
