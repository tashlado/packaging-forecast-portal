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
written last so it is newest. That is the hook for grouping them in the UI. History currently
shows the last 300 rows, so a large batch fills it.

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

### The validation rule pack (`validate.js`)

`runValidation()` runs every rule and rewrites the `Validation_Results` tab; `recalculate()`
runs the same pack via `validateForRecalc_` on the rows it has just computed, **before writing
anything**. Any ERROR leaves `Modelling` and `Output` holding the last good numbers, unless
`Config.VALIDATION_BLOCKS_RECALC` is the literal `FALSE` — absence blocks, so the gate can only
be lifted on purpose.

`SEVERITY` is `{ERROR, WARN, INFO}`. ERROR means the forecast would be wrong.

| Rule | Sev | What it catches |
|---|---|---|
| `RATE_MISSING` | ERROR | a segment whose component mix is above zero with no `Rate_Card` row in force — costs nothing, and in `Output` is indistinguishable from a component switched off on purpose |
| `MIX_SUM` | ERROR | the 100%-per-group invariant, re-derived over the whole `Component_Mix` table |
| `RANGE_GAP` | WARN | a horizon month with no active rate or mix row at all |
| `OUTPUT_SWING` | WARN | cost moving more than `VALIDATION_SWING_PCT` month on month, per High Level ID × customer type |

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
  `Dimension_Amends`.

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

Harnesses built so far: `gasenv.js` (the fake host), `bulktest.js` (bulk.js, 58 assertions),
`validatetest.js` (the rule pack and the audit diff, 64 assertions) and `clienttest.js` (the
pure functions inside `index.html`'s `<script>` — CSV builder, picker markup — 32 assertions).
Rebuild rather than reinvent; four gotchas cost time:

- `Date` objects created inside the `vm` context fail `instanceof Date` in the host realm, and
  `normDate()` tests exactly that. Hand the host's `Date` into the sandbox so both sides share
  one constructor. (Or test with `Object.prototype.toString.call(d) === '[object Date]'`.)
- A top-level `const` in a `vm` script lives in the context's global **lexical** scope, which is
  not a property of the contextified object: `ctx.HEADERS` is `undefined` while
  `ctx.runValidationCore_` (a function *declaration*) is not. Reach consts with
  `vm.runInContext('HEADERS', ctx)`.
- Load order matters: `utils.js`, `auth.js`, `code.js`, `rates.js`, `mixes.js`, `engine.js`,
  `validate.js`, `bulk.js`.
- `index.html` can be tested the same way: match out the `<script>` block and evaluate it with
  stub `window`/`document`/`google` objects. It only touches the DOM inside functions, so the
  block evaluates fine without one.

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

Structure: tabs are declared in the `TABS` array (`admin:true` hides a tab from non-Admins); each
has a `render<Tab>()` function dispatched by `renderActive()`, and `notReady(id)` renders the
loading/error skeleton until phase 2 finishes. `fitNav()` measures the tab row and collapses
overflow into a **More** menu, pinning `NAV_ALWAYS`. HTML is built by string concatenation —
**always pass user/sheet text through `esc()`**.

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
