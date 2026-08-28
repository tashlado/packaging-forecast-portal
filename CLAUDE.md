# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Google Apps Script web app ("Packaging Forecast Portal") that lets staff maintain packaging
cost assumptions and recalculate a packaging cost forecast. There is no build step, no npm, no
test framework: the `.js` files are Apps Script server code (pushed as `.gs`), `index.html` is
the entire client, and a single Google Sheet is the database.

## Commands

Local tooling is `clasp` v3 (installed globally, credentials in `~/.clasprc.json`).

```bash
clasp push              # deploy local files to the bound script project
clasp push --watch      # push on save while iterating
clasp status            # show which files would be pushed
clasp pull              # pull changes made in the online editor — do this before editing if
                        # anyone may have edited in the browser, since push overwrites remote
clasp open-script       # open the Apps Script IDE
clasp open-web-app      # open the deployed web app
clasp logs              # tail recent log entries (Logger.log / Stackdriver)
clasp run <fn>          # run a server function (needs a linked GCP project + OAuth scopes)
clasp deploy            # new web-app deployment version
```

There are no unit tests in the project. The three verification entry points are server
functions, run from the Apps Script IDE (`clasp run` is not configured — no `projectId` in
`.clasp.json`, no `executionApi` block in `appsscript.json`):

- `verifySetup()` — idempotent; creates any missing tab with canonical headers, fills in a
  header cell that is blank where `HEADERS` expects a name (that is how a column is added), and
  throws on a cell holding a *different* name, which means the layout moved and the positional
  writers are already wrong. Run after any change to `HEADERS`.
- `runValidation()` — runs the rule pack in `validate.js` and rewrites `Validation_Results`.
  Run it after changing any rule, and read the ERROR count: errors block `recalculate()`.
- `parityCheck()` — recomputes the forecast and diffs it against the `Parity_Expected` tab (the
  original RFQ4 workbook's output), writing a `Parity_Report` tab. This is the regression test
  for `engine.js`; the engine is documented as matching 1,560/1,560 cells within 1e-4.
  **Run it after any engine change.**

Run `verifySetup()` first after any deploy that changed `HEADERS` — the capability columns on
`Permissions` were appended that way, and they read as blank (which resolves to today's
behaviour) until it has filled the headers in.

## Architecture

### Sheet-as-database, positional writes

`utils.js` holds `SPREADSHEET_ID`, the `SHEET` name constants, and `HEADERS` — the canonical
column layout for every tab. `HEADERS` is the single source of truth:

- Reads go through `getAllData(name)` (raw 2D array, cached per execution) and `H(name)`
  (header-name → column-index map). Row objects come from `tableToObjects_()`, which also
  normalises any column matching `/(_Date|^Month$|_At$|Timestamp)/` to `yyyy-mm-dd` strings.
- Writes are **positional** — they build a full row array indexed by `H(...)` and `setValues` it.
  Changing column order or inserting a column mid-tab breaks writers silently. To add a column:
  append it to the `HEADERS` entry, run `verifySetup()` (which fills the new header cell in on
  existing tabs), then update the writers that construct literal row arrays (`rates.js`,
  `mixes.js`, `snapshots.js`, `utils.js`'s `auditRow_`).
- The `*_Amends` tables are generated from their source table's headers plus `AMEND_PREFIX`, so
  they stay in sync automatically.

### Caching (per execution, not persistent)

`_ssCache_`, `_sheetCache_`, `_sheetDataCache_`, `_hdrCache_`, `_nextIdCache_`,
`_userPermsCache_`, `_refCache_` all live for one server invocation only. `prewarmSheetCache_()`
fetches many tabs in **one** HTTP call via the Advanced Sheets Service (`Sheets` v4, declared in
`appsscript.json`) — this is the main latency win, so every entry point starts with a prewarm
(`prewarmForWrite_()` for mutating calls). After writing a tab, call `invalidateSheetCache(name)`
if later code in the same execution reads it back.

### Two-phase client load

`code.js` exposes `initApp()` (permissions + dimension reference data + config — enough to draw
the shell) then `loadAllAppData()` (rates, mixes, FX, output, completeness, and for Admins the
last 300 audit rows). `index.html` boots both in sequence, stores everything in the global `APP`
object, and re-calls `loadAllAppData` after any successful write rather than patching state
locally. All client→server calls go through the `run(fn, args, onOk, onErr, isWrite)` wrapper,
which drives the navbar save indicator and the `beforeunload` guard.

### Authorisation

`auth.js`: the `Permissions` tab maps email → role (`Viewer` < `Editor` < `Admin`, ranked by
`ROLE_RANK`) and a CSV of `Area_ID`s or `ALL`. Every server function re-checks with
`requireViewer/Editor/Admin` or `requireEditorForArea_(areaId)`; hiding a button in the UI is
cosmetic only. An unknown email gets rank 0, `initApp` returns `{authorised:false}`, and the
client shows the "not in Permissions" panel. The web app runs as `USER_DEPLOYING` with `DOMAIN`
access.

**Capability columns.** On top of the rank sit four columns on the `Permissions` tab, declared
in `CAPS`: `Can_Edit_Rates`, `Can_Edit_Mixes`, `Can_Edit_Dims`, `Can_View_Audit`. Two rules make
them safe, and both are load-bearing — do not relax either when adding a fifth:

- **A capability only ever takes rights AWAY.** Every gate still runs the rank and area check it
  ran before; the column is an extra condition on top. `requireEditDimsForArea_` therefore keeps
  the **Admin** rank floor `dimensions.js` has always had rather than lowering it to Editor —
  a capability column must never be the route by which somebody gains access they did not have.
- **A blank cell means "whatever the rank already said".** `verifySetup()` fills a new header in
  and leaves the cells under it empty, so the deploy that adds a column changes nobody's access
  and nothing has to be backfilled first. `capOf_(cell, rank, spec)` reads one cell; `false` is a
  value, not an absence (an unticked Sheets checkbox), and only `N`/`NO`/`FALSE`/`0` are false.

`spec.dflt(rank)` is what a blank resolves to. The three edit columns default to **true**, since
the rank gate in front of them is what admits an Editor at all. `Can_View_Audit` defaults to
**Admin only** — defaulting it on would hand every Viewer the change history on the deploy that
adds the column.

| Gate | Rank floor | Column |
|---|---|---|
| `requireEditRatesForArea_(areaId)` | Editor + area | `Can_Edit_Rates` |
| `requireEditMixesForArea_(areaId)` | Editor + area | `Can_Edit_Mixes` |
| `requireEditDimsForArea_(areaId)` | **Admin** | `Can_Edit_Dims` |
| `requireViewAudit_()` | Viewer | `Can_View_Audit` |
| `requireCapability_(perms, cap)` | whatever the caller already required | any |

`bulk.js` uses `requireCapability_(requireEditor(), 'editRates')` rather than the per-area gate,
because which areas a bulk row belongs to is decided per row inside the lock, and the capability
is a property of the person. `history.js`'s `requireRecordHistory_(areaId)` passes on
`Can_View_Audit` **or** edit access to that record's own area — see below for why.

`initApp` returns `perms.caps` on the user object; the client's `can(cap)` / `canEditRates()` /
`canEditMixes()` / `canEditDims()` / `canViewAudit()` hide what the server would refuse. A
payload with no `caps` (an older cached page) falls back to the rank, which is what a blank cell
resolves to server side, so the two agree.

**Refusals are logged.** Every gate calls `logDenied_(perms, scope, targetId, reason)`
(`utils.js`) before it throws: one `Audit_Log` row with `Action = DENIED`, `Target_Table`
saying which kind of check refused (`PORTAL` for a rank floor, `AREA` for scope,
`CAPABILITY` for a column), `Target_ID` naming the role, area or capability, and `Summary`
saying what the account actually has. `Field`/`Old_Value`/`New_Value` stay empty — nothing
changed. They show up on the History screen like any other row, which is gated on
`Can_View_Audit`. Three properties, all load-bearing:

- **It never throws.** A refusal is already the unhappy path; a logging failure must not
  replace the readable "you cannot do this" with a spreadsheet error, and must not stop the
  throw that follows. Everything is swallowed to `Logger.log`.
- **It never gates.** It reads the `perms` the caller already resolved and calls no
  `require*` of its own, so recording a refusal cannot recurse into a second one.
- **It writes outside the lock**, because that is where the gates run — every entry point
  checks rights before `withLock`. Taking the script lock to record a refusal would queue
  refused calls behind real writes. The cost is that two simultaneous refusals can be
  allotted the same `Log_ID` (`getNextId` is a per-execution max+1, not a reservation);
  nothing keys on `Log_ID`, so that is a dent in the numbering rather than a lost row.

Call sites: `requireRole_`, `requireEditorForArea_`, `requireCapability_` and
`requireEditDimsForArea_` in `auth.js`, `requireRecordHistory_` in `history.js`, and
`bulk.js`'s per-row scope re-check. Because the gates **nest** rather than sit side by side,
a doubly-refused call still writes exactly one row — the innermost reason, which is the one
to fix first ("not an Editor" rather than "no editRates" for somebody who is neither).

Two things are deliberately **not** logged, and adding either would drown the ones that
matter: `initApp` returning `{authorised:false}` for an unknown email, which is the shell
saying "you are not set up" rather than an action refused and fires on every page load; and
`bulk.js`'s `skippedNoScope`, which is a count the preview already shows. `roleText_` tells
the two causes of rank 0 apart — no active row at all, versus a `Role` cell holding
something `ROLE_RANK` does not recognise — because a typo reads as no access and is
invisible on the tab itself.

### Standard write path

Every mutating function follows the same shape — keep it when adding one:

```
prewarmForWrite_([tabs])  →  require<Role>/requireEditorForArea_  →  withLock(() => {
    validate  →  setValues/appendRow  →  appendAmend_ / appendDimAmend_  →  logAction_
})
```

`withLock` is a 20s script lock. Deletes are always **soft** (`Active = 'N'`) — nothing with
history is ever removed, and `isActive()` treats anything other than `'N'` as active.
`appendAmend_`/`appendDimAmend_` write the full post-change row to `*_Amends` (row-level
history, the authoritative record). `Audit_Log` is the readable one, and what the History tab
shows:

- `logAction_(perms, action, table, targetId, summary)` — one summary row. Use it for creates
  and for actions that are not a row edit (recalculate, snapshot, a batch summary).
- `logFieldChanges_(perms, action, table, targetId, beforeRow, afterRow, headers, opts)` — one
  row **per changed field**, with `Field` / `Old_Value` / `New_Value`. Use it wherever a
  before *and* an after row exist; capture `before` as `data[i].slice()` **before** anything
  mutates the copy. Values are normalised by column *name*, not JS type, because the same date
  arrives as a `Date`, a Sheets serial or a `yyyy-mm-dd` string depending on how it was read —
  diffing raw marks every date column changed on every save. `Updated_At`/`Updated_By` are
  skipped (`Timestamp` and `Email` on the audit row already say it). `opts.into` collects
  rows for one `appendAuditRows_` flush — use it anywhere many rows are touched, since
  `appendRow` is a round trip each.

A bulk rate change writes roughly five audit rows per rate, each carrying its
`BULK-<timestamp>` reference as the first token of `Summary`, with the batch summary row
written last so it is newest. `renderHistory()` groups on exactly that reference
(`bulkRefOf` / `historyGroups`) and shows one collapsible line per batch. History shows the last
`AUDIT_PAGE_ROWS` (300) rows, so a large batch would otherwise fill the whole window with one
action.

### Reading a record's history back (`history.js`)

The `*_Amends` tabs hold the whole post-change row for every save and were write-only until
`recordHistory({table, recordId, asOf})`. It reconstructs one row's state on a chosen date plus
the amendments that got it there, for the three tables in `HISTORY_TABLES` (`Rate_Card`,
`Component_Mix`, `Cold_Chain_Mix`).

- **Last-write-wins replay, not a diff replay.** Each amend row is a complete copy of the record
  after that save, so the state on a date is the latest amend at or before it. That stays correct
  where the chain has a gap — an import, a hand edit, a row predating the mechanism — which a
  diff replay would carry forward as a silent error.
- The cutoff is the **end** of the chosen day: a save at 16:20 on the 14th is part of what the
  record said on the 14th. `tableToObjects_` normalises `Amend_Timestamp` down to a date, so two
  saves on one day are ordered by `Amend_ID`.
- A record with no amends says so explicitly. An empty panel would read as "nothing ever changed".
- `requireRecordHistory_` passes on `Can_View_Audit` **or** edit access to the record's area. The
  History *screen* is a list of what everybody has been doing and defaults to Admin; this is one
  row shown next to that row, and seeing what a rate you may edit used to say is part of editing
  it.

### Dimension usage and the in-use guards (`lookups.js`)

Nothing in a Sheet enforces a foreign key. `getDimensionUsage()` returns, per dimension row, how
many rows in each child table point at it (`DIM_USES` declares the child tables; counts are
bucketed in one pass per table, not asked once per row). `dimensions.js` runs three guards inside
the lock, against the row as it stands, on **updates only** — a row nothing points at yet cannot
orphan anything:

- `guardDeactivate_` — refuses switching off a parent with live children. That is exactly the
  state `ORPHAN_FK` calls an error, so allowing it would let one click block the next recalculation.
- `guardRelink_` — refuses changing a value other rows are **matched on**: a Component's
  `High_Level_Component` (the mix group key — moving it breaks the 100% split on both the group it
  leaves and the one it joins), a Modelling Line's `High_Level_ID` and `Component_ID`, and a High
  Level ID's `Area_ID`.
- `guardCustomerTypes_` — refuses removing a customer type an active `Rate_Card` row in that area
  is filed under. Adding one is always allowed: it shows up as `RATE_MISSING` wherever nothing
  prices it, which is the correct thing to be told.

**Everything else stays editable, and the screen says so.** A High Level ID's Brand, Geo,
Treatment Type and WL Detail are labels — every reference is by id and `Output` re-derives them
each recalculation — so a typo in a brand name is always correctable. Saying which fields are safe
is as much the point as blocking the ones that are not.

### Copying a segment (`clone.js`)

`copySegment(p)` stands a new High Level ID up from an existing one, creating modelling lines,
rate rows, component mix rows and cold chain rows. It **changes nothing that already exists**.
Four properties, taken from `bulk.js` — do not erode them:

1. **Preview first.** It previews unless given `preview:false` **and** the `planKey` the preview
   issued. The key fingerprints both sides — source rows, target rows and the selection — so a
   rate added to the target in between refuses the write.
2. **It only fills gaps.** Nothing is overwritten, and nothing is copied *alongside* what is
   there either: two overlapping rate periods is a `RANGE_OVERLAP` error, and a tool for saving
   typing must not leave one behind. Every skip is counted and shown.
3. **Lines pair by `Component_ID`**, never by position. A component with no partner becomes a new
   line if lines were selected, and is listed as unpaired if not.
4. **Every row created says where it came from**, in its `Comment`, so a rate nobody actually
   negotiated stays findable.

**Component mix skips per GROUP, not per line.** A mix is a share of a 100% split across every
line of one `High_Level_Component`, so copying a 30% share into a group whose other line already
holds 100% hands back a segment failing `MIX_SUM` — broken by the tool, in the state it just
wrote. A populated group is left entirely alone; the new line in it reports `NO_COMP_MIX`, which
is the warning that says rebalance the split, the one decision a copy cannot make.

Gated per part against the **target's** area: lines need `Can_Edit_Dims` (and its Admin floor),
rates need `Can_Edit_Rates`, either mix needs `Can_Edit_Mixes`.

### Snapshots (`snapshots.js`)

`createSnapshot` / `setCompareSnapshot` are Admin (they move every area at once).
`listSnapshots()` and `compareSnapshots(from, to)` are **Viewer** — they read what a Viewer can
already see.

`Forecast_Snapshots` is one row per High Level ID × month × customer type, so a snapshot is a
*name* repeated across hundreds of rows; `listSnapshots()` collapses it back to the thing a person
picks from a list. `compareSnapshots` keys both sides `High_Level_ID | yyyy-mm | Customer_Type`,
the grain `Output` is written at, and an empty `to` means the live `Output` tab — the comparison
people want most often.

A key present on one side only is reported as **added or removed, never as a change from zero**.
A segment that did not exist in January has not gone up by infinity, and folding those into the
percentages would make every other number unreadable.

### The engine (`engine.js`)

`recalculate()` recomputes everything and fully rewrites the `Modelling` (per line × month) and
`Output` (per High Level ID × month × customer type) tabs, then stamps `LAST_RECALC` in `Config`.
Assumption edits do **not** update `Output` — a user must hit Recalculate. It is **Admin-only**,
along with `createSnapshot` and `setCompareSnapshot`: all three move every modelling area at
once and there is no per-area version to fall back on, so the rank has to carry the scope.

Between computing and writing it runs the validation gate — see below. On a block it returns
`{blocked:true, validation:{...}}` rather than throwing, because nothing went wrong: the call
succeeded and deliberately wrote nothing. The client has to handle that (`recalcBlocked`).

The calculation is segment-based so mid-month changes are exact: for each line × month it splits
the month at every rate / component-mix / cold-chain boundary and day-weights each segment. Rate
rows are weighted by cold-chain share according to `CC_Flag` (`CC` → cc, `Ambient` → 1−cc,
`Both` → 1), and `Customer_Type` `All` applies to every customer type of the area.

**All engine date maths uses UTC-day milliseconds (`utcDay_`, `DAY_MS`) on purpose** — local
midnight arithmetic gives wrong day counts across the March/October DST transitions. Don't
"simplify" it back to local `Date` maths.

### FX_Rates is read-only to the app

There is **no write path to `FX_Rates`** — no `saveFx`, no `getSheet(SHEET.FX)` anywhere.
`verifySetup()` creates the tab with its headers, `engine.js` reads it into `fxMap` to fill
`FX_to_GBP` and `Cost_GBP`, and `loadAllAppData` ships it to the client. Rates are
maintained by hand in the spreadsheet. Four consequences to know before changing anything
here:

- There is no `FX_Rates_Amends` tab, so unlike `Rate_Card` and the two mix tables an FX
  change leaves **no history at all** — not even a row-level snapshot.
- No validation rule looks at FX.
- A month with no FX row is **silent**: `engine.js` writes `fx || ''` and
  `fx ? local * fx : ''`, so `Cost_Local` is populated while `FX_to_GBP` and `Cost_GBP`
  come out blank. Downstream extracts reading `Cost_GBP` get a gap with nothing said.
- The client fetches `fx` in the phase-2 payload and assigns it to `APP.fx`, and **nothing
  reads it** — there is no FX screen.

### The validation rule pack (`validate.js`)

`runValidation()` runs every rule and rewrites the `Validation_Results` tab; `recalculate()`
runs the same pack via `validateForRecalc_` on the rows it has just computed, **before writing
anything**. Any ERROR leaves `Modelling` and `Output` holding the last good numbers, unless
`Config.VALIDATION_BLOCKS_RECALC` is the literal `FALSE` — absence blocks, so the gate can only
be lifted on purpose.

`SEVERITY` is `{ERROR, WARN, INFO}`. ERROR means the forecast would be wrong.

| Rule | Sev | What it catches |
|---|---|---|
| `ORPHAN_FK` | ERROR | an active row whose dimension is missing or switched off. `computeAll_` filters lines to **active** parents, so deactivating a High Level ID silently drops everything under it while those rows still read as live |
| `DUP_MODELLING` | ERROR | two active lines for one High Level ID × component. The engine costs each line and adds them, so the component is counted twice — and `MIX_SUM` cannot see it, because 0.7 and 0.3 across two duplicate lines still totals 100% |
| `RATE_NEG` | ERROR | a `CPU` or `QTY` that is negative, blank, or not a number. `saveRate` checks `isNaN` and stops there; a negative cost nets off inside its High Level ID in `Output` and an unreadable one is costed as zero by `safeNum`, so neither surfaces as a missing rate |
| `RANGE_OVERLAP` | ERROR | two active rate rows sharing an expanded CC/customer-type slot, or two cold chain rows, covering the same day. Reuses `expandCC_`/`expandCT_`, because exact-key matching would miss that a `Both`/`All` row and a `CC`/`New` one are the same slot |
| `NO_RATE` | ERROR | an active line with no active rate row at all — costed at zero, and in `Output` indistinguishable from a component switched off on purpose |
| `RATE_MISSING` | ERROR | a segment whose component mix is above zero with no `Rate_Card` row covering a given **customer type** — costs nothing, and in `Output` is indistinguishable from a component switched off on purpose |
| `MIX_SUM` | ERROR | the 100%-per-group invariant, re-derived over the whole `Component_Mix` table, clipped to the horizon |
| `MIX_OVERLAP` | ERROR | two active mix rows of one line covering the same day. The engine ADDS overlapping rows (`cm += Mix`), so an overlap is not a replacement — and MIX_SUM cannot see the worst case, an old row at 1.0 left open under a new one at 0, which sums to a valid 100% while the component the person tried to switch off stays on |
| `NO_COMP_MIX` | WARN | an active line with no active component mix row. Also costs zero, but "no mix" is a legitimate way to say the component is not shipping yet |
| `RANGE_GAP` | WARN | a month with no active rate or mix row **inside a line's own covered period**, or a line whose rows all fall outside the horizon |
| `OUTPUT_SWING` | WARN | cost moving more than `VALIDATION_SWING_PCT` month on month, per High Level ID × customer type, ignoring transition months |
| `NO_CC_MIX` | INFO | a High Level ID with live lines and no active cold chain row. Read as 0% cold chain, which is right for anything ambient; one finding per High Level ID, not per line |
| `SWING_SKIPPED` | INFO | how many swing comparisons were skipped as transition months |
| `TRUNCATED` | INFO | a rule hit `VALIDATION_MAX_PER_RULE` and the rest are not listed |

`NO_RATE` / `NO_COMP_MIX` / `NO_CC_MIX` **are** the Dashboard's old completeness check, folded in
so there is one severity-ranked report rather than two mechanisms answering overlapping questions
in different words. `computeCompleteness_` is gone; `loadAllAppData` sends only `activeLines`, and
`renderDashboard()` reads those three rule codes out of `APP.validation`. Unlike `RANGE_GAP` they
are deliberately **not** horizon-clipped: "this line has never had a rate" is worth saying whatever
the horizon is set to, and it is the check somebody wants the moment they add a line.

**Every one of these boundaries was drawn to keep the rule reporting things a
person can act on. Do not widen one without re-reading why it is where it is:**

- `RATE_MISSING` matches customer type the way `computeAll_` does (`All` serves
  every type; anything else only its own) and deliberately **ignores `CC_Flag`**,
  because in the engine that is a *weight*, not a filter — `w = cc | 1-cc | 1` —
  so a `CC` row and a `Both` row are equally present. A CC-only rate under 0%
  cold chain really does compute zero, but that is the cold-chain mix saying
  nothing shipped cold, which is an answer rather than a missing rate.
- `MIX_SUM` clips to the horizon; `saveComponentMixGroup` does not, because it is
  checking one payload a person just typed. An archive of superseded 2024 rows
  cannot make a 2026 number wrong, and left in it errors every run forever.
- `RANGE_GAP` reports only holes *between* the first and last covered month.
  Months before a line starts or after it ends are its scope: a component that
  begins shipping in April is supposed to have no March rate, and reporting that
  for every deliberately-scoped line buries the real holes.
- `OUTPUT_SWING` skips any comparison where either month contains a rate or mix
  boundary. The engine day-weights a part month, so a line starting on the 20th
  bills 12/31 of January and then reads **+158%** into February; one starting on
  28 Feb reads **+2700%** into March. The `prev > 0` guard catches the
  zero-to-part-month step but not the part-month-to-full-month step after it.
  A mid-month change that is genuinely wrong still surfaces one month later, in
  the first full-month comparison. `scratchpad/swingprobe.js` demonstrates all of
  this against the real engine.
- `ORPHAN_FK` reports at the **boundary** of a switched-off region, not all the
  way down it. Soft deletes have never cascaded here, so retiring one High Level
  ID leaves its lines, their rates, their mixes and its cold chain rows behind.
  Counting every one of those would raise a dozen errors for one deliberate act
  and block the next recalculation until somebody had ticked through all of them
  — which is how a rule pack teaches people to set `VALIDATION_BLOCKS_RECALC` to
  `FALSE`. A row is reported when its own parent is off and that parent's
  ancestors are fine (it is a straggler), and passed over when the break is
  further up. A **missing** parent is always reported: a dangling id is never
  somebody's deliberate act.
- `RANGE_GAP` leaves the no-rows-at-all case to `NO_RATE` / `NO_COMP_MIX`, which
  say the same thing with the severity the gap deserves. What it keeps is the
  case those cannot see: rows that exist but all fall outside the horizon.
- `RANGE_OVERLAP` and `MIX_SUM` clip to the horizon; `MIX_OVERLAP` does too. An
  overlap between two rows that both expired in 2024 cannot make a 2026 number
  wrong, and left in it errors on every run forever.

`validationInput_` exposes `input.raw` — the tables **unfiltered**. Everything else in that
object is the population the engine costs (active lines under active parents, rows whose dates
parse), which is the right lens for "is the forecast wrong" and the wrong one for "is the data
intact": a line pointing at a High Level ID that does not exist is precisely the row the filter
throws away. `ORPHAN_FK`, `DUP_MODELLING`, `RATE_NEG` and `RANGE_OVERLAP` read `input.raw`.

Two things to keep in mind when adding a rule:

- **Re-derive; do not trust the write path.** `rates.js` and `mixes.js` validate one payload on
  one code path. A bulk change, a hand edit in the Sheet or an import can leave the table in a
  state no single save would have accepted, and catching that is the whole point.
- **Segment, do not sample.** `RATE_MISSING` splits each month at every boundary for the same
  reason the engine does: a rate lapsing on the 14th leaves half a month uncosted, and a
  whole-month check calls that covered. Use `utcDay_`/`DAY_MS`, not local dates.

`ruleOutputSwing_` takes the computed rows when the gate calls it and reads the `Output` tab
when `runValidation()` does — otherwise the gate would be checking the numbers it is about to
replace. Findings are grouped per line rather than per line × month, and capped per rule at
`VALIDATION_MAX_PER_RULE` with a `TRUNCATED` INFO finding, because a cap that hides its own
truncation reads as all-clear.

### Business invariants enforced server-side

- `rates.js` — no two active rate rows for the same line may overlap in dates once `CC_Flag` and
  `Customer_Type` are expanded (`Both` → CC+Ambient, `All` → the area's customer types).
- `mixes.js` — component mix is saved per **group** (all lines of one High Level ID sharing a
  `High_Level_Component`) so a split can be rebalanced in one save. Per date segment: 2+ lines
  with non-zero mix must sum to 100% (±`MIX_TOL`); a single non-zero line is an attach rate and
  may be any value 0–1; all-zero means the component is off. Cold chain mix must not overlap per
  High Level ID; gaps are allowed and treated as 0% CC.
- `dimensions.js` — Admin-only upserts (`id` present = update, absent = create), duplicate active
  `High_Level_ID × Component_ID` lines rejected, every change snapshotted as JSON to
  `Dimension_Amends`. `_upsertDim_` takes `opts = {areaId, guard}`; the guard runs inside the lock
  on an update only. `saveLine` gates *before* it reads anything, because its duplicate check
  reports what it finds in the sheet and somebody who may not edit dimensions should be told that
  rather than told about line 1003.

### Bulk rate changes (`bulk.js`)

`bulkUpdateRates(p)` changes many Rate_Card rows in one action — the case being a component's cost
moving across every brand, geo, cold-chain flag and customer type at once. It mirrors the same
feature in the Postage Forecast Portal (built in the `pfp-bulk` worktree); keep the two in step.

Four properties are the point of the design — don't erode them:

1. **Preview-first.** It previews unless given `preview:false` **and** the `planKey` the preview
   returned. `planKey` is an MD5 fingerprint of the matched rows and their current values, so a
   confirmation can only ever apply the set that was actually shown; if a rate moved in between,
   the write is refused.
2. **Selection by dimension, never by row id.** `BULK_DIMS` lists the eight; values inside one
   dimension OR, the dimensions AND. An empty/absent dimension means "all of them" — **never a
   magic `'ALL'` string**, because a component literally named ALL is one data entry away.
   Leading them is a single-select **modelling area**: `bulkRateOptions()` returns options grouped
   `byArea` (one round trip, the client switches without another) because an area defines its own
   customer types and its own components, so a union across areas would offer values that cannot
   match. `p.areaId` is optional — absent means every area the user may edit — but an area they
   *cannot* edit is refused by name rather than quietly matching nothing, and `areaId` is part of
   the `planKey` so a plan cannot be replayed against a different area.
3. **It only supersedes rates that already exist.** It will not create one for a line that has
   none. Everything it cannot act on is counted and surfaced (`skippedNoRate`, `skippedNoScope`,
   `skippedBlocked`), never silently dropped.
4. **Same per-row rules as a single save.** Area rights are re-checked per row inside the lock, and
   §6.1 is enforced via `bulkSlotsClash_`, which reuses `expandCC_`/`expandCT_` from `rates.js` —
   exact-key matching would miss that a `Both`/`All` row occupies the same slot as a `CC`/`New` one.

Mechanics: the running period is closed the day before the effective date and a new row carries the
new value; a row that *already starts on* the effective date is revised in place instead (closing it
would invert its dates). Writes go through one working copy of Rate_Card, mutated as it goes, then
one ranged `setValues` plus one append — with `appendAmendsBatch_` for the amends, because
`appendAmend_`'s per-row `appendRow` would be hundreds of calls. Every row carries a shared
`BULK-<timestamp>` reference in its `Comment`, plus one summary row in `Audit_Log`.

Testing: `testBulkRateChange()` runs previews against the live sheet and writes nothing. The real
regression suite is local — see below.

## Testing the server code locally

`bulk.js` (and anything else that is mostly logic over sheet data) can run under node without
deploying. The pattern: fake the `SpreadsheetApp`/`Session`/`Utilities` layer, then load the real
source files into one `vm` context so the code under test is the shipped code.

**The harness must live in the session scratchpad, never in the project root.** `clasp push`
uploads every root `.js` as a `.gs`, and `.clasp.json` sets `skipSubdirectories: false`, so a
`test/` folder would go up too.

Harnesses built so far — rebuild rather than reinvent:

| File | What it covers |
|---|---|
| `gasenv.js` | the fake host: `SpreadsheetApp`, `Session`, `Utilities`, `LockService`, plus `loadPortal(root, book, opts)` |
| `fixture.js` | a small complete book — two areas, three High Level IDs, a split component group, five rate rows |
| `assert.js` | `ok` / `eq` / `throws` / `done` |
| `headers.js` | `HEADERS` out of a throwaway context (it is a `const`, see below) |
| `clientenv.js` | `index.html`'s `<script>` block under stub `window`/`document`/`google` |
| `authtest.js` | rank and capability resolution, every gate, a pre-column Permissions tab |
| `validatetest.js` | the whole rule pack, the audit diff, and the recalculate gate |
| `lookupstest.js` | usage counts and the three dimension guards |
| `clonetest.js` | `copySegment` preview, plan key, group-level mix skipping, per-part permissions |
| `historytest.js` | `recordHistory` reconstruction and who may read it |
| `snaptest.js` | `listSnapshots` and `compareSnapshots` |
| `clienttest.js` | client capability helpers, usage-count rendering, escaping |
| `tabletest.js` | the sortable/filterable table module |
| `histuitest.js` | batch grouping on the History screen |
| `swingprobe.js` | runs the real `computeAll_` over a mid-month launch to show what `OUTPUT_SWING` does with it |
| `deniedtest.js` | the DENIED audit row every gate writes, and the paths that must write none |
| `smoketest.js` | `initApp` / `loadAllAppData` for each role, asserting no spurious refusals |
| `headertest.js` | the header actions: what each role is shown, the tab switch, prompt ordering, re-enabling |
| `outputtest.js` | the Output screen: columns, the six filters, `Date_ID`, the cost cell, and the baseline's move to Snapshots |
| `patch.js` | exact-string file edits that survive CRLF — the `.js` files are CRLF, `index.html` is LF |

Seven gotchas cost time:

- `Date` objects created inside the `vm` context fail `instanceof Date` in the host realm, and
  `normDate()` tests exactly that. Hand the host's `Date` into the sandbox so both sides share
  one constructor. (Or test with `Object.prototype.toString.call(d) === '[object Date]'`.)
- A top-level `const` in a `vm` script lives in the context's global **lexical** scope, which is
  not a property of the contextified object: `ctx.HEADERS` and `ctx.APP` are `undefined` while
  `ctx.runValidationCore_` (a function *declaration*) is not. Reach consts with
  `vm.runInContext('HEADERS', ctx)` — `loadPortal` and `loadClient` both expose that as `ctx.$`.
- Load order matters: `utils.js`, `auth.js`, `code.js`, `rates.js`, `mixes.js`, `dimensions.js`,
  `engine.js`, `validate.js`, `bulk.js`, `snapshots.js`, `lookups.js`, `clone.js`, `history.js`.
- `index.html` can be tested the same way: match out the `<script>` block and evaluate it with
  stub `window`/`document`/`google` objects. It only touches the DOM inside functions, so the
  block evaluates fine without one. Make `getElementById` return a **memoised stub per id**
  rather than `null`, and a render function runs end to end and its output can be read back off
  the stub — which is how the History batch markup is asserted.
- `summariseFindings_` returns only the first 200 findings, so a test about
  `VALIDATION_MAX_PER_RULE` has to read the `Validation_Results` tab out of the book, not the
  report.
- Fixture row indices are off by one for the header: `book['High_Level_IDs'][1]` is the first
  data row. Two of the ORPHAN_FK tests initially passed against the wrong High Level ID because
  of it.
- **The `.js` files are CRLF and `index.html` is LF.** An exact-string edit written with `
`
  silently matches nothing in a `.gs` source file, and an edit that inserts LF into one leaves
  it mixed. `patch.js` normalises to LF, applies, and writes back in whatever the file had;
  it also fails loudly when an anchor matches zero or more than one time.

### Config tab keys

`HORIZON_START`, `HORIZON_END` (required by the engine and by validation — both throw without
them), `COMPARE_SNAPSHOT` (which `Forecast_Snapshots` name the Output variance columns compare
against), `LAST_RECALC` and `LAST_VALIDATION` (display strings),
`VALIDATION_BLOCKS_RECALC` (only the literal `FALSE` lets a recalculation write over ERRORs;
absent means blocking), `VALIDATION_SWING_PCT` (`OUTPUT_SWING` threshold, default 20).

## Client conventions (`index.html`)

No framework, no bundler, no CDN — everything (CSS and the HeliosX logo as a base64 data URI) is
inline, so the page has no external dependencies.

**The stylesheet is shared with the Postage Forecast Portal** (`C:\tools\postage-forecast-portal`)
so the two read as one product: same `:root` tokens (`--brand:#0000FF`, the `--ink`/`--line`/`--bg`
scale, `--ok`/`--warn`/`--err`), same header (logo + product name, tab row, status chip, initials
avatar), same `.card`/`.btn`/`.field`/`.chip`/`.badge`/`.checks` components. Keep the two in
step: when you restyle a shared component, port the change rather than forking it — and keep one
name to one component. `.checks` (the collapsible dimension dropdown, with `ckPlace` /
`ckCloseAll`) means the same thing in both files. Its panel is `position:fixed` to escape
`.modal{overflow:hidden}` and `.mbody{overflow:auto}`, which is why it is placed from script
and re-placed on scroll and resize; `modal()` wires that up for any modal containing one.

Structure: tabs are declared in the `TABS` array (`admin:true` hides a tab from non-Admins,
`cap:'viewAudit'` hides it unless that capability is granted); each has a `render<Tab>()` function
dispatched by `renderActive()`, and `notReady(id)` renders the loading/error skeleton until
phase 2 finishes. `fitNav()` measures the tab row and collapses overflow into a **More** menu,
pinning `NAV_ALWAYS`. HTML is built by string concatenation — **always pass user/sheet text
through `esc()`**.

**Row actions are `.btn.sm`, and `.btn.sm.danger` for the destructive one** — everywhere
they appear, inside `td.rowacts`, which spaces adjacent pills with a CSS rule rather than a
literal space in each template. This file used to draw them as `.btn.link` (borderless
coloured text), which was a fork of a shared component: the Postage portal has no
`.btn.link` at all. `.btn.link` survives with exactly one job — the "Show all" that lifts
the table render cap, which sits mid-sentence in a footer cell and should look like text.
Do not reintroduce `.btn.link.danger`; nothing is both a link and destructive.

**Header actions** (`renderHeaderActions()`, into `#hactions`) put Recalculate and Snapshot
in the header so they are reachable from any tab — Recalculate is the step that makes an
assumption edit reach Output at all, so it is most wanted from wherever the edit was made.
Ported from the Postage portal's function of the same name. Neither action is portable on
its own: `showOk` writes into whichever screen is on, and the answer belongs next to the
table it changed. So `gotoOutputThen(fn)` switches there first and then runs the same
function, which leaves you looking at what moved. (Output no longer carries its own
Recalculate button, so `recalcButtons()` usually finds only the header's — it was always
written to tolerate either being absent.)
Snapshot asks for its name **before** switching, so cancelling leaves you where you were —
hence `doSnapshot(presetName)` and its `typeof` guard, which stops a DOM Event being taken
for a name. `doRecalc` drives whichever Recalculate buttons exist (`recalcButtons()`) and
re-enables them on all three paths, the blocked one included: `refreshAfterRecalc` redraws
the Output tab's button but never the header's. Rendered from `boot()` once `initApp` has
returned, because `isAdmin()` needs `APP.user`; it calls `fitNav()`, since the buttons take
room the tab row measures against.

### The sortable, filterable table module

Ported from the Postage Forecast Portal's OUTPUT table, and used by the Rate Card and Output
screens. A column descriptor is
`{key, label, type:'num'|'str', filter:'pick'|'range'|'text'|null, dp, right, cls, title, sort, cell, hint}`;
state lives in `TBL[id]` and the render function to call back in `TBL_RENDER[id]`.

- `tRows(id, cols, all)` filters then sorts, both over the array already in memory.
  `type:'num'` is what stops 10 sorting before 2.
- The three filter kinds are chosen **per column**, because the useful question differs: `pick`
  for a short closed list, `range` for a number, `text` for anything open-ended.
- `tPickValues` narrows a pick list by every *other* column's filter, so a combination that
  matches nothing is never offered.
- `tSort` cycles ascending → descending → **off**, so a column can be un-sorted without a reload.
- The render cap is a concession, not a wall: `tBody` offers **Show all**, and sorting brings
  either end of the range to the top. The CSV always exports the filtered *and sorted* set.
- **`tRerender(id)` restores focus and caret** to the control carrying `data-tf`. The panes are
  rebuilt with `innerHTML`, which destroys the live input, so a text filter would otherwise lose
  focus on every keystroke. Any new screen with a text filter must go through it.

The Rate Card flattens Brand, Geo, Treatment and Component onto each row (`rateRowsAll()`) —
they live on the line's High Level ID and its component, and they are exactly what people filter
by. Buried inside one "Line" label they could only be matched as free text and not sorted at all.

**The Output screen is a reading view, and deliberately thin.** One control above the table —
Export CSV — and nine of Output's fourteen columns: High Level ID, Date ID, Brand, Geo,
Treatment Type, Detail, Customer Type, Month, Cost. Recalculate and Snapshot are in the header,
the variance baseline is on the Snapshots screen, and `tToolbar`'s row count and
"Clear filters & sort" are gone with them. Four things to know before changing it:

- **`Date_ID` is derived, not stored.** The Postage portal reads it from a `DIM_CALENDAR`
  tab; packaging has no calendar table, so `outputAllRows()` computes the month's position in
  the horizon, 1-based from `HORIZON_START`, via `monthIndex()`. It therefore **renumbers if
  `HORIZON_START` moves** — it names a month within the horizon as it currently stands and is
  not a key to store against. That is why it is absent from the CSV, and why the header says so
  on hover. Blank, never a guess, when the horizon is unset or the month will not parse.
- **The currency lives inside the cost cell**, not in a column. Packaging is multi-currency
  where postage is GBP-only, and a column of bare numbers mixing GBP with USD is a number
  nobody can read. `Cost_Local` keeps `type:'num'`, so the `cell` renderer changes what is
  shown without touching how it sorts.
- **Six filters, all `pick`**: Brand, Geo, Treatment Type, Detail, Customer Type, Month. An
  id and a cost are things you sort, not things you pick from a list. `Detail` is `WL_Detail`
  (postage calls the same dimension WL Split); the `Month` column is normalised to `yyyy-mm`
  so the pick list offers one entry per month, and is labelled for what it holds — a month,
  not a date, even though postage's equivalent column is called Date.
- **The CSV is the record, the table is the view.** `OUTPUT_CSV_COLS` still exports all
  fourteen stored columns including `Cost_GBP` and the variance ones. An export that mirrored
  the table would drop exactly what downstream extracts are taken for.
- **Export CSV downloads, and does nothing else** — single-purpose by request. Know what that
  costs before adding to it: `downloadCsv` catches a download that *throws* and puts the CSV
  on screen instead, but the Apps Script iframe can also swallow the click without throwing,
  and there is no way to detect that. In that case the person gets a green "Exported…" box and
  an empty Downloads folder, with no way to get the filtered rows out of the portal. The toast
  names the failure and points at the Google Sheet, which holds the same rows unfiltered; that
  is the whole mitigation. A Copy button and then a shift-click hatch both used to cover this
  and were removed deliberately — if it starts biting, restore a second way out rather than
  trying to detect the block.

- `modal(title, body, footer, wide)` builds the overlay and returns `{hide}`; `closeModal()`
  dismisses it. `mfield`/`mselect`/`mselectRaw`/`modalActs` build the 4-column field grid — span
  values are in quarters (`w2`, `w3`, `w4`).
- Outcomes go in the page, not a corner toast: `showOk`/`showError` (and the `toast(msg, kind)`
  wrapper) insert an `.ok-box`/`.err-box` at the top of the active screen. A failed save must
  leave a visible trace.
- The header's single `.chip` carries two independent facts — write state (`setSave`) and whether
  Output has been recalculated. Both are state, and `renderStatusChip()` is the only thing that
  touches the element; a write in flight or a failed write wins.
- Careful with class names inside modals: `.modal>.acts` is the footer, and table action cells use
  `.rowacts` precisely so the footer rule cannot reach them.
- Component mix editing keeps its working set in the `MIXEDIT` global and previews the per-segment
  percentage sum client side, but the server re-validates.
- Lazily-loaded side payloads each have their own global and their own invalidation: `DIMUSE`
  (usage counts, dropped by `reloadRefAfterDim` and after a copy), `SNAPS` (the snapshot list,
  dropped by `doSnapshot`), `BULKOPTS`, `RECHIST`, `SNAPDIFF`. A screen that writes has to drop
  the ones its write invalidated, or it shows the numbers from before the save.
- A dimension edit form opens with `useIntro(kind, id, what)` — a sentence naming what points at
  the row — and locks the fields that are therefore fixed (`useLocked`, `mfieldRO`, `mselectRO`,
  `activeSelect(id, val, locked)`). A disabled input still answers `v(id)`, so the unchanged value
  is what gets sent and the server sees nothing to refuse. Nobody should learn the rule by being
  refused.
