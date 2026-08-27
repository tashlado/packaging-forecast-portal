/************************************************************
 * setup.gs — run verifySetup() once from the editor (Step 8).
 *
 * Idempotent: creates any missing tab with the canonical headers,
 * verifies headers on tabs that exist (the Migration_Data import
 * creates the data tabs; this creates the system tabs and checks
 * everything lines up). Safe to re-run at any time.
 ************************************************************/

function verifySetup() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const report = [];
  Object.keys(HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) {
      sh = ss.insertSheet(name);
      sh.getRange(1, 1, 1, HEADERS[name].length).setValues([HEADERS[name]]).setFontWeight('bold');
      sh.setFrozenRows(1);
      report.push('CREATED  ' + name);
      return;
    }
    /* A tab made before a column was appended can be physically narrower than
       HEADERS now is; widen it before reading, or getRange overruns the grid. */
    if (sh.getMaxColumns() < HEADERS[name].length) {
      sh.insertColumnsAfter(sh.getMaxColumns(), HEADERS[name].length - sh.getMaxColumns());
    }
    const width = Math.max(sh.getLastColumn(), HEADERS[name].length);
    const existing = sh.getRange(1, 1, 1, width).getValues()[0].map(v => safeStr(v));
    const problems = [], added = [];
    HEADERS[name].forEach((h, i) => {
      if (existing[i] === h) return;
      /* A blank cell where a header belongs is a column appended to HEADERS since
         this tab was made — the documented way to add one. Fill it in, because
         reporting it and stopping leaves the caller to do by hand the one thing
         this function exists to do.

         A cell holding a DIFFERENT name is not that. It means the layout moved,
         and since every writer here is positional, rows are already being written
         to the wrong columns. That needs a person, so it stays an error. */
      if (existing[i] === '') {
        sh.getRange(1, i + 1).setValue(h).setFontWeight('bold');
        existing[i] = h;
        added.push(h);
        return;
      }
      problems.push('col ' + (i + 1) + ' expected "' + h + '" found "' + existing[i] + '"');
    });
    const rowCount = '  (' + Math.max(0, sh.getLastRow() - 1) + ' data rows)';
    if (problems.length) report.push('HEADER MISMATCH  ' + name + ' → ' + problems.join('; '));
    else if (added.length) report.push('ADDED    ' + name + '  columns: ' + added.join(', ') + rowCount);
    else report.push('OK       ' + name + rowCount);
  });
  report.forEach(r => Logger.log(r));
  /* indexOf(...) === 0 never matched: the line starts "HEADER MISMATCH", so the
     needle is at 7 and a real mismatch was logged and then passed silently. */
  const bad = report.filter(r => r.indexOf('HEADER MISMATCH') === 0);
  if (bad.length) {
    throw new Error('Setup problems found — open View → Logs (Executions) for details: ' + bad.join(' | '));
  }
  Logger.log('verifySetup complete — all tabs present with correct headers.');
  return report;
}
