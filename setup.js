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
    const width = Math.max(sh.getLastColumn(), HEADERS[name].length);
    const existing = sh.getRange(1, 1, 1, width).getValues()[0].map(v => safeStr(v));
    const problems = [];
    HEADERS[name].forEach((h, i) => {
      if (existing[i] !== h) problems.push('col ' + (i + 1) + ' expected "' + h + '" found "' + (existing[i] || '(blank)') + '"');
    });
    if (problems.length) report.push('HEADER MISMATCH  ' + name + ' → ' + problems.join('; '));
    else report.push('OK       ' + name + '  (' + Math.max(0, sh.getLastRow() - 1) + ' data rows)');
  });
  report.forEach(r => Logger.log(r));
  const bad = report.filter(r => r.indexOf('MISMATCH') === 0);
  if (bad.length) {
    throw new Error('Setup problems found — open View → Logs (Executions) for details: ' + bad.join(' | '));
  }
  Logger.log('verifySetup complete — all tabs present with correct headers.');
  return report;
}
