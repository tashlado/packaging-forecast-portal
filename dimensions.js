/************************************************************
 * dimensions.gs — Admin-only edits to the dimension tables.
 * All saves are upserts (id present = update, absent = create).
 * Deletes are soft (Active = N) — never remove rows with history.
 * Every change lands in Dimension_Amends as a JSON snapshot.
 ************************************************************/
 
function _upsertDim_(sheetName, idHeader, obj, buildRow, summary) {
  prewarmForWrite_([sheetName, SHEET.DIM_AM]);
  const perms = requireAdmin();
  return withLock(() => {
    const sh = getSheet(sheetName);
    const data = getAllData(sheetName);
    const c = H(sheetName);
    const now = new Date();
    if (obj.id) {
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][c[idHeader]]) !== String(obj.id)) continue;
        const before = data[i].slice();          // buildRow mutates the copy it is given
        const rowVals = buildRow(Number(obj.id), data[i].slice(), c);
        sh.getRange(i + 1, 1, 1, rowVals.length).setValues([rowVals]);
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
    appendDimAmend_(sheetName, 'CREATE', newId, rowVals, perms);
    logAction_(perms, 'CREATE_DIM', sheetName, newId, summary);
    return { id: newId };
  });
}
 
/* {id?, brand, geo, treatmentType, wlDetail, currency, areaId, active, comment} */
function saveHighLevelId(o) {
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
  }, safeStr(o.brand) + ' ' + safeStr(o.geo) + ' ' + safeStr(o.wlDetail));
}
 
/* {id?, areaId, highLevelComponent, component, active, comment} */
function saveComponent(o) {
  if (!safeStr(o.highLevelComponent) || !safeStr(o.component)) {
    throw new Error('High Level Component and Component names are required.');
  }
  return _upsertDim_(SHEET.COMPONENTS, 'Component_ID', o, (id, row, c) => {
    row[c.Component_ID] = id;
    row[c.Area_ID] = Number(o.areaId) || 1;
    row[c.High_Level_Component] = safeStr(o.highLevelComponent);
    row[c.Component] = safeStr(o.component);
    row[c.Active] = o.active === 'N' ? 'N' : 'Y';
    row[c.Comment] = safeStr(o.comment);
    return row;
  }, safeStr(o.highLevelComponent) + ' / ' + safeStr(o.component));
}
 
/* {id?, highLevelId, componentId, active, comment} */
function saveLine(o) {
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
  return _upsertDim_(SHEET.LINES, 'Modelling_ID', o, (id, row, c) => {
    row[c.Modelling_ID] = id;
    row[c.High_Level_ID] = Number(o.highLevelId);
    row[c.Component_ID] = Number(o.componentId);
    row[c.Active] = o.active === 'N' ? 'N' : 'Y';
    row[c.Comment] = safeStr(o.comment);
    return row;
  }, 'HL ' + o.highLevelId + ' × comp ' + o.componentId);
}
 
/* {id?, areaName, outputMetricName, customerTypes, active} */
function saveArea(o) {
  return _upsertDim_(SHEET.AREAS, 'Area_ID', o, (id, row, c) => {
    row[c.Area_ID] = id;
    row[c.Area_Name] = safeStr(o.areaName);
    row[c.Output_Metric_Name] = safeStr(o.outputMetricName);
    row[c.Customer_Types] = safeStr(o.customerTypes) || 'New,Repeat,OTC';
    row[c.Active] = o.active === 'N' ? 'N' : 'Y';
    return row;
  }, safeStr(o.areaName));
}
