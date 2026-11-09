# Agent Art web UI rewrite: implementation plan

Branch `feat/ui-svelte`, base `82d6b60` ("Web UI build tooling: Vite + Svelte 5 + TypeScript, UI unchanged").
Audience: the implementer. Follow the steps in section 6 in order. Tick the checklists as you go.
Everything here ships in 1.0. Rule of the house: **improve, never remove**. Every item in section 1 must still work at the end.

Contents

1. Feature inventory (parity checklist)
2. Target architecture
3. Typed API layer
4. Design system
5. Per-viewer migration spec
6. Ordered implementation steps
7. Performance budgets, packaging, dev workflow
8. Risks, mitigations, "do not" rules
9. Definition of done
10. Review 2 (Fable): changes (what a second review added or corrected, with reasons; the sections above already contain those changes, marked `Review 2`)

Conventions used below

- "legacy" = the current vanilla code: `web/app.js`, `web/ui/*.js`, `web/ui/viewers/*.js`, `web/style.css`.
- `(new)` marks behaviour that does not exist today and is added on purpose. Everything else is parity.
- `(quirk)` marks current behaviour that is odd; the text says whether to keep or fix it.
- Types marked `(UI-derived)` were inferred from how the legacy UI reads a response. Confirm them against the named `src/` file before you freeze the type; do not change the server to fit the type.

---

## 0. Ground rules (read first)

- Do not touch `src/fp*.js` (another branch is reworking it). Do not change MCP tool schemas (`src/mcp.js` `TOOLS[*].inputSchema`). Keep every `/api` route, parameter and response field backward compatible; additive fields only, and only where this plan says so.
- `package.json` `dependencies` stays empty. Everything new goes in `devDependencies` and is bundled.
- Git: commit per step, only the files you changed (`git add <paths>`, never `-A` / `.`). Identity is the global config `KelpHect <kellhect@gmail.com>`; never pass `-c user.email`, never set `GIT_AUTHOR_*`. End commit messages with the attribution line the session gives you. Do not push or merge unless asked.
- Long commands (`npm test`, `npm run test:e2e`, `npm install`) run in the background with output to a log file; read the log tail. Never run a dev server or `serve` in the foreground.
- The e2e suite and any manual CLI seeding must always pass **both** `--home <temp dir>` and `--port <e2e port>` to `bin/agent-art.js`. Without `--port` the CLI talks to whatever runs on 7420, which is the user's real workspace.
- If a step's acceptance criteria cannot be met, stop and report; do not weaken the criteria.

Standard verification block (called **VERIFY** in the steps):

```
npm run check:ui            # svelte-check, 0 errors, 0 warnings
npm run test:ui             # vitest
npm run build:ui            # vite build -> dist/ui
npm run check:build         # added in step 1: bundle budgets + pack contents
npm test                    # node --test (background, log to file)
npm run test:e2e            # Playwright (background, log to file)
```

---

## 1. Feature inventory (parity checklist)

Source of truth is the legacy code. File references are to the legacy files.

### 1.1 Page, boot, global handle

- [ ] P1 `web/index.html`: title "Agent Art", inline SVG favicon (4 coloured squares), `<head>` tag written literally as `<head>` (the server and the dev plugin inject the token with `html.replace(/<head>/i, ...)`; an attribute on `<head>` breaks both).
- [ ] P2 Boot order (`App.boot`): start 1 s status interval; in parallel load ui-state, assets, reviews; then `GET /api/activity?limit=600` (failure tolerated); then connect SSE; then open the hash target, else the most recently updated canvas, else the empty state "Nothing here yet / Ask the agent to draw something (it shows up live), or press "+ New" to create a canvas."
- [ ] P3 Hash target on boot is opened when it is not a canvas, or when it is a canvas that exists in the asset index. A canvas hash for a missing canvas falls through to "most recent canvas".
- [ ] P4 `window.agentArt` exists (debug handle). Keep it as a small documented-unstable object: `{ version, open(target), state() }`.

### 1.2 Top bar

- [ ] T1 Assets pane toggle button (visible only in the narrow layout), title "Assets pane ([)".
- [ ] T2 Brand: logo + "Agent Art" (hidden in the narrow layout).
- [ ] T3 Status pill with dot: `connecting…` (initial), `live` (green), `agent is working…` (amber, pulsing; shown while the last non-user activity entry is younger than 2500 ms; re-evaluated every 1 s), `disconnected — retrying` (red, on SSE error).
- [ ] T4 Workspace path (`assets.home`), mono, ellipsis from the left (`direction: rtl`), `title="workspace: <path>"`, hidden at <= 1100 px.
- [ ] T5 Follow button: "◉ Follow" when on / "○ Follow" when off, `.on` state, title mentions `F`. Click: if following, set mode `off`; else restore `store.followOn` (default `canvas`). When it turns on, `followOn` is saved with the mode.
- [ ] T6 Follow mode select: `asset` (value `canvas`), `project overview` (`project`), `off`. Change persists to `agent-art:follow` **and** the legacy key `agent-art-follow`.
- [ ] T7 Compare button (`C`), `.on` while comparing.
- [ ] T8 Review button (`M`), `.on` in review mode; `body.review-mode` class drives cursor + dashed outline on review-capable surfaces.
- [ ] T9 Notes button with count badge = number of reviews with status `open | in_progress | reopened`; hidden badge at 0. Opens the review list dialog.
- [ ] T10 Graph button (`Shift+G`): opens `{kind:'graph'}`.
- [ ] T11 Cleanup button: opens the Cleanup dialog on the Trash tab.
- [ ] T12 Help button (`?`): toggles the shortcuts dialog.
- [ ] T13 Inspector / activity pane toggle (narrow layout only), title "Inspector / activity pane (])".

### 1.3 Layout

- [ ] L1 Three columns: browser | splitter | centre | splitter | side. Side column = inspector over (splitter) timeline.
- [ ] L2 Four draggable splitters writing CSS vars on the app root: `--browser-w` (default 280 px), `--side-w` (360 px), `--insp-h` (46vh), `--bottom-h` (260 px). Persisted as `agent-art:sizes` `{ 'browser-w': n, 'side-w': n, 'insp-h': n, 'bottom-h': n }` (rounded px). Clamp today: 140 px .. 70% of `innerWidth` for all four (quirk: vertical ones use the width; fix: vertical clamp 120 px .. 70% of `innerHeight`).
- [ ] L3 Pane visibility `[` (browser) and `]` (side), persisted as `agent-art:panes` `{browser:boolean, side:boolean}`. A hidden pane must not shift the others (explicit grid columns).
- [ ] L4 Timeline dock: right (under the inspector) or bottom (under the viewers, height `--bottom-h`, min 120 px). `P` or the ⇅ button toggles. Persisted `agent-art:dock` = `'right' | 'bottom'`. With the bottom dock the inspector fills the side column.
- [ ] L5 After any layout change the viewers re-fit (legacy: `window.dispatchEvent(new Event('resize'))`).
- [ ] L6 Compare: two slots side by side (4 px gutter); slot B has Swap (⇄) and Close (✕, title "Close comparison (C / Esc)"). Closing destroys slot B's viewer. Empty slot B shows: "Alt+click (or Shift+click) an asset in the browser, or ⇆ on a timeline entry, to compare it here."
- [ ] L7 Slot header: kind icon, name (or "Asset graph"), badge `state <label|snap>` for snapshots, "Back to live" button (slot A only), tabs.
- [ ] L8 Tabs. Canvas (not snapshot): `Canvas` (edit), `Animation` (only when the canvas has > 1 frame or any tag, or is unknown to the index), `Sheet`, `Layers`, `Rig` (only when `canvas.rig` is set or `canvas.kind === 'rigparts'`). Rig: `Rig`, `Layers`. Others: none. Tab title is `<label> (<index>)`; keys `1`–`5` click them.
- [ ] L9 Tab switching (`switchView`): canvas → `rig` opens `{kind:'rig', name: canvas.rig || name without _parts, clip: canvas.rig && first tag ? '<canvas>/<tag>' : undefined}`; rig → `{kind:'rig', name, view: 'layers' | undefined}`; otherwise `{...target, view}`.
- [ ] L10 Viewer reuse: opening a target that maps to the same viewer type keeps the instance (state such as zoom, toggles, camera survives); a different type destroys and recreates. Slot B viewers are read-only.

### 1.4 Asset browser (`ui/browser.js`)

- [ ] B1 Header "Assets"; buttons: `Clear solo` (only while solo is non-empty), hidden toggle (`◌ hidden` / `◉ hidden`, persisted `agent-art:showHidden`), `☐ Select` / `☑ Select`, `+ New`.
- [ ] B2 New canvas form: name (`[A-Za-z0-9_\-.]{1,64}`, required), width, height (number 1..4096, default 16), Create, Cancel. Submit → op `create {name,width,height}`, hide form, clear name, open the canvas. Focus goes to the name field when the form opens.
- [ ] B3 Filter input "Filter assets  ( / )", substring, case-insensitive; `/` focuses and selects it (only when the browser pane is shown). While filtering: every section and row is expanded; a section with no rows shows "no matches".
- [ ] B4 Sections in order: Pinned, Groups, Projects, Canvases, Rigs, 3D models, Audio, Exports. Sticky header with twisty + title + count. Collapsed set persisted `agent-art:collapsed` (default `['exports','groups']`). A section with count 0 is not rendered, except Canvases.
- [ ] B5 Row anatomy: optional checkbox (select mode), twisty (when it has children), thumbnail or kind icon coloured `var(--k-<kind>)`, name, meta line, badges, hover actions. Indent `6 + depth*14` px. Expanded ids persisted `agent-art:expanded` (last 500).
- [ ] B6 Row badges: open review count (`title "<n> open review note(s)"`), approved ✓, `superseded` (title mentions `art_cleanup plan {select:{superseded:true}}`), `orphan` (title "nothing links to it, not in a project or group, not pinned"), free badge (member / item counts).
- [ ] B7 Row actions (asset rows only): Solo ◎ (session only, not persisted), Pin ☆/★, Hide ◉/◌. Shown on hover, or when one is on, or when the row is hidden. Hidden rows are dimmed and only listed when "show hidden" is on. Solo non-empty → only solo ids are visible.
- [ ] B8 Pinned section: `uiState.pinned` in order, filtered by visibility; canvases render as full canvas rows.
- [ ] B9 Groups: root groups (no parent), nested groups recurse, members filtered by visibility + filter; member thumbnails for canvas/model/rig; badge = member count; meta = note; click opens the graph focused on `group:<name>`. Group rows are never selectable.
- [ ] B10 Projects: row with description meta and item count badge; children = its canvases (cap 400, then "+N more: open the project overview"). Filter hides a project with no matching canvases unless its own name matches.
- [ ] B11 Canvases: only loose ones (no project, kind not `rigparts` / `rigout`), cap 800. Count shown is all loose canvases. Empty workspace row: "No canvases yet. Ask the agent to draw something, or create one."
- [ ] B12 Canvas row: meta `W×H ·Nf ·NL` (frames only if > 1, layers only if > 1); children when it has > 1 layer or any tag: animation tags (open `{kind:'canvas', name, view:'anim', tag}`) then layers top-first (meta "hidden" when not visible; open the canvas). Thumbnail `/api/canvas/<name>/png?v=<version>`.
- [ ] B13 Rigs: meta `<w>×<h> · <n> views`; thumbnail = parts canvas; filter also matches output canvas names; children: parts canvas row, output canvas rows, pose rows "pose <p>" (open `{kind:'rig', name, mode:'pose'}`).
- [ ] B14 3D models: meta `<n> parts · <m> clips`; thumbnail `/api/model/<name>/thumb.png?v=<updated>`; children: clips (meta "clip", open `{kind:'model', name, clip}`), named parts (open the model).
- [ ] B15 Audio: meta `kind · 1.47s · -20.2 LUFS`; filter also matches the recipe.
- [ ] B16 Exports: sorted by path, grouped by folder; folder rows (`<dir>/`, count badge) only toggle; file rows: meta = size, thumbnail for `.png` / `.gif` (`/api/export-file?path=…&m=<mtime>`), cap 400 per folder; no hover actions but selectable in select mode.
- [ ] B17 Click opens the row's target in slot A; Alt+click or Shift+click opens it in slot B (compare). Double-click a canvas row opens it in the Canvas (edit) view.
- [ ] B18 Active row highlight follows slot A (`currentId`), on every instance of that id in the tree.
- [ ] B19 Flash (0.9 s) on `canvas:<name>` rows when an agent `change` event arrives.
- [ ] B20 Scroll position survives re-renders.
- [ ] B21 Select mode: click or checkbox toggles a selectable row; Shift+click selects the range between the last toggled row and this one in visible order; bar shows "<n> selected", `All shown`, `by tag…` select (every tag in `assets.tags`; adds all assets with that tag, then resets), `Clear`, `Plan cleanup…` (disabled at 0). Leaving select mode clears the selection. After a successful apply the selection is cleared.
- [ ] B22 New assets appear without reload (asset index refresh, debounced 350 ms, on `change | deleted | model | audio | project | graph` events).

### 1.5 Activity timeline (`ui/timeline.js`)

- [ ] TL1 Header "Activity", counter `shown/top-level · N err`, dock button ⇅ (title "Move timeline (P): right / bottom").
- [ ] TL2 Filters: search box (JSON of tool, op, args, summary, error, asset names; case-insensitive; debounced 80 ms), tool select ("all tools" + every distinct tool/op label seen), chips `Errors`, `This asset`, `Agent`. Persisted `agent-art:tlFilter` `{tool, errors, current, agent}` (the search text is not persisted).
- [ ] TL3 "This asset" matches entries whose assets include the open asset's name, or `<name>_parts`, or the name minus `_parts`; the list re-filters when slot A changes.
- [ ] TL4 Entries: tool calls, plus ops that are not part of a known tool call. Newest first, max 400 rows rendered, store keeps the last 3000 entries. `(Review 2)`: from step 14 the list is virtualised and shows every filtered entry of the 3000 kept (RV6); the cap only exists in the legacy code.
- [ ] TL5 Row: status dot (ok green / error red / running amber pulsing), tool name without `art_` prefix (or op name), action pill, up to 4 key args from `['canvas','name','new_name','action','label','preset','animation','clip','pose','view','recipe','node','from','rel','to','id','status','asset','commands','path']` (skipping `action` when shown as a pill; `commands` printed raw; others `k=v`), compare button ⇆ (when an asset has both before and after), expand button ▸/▾ (when it has ops or args), duration (`…` while running), time (title = full date).
- [ ] TL6 Second line: error text (pre-wrap) or one-line summary.
- [ ] TL7 Thumbnails: up to 3 assets with snapshots: before → after pair, or a single image; asset name label; `title "<kind> <name> (new)"`. A snapshot image that fails to load (expired) is hidden.
- [ ] TL8 Expanded: pretty JSON args + one line per child op (status, op, key args, ms, error/summary).
- [ ] TL9 User entries are tinted; an entry whose assets are all hidden is dimmed.
- [ ] TL10 Click a row: open the first asset with an `after` snapshot as a snapshot target (`label '#<entry id>'`), else the first non-deleted asset of kind canvas/model/rig/audio/project live. Click a thumbnail: the first image of a before/after pair opens the before snapshot, otherwise the after. Rig snapshots open as canvas `<rig>_parts`. Deleted assets open live via `targetFor`.
- [ ] TL11 Compare button: slot A = before snapshot (label "before"), slot B = after snapshot (label "after").
- [ ] TL12 New entries arriving while the list is scrolled down do not move the reading position.
- [ ] TL13 Empty states: "Waiting for the agent… every tool call shows up here." / "No entries match the filters."

### 1.6 Inspector (`ui/inspector.js`)

- [ ] I1 Header "Inspector". No target: "Nothing open." Graph open with no node selected: "Select a node in the graph to see its relations." Selecting a graph node shows that node's inspector without changing the viewer.
- [ ] I2 Title: kind icon, name, badge `snapshot <label|snap>`.
- [ ] I3 Actions: `☆ Pin` / `★ Pinned`, `◉ Visible` / `◌ Hidden`, `Approve` / `✓ Approved` (op `review_approve {asset, approved: !current}`), `⚑ Note` (opens the review dialog for the asset with no region).
- [ ] I4 Canvas: Preview (two canvases: small and big, nearest-neighbour, animated with the first tag's playlist or 10 fps over all frames); table (size, frames, layers, colours, project, undo / redo, version); Layers list top-first (click = op `layer select`, eye = `layer visibility`, blend select = `layer blend` with `normal multiply screen add overlay darken lighten soft-light`, opacity shown as `(NN%)`, active and hidden styling) + "Layer stack / debug" button (opens the Layers view); Palette swatches (inherited + own; key label when <= 2 chars; click sets the paint colour) and "Used colours" (top colours with pixel counts; click sets the colour); Animations chips `tag · Nf` (title total ms, "no loop"; click opens the Animation view on that tag); Meta JSON (anchors summarised as "N frames", rig object summarised as "rig definition (N parts)", capped at 4000 chars); Project block (description + notes, "▦ Overview (O)" button).
- [ ] I5 Canvas snapshot: table (canvas, version, size or "expired", frames) + "Open live".
- [ ] I6 Model: table (triangles, parts, materials, size units, size cells, origin, template); Rig (nodes, sockets, poses, clips); Warnings; Notes.
- [ ] I7 Rig: table (frame, views, mirrored, sampling, root); Parts chips `name ← parent · zN`; Poses (buttons → pose mode) and presets (dim chips); "Layer stack / debug".
- [ ] I8 Audio: table (kind, recipe, seed, duration, loudness, peak, score, issues, intent, genre).
- [ ] I9 Project: table (canvases, description, minecraft), Notes, Palette (click sets colour).
- [ ] I10 Export: table (path, size, modified).
- [ ] I11 Review notes section "Review notes (N open)": notes where `asset === id` or `compare_with.asset === id`, newest update first; empty hint "No notes. Press M (review mode) and drag a box or click a pin in the viewer."
- [ ] I12 Relations: tags chips, note, edges out (`rel →`) and in (`← rel`) excluding `layer_of`, non-derived first, attrs as `{k:v}`, links open the node (`openNode`), max 40 then "+N more"; empty hint "No relations yet (the agent adds them with art_graph link / group)."; "⬡ Show in graph" opens the graph focused on the asset.
- [ ] I13 Refresh: on open, on pin/hide toggles, on reviews reload, on `change` events for the inspected canvas (debounced 150 ms). A slow response for a previous target never overwrites the current one.
- [ ] I14 Error in a section shows the message in red and still renders reviews + relations.

### 1.7 Review notes

- [ ] R1 Review mode (`M`, button): canvas = drag a box (region `[x,y,w,h]`) or click (point `[x,y]`); animation cell click = pin with tag, view, frame; rig clip click = pin on the output canvas with tag, frame; model click = 160 px crop of the view around the click sent as `image` + `where "screen X%,Y%"` + `view:'orbit'` + clip; audio = drag a time range (`time:[t0,t1]`); layers view = "Flag layering" with two selected parts.
- [ ] R2 Review dialog: title "⚑ Review note", asset id, "where" line (`tag …· frame …· view …· layer …· parts …· box [..] · pin (..) · a–b s · <where>`), Category (Fix, Redo, Inconsistent across views, Layering, Style, Question, Approve; default `fix`, or `inconsistent` when a compare target is preset, or the preset category), Priority (low, normal, high; default normal or preset), note textarea (3 rows, placeholder "What is wrong / what should change?", prefilled when preset, focused on open), compare-with asset input with suggestions (all `canvas:`, `model:`, `rig:`, `audio:` ids), compare view, compare frame, Cancel, "Add note". Esc and backdrop click cancel.
- [ ] R3 Submit: op `review_add` with `{asset, category, priority, note}` + any of `frame view tag layer part region point time image clip` present + `compare_with {asset, view?, frame?}`; `where` is appended to the note as ` (at <where>)`. On success: toast "Review note rN added — the agent sees it in art_review list and in replies about this asset" and review mode turns off. On error the dialog stays open (toast shows the error).
- [ ] R4 Review card: id, category, priority (when not normal), status label (open, in progress, fixed, accepted, reopened), note or "(approval)", where line, "compare with <asset>" link, last reply `by: text`, last 3 history images (`/api/review-image/<file>`; captions "noted" for the first of several, else the status or `v<version>`), actions: Show, Side by side (when compare_with), Accept (when fixed → `review_update {id, status:'accepted'}`), Reopen (when fixed or accepted → asks "What is still wrong?" → `review_update {id, status:'reopened', reply}`), Delete ✕ (confirm "Delete rN?" → `review_delete {id}`). Left border colour by status.
- [ ] R5 Show: opens `reviewTarget(asset, target)` (canvas: frame, tag, and `view:'anim'` when both tag and view are set). Side by side: A = the note's asset, B = compare asset with `{...target, ...compare_with}`, both forced out of the anim view.
- [ ] R6 Review list dialog: "Review notes · N open", active first then newest; each card prefixed with its asset id; clicking a button or link in a card closes the dialog; empty text "No review notes yet. Press M, then drag a box (or click a pin) on what needs fixing."
- [ ] R7 Marks: canvas viewer draws regions (amber; green when fixed; 1×1 = circle) with the id label, filtered to the shown frame; audio viewer draws time ranges with the id. Marks for statuses open, in_progress, reopened, fixed.
- [ ] R8 Reviews reload (debounced 200 ms) on `graph` events with `review: true` or `action === 'approve'`; then browser badges, viewer marks, inspector and the Notes count update.

### 1.8 Cleanup (`ui/cleanup.js`)

- [ ] C1 Plan dialog "Plan cleanup · N selected": options `Exported files` (on), `Dependents too` (off), `Allow approved` (off), each with its title text; any change re-runs the dry run (`cleanup_plan {select:{ids}, include_exports, include_dependents, allow_approved, full:true}`), "planning…" while running.
- [ ] C2 Plan result: stat tiles (assets, on disk, one per kind, blocked: red count or green 0); Blocked list (`<id> approved in review` / `needed by a, b`) + `plan.next`; Warnings; "Export files kept (path rules)"; "Will move to the trash" list (id, reason badge, size); "not removable / unknown: …".
- [ ] C3 Apply button: disabled while blocked or empty; label "Blocked" / "Move N to trash"; `cleanup_apply {plan_id, confirm:true}`; toast "<removed> asset(s), <size> moved to the trash (<trash>): Cleanup › Trash restores them"; footer note "Soft delete: files, graph links, review notes and pins go to the trash and can be restored."
- [ ] C4 Cleanup dialog tabs: Trash, Disk usage, Settings.
- [ ] C5 Trash: tiles (batches, in the trash), age select (everything, older than 1 day / 7 days / 30 days), "Empty…" (disabled at 0 batches; confirm "Permanently delete <what>? This cannot be undone."; `cleanup_empty {confirm:true, older_than?}`; toast "emptied N batch(es), <size> freed"). Batch card: twisty, id, via badge, plan id, "<age> ago · <date>", "<items> · <size>", "Restore all" (`cleanup_restore {ids:[batchId]}`), summary line (first 6 names, +N, graph links, review notes, manifests), collapsible asset list with per-asset "Restore" and file list in the title. Restore toast "restored N asset(s) · K conflict(s): <first>" (error style when conflicts). Empty text "The trash is empty. Removed assets (art_cleanup apply, and single deletes) land here and can be restored."
- [ ] C6 Disk usage: tiles (assets + exports total, each `other` entry), bars By kind / By project / By group (top 14, `count · size`, kind colours), Biggest (top 14; click closes the dialog and opens the asset), hint line about ☐ Select.
- [ ] C7 Settings: textarea of allowed export folders (one absolute path per line) with the explanatory paragraph naming the workspace exports folder, checkbox "Single deletes (…) go to the trash too", config file path, Save (`cleanup_config {allow_paths, trash_deletes}`; toast "cleanup settings saved"). This write needs `source: 'user'`, so it needs the UI token (section 3.2).

### 1.9 Viewers (details in section 5)

- [ ] V1 Canvas editor / snapshot viewer (PixelView)
- [ ] V2 Animation player (incl. per-view grid and 8-direction compass)
- [ ] V3 Sheet preview (canvas and exported sheet PNG + JSON)
- [ ] V4 Rig viewer (clip + skeleton, pose, parts sheet, skin mesh + weights)
- [ ] V5 Layers view (stack, debug tint, overlaps, hover, z lanes, flag layering)
- [ ] V6 3D model viewer (three.js, lazy; WebGL fallback image)
- [ ] V6b `(new)` 3D viewport shading modes: Wireframe, Solid, Material preview, Rendered (shadows, AO, baked AO / lightmap), section 5.7b
- [ ] V7 Audio player (waveform, spectrum, selection, analysis)
- [ ] V8 Asset graph
- [ ] V9 Export preview (png, sheet, gif, json/mcmeta/txt, glb → V6, audio → V7, other "No preview for .ext files.")
- [ ] V10 Project overview grid

### 1.10 Keyboard and pointer

Global key handler rules, in this exact order (`App.setupKeys`):

- [ ] K1 Focus in `input | textarea | select | contenteditable`: only `Esc` acts (blurs the field).
- [ ] K2 A dialog other than Help is open: only `Esc` acts (closes it).
- [ ] K3 `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` redo, `Ctrl/Cmd+Y` redo → slot A viewer's `undo(redo)`; default prevented.
- [ ] K4 Any other combination with Ctrl / Cmd / Alt is ignored. `(new, Review 2)`: one exception, checked just before this rule: `Ctrl/Cmd+K` opens the command palette (RV1); default prevented.
- [ ] K5 `Esc`, first match wins: leave review mode → close Help → close compare → snapshot back to live.
- [ ] K6 `Space` while a pixel canvas has focus is left to the canvas (hold-space panning).
- [ ] K7 The slot A viewer gets the key next (`keydown(e, key)`; key is lower-cased for single characters, `' '` for space). If it returns true the event is consumed.
- [ ] K8 `Shift+G` graph.
- [ ] K9 Tool keys when slot A is the canvas editor: `B` pencil, `E` eraser, `G` fill, `L` line, `R` rectangle, `I` picker, `H` hand.
- [ ] K10 `F` follow toggle, `C` compare toggle, `M` review mode, `/` filter assets, `?` help, `P` dock, `[` `]` panes, `O` project overview of the open canvas (when it has a project), `1`–`5` tabs of slot A.

Viewer keys:

- [ ] K11 Canvas: `+` / `=` zoom in, `-` zoom out, `0` fit, `#` grid, `T` tile 3×3, `,` `.` previous / next frame, `N` onion skin.
- [ ] K12 Animation: `Space` play / pause. Rig: `Space`. Layers: `,` `.` frame. Model: `Space` play / pause clip, `W` wireframe, `0` reset view; `(new)` `1`–`4` shading mode, `Z` shading pie, `Numpad1/3/7/9` view presets, `Numpad.` / `Home` frame model (5.7b). Audio: `Space`. Graph: `0` fit. Canvas while comparing `(new, RV7)`: `D` cycles the compare overlay, `X` swaps in Blink.

Pointer:

- [ ] K13 Canvas: wheel = zoom at cursor through the fixed zoom ladder; Shift+wheel = horizontal pan; middle / right drag, Space+drag, hand tool = pan; double-click = fit; Shift while dragging a rectangle = filled; context menu suppressed.
- [ ] K14 Graph: wheel zoom at cursor (0.05..6), drag background = pan, drag node = move and pin it, click = select, double-click node = open, double-click group = collapse / expand.
- [ ] K15 Audio: click = seek, drag = select a range (threshold 0.5% of the duration).

Help dialog content must list exactly the legacy text (three groups: Everywhere, Canvas, Players, plus the two footnotes), extended with anything `(new)`.

### 1.11 URL state

- [ ] U1 Hash formats written with `history.replaceState` when slot A changes (not for snapshots): canvas `#<encodeURIComponent(name)>`, graph `#graph`, others `#<kind>:<encodeURIComponent(name)>`.
- [ ] U2 Hash formats read: `#graph`; `#(project|model|rig|audio|export|canvas):<name>`; anything else = canvas name. The whole hash is `decodeURIComponent`-ed first.
- [ ] U3 `hashchange` opens the target when its id differs from the open one, without rewriting the hash.
- [ ] U4 The server and the MCP hand out `http://localhost:<port>/#<canvas>` and `/#project:<name>` links (`src/engine.js` `uiHint`, `src/mcp.js` `art_open_ui`). These must keep working unchanged.

### 1.12 Persisted state

Browser `localStorage`, key prefix `agent-art:` (JSON values; reads and writes never throw):

- [ ] S1 `follow`, `followOn`, legacy plain key `agent-art-follow` (string; value `asset` maps to `canvas`)
- [ ] S2 `panes`, `dock`, `sizes`
- [ ] S3 `collapsed`, `expanded`, `showHidden`
- [ ] S4 `tlFilter`
- [ ] S5 `grid` (canvas pixel grid), `fps` (animation fps for untagged frames), `dirgrid` (per-view grid), `ovSize` (project tile size)
- [ ] S6 `graphCollapsed`, `graphHiddenRels` (default `['layer_of']`), `graphSub`, `graphLayout`
- [ ] S6b `(new)` keys added by this plan, same prefix: `modelView` (5.7b), `volume`, `audioLoop` (5.8), `graphRenderer` (`'auto' | 'cards' | 'canvas'`, 5.9b), `recentColors` (max 12 `#rrggbbaa`, 5.2), `recent` (last 8 opened target hashes, command palette). `graphLayout` gains the value `'hierarchy'` (5.9b); an unknown stored value falls back to `'force'`.

Server, per workspace (`<home>/ui-state.json`):

- [ ] S7 `hidden: string[]`, `pinned: string[]` (asset ids; server keeps strings <= 200 chars, max 5000, deduplicated). Written with `POST /api/ui-state`; a failed save toasts "Could not save the hidden / pinned state". Reloaded on the `ui-state` SSE event (another tab, or cleanup moving pins).

Not persisted (session only): solo set, compare state, review mode, tool, colour, selection, timeline search text, expanded timeline rows, per-viewer toggles other than S5/S6.

### 1.13 SSE events handled (`App.onEvent` + viewers)

- [ ] E1 `hello` → status refresh.
- [ ] E2 `activity {entry}` → timeline upsert; if `entry.source !== 'user'` mark agent busy; if `entry.type === 'op' && entry.source === 'agent' && entry.ok !== false` → follow.
- [ ] E3 `ui-state` → reload ui-state.
- [ ] E4 `graph` → reload reviews when `ev.review || ev.action === 'approve'`; always refresh assets.
- [ ] E5 `change | deleted | model | audio | project` → refresh assets (debounced 350 ms).
- [ ] E6 `change` with `source === 'agent'` → flash the browser row.
- [ ] E7 Every event except `hello`, `activity`, `ui-state` is forwarded to both slot viewers' `onEvent`.
- [ ] E8 `change` for the open canvas while a non-edit view is shown → inspector refresh.
- [ ] E9 Unknown types (`anim_library`, `planet`, anything future) are ignored without error. `(new)`: they also trigger the debounced asset refresh, since they can add exports.

Follow (`App.follow`), must be reproduced exactly:

- [ ] E10 Skipped when follow is off or a dialog other than Help is open.
- [ ] E11 Candidates: entry assets of kind canvas / model / audio / rig that are not hidden, pass the solo filter, and are not deleted. Pick the first canvas with `after`, else the first with `after`, else the first.
- [ ] E12 Mode `project`: if the asset is a canvas with a project and that project overview is not already open, open it; otherwise do nothing.
- [ ] E13 Mode `canvas`: rig assets map to canvas `<rig>_parts`. No-op when the live target is already open. When following from one canvas to another, keep the current view unless it is `layers`.

### 1.14 API endpoints called by the UI

- [ ] A1 `GET /api/assets`, `GET /api/ui-state`, `POST /api/ui-state`, `GET /api/reviews`, `GET /api/activity?limit=600`, `GET /api/events` (SSE)
- [ ] A2 `POST /api/op` with ops: `create`, `draw`, `undo`, `layer`, `review_add`, `review_update`, `review_delete`, `review_approve`, `cleanup_plan`, `cleanup_apply`, `cleanup_trash`, `cleanup_restore`, `cleanup_empty`, `cleanup_usage`, `cleanup_config`
- [ ] A3 `GET /api/canvas/<n>`, `/api/canvas/<n>/png` (`t`, `v`, `layer`, `frame`, `download`), `/api/canvas/<n>/anim.gif` (`scale=4`, `download=1`, `animation`)
- [ ] A4 `GET /api/snapshot/<id>`, `/api/snapshot/<id>.png`
- [ ] A5 `GET /api/project/<n>`
- [ ] A6 `GET /api/rig/<n>`, `/preview.png` (`pose`, `view`, `t`), `/weights.png` (`mesh`, `bone`, `view`, `t`), `/layers` (`canvas`, `tag`, `view`), `/debug` (`canvas`, `tag`, `view`, `frame`)
- [ ] A7 `GET /api/model/<n>/glb` (`snap`, `profile=three`, `bake=1`, `download=1`), `/thumb.png` (`v`, `size=384`, `snap`), `/info`
- [ ] A8 `GET /api/audio/<n>`, `/api/audio/<n>.wav` (`t`, `download=1`), `/api/audio/<n>/analysis`
- [ ] A9 `GET /api/export-file?path=` (`download=1`, `m`)
- [ ] A10 `GET /api/graph`, `/api/graph/node?id=`
- [ ] A11 `GET /api/review-image/<file>`
- Not called today, used by this plan: `GET /api/health` (restart detection). Not called and not needed: `/api/canvases`, `/api/log`, `POST /api/trace`.

### 1.15 Token handling

- [ ] X1 The served page carries `<meta name="agent-art-ui-token" content="<48 hex>">` (per server process). `POST /api/op` sends header `x-agent-art-ui: <token>` and body `source: 'user'`. Without a valid token + same-origin `Origin` the server silently treats the caller as `agent` (ops still run; user-only settings such as `cleanup_config {allow_paths}` are refused).
- [ ] X2 `POST /api/ui-state` needs no token (local origin + JSON content type only).
- [ ] X3 Dev (`npm run dev:ui`): the Vite plugin copies the meta tag from the running server's page and rewrites `Origin` in the proxy.

### 1.16 Responsive behaviour

- [ ] N1 <= 1100 px: `--side-w: 300px`, `--browser-w: 230px`, workspace path hidden.
- [ ] N2 <= 860 px: both side panes become fixed drawers under the top bar (`min(86vw, 340px)` wide, shadow); the two pane-toggle buttons appear; vertical splitters hidden; compare stacks top / bottom; the Layers view's side list moves below the stage; brand hidden; top bar buttons get tighter padding and the bar scrolls horizontally.
- [ ] N3 (quirk) Drawers are toggled through the same `no-browser` / `no-side` classes as desktop pane visibility, with inverted meaning, and share the persisted `panes` value. Fix: separate, unpersisted drawer state (section 2.6).
- [ ] N4 Bottom timeline dock also works in the narrow layout (`docs/ui/17-follow-timeline-bottom.png`).

### 1.17 Other behaviour to keep

- [ ] O1 Toasts: bottom centre, stacked; info / ok 3.5 s, error 6 s, 0.5 s fade; every failed `api()` op toasts `<op>: <error>`.
- [ ] O2 Paint state is global: tool and colour are shared by both slots; setting a colour while on eraser, picker or hand switches to pencil; alpha comes from the alpha slider (`#rrggbbaa`).
- [ ] O3 User edits go through the same ops as the agent (`draw`, `undo`, `layer`), so they appear in the timeline as user entries.
- [ ] O4 Thumbnails are version-keyed (`?v=`) so the browser caches them; they load lazily.

### 1.18 Additions from Review 2 `(new)`

None of these replaces a legacy behaviour; each is an addition and is listed in the CHANGELOG. Where each is specified is in brackets.

- [ ] RV1 Command palette, `Ctrl/Cmd+K`: fuzzy jump to any asset, plus every shell action (step 18b).
- [ ] RV2 Asset row context menu (right-click, `Shift+F10`, long-press): Open, Open in compare, view tabs, Pin, Hide, Solo, Show in graph, Add review note, Copy name, Copy link, Select, Plan cleanup (step 15).
- [ ] RV3 Drag an asset row onto a viewer slot to open it there; dropping on the right edge of the viewers area starts a comparison (step 15).
- [ ] RV4 Asset graph "Cards" renderer (thumbnail cards, minimap, zoom controls, keyboard-focusable nodes) and a "Hierarchy" layout; the canvas renderer stays and is used automatically for large graphs (5.9b, step 10b).
- [ ] RV5 Colour picker popover in the canvas editor: saturation / hue / alpha in one control, hex field, palette and recent colours, screen eyedropper where the browser has one (5.2).
- [ ] RV6 Timeline and asset browser are virtualised with one library; the timeline shows every filtered entry (the 400-row cap of TL4 goes away) (steps 13–15).
- [ ] RV7 Compare tools for two canvases of the same size: linked zoom / pan / frame, and an overlay (Difference, Swipe, Blink) with a changed-pixel count (5.1, step 18c).
- [ ] RV8 3D viewport: view presets (front / right / top / opposite), axis gizmo, frame model, Overlays master toggle, Solid lighting choice MatCap / Studio (the legacy look) / Flat (5.7b).
- [ ] RV9 JSON is syntax-coloured wherever it is shown (export preview, timeline args, inspector meta) (5.10).
- [ ] RV10 Rig pose and skin-weight images are shown in a zoomable, pannable view instead of a plain image (5.5).

---

## 2. Target architecture

### 2.1 Directory tree

```
web/
  index.html                      shell page: <div id="app">, favicon, <script type="module" src="/src/main.ts">
  plan.md
  src/
    main.ts                       imports styles, mounts App.svelte, sets window.agentArt
    App.svelte                    layout grid, panes, slots, DialogHost, Toasts, global listeners
    styles/
      tokens.css                  CSS variables (section 4.1)
      base.css                    reset, typography, global primitives (.btn, .chip, .badge, inputs, .kv, utilities)
      viewers.css                 styles for the DOM that viewer classes build (.viewer, .vtoolbar, .stage, ...)
    lib/
      api/
        types.ts                  all request / response / event types (section 3)
        http.ts                   token, getJSON, postJSON, ApiError
        client.ts                 one typed function per endpoint + op()
        urls.ts                   URL builders (no fetch): canvasPng, thumb, snapshotPng, modelGlb, ...
        events.ts                 EventStream (SSE + reconnect)
      util/
        format.ts                 fmtMs, fmtTime, fmtBytes, clamp, debounce, rafBatch
        ids.ts                    assetId, splitId, idOfTarget
        storage.ts                store.get / store.set (prefix agent-art:)
        dom.ts                    h() element builder (typed port of el()), icon()
        checker.ts                checker(ctx, x, y, w, h, cell)
        playlist.ts               playList(info, tag, fps)
        kinds.ts                  KIND_ICON, KIND_COLOR, KIND_LABEL
        hash.ts                   targetToHash, hashToTarget
        targets.ts                targetFor, viewerKindFor, tabsFor, switchViewTarget, reviewTarget, followTarget, snapTarget
        icons.ts                  name -> raw SVG string (lucide-static, ?raw imports)
        contrast.ts               WCAG contrast helper (used by tokens.test.ts)
        jsonTokens.ts             tokenizeJson(text) for syntax-coloured JSON (RV9)
    state/
      connection.svelte.ts        status, lastAgentAt, serverPid, restart banner flag
      assets.svelte.ts            asset index + lookups + flags
      uiState.svelte.ts           hidden / pinned (server) + solo (session)
      reviews.svelte.ts           reviews, counts, approved, marks
      activity.svelte.ts          entries, order, filters, derived rows
      editor.svelte.ts            tool, colour, reviewMode
      layout.svelte.ts            sizes, panes, dock, narrow, drawer
      workspace.svelte.ts         slots A/B, open(), compare, follow, inspected target, hash sync
      toasts.svelte.ts            toast queue
      dialogs.svelte.ts           dialog stack + promise helpers
      prefs.svelte.ts             small persisted prefs (follow mode, showHidden, collapsed, expanded)
      live.ts                     wires EventStream -> stores -> viewers (the only place that knows event routing)
      shortcuts.ts                global key handler (pure decision function + installer)
      boot.ts                     boot sequence (P2, P3)
    components/
      ui/                         Button, IconButton, Chip, Badge, CountBadge, Toggle, Field, Kbd, Icon, Spinner,
                                  Tabs, Dialog, ConfirmDialog, PromptDialog, Tooltip, Menu, Toasts, Splitter,
                                  PaneHeader, EmptyState, ErrorNote, KV, VirtualList (wrapper over virtua),
                                  ContextMenu, JsonView
      shell/                      TopBar, StatusPill, FollowControl, OverflowMenu, Banner
      browser/                    AssetBrowser, AssetRow, SectionHeader, NewCanvasForm, SelectionBar, tree.ts
      timeline/                   Timeline, TimelineFilters, TimelineEntry, EntryThumbs, EntryDetails, timeline.ts
      inspector/                  Inspector, InspectorActions, CanvasInspector, SnapshotInspector, ModelInspector,
                                  RigInspector, AudioInspector, ProjectInspector, ExportInspector, ReviewSection,
                                  ReviewCard, Relations, PreviewCanvas, LayerList, Palette, Swatch
      viewers/                    ViewerSlot, SlotHeader, ViewerHost
      dialogs/                    DialogHost, HelpDialog, ReviewNoteDialog, ReviewListDialog, PlanCleanupDialog,
                                  CleanupDialog, TrashTab, UsageTab, SettingsTab, CommandPalette (+ commands.ts)
    viewers/
      types.ts                    Viewer, ViewerProps, ViewerEnv, ViewerHostApi, Target, Tool
      base.ts                     BaseViewer (disposables, timers, resize + DPR observers, load tokens)
      controls.ts                 DOM builders for viewer toolbars: button, toggle, select, range, group, spacer
      registry.ts                 viewerKindFor(target) -> loader
      pixel/PixelView.ts          + pixel/diff.ts (RV7)
      canvas/CanvasViewer.ts      + canvas/colorPicker.ts (RV5)
      anim/AnimViewer.ts          + anim/directions.ts
      sheet/SheetViewer.ts        + sheet/drawSheet.ts
      rig/RigViewer.ts
      layers/LayersViewer.ts      + layers/stack.ts
      model/ModelViewer.ts        + model/three.ts, model/channels.ts, model/clusters.ts, model/shading.ts, model/views.ts
      audio/AudioViewer.ts        + audio/fft.ts, audio/wav.ts
      graph/GraphViewer.ts        + graph/sim.ts, graph/CanvasRenderer.ts, graph/hierarchy.ts (dagre, lazy),
                                  graph/flow/{mountFlow.ts, bridge.svelte.ts, FlowGraph.svelte, AssetNode.svelte, RelEdge.svelte} (5.9b, lazy)
      export/ExportViewer.ts
      project/ProjectViewer.ts
    test/                         shared test helpers (fake fetch, fake EventSource, fixtures)
e2e/                              (repo root) Playwright
  tsconfig.json
  global-setup.ts                 temp home, seed, start server, write state file
  global-teardown.ts
  seed.ts                         the seed workspace (CLI calls)
  cli.ts                          runTool(name, args) helper: always --home and --port
  app.page.ts                     page object (the only file with selectors)
  smoke.spec.ts, viewers.spec.ts, timeline.spec.ts, review.spec.ts, cleanup.spec.ts, narrow.spec.ts,
  model3d.spec.ts, keyboard.spec.ts, reconnect.spec.ts, screenshots.spec.ts
playwright.config.ts
scripts/pw.mjs                    Playwright launcher that sets PLAYWRIGHT_BROWSERS_PATH
scripts/check-ui-build.js         budgets + pack contents
scripts/vite-notices.js           Vite build plugin: THIRD-PARTY-NOTICES.txt + licence allow-list (step 1)
```

Unit tests live next to their module as `*.test.ts` (Vitest root is `web/`). Tests that use runes are named `*.svelte.test.ts`.

Import alias: `@` → `web/src` (add to `vite.config.js` `resolve.alias` and to `tsconfig.json` `compilerOptions.paths` as `"@/*": ["./web/src/*"]`). `(Review 2)`: do **not** add `"baseUrl"`: the installed TypeScript is 6.0.3, where `baseUrl` is deprecated and reports an error; `paths` entries that start with `./` resolve relative to the tsconfig file without it.

### 2.2 Core types (`web/src/viewers/types.ts`)

```ts
import type { AssetIndex, ServerEvent, ReviewMark } from '@/lib/api/types';

export type SlotId = 'A' | 'B';
export type Tool = 'pencil' | 'eraser' | 'fill' | 'line' | 'rect' | 'picker' | 'hand';
export type CanvasView = 'edit' | 'anim' | 'sheet' | 'layers';

export type Target =
  | { kind: 'canvas'; name: string; view?: CanvasView; tag?: string; frame?: number; snap?: string; label?: string }
  | { kind: 'rig'; name: string; view?: 'layers'; mode?: 'clip' | 'pose' | 'parts' | 'skin'; clip?: string; canvas?: string; tag?: string; frame?: number }
  | { kind: 'model'; name: string; clip?: string; snap?: string; label?: string }
  | { kind: 'audio'; name: string }
  | { kind: 'project'; name: string }
  | { kind: 'export'; name: string }            // name = path relative to the exports folder
  | { kind: 'graph'; focus?: string };

export type ViewerKind = 'canvas' | 'anim' | 'sheet' | 'layers' | 'rig' | 'model' | 'audio' | 'graph' | 'export' | 'project';

/** Reactive values a viewer may need; a new object is passed on every change. */
export interface ViewerEnv {
  tool: Tool;
  color: { hex: string; hex8: string };
  reviewMode: boolean;
  following: boolean;
  reviewsRev: number;      // bumps when review notes reload (redraw marks)
  assetsRev: number;       // bumps when the asset index reloads
  // Review 2 (RV7, compare tools; all three are inert unless both slots are open)
  compareLink: boolean;    // mirror zoom / pan / frame between the slots
  compareOverlay: 'off' | 'diff' | 'swipe' | 'blink';   // only slot A draws the overlay
  peerRev: number;         // bumps when the other slot's viewer called host.notifyPeer() (its image changed)
}

export interface ViewerProps { target: Target; env: ViewerEnv }

export interface ReviewDraft {
  asset: string;
  frame?: number; view?: string; tag?: string; layer?: string; part?: string; clip?: string;
  region?: [number, number, number, number]; point?: [number, number]; time?: [number, number];
  image?: string;          // data URL
  where?: string; category?: string; priority?: 'low' | 'normal' | 'high'; note?: string;
  compare_with?: string; compare_view?: string;
}

/** What a viewer may ask of the app. Implemented once in state/workspace.svelte.ts. */
export interface ViewerHostApi {
  readonly slot: SlotId;
  readonly readOnly: boolean;
  assets(): AssetIndex | null;
  isHidden(id: string): boolean;
  reviewMarks(asset: { kind: string; name: string }): ReviewMark[];
  open(target: Target, opts?: { slot?: SlotId }): void;
  openNode(id: string): void;
  inspectNode(id: string): void;
  requestReview(draft: ReviewDraft): void;
  setTool(tool: Tool): void;
  setColor(hex: string): void;            // #rrggbb or #rrggbbaa
  canvasInfoChanged(name: string): void;  // replaces legacy app.inspector.refreshFor(viewer)
  toast(text: string, kind?: 'info' | 'ok' | 'error'): void;
  // Review 2 (RV7)
  peerViewer(): Viewer | null;            // the viewer in the other slot, or null
  notifyPeer(): void;                     // "my image changed": bumps peerRev for the other slot
  compareStatus(text: string | null): void;   // shown in slot B's header, e.g. "1 234 px differ (3.1%)"
  setCompareOverlay(mode: 'off' | 'diff' | 'swipe' | 'blink'): void;   // the D key (step 18c)
}

/** Review 2 (RV7): implemented by CanvasViewer only. */
export interface LinkState { zoom: number; cx: number; cy: number; frame: number }   // cx, cy = image pixel at the stage centre
export interface CompareImage { image: ImageBitmap; rect: Rect; key: string }        // rect = the shown frame inside the strip

export interface Viewer {
  /** Build DOM inside el and load props.target. Called exactly once. */
  mount(el: HTMLElement, props: ViewerProps): void | Promise<void>;
  /** New target and/or env. Must be cheap when nothing relevant changed. */
  update(props: ViewerProps): void | Promise<void>;
  /** Remove DOM, listeners, observers, timers, rAF, GPU and audio resources. Idempotent. */
  destroy(): void;
  onEvent?(ev: ServerEvent): void;
  /** Return true when the key was handled. key: lower-cased single char, ' ' for space, else e.key. */
  onKey?(e: KeyboardEvent, key: string): boolean;
  undo?(redo: boolean): void;
  // Review 2 (RV7): optional, CanvasViewer only
  applyLinkState?(s: LinkState): void;      // must not echo back to the peer
  compareImage?(): CompareImage | null;     // the bitmap stays owned by the viewer that returned it; never close() it
  debugInfo?(): unknown;                    // test / support hook (5.7b, 5.9b)
}

export type ViewerCtor = new (host: ViewerHostApi) => Viewer;
```

Rules for every viewer class:

- Constructor takes only `host`. No DOM work before `mount`.
- `update` compares `props.target` with the previous one via `targetKey(target)` (JSON of the fields that viewer cares about). Different key → load. Same key → only apply env changes.
- Every async load takes `const token = this.nextLoad()` and returns early with `if (!this.isCurrent(token)) return;` after each `await`. (Legacy has several races; this closes them.)
- Never import a `.svelte` or `.svelte.ts` file from a viewer. Viewers know only `ViewerHostApi`, `lib/api`, `lib/util`. `(Review 2)`: one exception, confined to one file: `viewers/graph/flow/mountFlow.ts` mounts the Svelte Flow renderer (5.9b). The components under `graph/flow/` get everything through props and callbacks and must not import anything from `state/` or `components/`.
- Errors during load are shown inside the viewer (`.vstatus` line or an `.empty-note`) **and** rethrown from `mount`/`update` so `ViewerHost` can toast `"<name>: <message>"` (legacy `App.open` does that).

`BaseViewer` (`web/src/viewers/base.ts`):

```ts
export abstract class BaseViewer implements Viewer {
  protected root!: HTMLElement;
  protected props!: ViewerProps;
  protected readonly dispose = new AbortController();   // pass { signal: this.dispose.signal } to every addEventListener
  constructor(protected readonly host: ViewerHostApi) {}
  mount(el: HTMLElement, props: ViewerProps) { this.props = props; this.root = this.build(); el.append(this.root); return this.load(props.target, null); }
  update(props: ViewerProps) { const prev = this.props; this.props = props; if (this.key(props.target) !== this.key(prev.target)) return this.load(props.target, prev.target); this.envChanged(prev.env, props.env); }
  destroy() { if (this.dead) return; this.dead = true; this.dispose.abort(); for (const f of this.cleanups.splice(0)) f(); this.root?.remove(); }
  protected abstract build(): HTMLElement;
  protected abstract load(target: Target, prev: Target | null): void | Promise<void>;
  protected envChanged(_prev: ViewerEnv, _next: ViewerEnv): void {}
  protected key(t: Target): string { return JSON.stringify(t); }
  protected nextLoad(): number; protected isCurrent(token: number): boolean;
  protected later(ms: number, fn: () => void, slot?: string): void;   // named slot = debounce; cleared on destroy
  protected frame(fn: (t: number) => void): void;                     // rAF loop, cancelled on destroy
  protected onResize(el: Element, fn: () => void): void;              // ResizeObserver, rAF-coalesced, disconnected on destroy
  protected onDprChange(fn: () => void): void;                        // matchMedia('(resolution: Xdppx)') re-armed on change
  protected addCleanup(fn: () => void): void;
}
```

### 2.3 Viewer registry (`web/src/viewers/registry.ts`)

```ts
export function viewerKindFor(t: Target): ViewerKind | null;
// canvas: snap ? 'canvas' : ({edit:'canvas', anim:'anim', sheet:'sheet', layers:'layers'})[t.view ?? 'edit'] ?? 'canvas'
// rig: t.view === 'layers' ? 'layers' : 'rig'
// model -> 'model'; audio -> 'audio'; project -> 'project'; graph -> 'graph'
// export: /\.glb$/i -> 'model'; /\.(wav|mp3|ogg|opus)$/i -> 'audio'; else 'export'

export function loadViewer(kind: ViewerKind): Promise<ViewerCtor>;
// 'canvas' is a static import (it is the default view). Every other kind is `() => import('./x/XViewer')`
// so each becomes its own chunk. Cache the promise per kind.
```

### 2.4 Stores (`web/src/state/*.svelte.ts`)

Pattern: one class per store with `$state` fields, exported as a singleton. Server payloads use `$state.raw` (no deep proxies). No store imports a component. Stores may import other stores, `lib/api`, `lib/util`.

```ts
// connection.svelte.ts
export type ConnStatus = 'connecting' | 'live' | 'busy' | 'down';
class Connection {
  phase = $state<'connecting' | 'open' | 'down'>('connecting');
  lastAgentAt = $state(0);
  now = $state(Date.now());                 // ticked every 1000 ms by boot.ts
  serverPid = $state<number | null>(null);
  restarted = $state(false);                // server pid changed since boot
  uiOutdated = $state(false);               // a newer build is being served
  attempt = $state(0);
  get status(): ConnStatus;                 // down | connecting | (now - lastAgentAt < 2500 ? busy : live)
  get label(): string;                      // 'connecting…' | 'live' | 'agent is working…' | 'disconnected — retrying'
}
export const connection: Connection;

// assets.svelte.ts
class Assets {
  index = $state.raw<AssetIndex | null>(null);
  loading = $state(true);
  error = $state<string | null>(null);
  rev = $state(0);
  refresh(): Promise<void>;                 // GET /api/assets; keeps the old index on failure
  refreshSoon(): void;                      // debounce 350 ms
  canvas(name: string): CanvasSummary | undefined;      // via a Map rebuilt on refresh
  rig(name: string): RigSummary | undefined;
  model(name: string): ModelSummary | undefined;
  isSuperseded(id: string): boolean; isOrphan(id: string): boolean;
  choices(): string[];                      // canvas:, model:, rig:, audio: ids (review compare suggestions)
  allTags(): string[];
}
export const assets: Assets;

// uiState.svelte.ts
class UiState {
  hidden = $state.raw<ReadonlySet<string>>(new Set());
  pinned = $state.raw<readonly string[]>([]);
  solo = $state.raw<ReadonlySet<string>>(new Set());
  load(): Promise<void>;                    // GET /api/ui-state
  isHidden(id: string): boolean; isPinned(id: string): boolean; isSolo(id: string): boolean;
  toggleHidden(id: string): void; togglePinned(id: string): void;   // optimistic, then save(); pin = unshift
  toggleSolo(id: string): void; clearSolo(): void;
  visible(id: string, showHidden: boolean): boolean;                // solo filter then hidden filter
  private save(): Promise<void>;            // POST; on failure toast 'Could not save the hidden / pinned state' and reload from server
}
export const uiState: UiState;

// reviews.svelte.ts
export const ACTIVE_REVIEW = new Set(['open', 'in_progress', 'reopened']);
class Reviews {
  list = $state.raw<Review[]>([]);
  counts = $state.raw<Record<string, number>>({});
  approved = $state.raw<ReadonlySet<string>>(new Set());
  rev = $state(0);
  refresh(): Promise<void>; refreshSoon(): void;        // debounce 200 ms
  get openCount(): number;
  forAsset(id: string): Review[];                       // asset or compare_with.asset, newest update first
  marks(asset: { kind: string; name: string }): ReviewMark[];   // statuses open, in_progress, reopened, fixed
  sortedAll(): Review[];                                // active first, then updated desc
}
export const reviews: Reviews;

// activity.svelte.ts
export interface TimelineFilter { tool: string; errors: boolean; current: boolean; agent: boolean }
class Activity {
  version = $state(0);                      // bumped at most once per animation frame (rafBatch)
  filter = $state<TimelineFilter>(store.get('tlFilter', { tool: '', errors: false, current: false, agent: false }));
  search = $state('');
  expanded = $state.raw<ReadonlySet<number>>(new Set());
  load(entries: ActivityEntry[]): void;
  upsert(entry: ActivityEntry): void;       // plain Map + order array; trims to 3000
  reset(): void;                            // server restart: ids start again from 1
  get(id: number): ActivityEntry | undefined;
  get lastId(): number;
  rows(currentName: string | null): { shown: ActivityEntry[]; total: number; errors: number; tools: string[] };
  setFilter(patch: Partial<TimelineFilter>): void;      // persists tlFilter
  toggleExpanded(id: number): void;
}
export const activity: Activity;

// editor.svelte.ts
class Editor {
  tool = $state<Tool>('pencil');
  color = $state.raw({ hex: '#4a7c3a', hex8: '#4a7c3aff' });
  reviewMode = $state(false);
  setTool(t: Tool): void;
  setColor(hex: string): void;              // normalises to hex8; eraser/picker/hand -> pencil
}
export const editor: Editor;

// layout.svelte.ts
class Layout {
  sizes = $state<Record<'browser-w' | 'side-w' | 'insp-h' | 'bottom-h', number | null>>(...);   // null = CSS default
  panes = $state<{ browser: boolean; side: boolean }>(store.get('panes', { browser: true, side: true }));
  dock = $state<'right' | 'bottom'>(store.get('dock', 'right'));
  narrow = $state(false);                   // matchMedia('(max-width: 860px)')
  drawer = $state<'browser' | 'side' | null>(null);     // narrow only, never persisted
  togglePane(which: 'browser' | 'side'): void;          // narrow: toggles drawer; wide: toggles panes + persists
  toggleDock(): void;
  setSize(key, px: number): void; commitSizes(): void; resetSize(key): void;
}
export const layout: Layout;

// workspace.svelte.ts
interface Slot { target: Target | null; error: string | null }
class Workspace {
  slots = $state<{ A: Slot; B: Slot }>(...);
  comparing = $state(false);
  compareLink = $state(true);                           // RV7, session only
  compareOverlay = $state<'off' | 'diff' | 'swipe' | 'blink'>('off');   // RV7, session only; reset to 'off' when compare closes
  compareStatus = $state<string | null>(null);          // RV7, text from the slot A viewer
  peerRev = $state({ A: 0, B: 0 });                     // RV7: notifyPeer() from slot X bumps the other slot's counter
  recent = $state.raw<string[]>(store.get('recent', []));   // RV1: last 8 opened target hashes, newest first
  inspected = $state.raw<Target | null>(null);          // what the inspector shows (slot A target, or a graph node)
  followMode = $state<'canvas' | 'project' | 'off'>(...);
  get current(): Target | null; get currentId(): string | null; get following(): boolean;
  open(target: Target, opts?: { slot?: SlotId; history?: boolean }): void;
  openNode(id: string): void; inspectNode(id: string): void;
  switchView(slot: SlotId, view: string): void;         // L9
  setCompare(on: boolean): void; compare(a: Target, b: Target): void; swap(): void;
  backToLive(): void;
  setFollowMode(m): void; toggleFollow(): void;         // T5, T6 persistence rules
  follow(entry: ActivityEntry): void;                   // E10..E13
  openReview(r: Review): void; openReviewCompare(r: Review): void;
  viewer(slot: SlotId): Viewer | null;                  // registered by ViewerHost
  registerViewer(slot: SlotId, v: Viewer | null): void;
  hostApi(slot: SlotId): ViewerHostApi;
}
export const workspace: Workspace;

// toasts.svelte.ts
export interface Toast { id: number; text: string; kind: 'info' | 'ok' | 'error'; until: number }
export const toasts: { list: Toast[]; push(text: string, kind?: Toast['kind']): void; dismiss(id: number): void };
export const toast: (text: string, kind?: Toast['kind']) => void;

// dialogs.svelte.ts
export type DialogSpec =
  | { type: 'help' } | { type: 'reviewList' } | { type: 'palette' }   // palette: Review 2 (RV1)
  | { type: 'reviewNote'; draft: ReviewDraft; resolve(r: { id: string } | null): void }
  | { type: 'planCleanup'; ids: string[]; resolve(done: boolean): void }
  | { type: 'cleanup'; tab: 'trash' | 'usage' | 'settings' }
  | { type: 'confirm'; title: string; body?: string; confirmLabel: string; danger?: boolean; resolve(ok: boolean): void }
  | { type: 'prompt'; title: string; label: string; placeholder?: string; resolve(v: string | null): void };
class Dialogs {
  stack = $state.raw<DialogSpec[]>([]);
  get blocking(): boolean;                  // any dialog except help is open (K2, E10)
  get helpOpen(): boolean;
  toggleHelp(): void; openReviewList(): void; openCleanup(tab?): void;
  reviewNote(draft: ReviewDraft): Promise<{ id: string } | null>;
  planCleanup(ids: string[]): Promise<boolean>;
  confirm(o): Promise<boolean>; prompt(o): Promise<string | null>;
  close(spec: DialogSpec, result?: unknown): void;
}
export const dialogs: Dialogs;
```

### 2.5 Data flow

```
EventSource /api/events
   -> lib/api/events.ts EventStream (parse, reconnect, status callbacks)
   -> state/live.ts route(ev)
        hello            -> connection.phase = 'open'
        activity         -> activity.upsert; connection.lastAgentAt; workspace.follow(entry)
        ui-state         -> uiState.load()
        graph            -> reviews.refreshSoon() when ev.review || ev.action === 'approve'; assets.refreshSoon(); inspectorTick++
        change|deleted|model|audio|project|anim_library|planet|<unknown non-activity> -> assets.refreshSoon()
        change (agent)   -> browserFlash.emit('canvas:' + ev.canvas)
        every non-hello/activity/ui-state event -> workspace.viewer('A')?.onEvent(ev); workspace.viewer('B')?.onEvent(ev)
        change|model|audio|project for the inspected asset -> inspectorTick++ (debounced 150 ms)
   -> stores ($state) -> components ($derived / $effect) -> DOM
                      -> ViewerHost $effect -> viewer.update({ target, env })
User input -> component handler -> store method -> lib/api/client -> server -> SSE echo -> stores
```

Rules:

- `live.ts` is the only file that maps event types to store calls. Viewers get raw events via `onEvent`.
- Components never call `fetch` directly; they call store methods or `lib/api/client` functions.
- Writes are not optimistic, except hidden / pinned / solo (instant, as today). Canvas edits appear through the SSE `change` event, as today.
- `browserFlash` and `inspectorTick` are tiny signals exported from `live.ts` (`{ id: string; n: number }` in `$state.raw`, and a `$state` counter).

### 2.6 Components: props and events

Svelte 5 runes; callback props instead of events. All shell components read stores directly unless a prop is listed.

```ts
// components/ui
Button      { variant?: 'default' | 'primary' | 'ok' | 'warn' | 'danger' | 'ghost'; size?: 'sm' | 'md'; active?: boolean; disabled?: boolean;
              icon?: IconName; href?: string; download?: string; title?: string; shortcut?: string; type?: 'button' | 'submit'; onclick?; children? }
IconButton  { icon: IconName; label: string /* aria-label + tooltip */; shortcut?: string; active?: boolean; size?: 'sm' | 'md'; onclick? }
Chip        { active?: boolean; dim?: boolean; title?: string; onclick?; children }
Badge       { tone?: 'neutral' | 'review' | 'ok' | 'state' | 'old' | 'orphan'; title?: string; children }
Tabs        { tabs: { id: string; label: string; shortcut?: string }[]; value: string; onchange(id: string): void; label: string }
Dialog      { open: boolean; title: string; size?: 'md' | 'lg'; onclose(): void; initialFocus?: string /* selector */; children; footer? }
Splitter    { orientation: 'vertical' | 'horizontal'; sizeKey: 'browser-w' | 'side-w' | 'insp-h' | 'bottom-h'; sign: 1 | -1; label: string }
VirtualList { items: T[]; key(item: T): string; row: Snippet<[T, number]>; rowHeight?: number /* estimate; rows may differ */;
              shift?: boolean /* keep the reading position when items are added at the start (timeline) */; overscan?: number; class?: string;
              role?: string; label?: string; scrollToIndex?: (fn: (i: number) => void) => void }
            // Review 2: a thin wrapper over `virtua/svelte` (step 13). It is the only file that imports virtua.
ContextMenu { items: MenuItem[] | ((target: Element) => MenuItem[] | null); children }   // Bits UI ContextMenu; one instance per list, not per row
JsonView    { text: string; maxChars?: number }   // spans from lib/util/jsonTokens.ts, no {@html}
EmptyState  { title?: string; text: string; icon?: IconName }
KV          { rows: [string, unknown][] }   // skips undefined, null and ''

// components/viewers
ViewerSlot  { slot: SlotId }                // header + ViewerHost + empty / error / loading states
ViewerHost  { slot: SlotId; target: Target }

// components/browser
AssetRow    { row: TreeRow; onactivate(row: TreeRow, e: MouseEvent | KeyboardEvent): void }

// components/timeline
TimelineEntry { entry: ActivityEntry; ops: ActivityEntry[]; expanded: boolean; dimmed: boolean }

// components/inspector
ReviewCard  { review: Review; showAsset?: boolean; onnavigate?(): void }

// components/dialogs
ReviewNoteDialog  { spec: Extract<DialogSpec, { type: 'reviewNote' }> }
PlanCleanupDialog { spec: Extract<DialogSpec, { type: 'planCleanup' }> }
CleanupDialog     { spec: Extract<DialogSpec, { type: 'cleanup' }> }
```

`ViewerHost.svelte` logic (the only bridge between Svelte and viewer classes):

```ts
let { slot, target }: { slot: SlotId; target: Target } = $props();
let el: HTMLElement;
let viewer: Viewer | null = null; let kind: ViewerKind | null = null; let gen = 0;
let state = $state<'loading' | 'ready' | 'error'>('loading');
const env = $derived<ViewerEnv>({ tool: editor.tool, color: editor.color, reviewMode: editor.reviewMode,
  following: workspace.following, reviewsRev: reviews.rev, assetsRev: assets.rev,
  compareLink: workspace.comparing && workspace.compareLink,
  compareOverlay: workspace.comparing && slot === 'A' ? workspace.compareOverlay : 'off',
  peerRev: workspace.peerRev[slot] });                 // Review 2 (RV7)

$effect(() => {
  const props = { target, env };                       // tracked
  untrack(() => { void apply(props); });
});
async function apply(props: ViewerProps) {
  const k = viewerKindFor(props.target);
  if (k !== kind) {
    const my = ++gen;
    viewer?.destroy(); viewer = null; workspace.registerViewer(slot, null); kind = k; state = 'loading';
    if (!k) return;
    const Ctor = await loadViewer(k);
    if (my !== gen) return;                            // a newer target won while the chunk loaded
    viewer = new Ctor(workspace.hostApi(slot)); workspace.registerViewer(slot, viewer);
    try { await viewer.mount(el, props); state = 'ready'; } catch (e) { fail(e, props.target); }
  } else if (viewer) {
    try { await viewer.update(props); } catch (e) { fail(e, props.target); }
  }
}
onDestroy(() => { gen++; viewer?.destroy(); workspace.registerViewer(slot, null); });
```

`fail` toasts `"<name || kind>: <message>"` (legacy behaviour) and keeps the viewer mounted. A chunk that fails to load (`loadViewer` rejects) shows `EmptyState` "Could not load this viewer. Reload the page." with a Reload button.

Narrow drawers `(new, fixes N3)`: `layout.narrow` from `matchMedia('(max-width: 860px)')`. In narrow mode `[`, `]` and the two top bar buttons toggle `layout.drawer` (`'browser' | 'side' | null`, only one open). A scrim behind the drawer closes it on click; `Esc` closes it (inserted in K5 before "leave review mode"). Opening an asset from the browser drawer closes the drawer. The persisted `panes` value is only read and written in the wide layout.

### 2.7 Loading, empty and error states

| Place | Loading | Empty | Error |
| --- | --- | --- | --- |
| App boot | panes render immediately with skeleton rows (3 grey bars per pane); status pill "connecting…" | P2 empty state in slot A | assets request failed: slot A `EmptyState` "Cannot reach the Agent Art server" + Retry button; status pill red |
| Browser | 6 skeleton rows until the first index arrives | B11 text; "no matches" per section | keep the last index; error toast only on the first failure after a success |
| Timeline | none (fills in) | TL13 | activity fetch failure is silent (older servers) |
| Inspector | keep the previous content dimmed (`aria-busy`) until the new data arrives, max 150 ms before a spinner | I1 texts | I14 |
| Viewer slot | spinner overlay after 200 ms while a chunk or first load is pending | L6 text in slot B | toast + the viewer's own status line |
| Dialog bodies | "planning…", "loading…", "measuring…" (legacy texts) | C5 empty text | red message in the pane |
| Thumbnails | checker background | n/a | hide the broken image (TL7) or keep the kind icon |

### 2.8 Routing and URL state

No router library. `lib/util/hash.ts`:

```ts
export function targetToHash(t: Target): string | null;   // null for snapshots (U1)
export function hashToTarget(hash: string): Target | null; // U2; '' -> null
```

`workspace.open` with `history !== false` and slot A calls `history.replaceState(null, '', '#' + h)` when it differs. `App.svelte` listens to `hashchange` (U3). Compare state, view tab, tag, frame are not in the URL today and stay out of it (links handed out by the server keep their exact shape, U4).

---

## 3. Typed API layer

All in `web/src/lib/api/`. Derived from `src/server.js` (routes), `src/assets.js`, `src/activity.js`, `src/doc.js` `info()`, `src/review.js`, `src/graph.js` `toJSON` / `nodeInfo`, `src/cleanup.js`, `src/rigdebug.js`.

### 3.1 Conventions of the server

- JSON errors: `{ ok: false, error: string }`. Status is 400 for thrown errors inside a GET handler, 404 for missing things, 403 cross-origin POST, 415 wrong content type. **`POST /api/op` returns HTTP 200 with `{ ok: false, error }` when the op throws.**
- Every POST needs `content-type: application/json` and a local `Origin` (or none).
- All GET responses are `cache-control: no-store`, except canvas PNG with `?v=` (1 h), snapshot PNG and review images (1 day), built `assets/*` (immutable).
- Names in paths are `encodeURIComponent`-ed.

### 3.2 `http.ts`

```ts
export class ApiError extends Error { constructor(message: string, readonly status: number, readonly op?: string) }
export function uiToken(): string;                 // in-memory override, else <meta name="agent-art-ui-token">, else ''
export function refreshUiToken(): Promise<boolean>; // GET '/' (cache: 'no-store'), parse the meta tag, store in memory; true when it changed
export function getJSON<T>(url: string, init?: { signal?: AbortSignal }): Promise<T>;
//   throws ApiError when !res.ok or body.ok === false; a non-JSON body gives ApiError(`HTTP ${status}`)
export function postJSON<T>(url: string, body: unknown): Promise<T>;   // always sends content-type and x-agent-art-ui
export function getBitmap(url: string, init?: { signal?: AbortSignal }): Promise<ImageBitmap>;  // throws ApiError(`HTTP ${status} for ${url}`)
export function getArrayBuffer(url: string, init?): Promise<ArrayBuffer>;   // reads {error} from a JSON error body
export function getText(url: string, init?): Promise<string>;
```

Token rules:

- Header name `x-agent-art-ui`. Sent on every POST (the server ignores it where it is not needed).
- The token is read at call time, never cached at module load (the dev page and `refreshUiToken` can change it).
- After an SSE reconnect where `/api/health` reports a different `pid`, call `refreshUiToken()` before any further op (section 3.5). This keeps "user" attribution across a server restart without a page reload `(new)`.
- If `cleanup_config` fails with a message containing "set by the user", call `refreshUiToken()` once and retry once `(new)`.

### 3.3 `client.ts`: endpoints

```ts
// --- ops -----------------------------------------------------------------
export function op<K extends keyof OpMap>(name: K, args: OpMap[K]['args'], o?: { quiet?: boolean }): Promise<OpMap[K]['result']>;
// POST /api/op { op, args, source: 'user' }. On { ok:false } -> toast(`${op}: ${error}`) unless quiet, then throw ApiError.

export interface OpMap {
  create:          { args: { name: string; width: number; height: number }; result: { created: CanvasInfo; ui?: string } };
  draw:            { args: { canvas: string; commands: DrawCommand[]; label?: string; frame?: number }; result: { canvas: string; version: number; commands: number; dirty: Rect | null } };
  undo:            { args: { canvas: string; redo?: boolean }; result: unknown };
  layer:           { args: { canvas: string; action: 'select' | 'visibility' | 'blend'; layer: number; blend?: string }; result: unknown };
  review_add:      { args: ReviewAddArgs; result: { text: string; id: string } };
  review_update:   { args: { id: string; status: 'accepted' | 'reopened'; reply?: string }; result: { text: string } };
  review_delete:   { args: { id: string }; result: { text: string } };
  review_approve:  { args: { asset: string; approved: boolean }; result: { text: string } };
  cleanup_plan:    { args: { select: { ids: string[] }; include_exports: boolean; include_dependents: boolean; allow_approved: boolean; full: true }; result: CleanupPlan };
  cleanup_apply:   { args: { plan_id: string; confirm: true }; result: { removed: number; size: string; trash: string } };          // (UI-derived, src/cleanup.js apply)
  cleanup_trash:   { args: { full: true }; result: TrashList };
  cleanup_restore: { args: { ids: string[] }; result: { restored: number; conflicts?: string[] } };                                 // (UI-derived, restore)
  cleanup_empty:   { args: { confirm: true; older_than?: '1d' | '7d' | '30d' }; result: { emptied: number; size: string } };        // (UI-derived, empty)
  cleanup_usage:   { args: { full: true }; result: DiskUsage };
  cleanup_config:  { args: { allow_paths?: string[]; trash_deletes?: boolean }; result: CleanupConfig };
}
export type DrawCommand =
  | { op: 'pixels'; color: string; points: [number, number][] }
  | { op: 'fill'; x: number; y: number; color: string }
  | { op: 'line'; x1: number; y1: number; x2: number; y2: number; color: string }
  | { op: 'rect'; x: number; y: number; w: number; h: number; color: string; fill?: false };

// --- GET JSON ------------------------------------------------------------
export const api = {
  health():              Promise<Health>,                      // GET /api/health
  assets():              Promise<AssetIndex>,                  // GET /api/assets
  uiState():             Promise<UiStateDoc>,                  // GET /api/ui-state
  saveUiState(s: { hidden: string[]; pinned: string[] }): Promise<{ ok: boolean; state: UiStateDoc }>,   // POST /api/ui-state
  activity(o?: { since?: number; limit?: number }): Promise<{ entries: ActivityEntry[]; seq: number }>,  // limit clamped 1..1500 by the server, default 400
  reviews():             Promise<ReviewsDoc>,                  // GET /api/reviews
  graph():               Promise<GraphDoc>,                    // GET /api/graph
  graphNode(id: string): Promise<GraphNodeInfo>,               // GET /api/graph/node?id=
  canvas(name: string):  Promise<CanvasInfo>,                  // GET /api/canvas/<n>
  snapshot(id: string):  Promise<SnapshotMeta>,                // GET /api/snapshot/<id>       404 { error: 'snapshot expired …' }
  project(name: string): Promise<ProjectInfo>,                 // GET /api/project/<n>
  rig(name: string):     Promise<RigInfo>,                     // GET /api/rig/<n>
  rigLayers(name: string, q: { canvas?: string; tag?: string; view?: string }): Promise<RigLayers>,
  rigDebug(name: string, q: { canvas?: string; tag?: string; view?: string; frame?: number }): Promise<RigDebug>,
  modelInfo(name: string): Promise<ModelInfo>,                 // GET /api/model/<n>/info
  audio(name: string):   Promise<AudioInfo>,                   // GET /api/audio/<n>
  audioAnalysis(name: string, view?: string): Promise<AudioAnalysis>,   // GET /api/audio/<n>/analysis
  exportJSON<T = unknown>(path: string): Promise<T>,           // GET /api/export-file?path=
  exportText(path: string): Promise<string>,
};
```

`urls.ts` (pure string builders, unit-tested; every viewer uses these instead of string concatenation):

```ts
canvasPng(name, o?: { v?: string; t?: number | string; layer?: number | string; frame?: number; scale?: number; download?: boolean }): string
canvasGif(name, o?: { animation?: string; scale?: number; download?: boolean }): string   // scale default 4
snapshotPng(id): string
modelGlb(name, o?: { snap?: string; profile?: 'three'; bake?: boolean; download?: boolean }): string
modelThumb(name, o?: { v?: string | number; size?: number; snap?: string }): string
rigPreview(name, o?: { pose?: string; view?: string; scale?: number; t?: number }): string
rigWeights(name, o: { mesh: string; bone?: string; view?: string; scale?: number; t?: number }): string
audioWav(name, o?: { t?: number; download?: boolean }): string
exportFile(path, o?: { download?: boolean; m?: number }): string
reviewImage(file): string
thumbUrl(kind: string, name: string, version?: string | number): string | null   // canvas, model, rig (= <name>_parts canvas); else null
```

Server parameter limits to respect: canvas PNG `scale` number; GIF `scale` 1..16; rig preview / weights `scale` 1..12; model thumb `size` default 128; `/api/rig/*/layers|debug` accept only `view, canvas, tag, pose, frame`; review image file must match `r<digits>-<digits>.png`; snapshot id `s<digits>`.

### 3.4 `types.ts`

```ts
export type Source = 'agent' | 'user';
export interface Rect { x: number; y: number; w: number; h: number }

export interface Health { app: 'agent-art'; version: string; pid: number; home: string; canvases: number }

// GET /api/assets  (src/assets.js)
export interface AssetIndex {
  canvases: CanvasSummary[]; rigs: RigSummary[]; models: ModelSummary[]; audio: AudioSummary[];
  projects: ProjectSummary[]; groups: GroupSummary[]; exports: ExportFile[];
  home: string; flags: { superseded: string[]; orphans: string[] }; tags: Record<string, string[]>;
}
export interface CanvasSummary {
  name: string; project?: string | null; width: number; height: number /* frame height */; frames: number;
  layers: { name: string; visible: boolean }[]; animations: string[];
  version: string /* "<version>-<updated>" */; updated: number;
  kind: 'canvas' | 'rigparts' | 'rigout' | 'render' | 'ctm' | 'normal';
  rig?: string; model?: string; texture?: string | string[]; anchors?: string[];
}
export interface RigSummary { name: string; canvas: string; project?: string | null; frame: [number, number]; views: string[]; mirror: string[];
  parts: string[]; poses: string[]; presets: string[]; template?: string; outputs: string[]; version: string }
export interface ModelSummary { name: string; project?: string | null; parts: number; named: string[]; types: string[]; poses: string[]; clips: string[];
  sockets: string[]; template?: string; updated: number }
export interface AudioSummary { name: string; kind?: string; recipe?: string; duration?: number; lufs?: number; score?: number; updated: number }
export interface ProjectSummary { name: string; description?: string; palette: number }
export interface GroupSummary { name: string; parent: string | null; note?: string; members: string[] /* node ids */ }
export interface ExportFile { path: string /* forward slashes */; size: number; mtime: number }   // max 2000 files, depth 6

// GET /api/ui-state
export interface UiStateDoc { hidden: string[]; pinned: string[]; updated?: number }

// GET /api/canvas/<n>  (doc.info() + colors + ui)
export interface AnimTag { frames: number[]; durations: number[]; loop?: boolean; direction?: 'forward' | 'reverse' | 'pingpong' }
export interface CanvasInfo {
  name: string; width: number; height: number /* full strip */; frames: number; frameHeight: number | null;
  activeLayer: number; layers: { index: number; name: string; visible: boolean; opacity: number; blend?: string }[];
  animations: Record<string, AnimTag>; project?: string | null; meta?: CanvasMeta;
  palette?: Record<string, string>; inheritedPalette?: Record<string, string>;
  undo: number; redo: number; version: number;
  colors?: { unique: number; top: { color: string; count: number }[] }; ui?: string;
}
export interface CanvasMeta { rig?: string | { parts?: Record<string, unknown> }; anchors?: Record<string, Record<string, [number, number, number?]>[]>;
  texture?: string | string[]; [k: string]: unknown }

// GET /api/snapshot/<id>  (src/activity.js canvasSnapshot / snapModel, minus png and def)
export interface SnapshotMeta { id: string; kind: 'canvas' | 'model'; name: string; bytes: number; hasDef: boolean;
  width?: number; height?: number; scale?: number; frames?: number; frameHeight?: number | null; version?: number }

// activity  (src/activity.js)
export interface ActivityAsset { kind: string; name: string; before?: string; after?: string; created?: boolean; deleted?: boolean }
interface ActivityBase { id: number; source: Source; ts: number; args: Record<string, unknown>; assets: ActivityAsset[];
  ok?: boolean; error?: string; ms?: number; summary?: string }
export interface ToolEntry extends ActivityBase { type: 'tool'; call: string; tool: string; action?: string; running: boolean; ops: number[] }
export interface OpEntry extends ActivityBase { type: 'op'; op: string; call?: string; tool?: string; files?: string[]; files_total?: number }
export type ActivityEntry = ToolEntry | OpEntry;

// SSE  (data: <json>\n\n; the server also sends ": ping" comments every 20 s)
export type ServerEvent =
  | { type: 'hello'; ts: number }
  | { type: 'activity'; entry: ActivityEntry; ts: number }
  | { type: 'change'; canvas: string; project?: string | null; version: number; op: string; source: Source; label?: string; dirty: Rect | null; structural: boolean; ts: number }
  | { type: 'deleted'; canvas: string; source: Source; ts: number }
  | { type: 'model'; model: string; source: Source; label?: string; deleted?: boolean; ts: number }
  | { type: 'audio'; name: string; kind?: string; source: Source; deleted?: boolean; ts: number }
  | { type: 'project'; project: string; source: Source; label?: string; deleted?: boolean; ts: number }
  | { type: 'graph'; action?: string; review?: boolean; id?: string; status?: string; asset?: string; ts: number; [k: string]: unknown }
  | { type: 'ui-state'; ts: number }
  | { type: 'anim_library'; kind: string; name: string; source: Source; ts: number }
  | { type: 'planet'; name: string; source: Source; ts: number }
  | { type: string; ts?: number; [k: string]: unknown };          // forward compatible: never throw on unknown

// reviews  (src/review.js)
export type ReviewStatus = 'open' | 'in_progress' | 'fixed' | 'accepted' | 'reopened';
export interface ReviewTarget { frame?: number; view?: string; tag?: string; layer?: string; part?: string; clip?: string;
  region?: [number, number, number, number]; point?: [number, number]; time?: [number, number] }
export interface Review { id: string; asset: string; target: ReviewTarget; category: string; priority: 'low' | 'normal' | 'high'; note: string;
  status: ReviewStatus; by: 'agent' | 'user'; created: number; updated: number; version?: number;
  compare_with?: { asset: string } & ReviewTarget;
  history: { ts: number; by: string; status?: ReviewStatus; img?: string; version?: number; reply?: string }[] }
export interface ReviewsDoc { reviews: Review[]; counts: Record<string, number>; approved: string[] }
export interface ReviewMark { id: string; status: ReviewStatus; region?: [number, number, number, number]; frame?: number; time?: [number, number] }
export interface ReviewAddArgs extends ReviewTarget { asset: string; category: string; priority: string; note: string; image?: string;
  compare_with?: { asset: string; view?: string; frame?: number } }

// graph  (src/graph.js)
export interface GraphNode { id: string; kind: string; tags?: string[]; note?: string; approved?: boolean; reviews?: number;
  superseded?: boolean; orphan?: boolean; parent?: string; version?: string; missing?: boolean }
export interface GraphEdge { from: string; rel: string; to: string; attrs?: Record<string, unknown>; derived?: boolean; auto?: boolean }
export interface GraphDoc { nodes: GraphNode[]; edges: GraphEdge[]; rels: string[] }
export interface GraphNodeInfo { id: string; exists: boolean; tags: string[]; note?: string; out: GraphEdge[]; in: GraphEdge[]; text: string }

// project / rig / model / audio  (UI-derived; confirm in src/engine.js project_info, src/rigops.js rig_info,
// src/modelops.js model_info, src/audio/ops.js audio_info and audio_analyze)
export interface ProjectInfo { name: string; description?: string; notes?: string; palette?: Record<string, string>; meta?: { minecraft?: string; [k: string]: unknown };
  canvases: { name: string; meta?: { texture?: string | string[] } }[] }
export interface RigInfo { frame: [number, number]; views: string[]; mirror?: Record<string, string>; sampling?: string; root?: number[];
  parts: Record<string, { parent?: string; z?: number }>; poses?: Record<string, unknown>; presets?: Record<string, unknown>;
  skin?: Record<string, { bones?: string[] }> }
export interface RigLayers { frames: { frame?: number; stack?: RawStackEntry[]; parts?: RawStackEntry[]; layers?: RawStackEntry[] }[]; views?: string[]; view?: string; source?: string }
export interface RigDebug { size: [number, number]; atlas: string /* base64 PNG, one cell per part, stacked vertically */; atlas_parts?: string[]; stack?: RawStackEntry[] }
export interface RawStackEntry { part?: string; name?: string; layer?: string; z?: number; order?: number; rule?: string; reason?: string; why?: string;
  hidden?: boolean; visible?: boolean; why_hidden?: string; parent?: string | null }
export interface ModelInfo { triangles?: number; parts_def?: unknown[]; materials?: string[]; size_units?: number[]; size_cells?: number[]; origin?: unknown;
  template?: string; rig?: { nodes?: ({ name: string } | string)[]; sockets?: ({ name: string } | string)[]; poses?: string[]; clips?: ({ name: string } | string)[] };
  warnings?: string[]; notes?: string }
export interface AudioStats { duration?: number; lufs?: number; peak_dbfs?: number; score?: number; issues?: string[]; [k: string]: unknown }
export interface AudioInfo { name: string; kind?: string; recipe?: string; seed?: number; intent?: string; genre?: string; stats?: AudioStats; cache?: AudioStats }
export interface AudioAnalysis { name: string; stats?: Record<string, unknown>; report?: string | object; image: string /* base64 PNG */; views?: string[] }

// cleanup  (src/cleanup.js report / trashList / usage / config; called with full: true)
export interface CleanupPlan { plan_id: string; remove: { count: number; bytes: number; size: string; by_kind: Record<string, number> };
  items: { id: string; bytes: number; reason?: string }[]; blocked?: { id: string; why: string; by: string[] }[];
  warnings?: string[]; refused_files?: string[]; unknown?: string[]; next?: string }
export interface TrashBatch { id: string; ts: number; age: string; via: string; plan?: string; items: number; bytes: number; size: string;
  assets: { id: string; bytes: number; files: string[] }[]; edges: number; reviews: number; manifests: string[] }
export interface TrashList { batches: number; bytes: number; size: string; trash: TrashBatch[] }
export interface DiskUsage { total: string; other: Record<string, number>; by_kind: Record<string, { count: number; bytes: number }>;
  by_project: Record<string, { count: number; bytes: number }>; by_group: Record<string, { count: number; bytes: number }>; biggest: { id: string; bytes: number }[] }
export interface CleanupConfig { exports: string; allow_paths: string[]; trash_deletes: boolean; file: string }
```

### 3.5 `events.ts`: SSE, reconnect, resync

```ts
export interface EventStreamOptions {
  url?: string;                                         // default '/api/events'
  onEvent(ev: ServerEvent): void;
  onOpen(info: { reconnect: boolean }): void;           // after the hello event
  onDown(info: { attempt: number; retryInMs: number }): void;
  makeSource?: (url: string) => EventSource;            // tests inject a fake
  now?: () => number; random?: () => number;
}
export class EventStream { constructor(o: EventStreamOptions); start(): void; stop(): void; readonly state: 'idle' | 'connecting' | 'open' | 'waiting' }
export function backoffMs(attempt: number, random?: () => number): number;
```

Rules (unit-tested with a fake `EventSource` and fake timers):

1. One `EventSource` at a time. `onmessage`: `JSON.parse` in a try/catch; a malformed frame is dropped with `console.warn`, it never breaks the stream.
2. "Open" is declared when the `hello` event arrives (not on `onopen`); `attempt` resets to 0 then.
3. On `onerror`: always `close()` the source and take over reconnection (do not rely on the browser's built-in retry; it gives no control and no resync hook). Call `onDown`, then schedule a reconnect after `backoffMs(attempt++)`.
4. `backoffMs(n) = min(15000, 500 * 2^n) * (0.8 + 0.4 * random())` → about 0.5 s, 1 s, 2 s, 4 s, 8 s, then 15 s forever. Never give up.
5. If no `hello` arrives within 10 s of creating a source, treat it as an error (rule 3).
6. `document.visibilitychange` to visible while in `waiting`: reconnect immediately and reset the backoff timer (not the attempt count).
7. `stop()` closes the source and clears timers (used by tests and HMR dispose).

Resync on every reconnect (`live.ts`, `onOpen({ reconnect: true })`), in this order:

1. `api.health()`. If `pid !== connection.serverPid`: set `connection.restarted = true`, `await refreshUiToken()`, `activity.reset()` (ids restart at 1 on a new process), update `serverPid`. Fetch `/` is also used to compare the entry script URL with the one in the current document; if it differs set `connection.uiOutdated = true`.
2. In parallel: `assets.refresh()`, `reviews.refresh()`, `uiState.load()`.
3. `api.activity({ since: activity.lastId, limit: 1500 })` (after a reset: `{ limit: 600 }`) → `activity.load`.
4. Send a synthetic `{ type: 'resync' }` to both viewers' `onEvent`; each viewer treats it as "reload what you show" (canvas, anim, sheet, rig, layers, model, audio, graph, project reload; export ignores it).

Banners (`shell/Banner.svelte`, a thin bar under the top bar):

- `connection.uiOutdated`: "A newer build of the web UI is available." + `Reload` button.
- `connection.restarted && !uiOutdated`: no banner (the token was refreshed silently); one info toast "Reconnected to a restarted server".

---

## 4. Design system

Identity stays: dark, dense, tool-like. The upgrade is consistency (one scale for space, type, radius, state colours), real icons instead of mixed Unicode glyphs and emoji, visible focus, readable low-emphasis text, and motion that can be turned off. No light theme in 1.0; tokens are named so one can be added later by overriding the same variables.

### 4.1 Tokens (`web/src/styles/tokens.css`)

Existing names are kept (viewer code and inline styles use them). Values marked `was` change in step 20, not before.

```css
:root {
  color-scheme: dark;

  /* surfaces */
  --bg: #0f1114;            /* app background, centre column */
  --bg2: #15171c;           /* toolbars, status bars, inputs, cards on panels */
  --panel: #1a1d23;         /* side panes, top bar, dialogs */
  --panel2: #20242b;        /* controls, hover rows */
  --panel3: #262b33;        /* control hover (was hard-coded #262b33) */
  --stage: #101216;         /* behind pixel art (was hard-coded) */
  --canvas-bg: #15171c;     /* 2D canvas fills: waveform, lanes, 3D clear colour */
  --checker-a: #3a3d44; --checker-b: #2c2f35;
  --line: #2a2f38;          /* separators */
  --line2: #353b46;         /* control borders */
  --line3: #4a5260;         /* control border hover */
  --scrim: rgba(0, 0, 0, .55);

  /* text */
  --text: #e6e9ef;
  --text2: #cbd2dc;         /* secondary body text (was hard-coded #cbd2dc / #b6bfcc) */
  --muted: #9aa3b2;         /* was #8b93a1 */
  --dim: #7f8898;           /* was #5b6372 (too low contrast for text) */

  /* brand and state */
  --accent: #f5a524; --accent-fg: #ffd28a; --accent-bg: #2b2410; --accent-bg2: #3b2a08; --accent-ink: #111111;
  --blue: #38bdf8;   --blue-fg: #9edcff;   --blue-bg: #0b2534;   --blue-line: #1c6d93;
  --green: #22c55e;  --green-fg: #86efac;  --green-bg: #0f2a19;  --green-line: #1f7a43;
  --red: #e5484d;    --red-fg: #fca5a5;    --red-bg: #2a1416;    --red-line: #7a2a2f;
  --warn-fg: #fcd34d; --warn-line: #8a5a10;
  --violet: #a78bfa;
  --focus: #7cc7ff;

  /* asset kinds (unchanged) */
  --k-canvas: #38bdf8; --k-layer: #64748b; --k-anim: #a78bfa; --k-frame: #64748b; --k-rig: #f472b6; --k-rigpart: #f9a8d4;
  --k-model: #f5a524; --k-modelpart: #fcd34d; --k-audio: #2dd4bf; --k-export: #94a3b8; --k-project: #e5484d;
  --k-group: #c084fc; --k-file: #94a3b8; --k-palette: #22c55e; --k-graph: #c084fc;

  /* space: 4 px grid */
  --s-1: 2px; --s-2: 4px; --s-3: 6px; --s-4: 8px; --s-5: 10px; --s-6: 12px; --s-7: 16px; --s-8: 24px; --s-9: 32px;

  /* radius */
  --r-1: 3px; --r-2: 4px; --r-3: 6px; --r-4: 8px; --r-5: 10px; --r-pill: 999px;

  /* type */
  --font-ui: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-mono: ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace;
  --fs-1: 10px; --fs-2: 11px; --fs-3: 12px; --fs-4: 13px; --fs-5: 15px; --fs-6: 18px;
  --lh: 1.4; --lh-tight: 1.15;

  /* control metrics */
  --h-control: 28px; --h-control-sm: 24px; --h-row: 28px; --h-topbar: 42px; --h-panehead: 34px; --h-toolbar: 38px; --h-status: 22px;
  --hit-min: 24px;          /* minimum pointer target; 36px in the narrow layout */

  /* elevation and motion */
  --shadow-1: 0 2px 8px rgba(0, 0, 0, .35);
  --shadow-2: 0 20px 60px rgba(0, 0, 0, .5);
  --shadow-drawer: 0 0 30px rgba(0, 0, 0, .6);
  --t-fast: 80ms; --t-med: 160ms; --t-slow: 500ms; --ease: cubic-bezier(.2, .8, .2, 1);

  /* layout defaults (overridden inline by the splitters) */
  --browser-w: 280px; --side-w: 360px; --insp-h: 46vh; --bottom-h: 260px;

  /* layers */
  --z-splitter: 2; --z-sticky: 1; --z-drawer: 20; --z-scrim: 19; --z-dialog: 50; --z-toast: 60; --z-tooltip: 70;
}
```

Contrast requirements (enforced by `tokens.test.ts`, which parses this file and uses `lib/util/contrast.ts`): `--text`, `--text2`, `--muted`, `--dim` on each of `--bg`, `--bg2`, `--panel`, `--panel2` ≥ 4.5:1; `--accent-fg` on `--accent-bg` ≥ 4.5:1; `--accent-ink` on `--accent` ≥ 4.5:1; `--focus` on every surface ≥ 3:1. If a value fails, adjust that value upward in lightness until it passes and note it in the commit.

Canvas-drawn colours: viewers read tokens once per mount through `themeColors()` in `lib/util/dom.ts` (`getComputedStyle(document.documentElement).getPropertyValue(...)`) instead of hard-coding hex strings, for: stage / canvas background, checker pair, accent, blue, green, red, muted text, grid line colours. Colours that encode data (anchor palette, relation colours, skeleton, debug hue) stay literal.

### 4.2 Typography

- Base: `font: var(--fs-4)/var(--lh) var(--font-ui)`. No web fonts (no network requests, ever).
- Scale use: `--fs-1` section labels and tiny captions; `--fs-2` meta lines, chips, badges, timeline args; `--fs-3` buttons `sm`, tables, mono blocks; `--fs-4` body; `--fs-5` dialog titles, viewer H1; `--fs-6` stat tile values, empty-state titles.
- Section label style (pane heads, browser sections, inspector sections): `--fs-1`, weight 700, `letter-spacing: .08em`, uppercase, `--muted`.
- Mono for: paths, ids, numbers in status bars, args, JSON. `font-variant-numeric: tabular-nums` on counters, durations, sizes, times.
- Truncation is always `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` with the full text in `title`.

### 4.3 Component specs

Global primitive classes live in `base.css` so both Svelte components and viewer-built DOM share them. The Svelte `ui/` components are thin wrappers that apply these classes; their own `<style>` blocks only contain layout.

| Component | Spec |
| --- | --- |
| `.btn` | height `--h-control`, padding `0 var(--s-5)`, radius `--r-3`, border `1px solid var(--line2)`, bg `--panel2`, gap `--s-2`, `--fs-4`. Hover: bg `--panel3`, border `--line3`. Active (pressed): translateY(0.5px). Disabled: opacity .45, no pointer events. `.sm`: height `--h-control-sm`, padding `0 var(--s-4)`, `--fs-3`. Variants: `.primary` (bg `--accent-bg2`, border `--accent`, fg `--accent-fg`), `.ok` (border `--green-line`, fg `--green-fg`), `.warn` (border `--warn-line`, fg `--warn-fg`), `.danger` (border `--red-line`, fg `--red-fg`), `.ghost` (transparent bg and border until hover). Toggle state `.on` / `[aria-pressed=true]`: bg `--accent-bg`, border `--accent`, fg `--accent-fg`. |
| `.btn.icon` | square `--h-control` (or `-sm`), icon 16 px, always has `aria-label` and a tooltip. |
| `.tool` | 30 × 28 px icon button in the paint tool group; `.active` = toggle state. The group is a `role="radiogroup"`, each tool `role="radio"`. |
| `.chip` | height 20 px, padding `0 var(--s-4)`, radius `--r-pill`, `--fs-2`; `.on` like buttons; `.dim` opacity .6. Chips that do nothing are `<span>`, chips that act are `<button>`. |
| `.badge` | height 16 px, padding `0 var(--s-3)`, radius `--r-pill`, `--fs-1`, border 1 px. Tones: neutral, `review` (accent), `ok` (green), `state` (blue), `old` (red), `orphan` (dashed, grey). |
| `.count-badge` | min-width 16 px, height 16 px, bg `--accent`, fg `--accent-ink`, weight 700, `--fs-2`. |
| Inputs (`select`, `input`, `textarea`) | height `--h-control` (textarea auto), bg `--bg2`, border `1px solid var(--line2)`, radius `--r-3`, padding `0 var(--s-3)`. Hover border `--line3`. Invalid (`:user-invalid`): border `--red`. Native `<select>` stays native everywhere (dense, keyboard-complete, zero cost). `input[type=range]` and checkboxes use `accent-color: var(--accent)`. |
| `.toggle` | label + native checkbox, gap `--s-2`, fg `--muted` (→ `--text` when checked). |
| Tabs | Viewer tabs: flat tabs on the slot header, height 26 px, radius `--r-3 --r-3 0 0`, selected = accent toggle state plus a 2 px accent bottom edge. `role="tablist"` / `role="tab"`, `aria-selected`, arrow keys move, Home / End. Dialog tabs (Cleanup): Bits UI `Tabs`, same look, with an underline separator. |
| Pane | bg `--panel`. Head: height `--h-panehead`, padding `0 var(--s-5)`, bottom border `--line`, section label on the left, actions right. |
| List row | height `--h-row` (fixed, so lists can be virtualised), padding `0 var(--s-3)`, 2 px left marker; hover bg `--panel2`; active bg `--accent-bg` + marker `--accent`; selected (select mode) bg `#22200f`; hidden opacity .4. |
| Toolbar (`.vtoolbar`) | min-height `--h-toolbar`, padding `var(--s-2) var(--s-5)`, gap `--s-5`, wraps, bg `--bg2`, bottom border. Groups (`.group`) gap `--s-2`; a 1 px `--line` divider between groups `(new)`. |
| Status bar (`.vstatus`) | height `--h-status`, mono `--fs-3`, `--muted`, single line with ellipsis. |
| Dialog | Bits UI `Dialog`. Scrim `--scrim`. Card: bg `--panel`, border `--line2`, radius `--r-5`, shadow `--shadow-2`, padding `var(--s-7)`, width `min(520px, 94vw)` (`md`) or `min(900px, 96vw)` (`lg`), max-height 88vh with an internally scrolling body. Header: title `--fs-5` weight 600 + close icon button. Footer: right-aligned buttons, primary last. Enter/exit: 120 ms opacity + 4 px translate; none with reduced motion. |
| Confirm / Prompt | Bits UI `AlertDialog`. Replaces `window.confirm` and `window.prompt` (R4, C5). Destructive confirm uses `.danger` and focuses Cancel first. |
| Toast | bottom centre stack, max 4 visible (older ones collapse), bg `--panel2`, border by kind (`--line2`, `--green`, `--red`), radius `--r-4`, padding `var(--s-3) var(--s-6)`, max-width 80vw. Lifetime 3.5 s (info / ok), 6 s (error); paused while hovered or focused `(new)`; error toasts have a dismiss button `(new)`. Container `role="status" aria-live="polite"`; errors `role="alert"`. |
| Tooltip | Bits UI `Tooltip`, delay 500 ms, bg `#0b0c0f`, border `--line2`, `--fs-3`, shows label + `<kbd>` shortcut. Used for shell icon buttons and top bar buttons. Viewer-built DOM keeps native `title`. Never both on one element. |
| Menu | Bits UI `DropdownMenu` for the narrow top bar overflow. Items height 28 px, icon + label + shortcut right-aligned. |
| Context menu `(new, Review 2)` | Bits UI `ContextMenu`, same look as Menu. One instance wraps the asset tree; the row is resolved from `event.target.closest('[data-row-id]')` (no per-row menu instances: thousands of rows, virtualised). Opens on right-click, `Shift+F10` / the Menu key on the focused tree item, and long-press on touch. Items are listed in step 15. |
| Command palette `(new, Review 2)` | Bits UI `Command` inside Bits `Dialog` (`md`, anchored 12vh from the top). Input height 36 px with the `search` icon; list max-height 50vh; groups "Recent", "Actions", "Assets" with section-label headings; item height `--h-row`: kind icon in its kind colour, name with the matched characters in `--accent-fg`, meta right-aligned in `--muted`, `<kbd>` shortcut for actions. Built-in filtering is off (`shouldFilter={false}`); results come from `commands.ts` (step 18b). `role="combobox"` / `listbox` semantics come from Bits. |
| Virtual list `(Review 2)` | `ui/VirtualList.svelte` wraps `virtua/svelte` (`VList`). Rows keep a stable key. The scroll container is the pane body; rows must not have vertical margins (virtua measures border boxes). |
| JSON view `(new, Review 2)` | `<pre class="json">` of `<span class="j-key | j-str | j-num | j-lit | j-punct">`; colours: key `--blue-fg`, string `--green-fg`, number `--accent-fg`, literal `--violet`, punctuation `--muted`. Above `maxChars` (default 200 000) it renders plain text in one node. |
| Kbd | bg `--panel2`, border `--line2`, bottom border 2 px, radius `--r-2`, mono `--fs-2`, padding `0 5px`. |
| Stat tile | bg `--bg2`, border `--line2`, radius `--r-4`, padding `var(--s-3) var(--s-6)`, value `--fs-6` weight 700 tabular, label `--fs-2` muted; tones `bad`, `good`. |
| Splitter | 4 px hit strip (8 px hit area via a pseudo element), bg `--line`, hover / drag / focus bg `--accent`. `role="separator"`, `aria-orientation`, `aria-valuenow/min/max`, `tabindex="0"`; arrow keys resize by 16 px (Shift = 64 px) `(new)`; double-click resets to the default `(new)`. |
| Skeleton | `--panel2` bars, radius `--r-2`, no shimmer with reduced motion. |
| Empty state | centred, max-width 460 px, optional 24 px icon, title `--fs-6`, text `--muted`. |

Icons: `lucide-static` (devDependency, ISC) imported as raw SVG strings in `lib/util/icons.ts` (`import pencil from 'lucide-static/icons/pencil.svg?raw'`), exposed as `ICONS: Record<IconName, string>`. `ui/Icon.svelte` renders with `{@html ICONS[name]}` inside a `span.icon` (16 px default, `currentColor`, `aria-hidden="true"`); `icon(name)` in `lib/util/dom.ts` does the same for viewer DOM. `{@html}` is allowed **only** for these build-time constants. Put `/*! Icons: Lucide, ISC License, https://lucide.dev */` at the top of `icons.ts` so the notice survives the build. Mapping (verify each file exists in the installed version; if not, pick the nearest and note it in `icons.ts`):

| Use | Icon | Use | Icon |
| --- | --- | --- | --- |
| assets pane | `panel-left` | side pane | `panel-right` |
| follow on / off | `circle-dot` / `circle` | compare | `columns-2` |
| review | `flag` | notes | `message-square` |
| graph | `waypoints` | cleanup | `trash-2` |
| help | `circle-help` | dock | `arrow-up-down` |
| swap | `arrow-left-right` | close | `x` |
| pin / pinned | `star` (filled via CSS when on) | hide / show | `eye-off` / `eye` |
| solo | `scan-eye` | select mode | `square-check` |
| new | `plus` | search | `search` |
| twisty | `chevron-right` (rotated 90° when open) | details | `chevron-right` |
| pencil | `pencil` | eraser | `eraser` |
| fill | `paint-bucket` | line | `slash` |
| rectangle | `square` | picker | `pipette` |
| hand | `hand` | undo / redo | `undo-2` / `redo-2` |
| zoom | `zoom-in` / `zoom-out` | fit | `maximize` |
| play / pause / stop | `play` / `pause` / `square` | download | `download` |
| ok / warn / error | `check` / `triangle-alert` / `circle-alert` | restore | `rotate-ccw` |
| kinds | canvas `image`, layer `layers`, anim `film`, frame `frame`, rig `bone`, rigpart `puzzle`, model `box`, modelpart `boxes`, palette `palette`, audio `music`, export `package`, project `folder-kanban`, group `group`, file `file`, graph `waypoints` | | |

The graph viewer draws kind glyphs with `fillText` on a 2D canvas; it keeps the Unicode `KIND_ICON` map (section 5.8). `KIND_ICON` therefore stays in `lib/util/kinds.ts` next to a new `KIND_ICON_NAME` map for the SVG icons.

### 4.4 Focus, keyboard, accessibility

- `:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }` on every interactive element. Never remove outlines; canvases get an inset outline (`outline-offset: -2px`).
- Everything clickable is a `<button>` or `<a>` (legacy uses `div.row`, `li`, `span.act` with click handlers; fix).
- Landmarks: `<header>` top bar, `<nav aria-label="Assets">`, `<main>` viewers, `<aside aria-label="Inspector">`, `<section aria-label="Activity">`.
- Asset tree: `role="tree"`, rows `role="treeitem"` with `aria-level`, `aria-expanded`, `aria-selected` (active row), `aria-checked` in select mode. Roving tabindex. Keys `(new)`: Up / Down move, Right expand or go to first child, Left collapse or go to parent, Home / End, Enter open, Shift+Enter or Alt+Enter open in compare, Space toggle selection (select mode), `H` is not used here (global). Row actions are reachable with Tab from the focused row. `(Review 2)`: because the tree is virtualised, every row also carries `aria-setsize` and `aria-posinset` (computed in `tree.ts`), the focused row id lives in component state (not in the DOM), and moving focus to a row that is not rendered first calls the list's `scrollToIndex`, then focuses it after the next frame. `Shift+F10` / the Menu key opens the row's context menu.
- Timeline: `<ol>`; each entry's main line is a `<button>` (opens), with the compare and details buttons as siblings; details button has `aria-expanded`.
- Status pill: `role="status" aria-live="polite"`; announce only changes between `live`, `disconnected — retrying` (not every busy flicker).
- Dialogs: focus trapped, initial focus as specified per dialog (review note → textarea; plan → Cancel; confirm destructive → Cancel), focus returns to the opener, `Esc` closes, labelled by the title.
- Global shortcuts must not fire when: focus is in a text field (K1); a dialog is open (K2; Bits handles `Esc`); **the event target is a button, link, tab, tree item, menu item or summary and the key is Space or Enter** `(new, fixes double actions such as Space on a focused button also toggling play)`.
- One shortcut table `(Review 2)`: `state/shortcuts.ts` exports `SHORTCUTS: { id: string; keys: string; label: string; group: 'Everywhere' | 'Canvas' | 'Players' | '3D view' | 'Graph'; action?: ActionId }[]`. The Help dialog, the tooltips' `<kbd>` hints and the command palette's "Actions" group all read it, so they cannot drift. The `label` of every legacy shortcut is the legacy help text verbatim (a unit test compares the rendered Help text of the legacy rows with a frozen copy of the legacy `#help` markup's text).
- Colour is never the only signal: status dots have text labels or titles; review card status is text; badges have text.
- `@media (prefers-reduced-motion: reduce)`: no pulse, no flash animation (use a static 2 px outline for 900 ms instead), no dialog / drawer transitions, no smooth scrolling.
- Pointer targets: ≥ 24 px; in the narrow layout row height becomes 36 px and icon buttons 36 px.
- Language: UI text stays English, sentence case, as today. Keep the legacy strings listed in section 1 verbatim unless marked.

### 4.5 Breakpoints

| Name | Width | Behaviour |
| --- | --- | --- |
| wide | ≥ 1101 px | full layout, defaults 280 / 360 px |
| compact | 861–1100 px | default `--browser-w: 230px`, `--side-w: 300px`; workspace path hidden; top bar buttons show icon + label still |
| narrow | ≤ 860 px | drawers (`min(86vw, 340px)`, shadow `--shadow-drawer`, scrim), top bar: pane toggles, status dot (label visually hidden when < 420 px), Follow, then an overflow menu with Compare, Review, Notes (with count), Graph, Cleanup, Help `(new; replaces horizontal scrolling of the bar)`. Compare stacks vertically. Layers side list under the stage. Viewer toolbars wrap. Row and button hit size 36 px. Dialogs: width 94vw, max-height 92vh. |

Breakpoint logic lives in CSS media queries plus `layout.narrow` (one `matchMedia` listener). No JS width math elsewhere.

### 4.6 What improves on the current look

- One spacing / radius / type scale instead of ad-hoc pixel values.
- SVG icons with labels and tooltips instead of `☰ ◉ ⇆ ⚑ ⬡ 🗑 ☷` (these render differently per OS and font).
- Readable low-emphasis text (`--muted`, `--dim`) at AA contrast.
- Visible keyboard focus everywhere; the whole shell is operable by keyboard.
- Toolbar groups separated by dividers; consistent control heights (28 / 24 px).
- Skeletons and inline spinners instead of blank panes; a real "cannot reach server" state.
- Native `confirm` / `prompt` replaced by styled dialogs.
- Narrow layout with an overflow menu and proper drawers with a scrim.
- Reduced-motion support.

---

## 5. Per-viewer migration spec

Common to all: port the logic line by line first (behaviour identical), then apply the listed changes. Keep the DOM class names the legacy code uses (`.viewer`, `.vtoolbar`, `.group`, `.stage`, `.vstatus`, `.toggle`, ...); `viewers.css` styles them. Build toolbars with `viewers/controls.ts`:

```ts
export function button(o: { text?: string; icon?: IconName; title: string; small?: boolean; variant?: 'primary' | 'warn' | 'ok'; onClick(): void }): HTMLButtonElement;
export function link(o: { text: string; title?: string; download?: string; small?: boolean }): HTMLAnchorElement;      // .btn, href set later
export function toggle(o: { label: string; title?: string; checked?: boolean; onChange(checked: boolean): void }): { el: HTMLLabelElement; input: HTMLInputElement };
export function select(o: { title?: string; className?: string; onChange(value: string): void }): HTMLSelectElement;
export function fillSelect(sel: HTMLSelectElement, items: { value: string; label: string }[], o?: { keep?: string; first?: { value: string; label: string } }): void;  // no-op when the option list is unchanged (replaces the dataset.k pattern); preserves the value when still valid
export function range(o: { min: number; max: number; step?: number; value: number; title?: string; className?: string; onInput(value: number): void }): HTMLInputElement;
export function group(...kids: (Node | null | false)[]): HTMLDivElement;
export function spacer(): HTMLDivElement;
export function label(text: string): HTMLSpanElement;          // span.muted
```

Toolbar buttons that were glyph-only (`↶ ↷ − + ◀ ▶ ❚❚ ■`) become icon buttons with `aria-label`; text buttons keep their text.

All text built from server data goes through `textContent` (the `h()` helper's `text` prop). The legacy `layerSel.innerHTML = opts` in `canvas.js` is replaced by `fillSelect`.

Shared pitfalls checklist (apply to every viewer):

- [ ] Every `addEventListener` on `window` / `document` uses `{ signal: this.dispose.signal }`.
- [ ] Every `setTimeout`, `requestAnimationFrame`, `ResizeObserver`, `matchMedia` listener is released in `destroy()` (use the `BaseViewer` helpers).
- [ ] Every awaited load is guarded by a load token.
- [ ] Canvas backing size = CSS size × `devicePixelRatio`, re-applied on resize and on DPR change. Pixel art is drawn with `imageSmoothingEnabled = false` (set again after every canvas resize; resizing resets context state).
- [ ] No canvas larger than 8192 px on a side or 32 megapixels: clamp the scale that would exceed it and say so in the status line.
- [ ] `ImageBitmap`s that are replaced are `close()`d.
- [ ] `destroy()` is safe to call twice and during a pending load.

### 5.1 PixelView (`viewers/pixel/PixelView.ts`), shared by canvas, rig parts, export PNG

Current: zoomable / pannable pixel canvas. Zoom ladder `[1/16, 1/8, 1/4, 1/2, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 40, 48, 64]`; auto-fit (largest ladder step that fits with 32 px padding) until the user zooms or pans; checker background sized `clamp(round(z/2), 4, 12)`; smoothing only below 1×; pixel grid at zoom ≥ 6 with stronger lines every 4 and 8 px; 3×3 tile mode with an accent frame on the centre tile and wrapped drawing coordinates; onion skin (previous frame red, next frame blue, alpha .28, tinted copies built once per image); frame separator lines in strip mode; live stroke preview; review marks and the dashed live box; change flash (blue rectangle fading over 1.2 s); draws only the visible part of the image. Tools: pencil and eraser (Bresenham-joined point set → one `pixels` command), line, rectangle (outline, or filled with Shift held at pointer down), fill, picker, hand, plus the `review` pseudo-tool (drag = region, click = point).

```ts
export interface PixelViewOptions {
  editable?: boolean;
  getTool?(): Tool | 'review';
  getColor?(): { hex: string; hex8: string };
  onCommands?(commands: DrawCommand[], label: string): void | Promise<void>;
  onPick?(hex: string): void;
  onHover?(p: [number, number] | null, color?: { hex: string; a: number } | null): void;
  onZoom?(zoom: number): void;
  onionFrames?(): { prev: number | null; next: number | null } | null;
  onReview?(r: { point: [number, number] } | { region: [number, number, number, number] }): void;
  marks?(): ReviewMark[];
  afterRender?(ctx: CanvasRenderingContext2D, view: { ox: number; oy: number; z: number; w: number; h: number }): void;
}
export class PixelView {
  readonly canvas: HTMLCanvasElement;
  zoom: number; autoFit: boolean; grid: boolean; tile: boolean; onion: boolean;
  constructor(host: HTMLElement, opts?: PixelViewOptions);
  setImage(strip: ImageBitmap, o?: { rect?: Rect; frameLines?: number | null; keepView?: boolean }): void;
  setFrameRect(rect: Rect): void;
  fit(): void; zoomBy(d: 1 | -1, cx?: number, cy?: number): void; setZoom(z: number, cx?: number, cy?: number): void;
  flash(rect: Rect): void; render(): void; setCursorTool(tool: string): void; destroy(): void;
}
```

Changes:

- Leak fix: legacy adds `window` `keydown` / `keyup` listeners per instance and never removes them. Use one `AbortController`.
- Colour sampling: legacy copies the whole strip into an `ImageData` on every load (hundreds of MB for big multi-frame canvases). Keep one `OffscreenCanvas` with `{ willReadFrequently: true }` holding the strip and read single pixels with `getImageData(x, y, 1, 1)` on hover / pick. If the strip exceeds 64 megapixels skip the copy; hover then shows coordinates only.
- DPR: re-run `resize()` on DPR change.
- Render scheduling: coalesce `render()` calls into one rAF (`requestRender()`); `flash` keeps its own rAF loop but stops when destroyed.
- Space-to-pan: track `space` only while the canvas is focused; reset on `blur`.
- Keyboard `(new)`: when the canvas has focus, arrow keys pan by 32 px (Shift = 128 px).
- Touch `(new)`: `touch-action: none` stays; two-pointer pinch zooms around the midpoint, two-pointer drag pans (track pointers in a `Map`). One finger keeps the tool behaviour.
- `canvas` gets `role="img"` and an `aria-label` set by the owner (`"<name>, frame 2 of 8, 32×32"`).
- Compare tools `(new, Review 2, RV7; wired in step 18c, the API is built here)`:

  ```ts
  // PixelViewOptions gains
  onView?(v: { zoom: number; cx: number; cy: number }): void;   // after a user zoom / pan / fit; never from setView
  // PixelView gains
  getView(): { zoom: number; cx: number; cy: number };            // cx, cy = image pixel at the stage centre
  setView(v: { zoom: number; cx: number; cy: number }): void;     // sets autoFit = false, snaps zoom to the ladder, renders; does not call onView
  setOverlay(o: { image: ImageBitmap; rect: Rect; mode: 'diff' | 'swipe' | 'blink'; split?: number } | null): void;
  readonly overlayInfo: { changed: number; total: number; bbox: Rect | null } | null;   // diff mode only
  // pixel/diff.ts (pure, unit-tested)
  export function diffMask(a: Uint8ClampedArray, b: Uint8ClampedArray, w: number, h: number): { mask: Uint8ClampedArray /* RGBA, magenta where different */; changed: number; bbox: Rect | null };
  ```

  Rules: the overlay is drawn only when `overlay.rect` has the same width and height as the shown frame rect; otherwise `setOverlay` stores nothing and returns. `diff`: exact RGBA comparison per pixel (two pixels with alpha 0 are equal whatever their RGB); the base image is drawn at 35% alpha over the checker and the mask at 100% (`#ff3df2`), built once per (image, overlay) pair as a 1:1 `ImageData` on an `OffscreenCanvas`, then scaled with smoothing off; skipped above 16 megapixels (status says so). `swipe`: the overlay image is drawn left of a vertical line at `split` (0..1 of the frame width, default 0.5); the line is an accent 2 px bar with a 24 px grab handle, draggable with the pointer and movable with Left / Right when the canvas has focus and the hand tool is not panning; editing tools are disabled while an overlay is active (cursor `col-resize` near the bar, else default). `blink`: alternates base and overlay every 500 ms on a timer owned by PixelView (cleared in `destroy` and by `setOverlay(null)`); with `prefers-reduced-motion: reduce` it does not auto-alternate: the `X` key swaps manually (the status line says "press X to swap"). The overlay bitmap is owned by the peer viewer: never `close()` it; drop the reference in `setOverlay(null)` and `destroy()`.

Tests (`PixelView.test.ts`, jsdom with a stubbed 2D context from `src/test/canvasStub.ts`): zoom ladder stepping from an off-ladder zoom in both directions; `fit` picks the largest fitting step; `setZoom` keeps the pixel under the cursor fixed; `pixelAt` with and without tile mode (wrapping), outside → null; Bresenham output for the 8 octants; rectangle preview outline vs filled; emitted commands for each tool (exact objects); review box normalisation for a drag in each direction; `destroy()` removes window listeners (spy on `removeEventListener` via the abort signal). `(Review 2)`: `getView` / `setView` round trip and "`setView` does not call `onView`"; `setOverlay` with a different size is ignored; `diff.test.ts`: identical images → 0 changed and null bbox, one changed pixel → bbox 1×1, alpha-0 pixels with different RGB are equal, bbox of two far-apart changes.

### 5.2 Canvas viewer (`viewers/canvas/CanvasViewer.ts`)

Current: toolbar = tools (7), colour input + alpha slider, undo / redo, zoom − / label / + / Fit, Grid (persist `grid`) and Tile toggles, layer solo select ("all layers" + each layer, "(hidden)" suffix; view only via `?layer=`), snapshot badge, PNG download. Stage = PixelView. Frames bar (shown when frames > 1 or any tag): Frame toggle (one frame vs whole strip with separators), Onion toggle, ◀ scrubber ▶, frame label (`f / max` or `N frames`), Tag select ("all frames" + tags), GIF download (hidden for snapshots; follows the tag select), frame thumbnails (44 px box, tagged frames tinted, active outlined, flash on agent change). Status: meta text + cursor text (`x y`, frame and local y in strip mode, hex colour or "transparent"). Read-only in slot B and for snapshots (no tools, pan only). Snapshot mode loads `/api/snapshot/<id>` + `.png`, badge `snapshot · v<version> · 1/<scale>` or "snapshot expired". Live: `change` events for this canvas → flash the dirty rectangle (frame-aware; with follow on and the dirty rect inside one frame, jump to that frame), re-fit on `op === 'transform'`, reload after 60 ms; `deleted` → status "<name> was deleted <time>". `open` with the same canvas keeps zoom / frame / layer solo; a different one resets them. Concurrent image loads are serialised (`busy` / `again`).

Class: `export class CanvasViewer extends BaseViewer` with `onEvent`, `onKey` (K11), `undo(redo)`.

- `key(t)` = name + snap + view; `tag` and `frame` changes on the same canvas are applied without a reload.
- `envChanged`: tool → toolbar radio state + cursor; colour → colour swatch (and the hidden native input, see "Colour picker" below) + alpha slider; `reviewMode` → PixelView tool `review` (not for snapshots); `reviewsRev` → `view.render()`.
- Paint commands go through `op('draw', { canvas, label, commands, frame? })`; undo through `op('undo', ...)`. Both swallow rejections (the op already toasted).
- After each successful info reload call `host.canvasInfoChanged(name)`.
- Drop the dead legacy call `this.app.onFrame?.(this, f)`.
- `resync` event → `reload()`.

Changes: icon buttons; tools as a radio group with roving focus; replace `busy / again` with a load token + "latest wins"; cap frame thumbnails at 512 and render the strip of thumbnails lazily (only thumbnails scrolled into view are drawn, via one `IntersectionObserver`); scroll the active thumbnail into view when the frame changes; PNG / GIF links are real `<a download>` (keep).

Colour picker `(new, Review 2, RV5)`, `canvas/colorPicker.ts`:

- Package: `vanilla-colorful` (MIT, zero dependencies, ≈ 2.7 kB gzip for one picker, a standard custom element, so it works inside viewer-built DOM without Svelte). Load it on first open with the literal `import('vanilla-colorful/hex-alpha-color-picker.js')` (its own chunk, cached promise); it must not be in the initial bundle although the canvas viewer is.
- Toolbar: the native `<input type="color">` is replaced by a 28 × 28 px swatch button (`aria-label="Colour <hex8>"`, `aria-haspopup="dialog"`, `data-color="<hex8>"`, the colour drawn over a checker so alpha is visible). The alpha slider stays where it is.
- The button toggles a popover element inside the viewer root (`popover="auto"`, so light dismiss and `Esc` are native and the global key handler sees no dialog; position it under the button with `getBoundingClientRect`, flipped above when it would leave the viewport). Content, top to bottom: `<hex-alpha-color-picker>` (200 px wide; listen to `color-changed`, `detail.value` is `#rrggbbaa` → `host.setColor`); a hex text input (accepts `#rgb`, `#rrggbb`, `#rrggbbaa`, with or without `#`; invalid input sets `aria-invalid` and changes nothing); "Palette" swatches (the canvas's own + inherited palette from `CanvasInfo`, same order as the inspector); "Recent" (last 12 colours actually painted with, persisted `agent-art:recentColors`, updated when a `draw` op succeeds); "Pick from screen" button only when `'EyeDropper' in window` (`new EyeDropper().open()` → `sRGBHex`); "System picker…" link that clicks a hidden native `<input type="color">` (keeps the OS dialog reachable).
- `envChanged` colour → update the swatch, the picker's `color` property (only when the popover is open and the value differs, to avoid feedback loops) and the hex field (not while it has focus).
- If the chunk fails to load, toast once and fall back to clicking the hidden native input.
- Slot B and snapshots have no tool group, so no picker (unchanged rule).
- Pure helpers, unit-tested: `parseHex(text): string | null` (→ `#rrggbbaa`), `pushRecent(list, hex, max = 12)` (dedupe, newest first).
- e2e: open the popover, type `#ff000080` in the hex field, paint one pixel, the `draw` entry's command colour is `#ff000080` and the swatch's `data-color` matches; the recent row shows it after a reload; `Esc` closes the popover and focus returns to the swatch button; the initial page load does not request the picker chunk.

Pitfalls: `setImage` must not re-fit when only pixels changed (keep `autoFit` semantics); the layer solo select must keep its value across reloads when the layer still exists; after `transform` the frame height may change, so recompute `nFrames` before clamping `frame`.

Tests: unit: `frameRect` maths, hover text formatting, onion neighbours at the first / last frame, GIF URL per tag, meta line formatting, event handling decisions (given event + state → `{ flashRect, jumpToFrame, refit }` as a pure function `planChange`). e2e: paint a pencil stroke and see a user `draw` entry in the timeline; undo; zoom keys; grid toggle persists across reload; frame stepping with `,` `.`; snapshot is read-only (no tool group in the DOM).

### 5.3 Animation player (`viewers/anim/AnimViewer.ts`, `anim/directions.ts`)

Current: toolbar = Animation select ("all frames" + tags; defaults to the requested tag, else the first tag), play / pause, Loop, fps slider 1..30 for untagged frames (persist `fps`), "Per-view grid" (persist `dirgrid`), Scale slider 1..16 (auto = largest integer that fits, max 16), GIF link. Stage = one cell per view. With the grid on and a tag selected, tags are grouped by base name using the rig's views + mirrored views (longest suffix first; a tag without a suffix belongs to the rig's first view; without a rig, the built-in compass names) and every direction plays side by side; when at least 3 directions all map to compass slots they are laid out 3×3 with the base name in the centre. Each cell plays its own playlist (tag durations, `reverse` and `pingpong` expansion, `loop: false` respected together with the Loop toggle). Review mode: click a cell = pin with tag, view, frame, pixel. Status line: tag frames, total ms, no-loop, direction, view count. Reloads 120 ms after a `change` to the canvas.

```ts
// directions.ts (pure, unit-tested)
export const COMPASS: Record<'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw', string[]>;
export const SLOT: Record<string, number>;
export function compassOf(view: string): string | undefined;
export function directionGroups(tags: string[], views: string[] | null, firstView: string | null): Map<string, Record<string, string>>;
export function layoutFor(tag: string, tags: string[], views: string[] | null, firstView: string | null, grid: boolean): { cells: { tag: string; label: string; view?: string }[]; compass: boolean };
```

Changes: one rAF loop only while playing and the stage is connected; re-layout on stage resize when the user has not set a scale (legacy only lays out on open); clamp scale so no cell exceeds the canvas limits; cells are `<canvas role="img" aria-label="<label>">`; in review mode cells are focusable and Enter pins the centre `(new)`. Rig lookup uses `host.assets()`; when the index arrives later (`assetsRev`), recompute views once.

Pitfalls: `tagSel` must keep the user's choice across reloads unless the target names a tag; changing fps rebuilds playlists but must not reset the scale; hidden tab → rAF stops by itself, on return do not fast-forward (set `next = now + duration`).

Tests: `directionGroups` (rig views, mirrored views, no rig, tag with no suffix, nested suffixes such as `front_side_left`), compass detection (3 of 8, non-compass names → plain grid capped at 4 columns), `playList` (reverse, pingpong with 2 and 3 frames, untagged at fps, `loop: false`). e2e: open a rig output canvas, Animation tab shows ≥ 3 cells, Space pauses (frame index stops changing: compare two canvas data URLs 300 ms apart).

### 5.4 Sheet preview (`viewers/sheet/SheetViewer.ts`, `sheet/drawSheet.ts`)

Current: canvas mode = every frame as a cell, one row per tag (or one row of all frames), label `tag #frame`, duration, per-frame anchors from `meta.anchors[tag][i]` drawn as coloured crosses with a rotation tick; legend of anchor names. Export mode (`kind: 'export'`, a `.png` with a sibling `.json`, or the `.json`) = frame rects and anchors from the Aseprite-style JSON, laid out at their sheet positions with gaps. Toolbar: Anchors, Labels, Scale 1..12 (auto 1..8 by width). Status line. Reloads 150 ms after a `change`.

`drawSheet(canvas, img, cells, { scale, showAnchors, labels })` stays a pure function returning the anchor name → colour map.

Changes: clamp the scale to the canvas limits; redraw on resize when scale is auto; the sheet canvas gets `aria-label`; add PNG download of the composed sheet `(new, small: canvas.toBlob)`. Used standalone and embedded by the export viewer (constructible with a host element: keep a `mountInto(el, target)` path via the normal `mount`).

Pitfalls: `Math.max(...src.map())` with thousands of cells can overflow the argument limit; use a loop. An export JSON without `frames` falls back to one cell covering the image.

Tests: cell layout for a 2-tag canvas (positions, labels, durations), export layout from a fixture JSON, anchor colour assignment order, auto-scale maths.

### 5.5 Rig viewer (`viewers/rig/RigViewer.ts`)

Current: mode select: "Clip + skeleton" (default when clips exist), "Pose (all views)", "Parts sheet", "Skin mesh + weights" (option hidden when the rig has no skin). Pose: pose select ("rest" + poses) and view select ("all views" + views + mirrored) → server image `/preview.png`; status mentions the ground line. Parts: PixelView (read-only) of `<rig>_parts`. Skin: mesh select, bone select ("dominant bone" + bones), view → `/weights.png`. Clip: clip select (`<output canvas>/<tag>` for every tag on the rig's output canvases), play / pause, Skeleton toggle; the clip plays at integer scale (max 16) with bones drawn from `meta.anchors[tag][frameIndex]` (parent → child lines, root red, joints blue, names at scale ≥ 4). "Edit parts" opens the parts canvas. Review mode: click the clip = pin on the output canvas with tag and frame. Target fields `mode` and `clip` preselect. Reloads 200 ms after a `change` to the parts canvas or any output canvas. No clips: "No clips yet: art_rig animate {name, preset} renders them."

Changes: fetch the output canvas infos in parallel (`Promise.all`; legacy awaits them one by one); pose and skin images get explicit `width` / `height` when known, `alt`, and an error state ("no mesh drawing to show (pick a mesh / view)" comes from the server as 404 JSON → show it in the stage); re-fit the clip scale on resize; a frame scrubber + step buttons for the clip `(new)` with `,` `.` keys; one rAF loop only in clip mode while playing. `(new, Review 2, RV10)`: the Pose and Skin images are fetched with `getBitmap` and shown in a read-only `PixelView` (zoom ladder, pan, fit, pixel grid at high zoom) instead of an `<img>`. Keep the legacy request parameters exactly (do not change or add `scale`: the server draws the ground line, the skin lattice and the heat map at that scale); the PixelView only adds zoom and pan on top of the image the server returns. Keep `aria-label` = the old `alt` text. A 404 JSON body still shows its message in the stage.

Pitfalls: anchors are indexed by position within the tag's frame list, not by absolute frame (legacy maps through `tagFrames.indexOf(frame)`; keep that, including the pingpong case); changing mode must destroy the PixelView; selects must keep their values across the periodic reload.

Tests: anchor index mapping for forward / reverse / pingpong playlists; mode fallback (no clips → pose; skin requested but absent → pose); status text. e2e: open the rig, the clip canvas is non-empty, switch to Pose (image loads, `naturalWidth > 0`), Parts sheet, back.

### 5.6 Layers view (`viewers/layers/LayersViewer.ts`, `layers/stack.ts`)

Current: works for a rig (rest pose or a clip of an output canvas, per view, per frame) and for a plain canvas (its layers, bottom = index 0). Toolbar: View select (rig only), Clip select ("rest pose" + clips; canvas mode shows "N frame(s)"), ◀ scrubber ▶ + frame label, Debug tint, Overlaps, "Flag layering" (enabled with exactly two parts selected; label "Flag: A above B?"). Stage: composite at integer scale with optional tint by draw order (hue per part index) and a red hatch where ≥ 2 visible parts overlap; outline of the two selected parts (blue, amber). Hover line: "x y: drawn by P (z N) · underneath: …" or "empty". Side list (top first): colour dot, eye (view-only hide), solo, name, `z N`, rule or hidden reason; click selects (max 2, FIFO). Lanes chart: one lane per part across frames by rank, labels at the left, current-frame marker, click sets the frame. Flag → review draft `{ asset, frame, view, tag, part: 'A,B', category: 'layering', note: 'A should be above B', priority: 'high' }` where asset = the output canvas, or the rig when on the rest pose, or the canvas in canvas mode. Data: rig `/layers` + `/debug` (atlas PNG, one cell per part); canvas mode loads one PNG per layer (`?layer=i&frame=f`). Reloads 250 ms after a relevant `change`. Keys `,` `.`.

`stack.ts` (pure): `normStack(raw: RawStackEntry[]): StackEntry[]`, `hue(i, n)`, `hitTest(alpha, W, px, py, visible)`, `overlapMask(alpha[], W, H, visible): Uint8Array`, `outlineMask(alpha, W, H): Uint8Array`, `laneLayout(frames, parts, width, rowH)`.

Changes (performance, same pixels on screen):

- Legacy tints by creating an `OffscreenCanvas` per part on every draw, and paints overlap / outline with one `fillRect` per pixel. Build the tinted part canvases once per frame load; build the overlap hatch and outlines as `ImageData` at 1:1, then scale with `drawImage` (smoothing off).
- Hover hit tests read the cached alpha arrays (already the case); throttle hover text to one update per frame.
- Re-fit on resize; lanes canvas redraws on resize and DPR change.
- Stack rows become buttons with `aria-pressed` for selection; eye and solo are icon buttons.
- Frame scrubber gets `aria-valuetext="frame 3 of 12"`.

Pitfalls: `/debug` returns `atlas_parts` in atlas order, which is not the stack order: index by part name; the token guard in `setFrame` is essential (scrubbing fires many requests): also abort superseded fetches with an `AbortController`; in canvas mode cap parallel layer fetches at 6.

Tests: `normStack` for the three accepted shapes; hit test order (top first); overlap mask on a 4×4 fixture; lane layout coordinates; flag draft for rig clip / rest pose / canvas. e2e: open Layers for the rig, the stack list has ≥ 3 rows, hovering the canvas centre updates the hover line, selecting two rows enables Flag and the review dialog opens prefilled with category Layering and priority high.

### 5.7 3D model viewer (`viewers/model/*`)

Current: three.js 0.170.0 loaded lazily (`three`, `OrbitControls`, `GLTFLoader`, `VertexNormalsHelper`) as one `three-*.js` chunk. Loads the in-memory GLB (`/api/model/<n>/glb`, or an exported `.glb`, or a model snapshot via `?snap=`). Toolbar: Wireframe (`W`), Clusters (triangles in Morton order cut into runs of 128, flat colour each, as a separate mesh group), Normals, UV checker (replaces `map` with a numbered checker texture), Sockets (default on; axes + labels for `socket_*` nodes), Pivots (sphere + axes + labels for named nodes), Grid (default on, sized from the bounding box, at the model's base), Channel select (Lit, Albedo, Normal, ORM, Metal, Rough, AO, Emissive, Height, Detail, Lightmap, Bent normals, Tangents, Lightmap UVs; channels that need the materials-v2 GLB reload with `profile=three`, those that need a bake add `bake=1`; shown through a `RawShaderMaterial` with channel swizzle, sRGB handling and fallback constant colours; status notes how many meshes lack the channel), Clip select ("rest pose" / "no clips" + clips with durations), play / pause, Loop, Reset view (`0`), GLB download. HTML labels projected each frame. Status: tris, verts, meshes, materials, nodes, sockets, clips, size, rig nodes, byte size, warnings, channel note. Reload 200 ms after a `model` event for this model or a `change` to one of its texture canvases; the camera is kept when the same model reloads. Review mode: click = 160 px crop of the rendered view as `image` (needs `preserveDrawingBuffer: true`). WebGL failure → server software thumbnail (`thumb.png?size=384`) + "WebGL unavailable (…); showing the server preview."

Files:

```ts
// model/three.ts
export interface ThreeBundle { THREE: typeof import('three'); OrbitControls: ...; GLTFLoader: ...; VertexNormalsHelper: ... }
export function loadThree(): Promise<ThreeBundle>;   // the four dynamic import('...') calls, literally, cached in a module variable
// model/channels.ts
export const CHANNELS: Record<ChannelId, { label: string; source: string | null; swizzle?: 'rgb' | 'r' | 'g' | 'b'; needs?: 'three' | 'bake' }>;
export const VS: string; export const FS: string;
export function needRank(need: '' | 'three' | 'bake'): 0 | 1 | 2;
export function glbQuery(target: Target, need: '' | 'three' | 'bake'): string;
// model/clusters.ts
export function mortonKey(x: number, y: number, z: number): number;        // 10 bits per axis
export function clusterColorIndex(sortedRank: number, base: number): number; // floor(rank / 128) + base
// model/ModelViewer.ts
export class ModelViewer extends BaseViewer { onEvent; onKey; }
```

`test/ui.test.js` and `test/materials.test.js` read the viewer source and assert it contains `import('three')`, the three addon specifiers, and the strings `chanSel`, `profile=three`, `bake=1`, `lightMap`, `bentNormalTexture`, `RawShaderMaterial`. Update both tests to read `web/src/viewers/model/three.ts` + `channels.ts` + `ModelViewer.ts` concatenated, and keep every one of those strings present (name the field `chanSel`, keep the literal import specifiers inside `import('…')`).

Changes:

- **Disposal (legacy leaks GPU memory on every reload and on destroy).** Add `disposeModel(root)`: traverse; for each mesh dispose geometry; for each material dispose it and every texture property (`map`, `normalMap`, `metalnessMap`, `roughnessMap`, `aoMap`, `emissiveMap`, `lightMap`, plus textures fetched through `gltf.parser.getDependency` that were handed to shader uniforms: track them in a `Set`). Call it when a new model replaces the old one and in `destroy()`. Also dispose: channel `RawShaderMaterial`s (track in a list, dispose when the channel changes), the cluster group, normal helpers (`geometry` + `material`), grid, socket / pivot helpers, the checker texture, the mixer (`stopAllAction()`, `uncacheRoot(model)`), `controls.dispose()`, `renderer.dispose()`, `renderer.forceContextLoss()`, remove the canvas.
- **Render on demand.** Legacy renders every frame forever. Keep one rAF loop but render only when `needsRender` is set: on OrbitControls `change`, while damping is settling (`controls.update()` returns true), while a clip plays, after resize, after any toggle / channel / model change, and for normal helpers when animated. Label placement runs with each render. Stop the loop while `document.hidden`.
- Pixel ratio `Math.min(devicePixelRatio, 2)`; update on DPR change.
- Clock: `getDelta()` after a pause must not jump the animation: clamp `dt` to 0.1 s.
- WebGL context loss: listen for `webglcontextlost` (prevent default, show "WebGL context lost — click to restore") and `webglcontextrestored` (reload the model).
- Chunk load failure (offline dev server, stale cache after a rebuild): show the server thumbnail fallback with "3D viewer failed to load (…)" and a Retry button that clears the cached promise.
- GLB fetch uses `getArrayBuffer` with an `AbortController` so a superseded load is cancelled.
- Compare mode can mount two model viewers = two WebGL contexts. That is fine; do not share a renderer.
- Keyboard `(new)`: arrow keys orbit by 10° when the 3D canvas has focus; `+` / `-` dolly. The canvas is focusable with `aria-label="3D view of <name>"`.
- Toolbar toggles reflect state for assistive tech (native checkboxes; keep).

Pitfalls: `preserveDrawingBuffer: true` must stay (review crop, e2e pixel check); the UV checker swaps `material.map` on shared materials, so remember originals per material (`userData.origMap`) and restore before disposal; channel materials replace `mesh.material`, so wireframe must apply to both the originals and the shader materials; `clipSel` keeps the selection across reloads when the clip still exists and honours `target.clip`; the status base text and the channel note are composed separately; when `open` is called while three is still loading, the token guard must stop the older call from calling `setModel`.

Typings `(Review 2)`: `three` ships no `.d.ts` (checked in `node_modules/three`), so add `@types/three@0.170.0` (MIT, types only, nothing reaches the bundle) as a devDependency in step 1 rather than "if needed"; `ThreeBundle` and `ShadingRig` are then fully typed and the "no `any`" rule holds for the model viewer too.

Tests: unit: `glbQuery` for each channel need and snapshot combination, `needRank` reload decision, Morton key ordering on a small fixture, status line formatting, `disposeModel` on a fake scene graph (every geometry / material / texture `dispose` spy called exactly once, shared material disposed once). e2e (`model3d.spec.ts`, section 6.2): runtime check that WebGL actually rendered.

### 5.7b 3D viewport shading modes `(new, owner requirement)`

Goal: the user can judge how a model really looks when shaded, the way Blender's viewport header does it. Four modes, switched from a segmented control in the model toolbar, with keys `1`–`4` and a `Z` pie. Everything below lives in the lazy `three-*.js` chunk; nothing here may enter the initial bundle.

All class names and import paths below were checked against the installed `three@0.170.0` (`node_modules/three/examples/jsm/...`).

#### Modes

| Key | Mode | What it shows | Implementation (three r170) |
| --- | --- | --- | --- |
| `1` | Wireframe | geometry only | current wireframe behaviour as a mode: every material `wireframe = true` on top of Solid shading. The existing `W` key and Wireframe checkbox stay as an overlay toggle that works in every mode. |
| `2` | Solid | form, without scene lighting: matcap studio look, pixel textures kept | per source material one `THREE.MeshMatcapMaterial({ matcap, map: src.map, color: src.color, vertexColors: src.vertexColors, side: src.side, transparent: src.transparent, opacity: src.opacity, alphaTest: src.alphaTest, flatShading: false })`. `map` is the model's own texture object, so its `magFilter = NearestFilter` is untouched. `matcap` is one shared `THREE.CanvasTexture` (256×256, drawn once: neutral grey sphere with a soft key highlight top-left and a cool rim; `colorSpace = SRGBColorSpace`). Toggle "Texture" (default on) sets `map` to null for a plain clay view. No lights, no shadows, no post-processing, `renderer.toneMapping = NoToneMapping`. |
| `3` | Material preview | PBR response under a neutral studio environment | the model's original `MeshStandardMaterial` / `MeshPhysicalMaterial` from `GLTFLoader` (base colour, ORM, normal, emissive maps as exported). Environment: `new RoomEnvironment()` (`three/addons/environments/RoomEnvironment.js`) → `new THREE.PMREMGenerator(renderer).fromScene(room, 0.04)` → `scene.environment = rt.texture`; `scene.environmentIntensity = 1`; `scene.environmentRotation.y` follows the Rotate slider. No HDR file, no network. Tone mapping `renderer.toneMapping = THREE.NeutralToneMapping` (keeps pixel-art albedo close to the source colours; ACES would shift hues), `toneMappingExposure = 1`. Direct lights off. No shadows, no AO pass. This mode loads the `profile=three` GLB (materials v2) so the maps exist. |
| `4` | Rendered | lit scene: sun + sky fill, real-time shadows, ambient occlusion, optional baked AO / lightmap | materials as in Material preview. Lights: `THREE.DirectionalLight` (sun, `castShadow = true`) + environment at `scene.environmentIntensity = 0.35` as fill. Shadows: `renderer.shadowMap.enabled = true`, `renderer.shadowMap.type = THREE.PCFSoftShadowMap`; every model mesh `castShadow = receiveShadow = true`; ground catcher `new THREE.Mesh(new THREE.PlaneGeometry(s, s), new THREE.ShadowMaterial({ opacity: 0.4 }))`, rotated flat at `box.min.y`, `receiveShadow = true`. AO: `EffectComposer` → `RenderPass` → `GTAOPass` → `OutputPass` (all from `three/addons/postprocessing/`). Tone mapping `NeutralToneMapping` (applied by `OutputPass`, which reads `renderer.toneMapping`). |

Solid lighting `(Review 2)`: Blender's Solid mode offers MatCap, Studio and Flat lighting; do the same with a "Lighting" select shown in Solid (persisted as `solidLight`):

- `matcap` (default): as in the table.
- `studio`: **the legacy look, kept exactly**: the model's original materials lit by the legacy `HemisphereLight` + `DirectionalLight` (same colours, intensities and positions as `web/ui/viewers/model.js` today; copy the numbers), no environment, no shadows, `NoToneMapping`. This is how "improve, never remove" is met for the old lighting: nothing the user could see before is gone.
- `flat`: unlit: one `MeshBasicMaterial({ map, color, vertexColors, side, transparent, opacity, alphaTest })` twin per source material (same twin `Map` mechanism as the matcap twins, a second map). Shows the texture colours exactly as painted.

The "Texture" toggle applies to `matcap` and `flat`.

Default mode: Material preview. The legacy look (hemisphere + directional light, no environment) is no longer the default but stays available as Solid › Studio (above); note this in the CHANGELOG. Whether the default should be Material preview or Solid › Studio is an owner decision (section 10); until told otherwise use Material preview.

Decisions and reasons:

- **AO = `GTAOPass`** (three addon, added in r160), not `SSAOPass` and not the external `n8ao` package. GTAO gives cleaner contact shading than SSAO at the same sample count, ships its own Poisson denoise, hides lines and points during its normal pre-pass (`overrideVisibility()` skips `isLine` / `isPoints`, so the grid, axes and normal helpers do not get occluded or cast AO), and adds no dependency or licence. `n8ao` is somewhat faster at high quality but is one more package in the lazy chunk for a difference that does not matter on low-poly models.
- **Shadows = `PCFSoftShadowMap`**, not `VSMShadowMap`: VSM light-bleeds on thin low-poly parts (gun barrels, blades) and needs a blur pass; PCF soft is stable and cheap.
- **Contact shadow** = the `ShadowMaterial` ground catcher plus GTAO where the model meets the ground. No separate contact-shadow pass.
- **Tone mapping = Neutral** everywhere PBR is shown; never ACES.

#### Baked lighting (what the engine exports)

`art_model export` can bake AO (`bake_ao`), lightmaps (`lightmap`) and SH9 probes (`probes`). The viewer shows them in Rendered mode through a "Baked" select: `Off` (default), `AO`, `AO + lightmap`.

- Workspace models: selecting anything other than Off loads the GLB with `profile=three&bake=1` (the server's quick bake: lightmap + AO + bent normals on `TEXCOORD_1`), the same request the Lightmap / AO channels already use. Reuse the existing "need rank" logic so a bake is fetched at most once per model version.
- `AO`: `material.aoMap` is already set by `GLTFLoader` (occlusion texture); set `material.aoMapIntensity = 1` and ensure `aoMap.channel = 1` when the occlusion texture uses `texCoord 1`.
- `AO + lightmap`: the lightmap is in material extras: `material.userData.lightMap = { index, texCoord: 1, intensity, range, encoding }` (see `src/materials.js`). Resolve it with `gltf.parser.getDependency('texture', index)`, then `material.lightMap = tex; tex.channel = 1; tex.colorSpace = SRGBColorSpace; material.lightMapIntensity = extras.intensity; material.needsUpdate = true`. While a lightmap is shown, turn the real-time sun and the GTAO pass off for those materials' scene (the bake already contains direct light and occlusion; stacking both double-darkens) and show "baked lighting" in the status line. Meshes without a lightmap keep real-time lighting; the status line says how many.
- Exported `.glb` files (opened from Exports) carry whatever was baked at export time; apply the same logic to what the file contains, with no reload.
- Probes: exported next to the GLB as metadata (`src/modelexport.js` writes `meta.probes` into the model's meta JSON, and a `<base>.probes.json` side file above 64 probes; confirm the exact side-file name there). For an exported `.glb` whose meta JSON has `probes`, add a "Probes" checkbox that draws one small sphere per probe shaded by its SH9 coefficients: `new THREE.LightProbe(new THREE.SphericalHarmonics3().fromArray(coeffs, i * 27))` visualised with `LightProbeHelper` (`three/addons/helpers/LightProbeHelper.js`), positioned from `origin` + `spacing` + `dims` (px → units with the GLB's `px_per_unit`). Workspace models have no probes until exported; the checkbox is hidden for them.
- The existing channel views (AO, Lightmap, Bent normals, Lightmap UVs, ...) stay exactly as they are. Selecting a channel other than "Lit" is a debug view that overrides the shading mode: the mode switcher is shown dimmed with the title "Channel view active" and the composer is bypassed.

#### Controls (model toolbar, second row `.vtoolbar.shading`)

| Control | Values | Notes |
| --- | --- | --- |
| Shading mode | segmented radio group: Wireframe, Solid, Material, Rendered (icons `box`-outline, `circle`, `circle-dot`-style sphere, `sun`; titles with keys) | keys `1`–`4` when slot A is a model viewer. Model targets have no viewer tabs, so the global `1`–`5` tab shortcut never applies there (the viewer's `onKey` runs first, K7). |
| `Z` | opens a pie at the pointer (or stage centre): four wedges in Blender's layout `(corrected in Review 2)`: left Wireframe, right Solid, top Rendered, bottom Material preview; pick with a click, `1`–`4`, or arrow keys + Enter; `Esc` or releasing outside closes. DOM overlay inside the stage, `role="menu"`. | plain `Z` only; `Ctrl+Z` stays undo (K3). |
| Sun (time of day) | range 6.0–18.0, step 0.25, default 10.0 | elevation `= 5° + 70° * sin(π * (t - 6) / 12)`; azimuth sweeps east → west with `t`; colour warms below 15° elevation (`Color.lerpColors(0xffb070, 0xffffff, k)`), intensity 1.2–3.0. Rendered only. |
| Rotate | range 0–360°, default 35 | adds to the sun azimuth and sets `scene.environmentRotation.y` (Material + Rendered). Also `Shift` + drag left / right on the stage. |
| Shadows | checkbox, default on | Rendered only. |
| AO | checkbox, default on + strength range 0–1.5, default 1 | `gtaoPass.blendIntensity = strength`; unchecked removes the pass from the chain (`pass.enabled = false`). |
| Baked | select Off / AO / AO + lightmap; "Probes" checkbox when available | Rendered only. |
| Background | select: Dark (`--canvas-bg`, today's look), Studio grey (`#3c3f45`), Environment (`scene.background = envTexture`, `scene.backgroundBlurriness = 0.6`, `scene.backgroundIntensity = 0.6`) | Environment is offered in Material and Rendered. |
| Turntable | toggle button, speed 30°/s | `controls.autoRotate = true; controls.autoRotateSpeed = 5` (OrbitControls: 2 = 30 s per turn, so 5 = 12 s); stops on the first pointer down on the stage. Not persisted. |
| Quality | select Auto (default), Low, Medium, High | see below. |
| Lighting `(Review 2)` | select MatCap (default), Studio, Flat | Solid only; see "Solid lighting" above. |
| View `(new, Review 2)` | select: Front, Back, Right, Left, Top, Bottom, Frame model | every mode. Keys by `e.code` so they never collide with the `1`–`4` shading keys (which match `Digit1`–`Digit4` only): `Numpad1` front, `Numpad3` right, `Numpad7` top, `Numpad9` the opposite of the current preset (front ↔ back, right ↔ left, top ↔ bottom), `NumpadDecimal` and `Home` frame the model (fit the bounding sphere, keep the direction). `0` / Reset view is unchanged. The camera moves there in 200 ms (0 ms with reduced motion) by interpolating the spherical offset around `controls.target`; `model/views.ts` holds the pure maths: `presetAngles(name): { azimuth: number; polar: number }`, `opposite(name)`, `lerpSpherical(a, b, t)` (shortest way round in azimuth), `frameDistance(radius, fovDeg, aspect)`. OrbitControls stays the controller; during the tween set `controls.enabled = false`, set the camera position from the interpolated spherical, call `controls.update()`, request a render. Top / Bottom use polar `0.001` / `π - 0.001` (OrbitControls cannot sit exactly on the pole). |
| Axis gizmo `(new, Review 2)` | three's `ViewHelper` (`three/addons/helpers/ViewHelper.js`, already inside `node_modules/three`, no new package) in the bottom-right 128 × 128 px of the stage | `new ViewHelper(camera, renderer.domElement)`; keep `viewHelper.center` equal to `controls.target`; after the main render (composer or renderer) call `viewHelper.render(renderer)` with `renderer.autoClear = false` around it. A pointer up without a drag inside that corner calls `viewHelper.handleClick(event)`; while `viewHelper.animating` is true call `viewHelper.update(dt)` each frame, keep rendering, and afterwards run `controls.update()`. It is pointer-only: the View select and the numpad keys are the keyboard / screen-reader path. `viewHelper.dispose()` joins the disposal list. |
| Overlays `(new, Review 2)` | checkbox, default on, session only | off hides the grid, sockets, pivots, normals helper, HTML labels and the axis gizmo in one go without changing their own toggles (Blender's "Show Overlays"); on restores exactly what was shown. Use it for clean screenshots and review crops. |

Controls that do not apply to the current mode are hidden, not disabled (keeps the toolbar short). Persist in `agent-art:modelView` `{ mode, texture, solidLight, sun, rotate, shadows, ao, aoStrength, baked, bg, quality }`. The status line gains ` · <mode>` and, in Rendered, ` · shadows 2048 · GTAO 16` (the active quality facts) or ` · degraded: <reason>`.

#### Quality tiers and auto-degrade

| | Low | Medium | High |
| --- | --- | --- | --- |
| DPR cap (`renderer.setPixelRatio`, `composer.setPixelRatio`) | 1 | `min(dpr, 1.5)` | `min(dpr, 2)` |
| Shadow map (`light.shadow.mapSize`) | 1024 | 2048 | 4096 |
| GTAO `updateGtaoMaterial({ samples })` / `updatePdMaterial({ samples, rings })` | 8 / 8, 2 | 16 / 16, 2 | 24 / 16, 2 |
| GTAO radius | `0.12 * diag` (same for all tiers; `updateGtaoMaterial({ radius, distanceFallOff: 1, thickness: 1 })`) | | |
| Composer MSAA (`new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples })`) | 0 | 2 | 4 |
| AO while orbiting | off, back 150 ms after `controls` `end` | on | on |

Auto: start tier = Low when `WEBGL_debug_renderer_info` `UNMASKED_RENDERER_WEBGL` matches `/Intel|UHD|Iris|SwiftShader|llvmpipe|Mali|Adreno|PowerVR|Microsoft Basic/i` or `renderer.capabilities.maxTextureSize < 8192`, else Medium (never High automatically). Then watch frame cost `(measurement corrected in Review 2)`: do **not** time `composer.render()` / `renderer.render()` with `performance.now()`: WebGL calls return before the GPU has done the work, so that number stays near 1 ms on exactly the machines that struggle. Measure the interval between consecutive animation frames instead: while the viewer renders continuously (pointer interaction, clip playback, turntable, view tween), `frameCost(ms)` gets the delta between this rAF timestamp and the previous one, only when the previous frame was also a rendered frame (so idle gaps are never counted) and the document is visible; ignore deltas above 250 ms (tab switch, GC pause). Keep a rolling mean of the last 30 deltas. If the mean stays above 34 ms (under 30 fps) for 1.5 s, step down once, in this order: DPR to 1 → GTAO samples 8 → shadow map 1024 → AO off → shadows off. Never step up automatically; a manual Quality choice disables auto. Each step writes the reason to the status line once and never toasts. Slot B (compare) always starts one tier below slot A.

#### Render pipeline

```ts
// model/shading.ts
export type ShadingMode = 'wire' | 'solid' | 'material' | 'rendered';
export type Quality = 'auto' | 'low' | 'medium' | 'high';
export interface ShadingSettings { mode: ShadingMode; texture: boolean; solidLight: 'matcap' | 'studio' | 'flat'; sun: number; rotate: number; shadows: boolean; ao: boolean; aoStrength: number;
  baked: 'off' | 'ao' | 'ao+lightmap'; bg: 'dark' | 'studio' | 'env'; quality: Quality }
export function sunDirection(timeOfDay: number, rotateDeg: number): { azimuth: number; elevation: number; color: number; intensity: number };  // pure
export function tierFor(rendererName: string, maxTextureSize: number): 'low' | 'medium';                                                     // pure
export function nextDegradeStep(state: DegradeState): DegradeStep | null;                                                                    // pure
export function needFor(settings: ShadingSettings, channel: ChannelId): '' | 'three' | 'bake';                                               // pure: which GLB to fetch
export class ShadingRig {
  constructor(T: ThreeBundle, renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera);
  setModel(root: THREE.Object3D, gltf: GLTF, box: THREE.Box3, diag: number): void;   // builds matcap twins, fits the shadow camera and ground plane
  apply(settings: ShadingSettings): Promise<void>;                                   // idempotent; swaps materials, lights, env, passes
  setSize(w: number, h: number, dpr: number): void;
  render(): void;                                                                    // composer in Rendered with AO, else renderer.render
  frameCost(ms: number): void;                                                       // feeds auto-degrade
  info(): { mode: ShadingMode; tier: string; shadowMap: number; gtaoSamples: number; composer: boolean; degraded: string[] };
  dispose(): void;
}
```

`three.ts` `loadThree()` adds, still inside the one lazy chunk: `three/addons/postprocessing/EffectComposer.js`, `RenderPass.js`, `GTAOPass.js`, `OutputPass.js`, `three/addons/environments/RoomEnvironment.js`, `three/addons/helpers/LightProbeHelper.js`, and `three/addons/helpers/ViewHelper.js` (Review 2, axis gizmo). The Vite `codeSplitting` group already matches everything under `node_modules/three/`, so they land in `three-*.js`; `check-ui-build.js` asserts that no other chunk contains the strings `GTAOPass` or `RoomEnvironment`. Keep the literal `import('three/addons/…')` specifiers (tests read them).

Rules:

- Material swap never mutates the source materials: Solid uses twin `MeshMatcapMaterial`s kept in a `Map<Material, MeshMatcapMaterial>`; switching back restores `mesh.material` from `userData.origMat` (the same slot the channel views use; channel views take precedence).
- Skinned and morphing meshes: `MeshMatcapMaterial` needs no flags in r170; verify with the rig model that a playing clip deforms in Solid.
- Shadow camera: orthographic frustum fitted to the model's bounding sphere each time the model or the sun direction changes (`light.shadow.camera.left/right/top/bottom = ±1.2 * radius`, `near = 0.1`, `far = 6 * radius`, `updateProjectionMatrix()`), `light.shadow.bias = -0.0004`, `light.shadow.normalBias = 0.02`. When `mapSize` changes: `light.shadow.map?.dispose(); light.shadow.map = null`.
- Transparent / glass parts (`material.transparent`): `castShadow = false`.
- The environment is built once per viewer on first use of Material or Rendered and reused: keep the PMREM render target; dispose the `PMREMGenerator` and the `RoomEnvironment` scene (`room.dispose()`) right after generation.
- Composer: created lazily on the first Rendered frame that needs AO. Chain `RenderPass(scene, camera)` → `GTAOPass(scene, camera, w, h)` (`output = GTAOPass.OUTPUT.Default`) → `OutputPass()`. With AO off in Rendered, render directly with `renderer.render` (the renderer's own MSAA and tone mapping apply) and keep the composer idle. `renderer.outputColorSpace` stays `SRGBColorSpace`; with the composer, `OutputPass` does the conversion.
- `preserveDrawingBuffer: true` stays, so the review crop and the e2e pixel reads work in every mode.
- Render-on-demand (5.7) still holds: a frame is rendered when something changed, a clip plays, the turntable runs, or damping settles. Sliders call `requestRender()`.
- HTML socket / pivot labels are unaffected. Socket axes and pivot markers render in every mode; pivot spheres set `castShadow = false`.

Disposal (extends the 5.7 list; every item must be covered by the `dispose` unit test with spies and by the e2e leak check):

- matcap twins (each `dispose()`), the matcap `CanvasTexture`;
- PMREM render target (`rt.dispose()`), `scene.environment = null`, `scene.background = null`;
- composer: `gtaoPass.dispose()` (frees its noise textures, normal / GTAO / denoise render targets and materials), `outputPass.dispose()`, `renderPass.dispose?.()`, `composer.dispose()` (frees `renderTarget1`, `renderTarget2`, copy pass), and the custom MSAA target if one was passed in;
- sun: `light.shadow.map?.dispose()`, `light.dispose()`, remove `light.target`; ground plane geometry + `ShadowMaterial`;
- lightmap textures resolved through `parser.getDependency` (track in the same texture set as the channel views); probe helper meshes;
- on mode change away from Rendered: dispose the shadow map and set `renderer.shadowMap.enabled = false` (then `needsUpdate = true` on the materials once), and release the composer after 10 s without use.

Live-reload cost `(Review 2)`: Material preview is the default and needs the `profile=three` GLB, which the server assembles on every request (tangents, ORM, height maps; `src/server.js` does not cache it). While the agent edits a model that means one heavier assemble per `model` event. So: in Material and Rendered the reload debounce after a `model` / texture `change` event is 400 ms instead of 200 ms, a reload never starts while the previous one is in flight (latest wins when it lands), and step 8b records in its commit message the measured response time of `/glb` vs `/glb?profile=three` for the seed models. If `profile=three` is more than 3× slower or above 300 ms on the seed rifle, stop and report (the owner then picks: default to Solid, or cache on the server, which is outside this plan).

Pitfalls: enabling or disabling `renderer.shadowMap` or adding the first light changes shader programs, so set `material.needsUpdate = true` on the affected materials once per transition, not per frame; `scene.environment` also affects the grid and helper materials only if they are PBR (they are basic / line materials, fine); `GTAOPass` scales its radius in world units, so derive it from the model diagonal; under SwiftShader (the e2e browser) GTAO at High can take hundreds of ms per frame, so tests select Low explicitly and use generous timeouts; two viewers in compare mode each own a full pipeline, hence the lower starting tier for slot B; a model snapshot (`?snap=`) cannot request `profile=three` reliably for old definitions, so if that request fails fall back to the plain GLB (the server already does this) and show Material / Rendered without the extra maps.

Tests (unit): `sunDirection` at 6, 12, 18 h and with rotation (azimuth wraps, elevation never below 5°); `tierFor` for sample renderer strings; `nextDegradeStep` order and termination; `needFor` matrix (mode × baked × channel); settings persistence round trip with unknown / old stored values falling back to defaults; `ShadingRig` on a fake three bundle: `apply` is idempotent, mode switches restore original materials, `dispose` calls every `dispose` exactly once, the composer is not created outside Rendered + AO. `(Review 2)`: `views.test.ts`: `presetAngles` for the six presets, `opposite`, `lerpSpherical` takes the short way across ±π and hits both ends exactly, `frameDistance` for a tall and a wide aspect; `frameCost` ignores the first delta after an idle gap and deltas above 250 ms; Solid `studio` restores the original materials and adds exactly the two legacy lights, `flat` twins are disposed once.

e2e (`model3d.spec.ts`, extends the checks in steps 5–11; all with Quality = Low unless stated):

1. Mode switcher: the radio group exists with 4 options; keys `1`–`4` select them (assert `aria-checked`), the status line contains the mode name; `Z` opens the pie (`role="menu"`, 4 items), pressing `4` picks Rendered and closes it; `Ctrl+Z` does not open it.
2. Each mode renders: for every mode read the WebGL canvas and assert ≥ 1% non-background pixels and that the image differs from the previous mode's image by more than 2% of pixels.
3. Solid keeps textures: with Texture on vs off the images differ; the model's base colour texture still has `magFilter === NearestFilter` (read through `window.agentArt.debug.viewer('A').info()`).
4. Material preview: `info().environment === true`, `toneMapping === 'Neutral'`; a request with `profile=three` was made; Rotate slider changes the image.
5. Rendered shadows: Shadows on vs off changes pixels in the lower third of the canvas (ground region) by more than 0.5%; `info().shadowMap === 1024`.
6. Rendered AO: AO strength 1.5 vs AO off differ; `info().composer` is true only while AO is on.
7. Sun slider: 7:00 vs 12:00 images differ; Rotate changes the shadow side.
8. Baked: selecting "AO + lightmap" triggers a request with `bake=1`; `info().lightmaps > 0`; the status line contains "baked lighting"; switching back to Off restores real-time lighting (image differs).
9. Background: each of the three options changes the top-left pixel colour.
10. Turntable: two canvas reads 400 ms apart differ; a pointer down on the stage stops it.
11. Quality: selecting High sets `info().shadowMap === 4096`; Auto on SwiftShader reports tier Low.
12. Leak check: cycle modes 1→4 ten times, then open another asset and return three times; assert `info().gl.textures` and `info().gl.geometries` (from `renderer.info.memory`) and `info().gl.programs` end within +2 of their values after the first full cycle, and the page's canvas count is unchanged.
13. Review mode click in Rendered still attaches a non-blank crop image (the dialog shows the preview).
14. Persistence: set Rendered + Studio grey, reload, the same mode and background are active.
15. `(Review 2)` Solid lighting: MatCap, Studio and Flat give three different images; in Studio `info().lights === 2` and `info().environment === false`.
16. `(Review 2)` View presets: `Numpad1` → `info().camera.azimuth` within 0.02 rad of 0 after 400 ms, `Numpad3` → π/2, `Numpad7` → `polar` < 0.05, `Numpad9` after `Numpad1` → azimuth ≈ π; `Digit1` still selects Wireframe and does not move the camera; "Frame model" keeps the direction and changes the distance.
17. `(Review 2)` Gizmo and overlays: with Overlays on, the bottom-right 128 px corner has non-background pixels; a click on its centre-right area changes `info().camera.azimuth`; Overlays off clears that corner, hides the `.model-labels` layer and leaves the Grid / Sockets checkboxes checked; on again restores them.

`window.agentArt.debug.viewer(slot)` returns the slot viewer's optional `debugInfo()`; only the model viewer implements it. It is a test and support hook, documented as unstable.

Screenshots (added to `screenshots.spec.ts`, Quality = High, 1680×980, a model with materials-v2 maps and a ground-touching silhouette): `26-model-solid.png`, `27-model-material-preview.png`, `28-model-rendered-shadows-ao.png`, `29-model-baked-lightmap.png`, `30-model-shading-pie.png`. `07-model-viewer.png` is retaken in the default mode (Material preview) and `08-model-wire-uv-normals.png` in Wireframe mode with UV checker and normals. Add the five new images to `docs/ui/README.md` (new row "Viewport shading") and one sentence to the README's Web UI paragraph and to `docs/3d/` if it describes the viewer.

Acceptance criteria:

- [ ] Four modes selectable by toolbar, `1`–`4` and the `Z` pie; the choice persists; channel views, wireframe overlay, UV checker, normals, clusters, sockets, pivots, grid, clips and the review crop work in every mode.
- [ ] Solid shows form with no scene lights and keeps nearest-filtered pixel textures. Solid › Studio reproduces the legacy lighting; Solid › Flat shows unlit texture colours.
- [ ] `(Review 2)` View presets by select and numpad, "Frame model", the axis gizmo and the Overlays master toggle work in every mode; none of them renders a frame while idle.
- [ ] Material preview uses `RoomEnvironment` + PMREM, Neutral tone mapping, and the model's ORM / normal / emissive maps when the GLB has them; no network request other than the GLB.
- [ ] Rendered has a shadow-casting sun with a ground catcher, GTAO with a strength control, time-of-day and rotate controls, and can show baked AO and lightmaps; probes are viewable for exports that have them.
- [ ] Background and turntable controls work; Quality has Auto / Low / Medium / High, Auto starts Low on integrated or software GPUs and steps down under load without flicker loops.
- [ ] Idle GPU use is zero in every mode (no rendering without a change, clip or turntable): assert in e2e that `info().frames` does not increase over 1 s of idleness.
- [ ] No render target, texture, geometry or program growth across mode cycles and viewer re-opens (e2e check 12).
- [ ] The three chunk stays within the budget in 7.1 and is still the only chunk containing three.js code; the initial bundle is unchanged in size by this feature (± 0.5 kB).

### 5.8 Audio player (`viewers/audio/*`)

Current: toolbar = Play / Pause (primary), Stop, Loop (default on), Volume 0..100 (default 70), time readout, selection readout, Analyze, WAV download. Waveform (up to 2 channels, min/max columns, seconds ruler with a step depending on duration, selection highlight, playhead, review time ranges with ids). Click = seek (keeps playing if it was), drag = select a range; with review mode a finished drag opens a review draft with `time`. Play respects the selection (loop points, or one pass of the range when Loop is off). Spectrum: live from an `AnalyserNode` (fft 2048, smoothing .7) while playing, else the average spectrum (up to 24 Hann windows of 4096 samples from channel 0; one zero-padded window for short clips), log-frequency bars 20 Hz..Nyquist, dB scale, frequency labels, "live" / "average" tag. Analysis panel (auto-run for clips under 12 s that are not export files): server image (base64 PNG), listener report text, stats table (first 24 scalar stats), elapsed time. Status: name, kind, recipe, duration, channels, sample rate, LUFS, peak, score, issues. Works for workspace audio (`/api/audio/<n>.wav`) and exported `.wav/.mp3/.ogg/.opus` files (no info, no analysis). Reload 300 ms after an `audio` event for this name.

Files: `audio/fft.ts` (`fftMag(input: Float32Array): Float32Array`, `averageSpectrum(samples, n = 4096, maxWindows = 24)`, `bars(mags, sampleRate, nBars)`), `audio/wav.ts` (`wavSampleRate(buf: ArrayBuffer): number | null`, walks RIFF chunks to `fmt `), `audio/AudioViewer.ts`.

Changes:

- Decode with a short-lived `OfflineAudioContext(1, 1, 44100)` and create the real `AudioContext` lazily on the first Play (legacy creates it on open, before any user gesture, which logs an autoplay warning and holds an audio device per viewer).
- The status line shows the file's sample rate from the WAV header when available (legacy shows the context's rate, which is the output device's rate, not the file's).
- Waveform: precompute min/max peaks once per (buffer, width) into typed arrays; the per-frame draw while playing only blits the cached waveform bitmap and draws the playhead. Legacy rescans the samples every frame.
- Volume persists in `agent-art:volume` `(new)`; Loop persists in `agent-art:audioLoop` `(new)`.
- Keyboard `(new)`: the waveform is focusable (`role="slider"`, `aria-valuemin 0`, `aria-valuemax duration`, `aria-valuenow position`, `aria-valuetext "1.25 of 3.40 seconds"`); Left / Right seek 5% (Shift 1%), Home / End.
- `destroy()`: stop the source, cancel rAF, disconnect nodes, `close()` the context, drop the buffer and cached bitmaps.
- Analysis image gets `alt="Analysis image the agent reads: waveform, spectrogram, loudness"`.

Pitfalls: `AudioBufferSourceNode` is single use: create a new one per play; `onended` also fires on `stop()`: compare identity before resetting the button (legacy does); looped playback position = `(now - startedAt) % length`; selection end before start is normalised; `decodeAudioData` rejects for unsupported formats (opus in Safari): show the message in the status line and keep the download link; do not auto-analyze long music.

Tests: unit: `fftMag` on a pure sine (peak bin), `averageSpectrum` for a clip shorter than one window, bar mapping monotonic in frequency, `wavSampleRate` on a canonical header and on a header with an extra `LIST` chunk, play range maths (`from`, loop, selection) as a pure function `playbackPlan(pos, sel, duration, loop)`. e2e: open the audio asset, waveform canvas has non-background pixels, the Analysis panel appears with an image, pressing Space toggles the button label Play ↔ Pause.

### 5.9 Asset graph (`viewers/graph/GraphViewer.ts`, `graph/sim.ts`)

Current: 2D canvas, pan / zoom, force layout (grid-bucketed repulsion within 140 px, spring lengths 70 for `part_of` and 110 otherwise, weak gravity, velocity cap, cooling 0.985 per tick, stops under 0.01) or "Layered by kind" (columns by kind order, rows sorted by id). Nodes: circle coloured by kind with the kind glyph (zoom > 0.6), thumbnails for canvas / model / rig when zoom > 1.1 (cache up to 1500 images keyed by id + version), missing nodes hollow, selection / hover ring, `+` for collapsed groups, review count badge, approved tick, superseded (red dashed ring + slash + label) and orphan (grey dashed ring + label) badges, labels by zoom, tags under the label at zoom > 1. Edges: coloured by relation, dashed when not derived, arrow heads, relation label (+ attrs) when zoom > 0.9 and fewer than 600 edges, or when attached to the selection. Selection dims unrelated nodes. Toolbar: Find node (first match by id or note, zooms to ≥ 1.2 and centres), Tag select, Sub-assets toggle (persist `graphSub`), layout select (persist `graphLayout`), Fit, counts. Relation chips row (checkbox per relation, persist `graphHiddenRels`, default hides `layer_of`). Collapsed groups (double-click, persist `graphCollapsed`) fold their members, with edges re-pointed to the outermost collapsed group and de-duplicated. Tooltip on hover (id, note, review / approved / superseded / orphan). Click = select → inspector shows the node; double-click a non-group = open it. Target `focus` selects and centres. Reload 400 ms after `graph`, `deleted`, `model`, `audio`, `project` events and structural `change` events; positions of surviving nodes are kept. `0` = fit. First load auto-fits (after 700 ms in force mode).

`sim.ts` (pure, unit-tested): `applyFilter(nodes, edges, { tag, showSub, hiddenRels, collapsed }) → { vis, edges }`, `stepForce(vis, edges, alpha, dragId) → nextAlpha`, `layeredLayout(vis)`, `fitView(vis, W, H) → { x, y, k }`, `hitTest(vis, wx, wy, k, radiusOf)`.

Changes:

- Seed new node positions deterministically (hash of the id) instead of `Math.random()`, so reloads and screenshots are stable.
- Draw only when dirty (already) and pause the loop while `document.hidden`; cap simulation at 300 ticks per layout run, then let a drag re-heat it.
- DPR change handling; canvas `aria-label="Asset graph: N nodes, M edges"`.
- Accessibility `(new)`: a visually hidden, keyboard-reachable list of the visible nodes (`<ul role="listbox">` in the toolbar area, toggled with a "List" button) so selection and open work without a pointer; Arrow keys on the focused canvas pan, `+` / `-` zoom, Enter opens the selection.
- Thumbnail `Image` objects: on destroy set `src = ''` and clear the map.
- The relation chips become real toggle chips with `aria-pressed`.
- Keep Unicode kind glyphs for the canvas-drawn node icons (`KIND_ICON`), since they are drawn with `fillText`.

Pitfalls: group double-click also fires two clicks: keep the 350 ms guard; `rep()` (outermost collapsed ancestor) must stay cycle-safe; a tag filter keeps groups but drops isolated ones; `select(id)` must call `host.inspectNode(id)` and not `open`; reload must not reset the view transform.

Tests: `applyFilter` (sub-assets hidden, tag filter, hidden relations, nested collapsed groups, cycle), `fitView`, `hitTest` nearest wins, `layeredLayout` column order, force step keeps a dragged node fixed, deterministic seeding. e2e: open the graph (Shift+G), counts text matches `/\d+ nodes/`, type a node name in Find → the inspector title changes to that node, press `0`.

### 5.9b Graph: Cards renderer and Hierarchy layout `(new, Review 2, RV4)`

Why: the canvas graph draws assets as coloured dots with a glyph; you cannot recognise a sprite, nodes cannot take focus, and the only structured layout sorts by kind and ignores the edges. A node-graph library gives real DOM nodes (thumbnails, the same badges and icons as the rest of the UI, hover actions, focus and keyboard for free), a minimap and tested pan / zoom / drag. A layered layout library gives edge-aware ranks. The canvas renderer of 5.9 is kept: it is faster for large graphs and is the parity port; both renderers share the data, filter, selection and positions.

Packages (devDependencies, both lazy):

| Package | Version checked | Licence | Use | Size (gzip, estimate; measure and record in the commit) |
| --- | --- | --- | --- | --- |
| `@xyflow/svelte` (Svelte Flow) | 1.7.1, peer `svelte ^5.25.0` (installed 5.57.3), released within the last week, runes-native | MIT; pulls `@xyflow/system` (MIT), `@svelte-put/shortcut` (MIT) and `d3-zoom`, `d3-drag`, `d3-selection`, `d3-interpolate` + their d3 deps (ISC / BSD-3-Clause) | Cards renderer | ≈ 55–65 kB JS + ≈ 3 kB CSS, chunk `graph-cards` |
| `@dagrejs/dagre` | 3.1.3 (+ `@dagrejs/graphlib` 4.0.6) | MIT | Hierarchy layout for both renderers | ≈ 20–25 kB, chunk `graph-layout` |

Rejected for this job: `elkjs` (licence is EPL-2.0 / GPL, outside the allowed set, and ≈ 400 kB gzip); Cytoscape (first planner's rejection stands: a second canvas renderer buys nothing over ours); `d3-force` (the ported `stepForce` is tested and good enough; not worth a dependency).

Structure:

- `GraphViewer.ts` becomes the controller: data loading, `applyFilter`, toolbar, relation chips, selection, collapsed groups, persistence, events, `positions: Map<string, { x: number; y: number; pinned?: boolean }>`. Rendering moves behind one interface:

  ```ts
  // graph/renderer.ts
  export interface GraphRenderer {
    setData(d: { nodes: VisNode[]; edges: VisEdge[]; positions: Map<string, { x: number; y: number }>; selected: string | null; version: number }): void;
    setSelected(id: string | null): void;
    fit(): void; center(id: string, minZoom: number): void;
    resize(): void; destroy(): void;
    readonly settled: boolean;
  }
  export interface GraphRendererHost {
    onSelect(id: string | null): void; onOpen(id: string): void; onToggleGroup(id: string): void;
    onMoved(id: string, x: number, y: number): void;      // drag end: store and pin
    onAction(id: string, action: 'compare' | 'pin' | 'hide'): void;
    thumb(node: VisNode): string | null; isHidden(id: string): boolean; isPinned(id: string): boolean;
  }
  ```

- `graph/CanvasRenderer.ts`: the 5.9 canvas drawing and pointer code, moved behind that interface (step 10 already produces it in this shape; see the step list).
- `graph/flow/mountFlow.ts`: `export async function mountFlow(el: HTMLElement, host: GraphRendererHost): Promise<GraphRenderer>`: dynamic `import('./FlowGraph.svelte')` + `import('svelte')`'s `mount` / `unmount`; props are a `$state.raw` object in `bridge.svelte.ts` that `setData` replaces. This is the one allowed Svelte import under `viewers/` (2.2).
- `graph/flow/FlowGraph.svelte`: `<SvelteFlow>` with `nodes` / `edges` built from the bridge props, `nodeTypes = { asset: AssetNode }`, `edgeTypes = { rel: RelEdge }`, `<MiniMap>` (node colour = kind colour), `<Controls>` (zoom in / out / fit; hide the lock button), `<Background>` dots. Settings: nodes draggable, not connectable, not deletable (`deleteKey={null}`), `minZoom 0.05`, `maxZoom 6` (K14), render-only-visible-elements on, pan on drag, zoom on wheel at the cursor, double-click zoom off (double-click is "open"), selection of one node at a time, no edge selection. Check the installed version's documentation for the exact prop names; do not guess them from React Flow.
- Styles: import `@xyflow/svelte/dist/base.css` (the minimal sheet, not the themed `style.css`) inside `FlowGraph.svelte`, then map its `--xy-*` variables to our tokens in the component's `<style>` (`--xy-background-color: var(--canvas-bg)`, edge stroke `--line3`, minimap background `--panel`, controls like `.btn.icon`). Vite splits this CSS into the lazy chunk; it must not appear in the initial CSS.
- `AssetNode.svelte` (card, 156 × 44 px; group nodes use the same component): 2 px left edge in the kind colour; 32 px thumbnail (`<img loading="lazy" decoding="async">`, `image-rendering: pixelated`, checker behind) for canvas / model / rig, else the kind's Lucide icon; name (ellipsis, `title` = id); second line = tags (first two) or the note, `--muted`; badges exactly as the browser rows (review count, approved, superseded, orphan); missing node = dashed border and 60% opacity; collapsed group = `+N` badge; selected = accent outline; unrelated-to-selection = 35% opacity (parity with the canvas dimming). On hover or focus a small toolbar above the card: Open, Open in compare, Pin, Hide (`IconButton` look, built inside this folder, not imported from `components/`). `aria-label="<kind> <name>, N relations"`.
- `RelEdge.svelte`: straight edge, stroke = the relation colour from the existing relation colour table (data colour, stays literal), dashed when `!derived` (parity), arrow marker, label (`rel` + attrs) only when the viewport zoom is above 0.9 and there are fewer than 600 visible edges, or when the edge touches the selected node (parity).
- Level of detail: the Flow root gets `data-lod="far"` below zoom 0.45; CSS then hides thumbnails, second lines, badges and hover toolbars and the card shrinks to a kind-coloured pill with the name. No per-node JavaScript on zoom.
- Interaction mapping: click = select (→ `host.inspectNode`, K14); double-click a non-group = open; double-click a group = collapse / expand; drag end = `onMoved` (position stored, node pinned); click on the pane = clear selection; `0` = fit (existing key). Keyboard: nodes are in the tab order (library behaviour); `Enter` on a focused node selects it, `Enter` on the already selected node opens it; arrow keys move the focused node (library behaviour) and that counts as a drag end. With this renderer the hidden "List" listbox of 5.9 is not rendered (the nodes themselves are reachable); it stays for the canvas renderer.
- Positions: both renderers read and write the controller's `positions` map, so switching renderer or reloading keeps the layout. In Cards mode the force layout is run to completion off-screen (`stepForce` in a loop, at most 300 ticks, yielding to the event loop every 50) and then applied once; there is no live simulation and a drag does not re-heat it. Scale layout distances for cards: positions from `stepForce` / `layeredLayout` are multiplied by 2.2 on the x axis and 1.0 on y when handed to the Cards renderer (cards are wide), divided again on `onMoved`.

Renderer choice: toolbar select "View": `Auto` (default), `Cards`, `Canvas`; persisted `agent-art:graphRenderer`. Auto = Cards when the filtered graph has ≤ 400 nodes and ≤ 1200 edges, else Canvas; the counts text gains ` · cards` / ` · canvas`, and when Auto fell back, ` (large graph)`. Choosing Cards above 1500 nodes is refused with a toast "Too many nodes for cards: filter by tag or collapse groups" and the select returns to Canvas. If the `graph-cards` chunk fails to load: toast once, use Canvas.

Hierarchy layout (`graph/hierarchy.ts`), third option in the existing layout select ("Force", "Layered by kind", "Hierarchy"), value `'hierarchy'`:

```ts
export async function hierarchyLayout(nodes: { id: string; w: number; h: number }[], edges: { from: string; to: string; rel: string }[]): Promise<Map<string, { x: number; y: number }>>;
// literal import('@dagrejs/dagre') inside, cached; graph options { rankdir: 'LR', nodesep: 14, ranksep: 64, acyclicer: 'greedy', ranker: 'network-simplex' }
// containment relations (exactly `part_of` and `layer_of`, plus group membership if applyFilter exposes it as an edge) are added reversed, so the container is
// ranked left of its parts; every other relation (variant_of, view_of, uses_palette, rendered_from, exports_to, depends_on, replaces, custom ones) keeps its direction. Parallel edges between the same pair are added once. Unconnected nodes are stacked in a last column, sorted by kind then id.
// Node size: 156x44 for Cards, 28x28 for Canvas.
```

Limits: more than 1500 nodes or 4000 edges → do not call dagre; status "Hierarchy needs ≤ 1500 nodes: filter by tag or collapse groups", layout falls back to "Layered by kind" for this run (the stored choice is kept). While it runs show "laying out…" in the counts text (render one frame first). Pinned positions are ignored by Hierarchy (it is a full re-layout); choosing a layout again clears pins, as today.

`debugInfo()` on the graph viewer returns `{ renderer: 'cards' | 'canvas', nodes, edges, layout, settled, positions: Record<string, [number, number]> }` (reachable through `window.agentArt.debug.viewer('A')`, same unstable hook as 5.7b).

Tests: unit: `hierarchy.test.ts` with the real dagre in Node: a project → canvas → layer chain is ranked left to right (x strictly increasing), no two node boxes overlap, a cycle does not throw, parallel edges are de-duplicated, unconnected nodes land in the last column, the node / edge limits return the fallback signal without importing dagre (spy); `chooseRenderer(pref, nodes, edges)` table; card-scale round trip (`toCards` then `fromCards` is the identity). No jsdom component test for `FlowGraph` (the library needs real layout); it is covered in e2e. e2e (`graph.spec.ts`): seed workspace opens in Cards (`debugInfo().renderer === 'cards'`); the number of `.svelte-flow__node` elements equals the node count in the counts text; a card for `helmet_front` contains an `img` with `naturalWidth > 0`; clicking it changes the inspector title, double-click opens the canvas; Tab reaches a node and `Enter` twice opens it; the minimap and the three control buttons are visible; hover toolbar Pin pins the asset (browser shows it under Pinned); switching View to Canvas and back keeps `debugInfo().positions` for an unmoved node within 1 px and keeps the selection; Hierarchy puts `project:severance` left of `canvas:helmet_front` (`positions`); with the 300-canvas workspace Auto reports `canvas` and "(large graph)"; the `graph-cards` and `graph-layout` chunks are requested only after the graph is opened / Hierarchy is chosen; axe has no serious findings on the graph in Cards mode. Screenshots: `12-asset-graph` is retaken in Cards + Force; new `31-graph-hierarchy.png` (Cards + Hierarchy) and `32-graph-canvas-large.png` (300-canvas workspace, Canvas renderer).

Acceptance:

- [ ] Every 5.9 behaviour works in both renderers (find, tag filter, sub-assets, relation chips, collapse, focus target, selection → inspector, open, fit, live reload keeping positions, persisted keys).
- [ ] Cards is the default for small graphs, Canvas for large ones, and the user can force either.
- [ ] Neither library is in the initial bundle; each is in exactly one lazy chunk within its budget (7.1).
- [ ] No store or `components/` import under `viewers/graph/flow/` (`rg "from '@/(state|components)" web/src/viewers` returns nothing).

### 5.10 Export preview (`viewers/export/ExportViewer.ts`)

Current: header line = path, size and date, Download. By extension: `.png` with a sibling `.json` (or a `.json` with `frames` and a sibling `.png`) → embedded Sheet viewer; other `.png` → PixelView (read-only); `.gif` → `<img>` pixelated, min 256 px; `.json`, `.mcmeta`, `.txt` → pretty-printed text (JSON re-indented, capped at 400 000 chars); `.glb` and audio files never reach this class (registry routes them); anything else → "No preview for .ext files."

Changes: abort superseded loads; `(new, Review 2, RV9)` `.json` and `.mcmeta` previews are syntax-coloured: `lib/util/jsonTokens.ts` `tokenizeJson(text): { t: 'key' | 'str' | 'num' | 'lit' | 'punct' | 'ws'; v: string }[]` (a single regex pass over the already pretty-printed text; never throws: text that is not valid JSON comes back as one `ws` token) and `renderJson(pre: HTMLElement, text: string, maxChars = 200_000)` in `lib/util/dom.ts`, which appends one `<span>` per token with `textContent` (no `innerHTML`) and falls back to a single text node above `maxChars`. The same tokens feed `ui/JsonView.svelte`, used for the timeline's expanded args (TL8) and the inspector's Meta block (I4). No package: a highlighter library (Shiki, Prism, CodeMirror) costs 20 kB to 1 MB for what 40 lines do for one language. Tests: tokens for nested objects, escaped quotes inside strings, numbers with exponents, `true` / `false` / `null`, a key vs a string value, invalid input; text preview gets a "Copy" button `(new)`; image dimensions in the header once known `(new)`; `resync` is ignored; `destroy()` destroys the embedded PixelView / SheetViewer.

Tests: unit: `previewKindFor(path, siblings)` → `'sheet' | 'image' | 'gif' | 'text' | 'none'`. e2e: open an exported PNG (canvas visible), the sheet JSON (sheet canvas + status mentions frames), an exported text / JSON file.

### 5.11 Project overview (`viewers/project/ProjectViewer.ts`)

Current: title, description line ("N canvases · Minecraft X — description"), Size slider 32..256 step 16 (persist `ovSize`), grid of tiles (lazy thumbnail, name, texture list); hidden canvases are skipped; click opens the canvas. Live: `project` event → reload after 300 ms; `deleted` → remove the tile; `change` with `project === name` → update the thumbnail (cache-busted with version + ts), add new tiles (green outline), and when the change is the agent's: flash and `scrollIntoView({ block: 'nearest', behavior: 'smooth' })`.

Changes: tiles are `<button>`s in a `role="list"`; smooth scrolling is `auto` with reduced motion; when follow mode is `project` and the user has scrolled manually in the last 3 s, do not auto-scroll `(new)`; grid uses `content-visibility: auto` per tile so thousands of tiles stay cheap; show hidden-canvas count in the description ("· 3 hidden") `(new)`.

Tests: unit: description line formatting; event → action decision (`planTileUpdate`). e2e: open the project from the browser, tile count equals the project's canvas count, click a tile opens that canvas; draw on a project canvas through the CLI and assert the tile has the flash class within 2 s.

---

## 6. Ordered implementation steps

Each step ends with VERIFY (section 0) green and one commit. "e2e baseline" means the Playwright suite from step 2, which must stay green from then on; when a step changes selectors, only `e2e/app.page.ts` changes.

### Step 1: tooling

Files: `package.json`, `package-lock.json`, `vite.config.js`, `tsconfig.json`, `scripts/check-ui-build.js`, `scripts/pw.mjs`, `playwright.config.ts`, `e2e/tsconfig.json`, `.gitignore`.

- Add devDependencies (exact versions resolved by npm at install time; record them in the commit message): `bits-ui` (the current major that declares Svelte 5 as peer), `lucide-static`, `@playwright/test`, `@types/node`, `jsdom`, `@testing-library/svelte`.
- `(Review 2)` Also add, all as devDependencies (versions are the ones checked on the registry during the review; take the newest patch of the same major, and stop and report if the peer range no longer includes the installed Svelte 5.57 / three 0.170):

  | Package | Checked | Licence | Feature it earns its place for | Chunk |
  | --- | --- | --- | --- | --- |
  | `virtua` | 0.54.2, peer `svelte >= 5.0` | MIT | virtualised asset browser and timeline: variable row heights and position-preserving prepends (TL12) that a fixed-height home-made list cannot do (step 13–15) | initial, ≈ 6 kB gzip |
  | `@xyflow/svelte` | 1.7.1, peer `svelte ^5.25.0` | MIT (+ ISC / BSD d3 parts) | graph Cards renderer (5.9b) | lazy `graph-cards` |
  | `@dagrejs/dagre` | 3.1.3 | MIT | graph Hierarchy layout (5.9b) | lazy `graph-layout` |
  | `vanilla-colorful` | 0.7.2 (last release 2022, stable, zero deps) | MIT | colour picker with alpha as a custom element usable from viewer-built DOM (5.2) | lazy, ≈ 3 kB |
  | `fuzzysort` | 4.0.2 | MIT | ranked fuzzy matching with match highlighting over thousands of asset names for the command palette (step 18b) | lazy `palette`, ≈ 5 kB |
  | `@types/three` | 0.170.0 (must equal the `three` version) | MIT | typings only (5.7) | none |

  `bits-ui` 2.x lists `@internationalized/date` as a peer; npm installs it automatically. It is only used by Bits' date components and must not reach the bundle (the notices file below proves it: the build fails if that package appears in it).
- `(Review 2)` `scripts/vite-notices.js`: a Vite plugin (`apply: 'build'`, hook `generateBundle`) that collects the package of every bundled module id under `node_modules/` (from each output chunk's module ids), reads that package's `package.json` `license` and its `LICENSE*` / `LICENCE*` file, and emits `THIRD-PARTY-NOTICES.txt` (name, version, licence id, full licence text, sorted by name) into `dist/ui/`. It throws (failing the build) when a bundled package's licence id is not in `['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD']` or when a package named in `FORBIDDEN = ['@internationalized/date']` is bundled. Reason: MIT, ISC and BSD all require the copyright notice to travel with copies, and the minified bundle keeps only `/*! */` banners, which most of these packages do not have. Register it in `vite.config.js`. Unit test (`node:test`, in `test/ui.test.js`): the pure part `noticesFor(moduleIds, readFile)` on a fake module list (scoped package, nested `node_modules`, a disallowed licence → throws).
- `package.json` scripts: add
  - `"check:build": "node scripts/check-ui-build.js"`
  - `"test:e2e": "npm run build:ui && node scripts/pw.mjs test"`
  - `"test:e2e:install": "node scripts/pw.mjs install chromium"`
  - `"docs:ui-shots": "npm run build:ui && node scripts/pw.mjs test --grep @shots"`
  - `"check:e2e": "tsc -p e2e/tsconfig.json --noEmit"`
  - Leave `test`, `prepack`, `build:ui`, `dev:ui`, `check:ui`, `test:ui` as they are. `npm test` must not run Playwright.
- `scripts/pw.mjs`: if `PLAYWRIGHT_BROWSERS_PATH` is unset and `C:\dev-overflow` exists, set it to `C:\dev-overflow\playwright`; then spawn `node node_modules/@playwright/test/cli.js <args>` with inherited stdio and exit with its code.
- `vite.config.js`: add `resolve.alias { '@': here('./web/src') }`; add `resolve.conditions: process.env.VITEST ? ['browser'] : undefined` (Svelte component tests under jsdom); keep `test.environment: 'node'` as the default (component tests opt in with `// @vitest-environment jsdom` on line 1); add `test.setupFiles` later when needed.
- `tsconfig.json`: add `"paths": { "@/*": ["./web/src/*"] }` and nothing else. `(Review 2)`: no `"baseUrl"` (deprecated in the installed TypeScript 6.0.3: it makes `npm run check:ui` fail). Verify with one throwaway `import {} from '@/lib/x'` that both `svelte-check` and Vite resolve the alias.
- `vite.config.js` `(Review 2)`: extend the `codeSplitting.groups` so the lazy libraries get stable chunk names the budget script can find: `{ name: 'graph-cards', test: /[\\/]node_modules[\\/](@xyflow|@svelte-put|d3-[a-z]+)[\\/]/ }`, `{ name: 'graph-layout', test: /[\\/]node_modules[\\/]@dagrejs[\\/]/ }`. Keep the `three` group first. None of these groups may be imported statically from the entry.
- `scripts/check-ui-build.js` (plain Node, no deps): fail (exit 1) with a clear message when any rule in section 7.1 / 7.2 is broken. In this step the budgets are the **baseline** numbers (entry JS ≤ 60 kB gzip, CSS ≤ 8 kB gzip, three chunk ≤ 195 kB gzip); they are raised to the final budgets in step 18.
- `.gitignore`: add `test-results/`, `playwright-report/`, `e2e/.state.json`.

Acceptance: `npm ci` works; `npm run check:build` passes on the current build; `npm pack --dry-run` lists no new files outside `bin/ src/ dist/ui/ README.md LICENSE package.json`; `dependencies` is still absent or `{}`.

Tests: none new (the script is the test). Commands: VERIFY without `test:e2e`.

### Step 2: Playwright harness and baseline e2e on the legacy UI

Files: `playwright.config.ts`, `e2e/*`.

- `playwright.config.ts`: `testDir: 'e2e'`, `globalSetup`, `globalTeardown`, `workers: 1` (one shared server and workspace), `retries: 0`, `timeout: 30_000`, `use: { baseURL from e2e/.state.json, viewport: { width: 1680, height: 980 }, reducedMotion: 'reduce', launchOptions: { args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] } }`, one project `chromium`, reporter `list`, `outputDir: 'test-results'`, `grepInvert: /@shots/` unless `--grep` is given.
- `e2e/global-setup.ts`:
  1. Fail fast with "run npm run build:ui" if `dist/ui/index.html` is missing.
  2. `home = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-e2e-'))`.
  3. Pick a free port: listen on port 0, read it, close.
  4. Seed (`e2e/seed.ts`) **before** starting the server, through `e2e/cli.ts`: `execFileSync(process.execPath, ['bin/agent-art.js', '--home', home, '--port', String(port), 'tool', name, '-'], { input: JSON.stringify(args) })`. Passing JSON on stdin avoids shell quoting on Windows. With nothing listening on the port the CLI runs in-process on `home`.
  5. Start the server: `spawn(process.execPath, ['bin/agent-art.js', 'serve', '--port', port, '--home', home], { stdio: ['ignore', logFd, logFd] })`; poll `GET /api/health` until `app === 'agent-art'` (timeout 15 s).
  6. Write `e2e/.state.json` `{ port, home, pid }`.
- `e2e/global-teardown.ts`: kill the server pid, remove `home` (ignore errors).
- `e2e/seed.ts`: an ordered list of `{ tool, args }`. The argument shapes below are indicative: run each once by hand against a temp home, correct them with `node bin/agent-art.js tools` and `node bin/agent-art.js help <topic>`, then freeze them. The seed must produce at least:
  - project `severance` (description, a 4-colour palette, notes);
  - canvases `helmet_front` and `helmet_side` (24×24, in the project, two layers each via `art_layer add`), `pauldron` (16×16, in the project), loose canvas `spark` (16×16, 4 frames, tag `spin` frames 0–3 via `art_animation tag`), all with a few `art_draw` commands (`rect`, `ellipse`);
  - rig `hero` via `art_rig {action:'create', name:'hero', template:'humanoid', ...}` plus one `animate` preset that yields ≥ 3 directional tags (walk);
  - model `rifle` via `art_model {action:'create', name:'rifle', template:'fp_rifle'}` (has sockets and clips);
  - audio `rifle_shot` via `art_audio {action:'sfx', name:'rifle_shot', recipe:<a short recipe>, seed:1}`;
  - exports: `art_export {canvas:'helmet_front', path:'helmet_front.png'}` and a spritesheet + JSON via `art_animation {canvas:'spark', action:'export', format:'spritesheet'}`;
  - graph: `art_graph` `group` "Severance armour" with the three project canvases, `link helmet_side variant_of helmet_front`, `tag`, `note`;
  - one agent review note via `art_review {action:'add', asset:'helmet_side', note:'…', category:'inconsistent', region:[12,11,5,3], compare_with:'helmet_front'}`.
- `e2e/app.page.ts`: class `AppPage` with locators and actions only: `goto(hash?)`, `browserRow(name)`, `openAsset(name)`, `tab(label)`, `timelineEntries()`, `statusText()`, `slot('A'|'B')`, `inspectorTitle()`, `toasts()`, `press(key)`, `dialog()`, `openCleanup()`, `enterSelectMode()`, `viewerStatus()`. Legacy selectors go here (ids and classes); they are swapped for roles / test ids as components migrate. Add `data-testid` only where no role / label fits.
- Console guard fixture (`e2e/fixtures.ts`, used by every spec): collect `page.on('console')` messages of type `error` and `page.on('pageerror')`; fail the test in `afterEach` if any occurred. Also fail on any request whose host is not `127.0.0.1` / `localhost` (the UI must never call out).
- Specs for this step (all against the legacy UI): `smoke.spec.ts` (page loads with HTTP 200, title, status "live", the browser lists the seeded assets, a canvas is open, hash is set); `viewers.spec.ts` (one test per viewer: canvas, animation, sheet, layers, rig, model without the pixel check, audio, graph, export PNG, export sheet, project: open it and assert its main surface exists and its status text matches a pattern); `timeline.spec.ts` (run `art_draw` on `pauldron` through `e2e/cli.ts` against the live server → a new row containing `draw` and `pauldron` appears within 3 s, status pill shows "agent is working…" then "live", follow switches slot A to `pauldron`, the browser row flashes); `keyboard.spec.ts` (`C`, `M`, `?`, `[`, `]`, `P`, `Shift+G`, `/`, `1`–`3`, `Esc` chain); `review.spec.ts` (press `M`, drag a box on the canvas, dialog shows the box coordinates, fill the note, submit → toast, Notes count increments, the card appears in the inspector; Reopen / Delete flows are added in step 16 once the native prompts are gone); `cleanup.spec.ts` (create a throwaway canvas through the CLI, select it, Plan cleanup, apply, Cleanup › Trash shows a batch, Restore all brings the canvas back); `narrow.spec.ts` (viewport 430×900: the pane toggles are visible, the assets drawer opens and closes, a canvas renders).

Acceptance: `npm run test:e2e` green on the untouched legacy UI; no test relies on a fixed sleep longer than 300 ms (use `expect.poll` / locator waits); the suite finishes in under 3 minutes; running it leaves no process behind and never touches port 7420 or `~/.agent-art`.

### Step 3: utilities, API client, event stream (TypeScript, tested), legacy re-exports

Files: `web/src/lib/util/*`, `web/src/lib/api/*`, `web/src/test/*`, `web/ui/util.js`.

- Port `util.js` into the `lib/util` modules listed in 2.1 with identical behaviour. `h()` is `el()` with types.
- Implement `lib/api` exactly as in section 3.
- `web/ui/util.js` becomes a thin re-export of the TS modules (`export { h as el } from '../src/lib/util/dom'`, `api` = a wrapper over `op` that keeps the legacy signature, `getJSON`, `postJSON`, `loadBitmap`, `store`, ...), so legacy code and new code share one implementation. `toast` / `onToast` keep working (bridge to a module-level callback for now).

Tests (Vitest):

- `format.test.ts`: `fmtMs` (undefined, 999, 1000, 9999, 10000), `fmtBytes` boundaries, `clamp`, `debounce` with fake timers.
- `ids.test.ts`: `splitId('a')` → `['canvas','a']`, names containing `:` and `/`.
- `hash.test.ts`: round trip for every target kind; names with spaces, `#`, `%`, unicode; snapshot → null; `#canvas:x`; a bare name that looks like `model` without a colon stays a canvas.
- `targets.test.ts`: `viewerKindFor` table (every row of 2.3); `tabsFor` (L8, all branches); `switchViewTarget` (L9); `targetFor` for layer / anim / frame / rigpart / modelpart / group / palette (project palette vs canvas palette); `reviewTarget`; `followTarget` (E10–E13, table-driven: follow off, hidden asset, solo, deleted, rig → parts canvas, same target no-op, view kept except layers, project mode); `snapTarget`.
- `playlist.test.ts`, `storage.test.ts` (throws in `localStorage` are swallowed; legacy `agent-art-follow` read).
- `urls.test.ts`: every builder, encoding of names with spaces and slashes, option combinations.
- `http.test.ts`: `getJSON` error mapping (HTTP 400 JSON body, 404, non-JSON 500), `op` success / `{ ok:false }` (toast called once, `ApiError.op` set), token header present, token read at call time, `refreshUiToken` parses the meta tag.
- `events.test.ts`: rules 1–7 of 3.5 with a fake `EventSource` and fake timers; `backoffMs` sequence with `random = () => 0.5`.

Acceptance: legacy UI unchanged in behaviour (e2e baseline green); `rg "fetch\(" web/ui web/app.js` finds only calls that are not JSON API calls (binary loads may remain until their viewer is ported).

### Step 4: CSS split and tokens (no visual change)

Files: `web/src/styles/tokens.css`, `base.css`, `viewers.css`, `web/src/styles/legacy-shell.css`, `web/index.html`, `web/app.js`, delete `web/style.css`.

- Move rules verbatim: variables → `tokens.css` (add the new tokens from 4.1 **with the old values** for `--muted` and `--dim`, and the new names aliased to today's literals); "controls" block + utilities → `base.css`; "viewers" blocks (frames strip, animation, sheet, rig, model, audio, project, graph, layers) → `viewers.css`; top bar, layout, browser, inspector, review, timeline, modal, toasts, responsive, cleanup → `legacy-shell.css`.
- Load them from `web/app.js` (`import './src/styles/tokens.css'` ... in that order) and remove the `<link>` from `index.html`.
- Add `tokens.test.ts` + `contrast.ts`, with the assertions that already hold; mark the two that fail today (`--muted`, `--dim`) as `it.todo` naming step 20.

Acceptance: pixel-identical UI. Check by running `npm run docs:ui-shots` into a temp folder before and after (set `SHOTS_DIR`, see step 22; implement the minimal version of `screenshots.spec.ts` now for `01-overview` and `18-narrow`) and comparing with Playwright's `toHaveScreenshot`-style pixel diff ≤ 0.1%.

### Steps 5–11: viewers to TypeScript classes

One step per group. For each: create the files under `web/src/viewers/…`, write the unit tests from section 5, switch the import in `web/app.js` to the adapted class, delete the legacy file.

- Step 5: `viewers/types.ts`, `base.ts`, `controls.ts`, `registry.ts`, `legacyAdapter.ts`, `pixel/PixelView.ts`, `canvas/CanvasViewer.ts`.
- Step 6: `anim/*`, `sheet/*`.
- Step 7: `rig/*`, `layers/*`.
- Step 8: `model/*` (update `test/ui.test.js` and `test/materials.test.js` paths as described in 5.7; add `e2e/model3d.spec.ts`). Parity port only: the legacy lighting stays in this step.
- Step 8b: viewport shading modes (section 5.7b): `model/shading.ts` (`ShadingRig` + pure helpers), the second toolbar row, the `Z` pie, `debugInfo()`, the extra addon imports in `model/three.ts`, persistence key `agent-art:modelView`; seed gains a second model with materials-v2 maps (use a material preset from `node bin/agent-art.js help materials`) standing on the ground plane; unit tests and e2e checks 1–14 of 5.7b; raise the three chunk budget in `scripts/check-ui-build.js` to the 7.1 value and add the "only the three chunk contains `GTAOPass` / `RoomEnvironment`" assertion. Acceptance: the 5.7b acceptance list. Sub-commits are fine in this order: (1) mode switcher + Solid + Material preview, (2) Rendered: sun, shadows, ground, GTAO, quality tiers and auto-degrade, (3) baked AO / lightmap / probes, background, turntable, pie.
- Step 9: `audio/*`.
- Step 10: `graph/*`. Parity port only, canvas renderer, but already split as 5.9b describes: `GraphViewer.ts` (controller) + `graph/renderer.ts` (interface) + `graph/CanvasRenderer.ts` (drawing and pointer code). No new package in this step.
- Step 10b `(Review 2)`: graph Cards renderer and Hierarchy layout (section 5.9b): `graph/flow/*`, `graph/hierarchy.ts`, the "View" select, `debugInfo()`, `e2e/graph.spec.ts`, the two chunk budgets. Sub-commits in this order: (1) Hierarchy layout on the canvas renderer (dagre only), (2) Cards renderer, (3) Auto choice, limits, screenshots. This step is separable: if the Cards renderer cannot meet its acceptance list (5.9b) or its budget, stop and report after sub-commit (1); the product is complete without (2) and (3) and no later step depends on them.
- Step 11: `export/*`, `project/*`; delete `web/ui/viewers/`.

Review 2 additions inside these steps (each is specified in its section; all are done in the same step as the viewer they belong to, after the parity port of that viewer is green): step 5: PixelView compare API and `pixel/diff.ts` (5.1; not wired to any UI until step 18c), colour picker (5.2). Step 7: zoomable pose / weights images (5.5). Step 8b: Solid lighting choices, view presets, axis gizmo, Overlays toggle, the corrected pie layout and frame-cost measurement, the `profile=three` timing record (5.7b). Step 11: JSON colouring in the export preview and `lib/util/jsonTokens.ts` (5.10).

`viewers/legacyAdapter.ts` (temporary, deleted in step 18): lets the legacy `App` host the new classes.

```ts
export function adapt(Ctor: ViewerCtor) {
  return class LegacyViewer {
    constructor(hostEl: HTMLElement, ctx: { app: any; readOnly?: boolean; slot: SlotId });  // builds a ViewerHostApi from ctx.app
    open(target: Target): Promise<void>;        // first call -> mount, later calls -> update
    onEvent(ev: ServerEvent): void; keydown(e: KeyboardEvent, k: string): boolean; undo(redo: boolean): void;
    setToolUI(): void; setColorUI(): void;      // -> update() with a fresh env read from ctx.app
    get view() { return { render: () => this.pushEnv() }; }   // legacy refreshReviews calls viewer.view.render()
    destroy(): void;
  };
}
```

The legacy `App.open` uses `instanceof Cls` for viewer reuse; adapted classes are distinct per viewer kind, so that keeps working. `App.setReviewMode`, `setTool`, `setColor`, `refreshReviews` already call `setToolUI` / `setColorUI` / `view.render()`; they now funnel into `update()`.

`e2e/model3d.spec.ts` (runtime check of the 3D viewer): open the model; wait for the status line to match `/\d+ tris/`; assert there is no `img.fallback`; assert a network response for a URL matching `/assets/three-.*\.js` with status 200 happened only after the model was opened (not during initial page load); read the WebGL canvas with `canvas.toDataURL()` in the page, decode it to pixels and assert that at least 1% of the pixels differ from the clear colour; toggle Wireframe with `W` and assert the checkbox is checked; switch the channel to "Normal" and assert the status contains "channel Normal" and a request with `profile=three` was made; play a clip with Space and assert two canvas reads 300 ms apart differ; open another asset and back 5 times and assert `page.evaluate(() => document.querySelectorAll('canvas').length)` does not grow (context leak guard).

Acceptance per step: section 5 checklists for those viewers ticked; unit tests added; e2e baseline green; `rg "ctx\.app|this\.app" web/src/viewers` returns nothing; no `any` in viewer files except three.js addon typings where `@types/three` is absent (if needed add `@types/three` at the matching version as a devDependency rather than typing by hand).

### Step 12: stores own the data; live wiring; reconnect

Files: `web/src/state/*` (all stores, `live.ts`, `boot.ts`), `web/app.js` (becomes a facade).

- Implement the stores of 2.4 and `live.ts` of 2.5, including reconnect + resync (3.5).
- Legacy `App` keeps its public surface but delegates: `get assets() { return assets.index }`, `uiState` / `hiddenSet` / `solo` getters over `uiState`, `reviews` / `reviewCounts` / `approvedSet` over `reviews`, `tool` / `color` / `reviewMode` over `editor`, `followMode` over `workspace`, `refreshAssets()` → `await assets.refresh(); this.browser.render(); …` and so on. `App.connect` is replaced by `live.start()`; `App.onEvent` shrinks to the legacy render calls triggered from a `live` subscriber hook (`live.onAfterEvent(fn)`, temporary).
- Status pill text and class come from `connection`.

Tests: `*.svelte.test.ts` per store: `assets` lookups and `rev`; `uiState` toggles, optimistic update + rollback on failed save, `visible()` with solo and showHidden; `reviews.marks` filter, `openCount`, `sortedAll`; `activity` upsert / trim at 3000 / `rows()` for each filter and the search, top-level rule (ops of known tool calls are hidden), `reset()`; `editor.setColor` normalisation and tool switch; `workspace.open` (slot B turns compare on, hash written only for slot A and non-snapshots), `switchView`, `swap`, `follow` (reuses the table from step 3), `toggleFollow` persistence (T5, T6); `connection.status` thresholds with a fake clock; `live.route` (table: event → expected store calls, using spies), resync order and the pid-change branch.
e2e: `reconnect.spec.ts`: kill the e2e server process and restart it on the same port and home (helper in `e2e/server.ts`): status goes "disconnected — retrying" then "live" within 20 s; an op run through the CLI after the restart shows up in the timeline; `cleanup_config` Save still succeeds after the restart (proves the token refresh).

Acceptance: e2e baseline + reconnect green; no behaviour change otherwise.

### Step 13: UI primitives, toasts, help dialog

Files: `web/src/components/ui/*`, `components/dialogs/DialogHost.svelte`, `HelpDialog.svelte`, `state/toasts.svelte.ts`, `state/dialogs.svelte.ts`, `lib/util/icons.ts`, `web/app.js`, `web/index.html` (remove the static `#help` and `#toasts` markup), `legacy-shell.css` (remove their rules).

- Mount two small Svelte roots from `app.js` for now: `Toasts` and `DialogHost` (`mount(Component, { target: document.body })`).
- `App.toast` → `toasts.push`; `App.toggleHelp` → `dialogs.toggleHelp()`.
- Help content = the legacy text plus the new shortcuts introduced so far, rendered from the `SHORTCUTS` table (4.4); the table is created in this step in `state/shortcuts.ts` (data only; the key handler arrives in step 18).
- `(Review 2, gap in the strangler phase)` The legacy `App` detects open dialogs through the DOM: `document.querySelector('.modal:not(#help)')` in `setupKeys` (K2) and in `follow` (E10), and `!$('help').hidden` in the `Esc` chain (K5). From this step on, dialogs move to Bits UI one by one (Help here, review dialogs in step 16, cleanup in step 17) and stop matching those selectors. In this step replace all three checks in `web/app.js` with one helper: `dialogOpen = () => dialogs.blocking || !!document.querySelector('.modal:not(#help)')` (store first, legacy DOM second, until step 17 removes the last legacy modal) and `dialogs.helpOpen` for Help. When `dialogs.blocking` is true the legacy handler must return without removing anything (Bits closes its own dialog on `Esc`). Add to `keyboard.spec.ts`: global keys still work while Help is open (K2 excludes Help: `C` toggles compare with Help open); and from step 16 on: with the review note dialog open, `C` does nothing and an agent draw made through the CLI does not switch slot A (E10).
- `ui/VirtualList.svelte` `(Review 2)` is a wrapper over `virtua/svelte`, not a hand-written windowing component. Read the installed version's README for the Svelte entry (`VList`, its `data` / `getKey` / children-snippet props, the option that keeps the scroll position when items are prepended, and its imperative `scrollToIndex`), wrap exactly those, and keep every virtua identifier inside this one file. If Bits' focus handling or virtua needs `ResizeObserver` under jsdom, add a minimal stub to `web/src/test/setup.ts` and reference it from `test.setupFiles`.

Tests: component tests (jsdom): `Button` variants and `aria-pressed`; `Tabs` arrow key navigation; `Dialog` renders title, calls `onclose` on Esc; `Toasts` lifetime with fake timers, pause on hover, max 4; `Splitter` keyboard resize and clamps; `VirtualList` (jsdom has no layout, so test the wrapper's contract only: it renders the `row` snippet with the right item and index for the items the library asks for, passes keys through, and exposes `scrollToIndex`; real windowing is asserted in e2e by the row-count budget in 7.1); `Icon` renders an `svg`. e2e: `?` opens Help with a focus trap and `Esc` closes it; an induced op error shows an error toast with `role="alert"`.

### Step 14: timeline in Svelte

Files: `components/timeline/*`, `web/app.js` (mount `Timeline` into `#timelinePane`; `app.timeline` becomes a shim `{ upsert, load, render(){}, f }` over `activity`), delete `web/ui/timeline.js`, remove timeline rules from `legacy-shell.css`.

- `timeline.ts` (pure): `keyArgs(args, skip)`, `entryLabel(e)`, `statusOf(e)`, `thumbsOf(e)` (max 3), `clickTarget(entry, hit: { pairName?: string; imageIndex?: 0 | 1 })` (TL10), `compareTargets(entry)` (TL11).
- Rows are keyed by `entry.id`. `(Review 2, replaces the hand-written anchoring and the 400-row cap)`: render the list with `ui/VirtualList` (`shift` on, `rowHeight` 46 as the estimate). Entries have different heights (second line, thumbnails, expanded details); virtua measures them. Reading position (TL12) is the library's prepend handling: when new entries arrive at the top while `scrollTop > 0` the visible entries stay where they are; at `scrollTop === 0` the new entry appears at the top (legacy behaviour). Thumbnail boxes have a fixed height in CSS so a late image never changes a row's height. Do not also write the `$effect.pre` fallback; if the e2e position test below fails with virtua, stop and report instead of stacking a second mechanism on top.
- No row limit: every filtered entry of the 3000 kept is reachable by scrolling (RV6). The counter `shown/top-level` (TL1) now reports the real numbers.
- Expanded args use `ui/JsonView` (RV9).

Tests: `timeline.test.ts` for the pure functions (table-driven, including `commands` raw printing, 4-arg cap, deleted assets, rig → parts snapshot). Component test: an entry with before / after renders two images and a compare button; an error entry shows the error; expanding shows args JSON and child ops. e2e: baseline timeline spec, plus: Errors chip filters to the seeded failing op; "This asset" narrows when another asset is opened; scroll the list down 300 px, trigger an op through the CLI, the first visible entry's bounding box does not move by more than 2 px.

### Step 15: asset browser in Svelte

Files: `components/browser/*`, `state/prefs.svelte.ts`, `web/app.js` (shim `app.browser = { render(){}, markActive(){}, flash(id), focusSearch() }`), delete `web/ui/browser.js`, remove browser rules from `legacy-shell.css`.

- `tree.ts` (pure): `buildTree(input: { index, hidden, pinned, solo, showHidden, filter, collapsed, expanded, selectMode, reviewCounts, approved }): TreeItem[]` returning a flat list of `{ type: 'section' | 'row' | 'note', ... }` in display order (B4–B16, all caps and texts). `TreeRow` carries `id, kind, name, label, meta, thumb, depth, hasKids, expanded, badge, open: Target | null, actions: boolean, selectable: boolean`.
- Selection (B21) operates on the flat list: `rangeSelect(rows, lastId, id, selected)`.
- Rendering `(Review 2: one path, not two)`: always `ui/VirtualList` (`rowHeight` 28, 36 narrow; no `shift`). The "plain `{#each}` under 200 items" branch is dropped: two render paths mean two sets of sticky-header, focus and scroll-restore behaviour to keep in step. The current section header is rendered as a pinned overlay above the list (computed from the first visible index). Scroll position survives re-renders (B20) because rows are keyed and the list instance is not recreated.
- Context menu `(new, Review 2, RV2)`: one `ui/ContextMenu` around the tree. Items for an asset row, in order: Open; Open in compare; for a canvas: Animation / Sheet / Layers (only the tabs L8 would show); separator; Pin / Unpin; Hide / Show; Solo / Unsolo; separator; Show in graph; Add review note… (the same call the inspector's "⚑ Note" button makes at this step: the legacy `reviewPrompt` now, `dialogs.reviewNote` from step 16); separator; Copy name; Copy link (`location.origin + location.pathname + '#' + targetToHash(target)`); separator; Select (enters select mode with this row checked); Plan cleanup… (this row, or the whole selection when the row is part of it). Section headers, notes and folder rows have no menu (the native menu is not suppressed there). Every item calls the same store method as the existing button or key, no new logic. Copy uses `navigator.clipboard.writeText` and toasts "Copied" / the error. `pure: menuFor(row, ctx): MenuItem[]` in `tree.ts`, unit-tested per row kind.
- Drag to a slot `(new, Review 2, RV3)`: asset rows are `draggable`; `dragstart` sets `application/x-agent-art-target` (JSON of the row's `open` target) and `text/plain` (the name). `ViewerSlot` accepts that type: drop on slot A opens there, drop on slot B opens in B; while not comparing, the right 28% of the viewers area shows a "Compare here" drop zone during a drag and a drop there opens slot B. Native HTML drag and drop, no package; ignore any drag without the custom type (files, text from other apps). Not available in select mode (dragging there would fight range selection).
- Flash (B19): subscribe to `browserFlash`; add a `flash` class for 900 ms on matching rows.
- Keyboard tree navigation (4.4).

Tests: `tree.test.ts`: section order and counts; empty sections omitted except Canvases; filter expands everything and yields "no matches"; hidden / showHidden / solo visibility; project cap note at 401 canvases; loose canvases exclude `rigparts` / `rigout`; rig children order; model children; export folders; group nesting and missing sub-group; pinned canvas renders as a canvas row; badges; `rangeSelect` forward / backward / deselect range. Component tests: `AssetRow` action buttons call the store; select mode shows checkboxes. e2e: baseline browser assertions; filter with `/`; pin and hide survive a reload (server ui-state); Alt+click opens in slot B; double-click opens the Canvas tab; arrow key navigation opens an asset with Enter; a second browser context sees the pin after the `ui-state` event. `(Review 2)`: right-click a canvas row → the menu lists the items above, "Open in compare" fills slot B, "Copy link" puts a URL ending in `#<name>` on the clipboard (grant `clipboard-read` / `clipboard-write` in the Playwright context); `Shift+F10` on a focused row opens the same menu and `Esc` returns focus to the row; `dragTo` from a row to the "Compare here" zone opens slot B; with the 300-canvas workspace, `End` then `Enter` in the tree opens the last asset (focus across virtualised rows) and the DOM row count stays under 400.

### Step 16: inspector, review cards, review dialogs

Files: `components/inspector/*`, `components/dialogs/ReviewNoteDialog.svelte`, `ReviewListDialog.svelte`, `ui/ConfirmDialog.svelte`, `ui/PromptDialog.svelte`, `web/app.js` (shim `app.inspector = { show(t){ workspace.inspected = … }, refreshFor(){…}, reviewCard: unused }`, `reviewPrompt` → `dialogs.reviewNote`), delete `web/ui/inspector.js`, remove inspector / review / modal rules from `legacy-shell.css`.

- Meta JSON (I4) renders through `ui/JsonView` (RV9); the 4000-character cap and the anchors / rig summaries stay.
- `Inspector.svelte` loads data with a small resource helper keyed by `(inspected target id, snap, inspectorTick)`: abortable, last-wins, keeps the previous data while loading (2.7).
- `PreviewCanvas.svelte`: the two animated previews; timer cleared on destroy and when the canvas changes (legacy leaks a timer chain when switching quickly).
- Reopen uses `dialogs.prompt({ title: 'Reopen rN', label: 'What is still wrong?' })`; Delete uses `dialogs.confirm({ title: 'Delete rN?', confirmLabel: 'Delete', danger: true })`.
- `ReviewNoteDialog`: fields and submit as R2 / R3; `Ctrl+Enter` submits `(new)`; shows the attached crop when `draft.image` is set `(new)`; compare-with uses a native `<input list>` + `<datalist>`.

Tests: pure `whereLine(target)` / `draftWhereLine(draft)`; `reviewAddArgs(draft, form)` (R3: where suffix, optional fields, compare_with shapes); `metaSummary(meta)` (anchors, rig object, 4000 cap); `relationRows(info)` (I12 ordering, 40 cap). Component tests: `ReviewCard` action visibility per status; `CanvasInspector` layer click / eye / blend call the right ops. e2e: review spec completed (Accept is not reachable without the agent, so drive `art_review update … status:'fixed'` through the CLI, then Accept in the UI, then Reopen with a reply, then Delete with confirm); layer eye toggle changes the canvas (timeline shows a user `layer` entry); palette swatch click changes the editor colour (the toolbar swatch's `data-color`, Review 2: the swatch button replaced the visible native input in 5.2); relations link opens the linked asset.

### Step 17: cleanup dialogs

Files: `components/dialogs/PlanCleanupDialog.svelte`, `CleanupDialog.svelte`, `TrashTab.svelte`, `UsageTab.svelte`, `SettingsTab.svelte`, `web/app.js`, delete `web/ui/cleanup.js`, remove cleanup rules from `legacy-shell.css`.

- C1–C7 exactly. The plan dialog resolves `true` only after a successful apply (legacy used a `MutationObserver` on `document.body` for this; use the dialog promise).
- "Empty…" uses `dialogs.confirm` (danger). Settings Save goes through `op('cleanup_config', …)` with the token retry of 3.2.

Tests: pure `planView(plan)` (tiles, apply label and disabled state), `batchSummary(batch)` (C5 summary line), `usageBars(obj, max 14)`. Component tests for the three tabs with fixture data, including the empty trash and an error. e2e: cleanup spec completed: blocked plan (select a canvas that a model or project still needs → "Blocked", Apply disabled; "Dependents too" unblocks), disk usage tab lists `canvas`, Settings Save with an existing temp folder succeeds and with a non-existent path shows the server's error toast.

### Step 18: the shell takes over

Files: `web/src/App.svelte`, `main.ts`, `components/shell/*`, `components/viewers/*`, `state/shortcuts.ts`, `state/boot.ts`, `web/index.html` (body becomes `<div id="app"></div>` + the module script `./src/main.ts`), delete `web/app.js`, `web/ui/`, `web/src/viewers/legacyAdapter.ts`, `web/src/styles/legacy-shell.css`, `web/svelte/` (toolchain stub and its test), the temporary `live.onAfterEvent` hook.

- `App.svelte`: grid layout (L1–L5) with `Splitter`s, panes, `ViewerSlot` A (+ B when comparing), bottom dock, `Banner`, `DialogHost`, `Toasts`. The timeline component instance moves between the side dock and the bottom dock by conditional rendering; its state lives in the store, so nothing is lost.
- `shortcuts.ts`: `decide(e: KeyEventLike, ctx: ShortcutContext): Action | null` implementing K1–K10 in order plus the new rules of 4.4 and the narrow drawer `Esc`; `install()` adds the single `keydown` listener and executes actions. `ShortcutContext` = `{ inText, onInteractive, dialogBlocking, helpOpen, reviewMode, comparing, snapOpen, drawerOpen, pixelCanvasFocused, slotAKind, browserShown }`.
- `boot.ts`: P2, P3. Also sets `connection.serverPid` from `/api/health`.
- `main.ts`: `mount(App, { target: document.getElementById('app')! })`; `window.agentArt = { version, open: workspace.open, state: () => snapshot }`; `import.meta.hot?.dispose(() => live.stop())`.
- Raise the budgets in `scripts/check-ui-build.js` to the final values (7.1).
- Update `test/ui.test.js` "sources load three.js…" to the new paths; `web/index.html` must still contain no import map.

Tests: `shortcuts.test.ts`: one case per rule K1–K10 and each viewer key hand-off, Space on a focused button is ignored, `Esc` priority chain, `/` when the browser pane is hidden, digits beyond the tab count. Component test: `SlotHeader` tabs per L8. e2e: full suite green with `app.page.ts` now using roles and labels; add: hash deep links for every kind (`#spark`, `#model:rifle`, `#rig:hero`, `#audio:rifle_shot`, `#project:severance`, `#export:helmet_front.png`, `#graph`, `#canvas:spark`), `hashchange` navigation, compare + swap + close, snapshot open from the timeline then `Esc` back to live, splitter drag persists across reload, dock toggle persists, follow mode select persists and `project overview` mode opens the project on an agent draw, first-paint marks (7.1).

Acceptance: no file under `web/` outside `web/src`, `web/index.html`, `web/plan.md`; `rg "innerHTML" web/src` returns only `icon()` in `lib/util/dom.ts` and nothing else; `rg "@html" web/src` returns only `ui/Icon.svelte`; `rg "confirm\(|prompt\(|alert\(" web/src` returns nothing; every checkbox in section 1 is ticked or has a note explaining an intentional, listed change.

### Step 18b: command palette `(new, Review 2, RV1)`

Files: `components/dialogs/CommandPalette.svelte`, `components/dialogs/commands.ts`, `state/dialogs.svelte.ts`, `state/shortcuts.ts`, `components/dialogs/DialogHost.svelte`, `e2e/palette.spec.ts`.

- Open with `Ctrl/Cmd+K` (rule inserted before K4; works while Help is open; does nothing while another dialog is open or focus is in a text field other than the palette's own input) and from a top bar `search` icon button "Search assets and actions (Ctrl+K)" (in the narrow layout it is an overflow menu item). `Esc` closes; focus returns to where it was.
- `DialogHost` loads the component with `import('./CommandPalette.svelte')` on first open (chunk `palette`, which also holds `fuzzysort`); neither is in the initial bundle. Start the import on `pointerenter` / `focus` of the top bar button as a warm-up.
- `commands.ts` (pure, unit-tested):

  ```ts
  export interface PaletteItem { id: string; group: 'Recent' | 'Actions' | 'Assets'; label: string; meta?: string; kind?: string; shortcut?: string;
    highlight?: number[] /* matched character indexes in label */; run(opts: { compare: boolean }): void }
  export function assetItems(index: AssetIndex, visible: (id: string) => boolean): PaletteItem[];
  //   every canvas, rig, model, audio, project, group and export of the index that passes the hidden / solo filter; label = name, meta = kind label (+ project);
  //   run = workspace.open(targetFor(kind, name), { slot: compare ? 'B' : 'A' })
  export function actionItems(ctx: ShortcutContext): PaletteItem[];
  //   one item per SHORTCUTS row that has an `action` and is applicable in ctx (tabs of slot A, tool keys only on the canvas editor, 'Back to live' only on a snapshot, ...),
  //   plus actions that have no key: 'New canvas…', 'Cleanup: Trash', 'Cleanup: Disk usage', 'Cleanup: Settings', 'Review notes', 'Clear solo', 'Show hidden assets' on / off,
  //   and for a model in slot A the four shading modes and the six view presets
  export function search(query: string, items: PaletteItem[], recent: string[], limit = 50): PaletteItem[];
  //   empty query: Recent (the last 8 opened targets that still exist) then all Actions; otherwise fuzzysort over label (assets also over meta), threshold as the library default,
  //   Actions first when their score is within 10% of the best asset, at most `limit` items, `highlight` filled from the library's match indexes
  ```

- Keys inside the list: Up / Down, Home / End, `Enter` runs, `Alt+Enter` or `Shift+Enter` runs with `compare: true` (assets only), same convention as the tree (4.4). Running an item closes the palette first.
- The asset list is prepared once per `assets.rev` (`fuzzysort.prepare` on each label) and reused; with 5000 assets a keystroke must filter in under 30 ms (unit-level timing guard: 5000 synthetic names, median of 20 searches < 30 ms on the CI machine; skip the assertion when `process.env.CI_SLOW` is set).
- `workspace.open` (slot A, not snapshots) pushes the target's hash to `workspace.recent` (dedupe, max 8, persisted `agent-art:recent`).

Tests: `commands.test.ts`: asset items respect hidden and solo; action applicability per context; empty query → Recent then Actions; a subsequence query (`hlmfr`) ranks `helmet_front` first and returns its highlight indexes; limit; a recent entry for a deleted asset is dropped. Component test: typing filters, `Enter` calls `run({ compare: false })`, `Alt+Enter` → `compare: true`, `Esc` closes. e2e (`palette.spec.ts`): `Ctrl+K`, type `pauld`, `Enter` → slot A shows `pauldron`; `Ctrl+K`, `graph`, `Enter` → the graph opens; `Alt+Enter` on an asset fills slot B; the palette does not open while the review note dialog is open; the `palette` chunk is requested only on first use; axe: no serious findings with the palette open. Screenshot `33-command-palette.png`.

Acceptance: the initial bundle grows by no more than 1 kB gzip from this step (the lazy import and one button).

### Step 18c: compare tools `(new, Review 2, RV7)`

Files: `components/viewers/SlotHeader.svelte`, `state/workspace.svelte.ts`, `viewers/canvas/CanvasViewer.ts`, `state/shortcuts.ts`, `e2e/compare.spec.ts`. The PixelView side (5.1) already exists from step 5.

- Slot B's header gains, only while both slots hold a `CanvasViewer` (live or snapshot): a "Link" toggle button (`aria-pressed`, default on, title "Link zoom, pan and frame") and an "Overlay" native select: Off, Difference, Swipe, Blink (title "Show slot B over slot A (D)"). For any other viewer pair they are not rendered. Next to them, `workspace.compareStatus` as muted mono text.
- `CanvasViewer` wiring:
  - on PixelView `onView` and on a user frame change: `if (env.compareLink) host.peerViewer()?.applyLinkState?.({ ...view.getView(), frame })`. `applyLinkState` calls `view.setView` and sets the frame (clamped to its own frame count) without calling the peer back.
  - after every successful image load, and on frame change: `host.notifyPeer()`.
  - `compareImage()` returns `{ image: <current strip bitmap>, rect: <shown frame rect>, key: name + version + frame }`.
  - `envChanged` on `compareOverlay` or `peerRev` (slot A only): `const peer = host.peerViewer()?.compareImage?.()`; when the overlay is not `off`, `peer` exists and `peer.rect` has the same width and height as the own frame rect → `view.setOverlay({ image: peer.image, rect: peer.rect, mode })`, and in Difference `host.compareStatus("<changed> px differ (<pct>%) · bbox x,y w×h")` or `"identical"`; sizes differ → `view.setOverlay(null)` and `host.compareStatus('Overlay needs two canvases of the same size')`; overlay `off` or no peer → `setOverlay(null)`, `compareStatus(null)`.
  - while an overlay is shown in slot A, slot A is view-only (tool group disabled with the title "Editing is paused while an overlay is shown"); undo / redo keys stay active.
- Keys (in `CanvasViewer.onKey`, only when `host.peerViewer()?.compareImage` exists, i.e. the other slot is a canvas too; otherwise return false so the key falls through): `D` cycles Off → Difference → Swipe → Blink → Off through a new host call `host.setCompareOverlay(next)` (add it to `ViewerHostApi`); `X` swaps the Blink image by hand. Add both to `SHORTCUTS` (group Canvas).
- Closing compare, or either slot changing to a non-canvas viewer, resets `compareOverlay` to `off` and clears `compareStatus`. Swap (⇄) keeps Link and resets the overlay to Off.
- The timeline's ⇆ compare (TL11: before / after snapshots of one asset) is the main use: after it opens, nothing is forced; the user presses `D` to see what the agent changed. Snapshots of big canvases are stored downscaled (`SnapshotMeta.scale`); two snapshots of one canvas normally share scale and size, so the overlay works on them as they are. When they do not (the canvas was resized in between) the status text above explains why there is no overlay.

Tests: unit: the wiring decision as a pure function `overlayPlan(mode, ownRect, peer) → { overlay: … | null, status: string | null }` (all four branches); `nextOverlay(mode)` cycle; link echo guard (applying a link state does not emit one). e2e (`compare.spec.ts`): draw one pixel on `pauldron` through the CLI, click ⇆ on that timeline entry → both slots show snapshots; press `D` → status matches `/^1 px differ/` and the Overlay select shows Difference; zoom in slot A with `+` → slot B's zoom label equals slot A's; turn Link off, zoom A again → B unchanged; select Swipe, drag the bar → the canvas pixels left and right of the bar change (two reads); open a model in slot B → the Link / Overlay controls disappear and slot A's tool group is enabled again. Screenshot `34-compare-difference.png`.

Acceptance: with compare closed, `CanvasViewer` makes no extra work per frame (no overlay, no peer calls: assert `overlayInfo === null` and that `notifyPeer` is a no-op when there is no peer); TL11 and L6 behave exactly as before when the new controls are left untouched.

### Step 19: narrow layout and accessibility pass

Files: `App.svelte`, `shell/TopBar.svelte`, `shell/OverflowMenu.svelte`, `styles/base.css`, `styles/viewers.css`, component styles.

- Drawers, scrim, overflow menu, 36 px targets (4.5, 2.6).
- Walk the 4.4 list and fix every gap. Run an automated pass in e2e with `@axe-core/playwright` (add as a devDependency) on: main view, review dialog, cleanup dialog, narrow view with a drawer open. Rules: fail on `critical` and `serious`; allow-list nothing without a comment explaining why.

Tests: e2e `narrow.spec.ts` extended: drawer opens with the button and with `[`, scrim click and `Esc` close it, opening an asset closes it, the overflow menu lists the six actions and each works, the Notes count is visible in the menu, compare stacks vertically (slot B's top is below slot A's bottom), bottom dock works, no horizontal scrollbar on `document.documentElement` at 360, 430 and 860 px. `a11y.spec.ts` with axe. Keyboard-only spec: Tab from the page start reaches the browser, opens an asset with Enter, reaches the viewer toolbar, opens Help, closes it, focus returns to the Help button.

### Step 20: visual pass

Files: `styles/tokens.css` (flip `--muted`, `--dim` and the aliased literals to the 4.1 values; un-todo the contrast tests), `base.css`, `viewers.css`, component styles, viewer toolbars (icons, dividers).

- Apply 4.3 to every component and to viewer-built DOM. Replace remaining hard-coded colours with tokens (`rg "#[0-9a-fA-F]{3,8}" web/src --glob "*.css" --glob "*.svelte"` should only hit `tokens.css` and data-encoding colours listed in 4.1).
- Viewers use `themeColors()` for chrome colours drawn on canvases.

Acceptance: `tokens.test.ts` fully green; screenshots reviewed by eye against the old ones in `docs/ui/` for regressions in density (the 1680×980 overview must still show ≥ 8 timeline entries and the whole inspector Preview + Canvas + Layers blocks without scrolling, as `01-overview.png` does today).

### Step 21: source checkout note, build staleness, packaging checks

Files: `vite.config.js`, `src/server.js`, `src/mcp.js` (reply text of `art_open_ui` only, not its schema), `test/ui.test.js`, `scripts/check-ui-build.js`, `README.md`.

- Build stamp: a tiny Vite plugin (`apply: 'build'`, `closeBundle`) writes `dist/ui/build.json` `{ "version": <package version>, "builtAt": <ms> }`.
- `src/server.js` (additive only):
  - export `uiBuildStatus(uiDir = UI_DIR): { built: boolean; stale: boolean; reason?: string }`. `built` = `index.html` exists. `stale` is evaluated only when a `web/src` folder exists next to `src/` (a source checkout; the npm package has none): true when `build.json` is missing, or its `version` differs from `VERSION`, or the newest mtime under `web/src` and `web/index.html` is later than `builtAt`. Walk `web/src` once at startup (a few hundred files), never per request.
  - at `startServer` time (not on the first request) write one stderr line when not built (`UI_NOT_BUILT (<dir> is missing)`, existing text) or stale (`Agent Art web UI build is older than web/ sources: run npm run build:ui`).
  - `GET /api/health` gains `ui: { built, stale }`. Existing fields unchanged.
  - the 503 "not built" page stays as is (it already names `npm install`, `npm run build:ui`, `npm run dev:ui`).
- `src/mcp.js` `art_open_ui`: when the backend can tell the UI is not built or stale, add `note: 'web UI not built: run npm run build:ui in <repo root>'` (or the stale text) to the returned object. Input schema untouched.
- UI: when `health.ui.stale` is true show the Banner "This web UI build is older than the sources. Run npm run build:ui and reload." (dismissible for the session).
- README: in "Web UI" (and wherever running from a source checkout is described) add: "Running from a source checkout: run `npm install` and `npm run build:ui` once, and again after pulling changes to `web/`. Without a build the page says so and the server prints it at startup."

Tests (`test/ui.test.js`, node:test): `uiBuildStatus` for: missing dir, built without `build.json` in a checkout layout (stale), fresh stamp (not stale), stamp older than a touched source file (stale), package layout without `web/` (never stale); `/api/health` includes `ui`; stderr line printed once at startup (capture `process.stderr.write`). `scripts/check-ui-build.js` gains the pack checks of 7.2.

### Step 22: screenshots and docs

Files: `e2e/screenshots.spec.ts`, `docs/ui/*.png`, `docs/ui/README.md`, `docs/cleanup/README.md` (only if captions change), `README.md`, `CHANGELOG.md`, `llms.txt` / `llms-full.txt` via `npm run docs:llms`.

- `screenshots.spec.ts` (tagged `@shots`, excluded from the normal run): uses the same seed; viewport 1680×980 except the narrow shots (430×900); `reducedMotion: 'reduce'`; writes to `process.env.SHOTS_DIR || 'docs/ui'`. One test per file, same names as today:
  `01-overview`, `02-timeline`, `03-animation-8-directions`, `04-rig-skeleton`, `05-layers-debug`, `06-layering-review-dialog`, `07-model-viewer`, `08-model-wire-uv-normals`, `09-audio-player`, `10-sheet-anchors`, `11-export-preview`, `12-asset-graph`, `13-review-mark-dialog`, `14-review-notes`, `16-compare-side-by-side`, `17-follow-timeline-bottom`, `18-narrow`, `18b-narrow-assets-drawer`, `19-many-canvases` (seed 300 extra 8×8 canvases in a second project through one `agent-art batch` call for this shot only), `20-cleanup-select`, `21-cleanup-plan-blocked`, `22-cleanup-plan`, `23-cleanup-trash`, `24-cleanup-usage`, `25-cleanup-graph-badges`, and the viewport shading shots `26-model-solid`, `27-model-material-preview`, `28-model-rendered-shadows-ao`, `29-model-baked-lightmap`, `30-model-shading-pie` (5.7b), and the Review 2 shots `31-graph-hierarchy`, `32-graph-canvas-large` (5.9b), `33-command-palette` (18b), `34-compare-difference` (18c), `35-colour-picker` (5.2, popover open on the canvas editor), `36-asset-context-menu` (step 15). `12-asset-graph` is retaken with the Cards renderer.
  `15-art-review-get.png` is not a UI screenshot: produce it with `e2e/cli.ts` (`tool art_review {"action":"get","id":"r1"} --out <dir>/15-art-review-get.png`).
  Before each shot wait for: status "live", fonts ready, the viewer's status line populated, images decoded (`img.complete && naturalWidth > 0` for all visible images), the graph simulation settled (expose `data-settled="true"` on the graph stage when `alpha < 0.01`), and for 3D one extra rendered frame.
- `docs/ui/README.md`: fix "three.js, vendored" → "three.js, bundled and loaded on first use"; add the new capabilities (keyboard navigation of the asset tree, narrow overflow menu, reconnect behaviour, styled confirmations, and the Review 2 additions of 1.18: command palette, row context menu and drag to compare, graph cards / hierarchy / minimap, colour picker, compare overlay, 3D view presets and gizmo); keep the screenshot table and add rows for shots 31–36.
- `README.md` "Web UI" paragraph: same feature list; add one sentence on keyboard access. Then `npm run docs:llms` and `npm test` (there is a test that checks the generated files are in sync).
- `CHANGELOG.md`: one entry under the 1.0 heading: rewritten web UI (Svelte 5 + TypeScript), no feature removed, list of additions marked `(new)` in this plan.

Acceptance: every PNG regenerated in one run; no screenshot shows a spinner, skeleton, toast or focus ring by accident; file names unchanged so existing links keep working.

### Step 23: final verification

Run section 9 top to bottom and record the numbers (bundle sizes, e2e duration, test counts) in the commit message / PR description.

---

## 7. Performance budgets, packaging, dev workflow

### 7.1 Budgets (enforced by `scripts/check-ui-build.js`)

Baseline today (vanilla UI): entry JS 161 kB raw / 51 kB gzip; CSS 25.6 kB / 6.0 kB gzip; three chunk 744 kB / 187 kB gzip.

| Item | Budget (gzip) | Notes |
| --- | --- | --- |
| Initial JS (the entry chunk plus every chunk it imports statically or preloads) | ≤ 116 kB | Svelte runtime, shell, stores, Bits UI parts in use, icons, canvas viewer. `(Review 2)`: was 110; + 6 kB for `virtua`. Nothing else from Review 2 may land here: the picker, palette, graph libraries and dialogs' heavy parts are lazy. |
| Any single lazy viewer chunk (anim, sheet, rig, layers, audio, graph controller + canvas renderer, export, project, model glue without three) | ≤ 15 kB each, ≤ 55 kB together | |
| `three-*.js` | ≤ 220 kB | must be a separate chunk, absent from the initial set. 187 kB today; the allowance covers `EffectComposer`, `RenderPass`, `GTAOPass`, `OutputPass`, `RoomEnvironment`, `LightProbeHelper` (5.7b) and `ViewHelper` (Review 2, + 5 kB). No other chunk may contain three.js or addon code. |
| `graph-cards-*.js` `(Review 2)` | ≤ 75 kB | `@xyflow/svelte`, `@xyflow/system`, the d3 parts, `graph/flow/*`. Requested only when the graph opens in Cards mode. If the measured size is above 75 kB stop and report (do not raise it yourself). |
| `graph-layout-*.js` `(Review 2)` | ≤ 30 kB | `@dagrejs/dagre` + graphlib. Requested only when Hierarchy is chosen. |
| `palette` chunk `(Review 2)` | ≤ 14 kB | `CommandPalette.svelte`, Bits `Command`, `fuzzysort`. Requested on first `Ctrl+K`. |
| colour picker chunk `(Review 2)` | ≤ 5 kB | `vanilla-colorful` hex-alpha picker. Requested when the popover first opens. |
| CSS, initial | ≤ 14 kB | |
| CSS, total `(Review 2)` | ≤ 20 kB | adds the lazy Svelte Flow sheet (`base.css` + our token mapping) |
| `dist/ui` total, raw | ≤ 1.8 MB | `(Review 2)`: was 1.3 MB; the two graph libraries and the notices file account for the difference |
| Lucide icons in the bundle | ≤ 60 icons | imported one by one; never `import * from 'lucide-static'` |

The script reads `dist/ui/index.html`, follows `<script type="module">` and `<link rel="modulepreload">` to compute the initial set, gzips with `zlib.gzipSync` (level 9) and prints a table. It fails when: a budget is exceeded; any `*.map` exists; a file other than `index.html`, `build.json`, `THIRD-PARTY-NOTICES.txt` (Review 2; never requested by the page, it only has to be in the package), `assets/*.js`, `assets/*.css` exists; `(Review 2)` a lazy library leaked into the initial set (test: none of the marker strings `svelte-flow__` (Svelte Flow), `network-simplex` (dagre), `hex-alpha-color-picker` (vanilla-colorful), `fuzzysort` appears in any initial chunk; adjust a marker if the installed version does not contain it, and say so in the script); `THIRD-PARTY-NOTICES.txt` is missing or does not name `svelte`, `bits-ui`, `three`, `lucide-static`, `virtua`; `index.html` references an absolute URL or another origin; the three chunk is in the initial set; the string `sourceMappingURL` appears in any JS / CSS file.

Runtime budgets (asserted in `e2e/smoke.spec.ts` on the built bundle with the seed workspace; thresholds are lenient because CI machines vary):

- First contentful paint ≤ 1000 ms (`performance.getEntriesByName('first-contentful-paint')`).
- `performance.mark('aa:shell')` (panes visible, set in `App.svelte` `onMount`) ≤ 800 ms after navigation start.
- `performance.mark('aa:ready')` (assets loaded and the first viewer image drawn) ≤ 2500 ms.
- No request for the three chunk before a model is opened.
- With the 300-canvas workspace: typing one character in the asset filter updates the list within 100 ms (measure with `performance.now()` around the input event and a `requestAnimationFrame`), and the DOM holds fewer than 400 row elements.
- `(Review 2)` With 3000 activity entries loaded (seed them with one `batch` call), the timeline DOM holds fewer than 120 entry elements, and scrolling to the end shows the oldest entry.
- `(Review 2)` Graph, seed workspace, Cards: `data-settled="true"` within 2500 ms of opening; 300-canvas workspace: Auto picks Canvas and settles within 4000 ms.
- 200 synthetic activity entries pushed within one second (through the CLI `batch` command) do not produce more than 60 timeline re-renders (count with a counter incremented in an `$effect` that is exposed on `window.agentArt.state()`).

### 7.2 Packaging checks (`scripts/check-ui-build.js`, second half)

Run `npm pack --dry-run --json` (it triggers `prepack` → build) and assert on the file list:

- contains `dist/ui/index.html`, `dist/ui/build.json`, `dist/ui/THIRD-PARTY-NOTICES.txt` (Review 2), at least one `dist/ui/assets/index-*.js`, one `dist/ui/assets/index-*.css`, one `dist/ui/assets/three-*.js`;
- contains nothing under `web/`, `e2e/`, `test/`, `docs/`, `scripts/`, `node_modules/`, `test-results/`, no `playwright.config.ts`, `vite.config.js`, `svelte.config.js`, `tsconfig.json`, no `*.map`, no `src/meshfixtures.js`;
- `package.json`: `dependencies` absent or empty; no `postinstall` / `prepare` script; `files` still lists `dist/ui/`; `prepack` is `npm run build:ui`.

### 7.3 Dev workflow

- `npm run serve` (or the MCP) runs the API on 7420 and serves `dist/ui`.
- `npm run dev:ui` starts Vite on 5173 with hot reload and proxies `/api` (REST, ops, SSE) to `AGENT_ART_URL` (default `http://127.0.0.1:7420`). The plugin `agent-art-dev-ui-token` copies the token meta tag from the running server's page; if no server is up it warns once and the UI shows the "Cannot reach the Agent Art server" state. Keep the plugin and the `Origin` rewrite unchanged. `refreshUiToken()` works in dev too because `GET /` on the dev server re-runs `transformIndexHtml`.
- SSE through the Vite proxy: do not add compression or buffering middleware; verify once that timeline entries arrive live in dev.
- `npm run build:ui` → `dist/ui` (no sourcemaps, three as a lazy chunk, legal comments kept). `prepack` runs it, so `npm pack` / `npm publish` always ship a fresh build.
- HMR: `main.ts` disposes the event stream on hot dispose; stores are module singletons and survive component HMR. Viewer class edits trigger a full reload (accept that; do not write HMR glue for viewers).

### 7.4 Source checkout

The user runs the MCP from a source checkout. A missing or outdated build must be obvious in three places: the server's stderr at startup, the page itself (503 page when missing; banner when stale), and `art_open_ui`'s reply (step 21). `dist/` stays git-ignored. Do not add a `postinstall` or `prepare` build (the package must install without running scripts, and `test/ui.test.js` asserts that).

---

## 8. Risks, mitigations, "do not" rules

| Risk | Mitigation |
| --- | --- |
| Silent feature loss during the rewrite | Section 1 checklist; e2e baseline written against the legacy UI first (step 2) and kept green through every step via the page object. |
| Legacy `App` and new stores drifting during the strangler phase (steps 12–17) | Stores are the only data owners from step 12; the legacy `App` only has getters and shims. Each shim is deleted in the step that replaces its consumer; step 18's acceptance greps prove none is left. |
| Svelte reactivity cost on large payloads (asset index, 3000 activity entries) | `$state.raw` for server payloads; activity kept in a plain Map with a rAF-batched version counter; virtualised browser list; budgets in 7.1 measured in e2e. |
| Viewer / Svelte lifecycle races (target changes while a chunk or image loads) | Generation counter in `ViewerHost`, load tokens + `AbortController` in viewers, unit tests for "latest wins". |
| WebGL context and GPU memory leaks | `disposeModel`, tracked textures and materials, `forceContextLoss`, e2e open / close loop asserting the canvas count stays flat. |
| Post-processing cost on integrated GPUs (GTAO, shadow maps, two viewers in compare) | Quality tiers, Auto starting at Low on integrated / software renderers, one-way auto-degrade, AO paused while orbiting on Low, slot B one tier lower, render on demand (5.7b). |
| Render target and shader program leaks from mode switching | `ShadingRig.dispose` unit test with spies; e2e check 12 on `renderer.info`. |
| Headless Chromium without GPU fails the 3D test | SwiftShader launch flags in `playwright.config.ts`; if WebGL is still unavailable the spec fails loudly (it must not silently pass on the fallback image). |
| Svelte Flow with many DOM nodes is slow `(Review 2)` | Cards is only the default up to 400 nodes / 1200 edges and refused above 1500; the canvas renderer stays for everything larger; render-only-visible on; CSS-only level of detail; settle-time budgets in 7.1; step 10b is separable and can stop after the dagre sub-commit. |
| A new library breaks on a future Svelte or three release `(Review 2)` | Each one is behind a single file (`ui/VirtualList.svelte`, `graph/flow/mountFlow.ts` + its folder, `graph/hierarchy.ts`, `canvas/colorPicker.ts`, `dialogs/CommandPalette.svelte`), lazy except virtua, and has a stated fallback (canvas renderer, "Layered by kind", native colour input, no palette). Peer ranges were checked against the installed Svelte 5.57.3 and three 0.170.0. |
| `vanilla-colorful` has had no release since 2022 `(Review 2)` | It is a zero-dependency custom element (web standard API, nothing to rot); it is lazy; the native input remains reachable ("System picker…") and is the automatic fallback when the chunk fails. Replaceable in one file. |
| Licence drift in bundled packages `(Review 2)` | `scripts/vite-notices.js` fails the build on a licence outside the allow-list and ships the notices file. |
| Dialog detection breaks half-way through the migration (keys and follow firing under a Bits dialog) `(Review 2)` | Step 13 switches the legacy checks to `dialogs.blocking` + the legacy selector; e2e asserts it in steps 13 and 16. |
| `profile=three` GLB on every live reload makes following a model sluggish `(Review 2)` | Longer debounce and in-flight guard in Material / Rendered; measured in step 8b with a stop-and-report threshold (5.7b). |
| Bits UI API differences between majors | Seven primitives are used after Review 2 (Dialog, AlertDialog, Tooltip, DropdownMenu, Tabs, ContextMenu, Command), each wrapped once in `components/ui/`; check the installed version's docs when writing the wrappers; component tests cover open / close / focus. If a primitive misbehaves, replace that one wrapper with a small hand-written version rather than switching libraries. |
| Bundle growth | Budgets fail the build; viewers are lazy; icons imported individually; native `<select>` instead of a headless select. |
| Token invalid after a server restart (edits silently attributed to the agent, `cleanup_config` refused) | pid check on reconnect + `refreshUiToken()`; e2e reconnect spec. |
| Missed events during a disconnect | Resync on every reconnect (3.5), `since=lastId` for activity, `resync` event to viewers. |
| The e2e suite writing into the user's real workspace | `e2e/cli.ts` is the only way to call the CLI and always passes `--home` and `--port`; global setup picks a free port; a guard test asserts the state file's port is not 7420 and the home is under the OS temp dir. |
| Screenshot flakiness | Reduced motion, deterministic graph seeding, explicit "settled" signals, single worker. |
| Tests in `test/` that read UI source paths (`test/ui.test.js`, `test/materials.test.js`) | Updated in steps 8 and 18 with the same assertions against the new paths. |
| The server's static MIME map does not know new asset types | Ship only `.js`, `.css`, `.html`, `.json` (and inline SVG). No font or image files in the bundle; `check-ui-build.js` enforces the file list. |
| `<head>` regex token injection | Keep a bare `<head>` in `web/index.html`; `check-ui-build.js` asserts `dist/ui/index.html` contains the literal `<head>`. |
| Scope creep in the visual pass | Step 20 changes tokens and styles only; no new features there. |

Do not:

- Do not edit `src/fp*.js`, or anything under `src/` other than the listed additive changes in step 21 (`src/server.js`, `src/mcp.js` reply text).
- Do not change MCP tool names, descriptions or input schemas. Do not change, rename or remove any `/api` route, query parameter or response field. Do not change the hash link formats.
- Do not add runtime `dependencies`, a `postinstall` / `prepare` script, a CDN reference, a web font, analytics, or any request to another origin.
- Do not add Tailwind, a state library, a router, or a component library other than Bits UI. `(Review 2)`: the complete list of packages allowed in the bundle is: `svelte`, `bits-ui` (and what it pulls in), `lucide-static`, `three`, `virtua`, `@xyflow/svelte` (and what it pulls in), `@dagrejs/dagre`, `vanilla-colorful`, `fuzzysort`. Anything else needs the owner's yes first. In particular do not add: `elkjs` (EPL / GPL), `postprocessing` (Zlib licence; `GTAOPass` covers it), `camera-controls`, `wavesurfer.js`, Cytoscape, `d3-force`, a chart library, a syntax highlighter, a drag-and-drop library, a toast library, a hotkey library.
- Do not import `@xyflow/svelte`, `@dagrejs/dagre`, `vanilla-colorful` or `fuzzysort` statically from anything the entry chunk reaches; each has exactly one `import()` site.
- Do not ship sourcemaps or anything from `web/`, `e2e/`, `test/`.
- Do not import Svelte stores or components from viewer classes; do not put viewer rendering logic in Svelte components.
- Do not use `{@html}` or `innerHTML` with anything that is not a build-time constant.
- Do not use `window.confirm`, `window.prompt`, `window.alert`.
- Do not make writes optimistic beyond hidden / pinned / solo.
- Do not remove a legacy `localStorage` key or change its value shape; new keys use the same `agent-art:` prefix.
- Do not delete a legacy file before its replacement passes the e2e baseline.
- Do not bump the package version or publish; that is handled outside this plan.
- Do not run the e2e server or CLI without `--home` and `--port`.
- Do not "fix" failing tests by loosening them; if a legacy behaviour looks wrong and is not marked `(quirk)` here, keep it and report it.

---

## 9. Definition of done

- [ ] Every checkbox in section 1 is ticked. Each intentional difference is one of the items marked `(new)` or `(quirk … fix)` in this plan, and is listed in `CHANGELOG.md`.
- [ ] `web/` contains only `index.html`, `plan.md` and `src/`. No legacy JS, no `style.css`, no adapter, no shims.
- [ ] `npm run check:ui`: 0 errors, 0 warnings. `npm run check:e2e`: 0 errors. No `any` outside third-party typing gaps, each with a comment.
- [ ] `npm run test:ui`: all green; unit tests exist for every module named in sections 3, 5 and 6.
- [ ] `npm test`: all green (the count is at least the starting count plus the tests added in step 21).
- [ ] `npm run test:e2e`: all green in one run, under 8 minutes (Review 2: was 6; five more spec files), with zero console errors, zero page errors and zero cross-origin requests; covers: seed through the CLI, every viewer opened, live timeline event + follow, review note dialog (add, accept, reopen, delete), cleanup (plan, blocked plan, apply, trash, restore, usage, settings), narrow layout (drawers, overflow menu), 3D runtime render check, the four viewport shading modes with shadows / AO / baked lighting and the leak check (5.7b), deep links, keyboard shortcuts, reconnect after a server restart, axe checks.
- [ ] `npm run build:ui && npm run check:build`: budgets of 7.1 met, pack contents of 7.2 correct, `dependencies` empty, no sourcemaps, three.js is a lazy chunk.
- [ ] `(Review 2)` Every RV item in 1.18 is ticked; e2e covers the command palette, the row context menu and drag-to-compare, the graph in Cards and Canvas renderers with the Hierarchy layout, the colour picker, the compare overlay, the 3D view presets / gizmo / overlays / Solid lighting; `dist/ui/THIRD-PARTY-NOTICES.txt` exists and lists every bundled package; the measured gzip size of each new lazy chunk is written in the PR description next to its budget.
- [ ] A fresh clone works: `npm ci`, `npm run build:ui`, `node bin/agent-art.js serve --home <tmp> --port <free>` serves the new UI; removing `dist/ui` gives the 503 page and the stderr line; touching a file in `web/src` gives the stale warning and banner.
- [ ] `npm run dev:ui` against a running server: hot reload works, ops are attributed to the user (a paint stroke shows as a user entry), timeline entries arrive live.
- [ ] `docs/ui/*.png` regenerated with unchanged file names; `docs/ui/README.md`, `README.md`, `CHANGELOG.md` updated; `npm run docs:llms` re-run and committed.
- [ ] Manual pass on a real workspace at 1680 px, 1000 px and 430 px: paint with every tool, undo / redo, scrub frames, play each player, orbit a model through every channel and every shading mode (Solid, Material preview, Rendered with shadows, AO, baked lightmap, time-of-day, turntable) on an integrated GPU if one is available, play audio with a selection, graph pan / zoom / collapse, compare, snapshot and back, pin / hide / solo, select + cleanup + restore, review round trip with the agent (`art_review list` shows the note; a `fixed` update appears in the UI).
- [ ] Commits are one per step, authored as `KelpHect <kellhect@gmail.com>`, touching only files named in that step.

---

## 10. Review 2 (Fable): changes

Second, independent review of this plan. Everything listed here is already written into the sections above (search for `Review 2`). Package facts were read from the npm registry and from `node_modules` on the review day: installed `svelte` 5.57.3, `vite` 8.3.7, `typescript` 6.0.3, `three` 0.170.0, `vitest` 5.1.0. Gzip sizes of packages not yet installed are estimates; every new chunk has a budget in 7.1 and a "stop and report" rule if the measured size is above it.

### 10.1 Packages added (all devDependencies, bundled by Vite; `dependencies` stays empty)

| Package | Feature | Why it beats custom code | Size (gzip) | Licence | Maintenance / Svelte 5 | Loading |
| --- | --- | --- | --- | --- | --- | --- |
| `virtua` 0.54.x | virtualised asset browser and timeline (steps 13–15) | the plan's own `VirtualList` was fixed-row-height only, so the timeline (variable heights, items prepended while reading) needed a separate hand-written scroll-anchoring hack and a 400-row cap; virtua measures rows and keeps the position on prepend | ≈ 6 kB | MIT | released this month; peer `svelte >= 5.0`, has a native `virtua/svelte` entry | initial (budget raised 110 → 116 kB) |
| `@xyflow/svelte` 1.7.x (Svelte Flow) | asset graph "Cards" renderer: thumbnail cards, minimap, controls, focusable nodes (5.9b) | DOM nodes get thumbnails, shared badges / icons, hover actions and keyboard access that a canvas cannot give without re-implementing a widget toolkit; pan / zoom / drag / minimap are tested library code | ≈ 55–65 kB + 3 kB CSS | MIT (transitive d3 parts ISC / BSD-3) | released this week; peer `svelte ^5.25.0`, runes-native | lazy chunk `graph-cards`, ≤ 75 kB |
| `@dagrejs/dagre` 3.1.x | graph "Hierarchy" layout for both renderers (5.9b) | layered layout with crossing reduction is a research-grade algorithm; "Layered by kind" ignores edges | ≈ 20–25 kB | MIT | released last month; framework-free | lazy chunk `graph-layout`, ≤ 30 kB |
| `vanilla-colorful` 0.7.2 | colour picker with alpha in the canvas editor (5.2) | the native `<input type="color">` opens a modal OS dialog and has no alpha; a correct HSV + alpha picker with pointer, keyboard and ARIA is fiddly; this one is a custom element, so it drops into viewer-built DOM | ≈ 3 kB | MIT | no release since 2022 (stable, zero deps, web-standard API); framework-free | lazy, on first open, ≤ 5 kB |
| `fuzzysort` 4.0.x | command palette search (step 18b) | ranked subsequence matching with highlight indexes, fast on thousands of names; a naive scorer ranks badly | ≈ 5 kB | MIT | released in the last three months; framework-free | lazy chunk `palette`, ≤ 14 kB |
| `@types/three` 0.170.0 | typings for the 3D viewer (5.7) | `three` ships no types; without them the model viewer is `any` | 0 (types) | MIT | matches the pinned three version | not bundled |

Also used, without a new package: Bits UI `ContextMenu` and `Command` (already a dependency of the plan), three's `ViewHelper` addon (already inside `node_modules/three`).

### 10.2 Candidates rejected (so nobody re-litigates them)

- `elkjs`: licence is `EPL-2.0 OR GPL-3.0-or-later` (outside MIT / Apache / BSD) and about 400 kB gzip. dagre covers the layered layout.
- Cytoscape: agree with the first planner. Its value is a canvas renderer plus layouts; we keep our own canvas renderer and add only the layout (dagre) and a DOM renderer (Svelte Flow), which is the part canvas cannot do.
- `d3-force` (ISC): the ported `stepForce` is tested and adequate; not worth a dependency.
- `camera-controls` (MIT, ≈ 12 kB): smooth view transitions and fit-to-bounds are nice, but `test/ui.test.js` pins the `OrbitControls` import, the turntable in 5.7b uses its `autoRotate`, and a 200 ms spherical tween (`model/views.ts`) gives the view presets without it.
- pmndrs `postprocessing` (Zlib licence) and `n8ao`: agree with the first planner; `GTAOPass` is in three, verified in r170 (`blendIntensity`, `updateGtaoMaterial`, `updatePdMaterial`, `overrideVisibility` skipping lines and points all exist).
- `wavesurfer.js`: agree. The waveform needs review ranges, selection loop points and a spectrum that are custom anyway; the plan's cached-peaks change fixes the only real cost.
- Tailwind, React / R3F: agree, no argument to reopen.
- Chart libraries (uPlot, LayerChart): the usage bars are CSS bars and the audio views are bespoke canvases; nothing to gain.
- `svelte-sonner`, `paneforge`, `tinykeys` / `hotkeys-js`, `svelte-dnd-action`: each replaces 40–80 lines whose exact behaviour (toast timings O1, px-based persisted sizes L2, the ordered key rules K1–K10, row → slot drag) is specified here and would have to be bent around the library.
- `@tanstack/svelte-virtual`: works, but its Svelte adapter is store-based and it has no built-in prepend anchoring; virtua fits the timeline better.
- Shiki / Prism / CodeMirror, JSON tree components: only JSON is shown; a 40-line tokenizer does it (RV9).
- `pixelmatch`, `img-comparison-slider`: pixel art needs exact comparison and nearest-neighbour zoom inside PixelView; 15 lines in `pixel/diff.ts`.
- `runed` (direct use): it arrives with Bits UI anyway, but importing it directly risks a second copy at a different major; the small resource helper in step 16 stays.

### 10.3 Corrections to the first plan

| # | Change | Reason |
| --- | --- | --- |
| 1 | `tsconfig.json`: no `"baseUrl"`; `paths` uses `./web/src/*` (2.1, step 1) | TypeScript 6.0.3 is installed; `baseUrl` is deprecated there and `npm run check:ui` would fail on the first step. |
| 2 | `@types/three@0.170.0` added outright (5.7, step 1) | `node_modules/three` has no `.d.ts`; "add if needed" would surface as a pile of `any` in step 8. |
| 3 | Step 13: legacy dialog detection switched from DOM selectors to `dialogs.blocking` (+ the legacy selector until step 17) | `web/app.js` uses `.modal:not(#help)` in the key handler and in `follow`; once dialogs become Bits dialogs (steps 13, 16, 17) those checks silently stop matching, so global keys and follow would fire under an open dialog for five steps. |
| 4 | 5.7b `Z` pie layout: left Wireframe, right Solid, top Rendered, bottom Material preview | The plan said "top Solid, right Rendered" and called it Blender's layout; Blender has Solid on the right and Rendered on top. |
| 5 | 5.7b auto-degrade measures the interval between animation frames, not `performance.now()` around `render()` | WebGL calls are asynchronous; timing the call reads about 1 ms on the slow GPUs the feature exists for, so it would never degrade. |
| 6 | 5.7b Solid gets a Lighting choice: MatCap, Studio, Flat; Studio is the legacy hemisphere + directional setup, copied exactly | The plan dropped the legacy look ("a subset of Rendered"). House rule is improve, never remove; Blender's Solid mode has exactly these three options, so the old look gets a natural home. |
| 7 | 5.7b live-reload guard for `profile=three` (longer debounce, in-flight guard, timing recorded, stop-and-report threshold) | Material preview as default means every reload asks the server for the heavier materials-v2 GLB, which `src/server.js` assembles per request. |
| 8 | 5.7b view presets, "Frame model", axis gizmo (`ViewHelper`), Overlays master toggle | The section aims at a Blender-like viewport but had only shading; orientation controls are the other half and cost no dependency. Numpad codes avoid clashing with the `1`–`4` shading keys. |
| 9 | Step 14: virtua replaces `overflow-anchor` + the `$effect.pre` fallback and the 400-row cap | Two stacked anchoring mechanisms on variable-height rows is the classic source of scroll jitter; one library mechanism, one e2e assertion. |
| 10 | Step 15: one render path (always virtual) instead of "plain under 200 items, virtual above" | Two paths double the sticky-header, focus and scroll-restore cases; adds `aria-setsize` / `aria-posinset` and focus-across-virtual-rows rules that the first plan did not cover. |
| 11 | Step 10 produces the graph already split into controller + renderer interface; step 10b adds Cards and Hierarchy and is separable | Keeps the parity port (canvas) shippable on its own and lets the Cards renderer be cut without touching later steps. |
| 12 | `scripts/vite-notices.js`: `THIRD-PARTY-NOTICES.txt` + licence allow-list at build time (step 1, 7.1, 7.2) | MIT / ISC / BSD require the notice to ship with copies; the minified bundle keeps only `/*! */` banners (three, the Lucide comment). Also guards against `@internationalized/date` (a Bits peer) being bundled. |
| 13 | Budgets (7.1): initial 110 → 116 kB; three 215 → 220 kB; new budgets for `graph-cards`, `graph-layout`, `palette`, picker; CSS split into initial ≤ 14 / total ≤ 20 kB; `dist/ui` 1.3 → 1.8 MB; leak-into-initial marker checks; new runtime budgets for the timeline and graph | Each increase is tied to a named package; everything heavy is lazy. |
| 14 | One `SHORTCUTS` table feeds Help, tooltips and the palette (4.4) | The first plan kept the help text, tooltip hints and key handler as three hand-synced lists. |
| 15 | 2.2: the "no Svelte import from viewers" rule gets one named exception (`graph/flow/mountFlow.ts`) with a grep in the acceptance list | Needed for Svelte Flow; fenced so it cannot spread. |
| 16 | Section 9: e2e time limit 6 → 8 minutes; new DoD line for the RV items | More spec files (`graph`, `palette`, `compare`). |
| 17 | 5.9b Hierarchy reverses only `part_of` and `layer_of` | Checked against `REL_COLOR` in the legacy graph: `variant_of` and `view_of` also end in `_of` but are not containment. |

### 10.4 New features added (1.18)

RV1 command palette (18b) · RV2 row context menu (15) · RV3 drag a row to a slot (15) · RV4 graph Cards renderer + Hierarchy layout + minimap (5.9b, 10b) · RV5 colour picker popover (5.2) · RV6 virtualised lists, timeline without the 400 cap (13–15) · RV7 compare tools: linked views + Difference / Swipe / Blink overlay (5.1, 18c) · RV8 3D view presets, gizmo, overlays, Solid lighting (5.7b) · RV9 JSON colouring (5.10) · RV10 zoomable rig pose / weights images (5.5).

Each is additive, has unit and e2e tests named in its section, and steps 10b (sub-commits 2–3), 18b and 18c are independent of each other and of every later step, so any one can be cut without re-planning.

### 10.5 Checked and found sound (no change)

- Feature inventory: spot-checked against `web/app.js` (key handler order, `viewerClass`, `targetFor`, tabs, hash, compare), `web/ui/util.js` exports, viewer toolbar labels, persisted keys (all 17 legacy `store` keys are in 1.12), and every `/api` route and query parameter in `src/server.js`. No missing item found.
- three r170 facts used in 5.7b: `GTAOPass`, `OutputPass`, `RoomEnvironment`, `LightProbeHelper`, `ViewHelper`, `NeutralToneMapping`, `scene.environmentIntensity` / `environmentRotation` all exist in the installed build; the lightmap extras shape matches `src/materials.js`.
- Step order: every step leaves a working UI (strangler with the legacy `App` as a facade); the e2e baseline is written against the legacy UI before anything moves. Sound.
- GTAO vs SSAO vs n8ao, PCF soft vs VSM shadows, Neutral vs ACES tone mapping: agree with each choice.

### 10.6 Noted, outside this plan

- `src/server.js` caches model thumbnails by `updated` only, not by `size`: `thumb.png?size=384` (the WebGL fallback image) can return a cached 128 px thumbnail. It is a server bug that exists today; the plan forbids `src/` changes beyond step 21, so it is only recorded here.

### 10.7 For the owner to decide

1. **ISC licence.** The brief said MIT / Apache / BSD only. `lucide-static` (first plan) is ISC, and Svelte Flow pulls ISC d3 modules. ISC is the same grant as MIT / BSD-2 in fewer words, so the allow-list in `vite-notices.js` includes it. If ISC is not acceptable: drop the Cards renderer (step 10b sub-commits 2–3) and replace the icon set.
2. **Graph default.** Auto shows Cards for small graphs and Canvas above 400 nodes. If you prefer the canvas look everywhere, set the default of `graphRenderer` to `'canvas'`; nothing else changes.
3. **Default 3D mode.** Material preview (first plan) costs a heavier GLB per reload. The alternative is Solid › Studio, which is exactly today's look. The plan keeps Material preview unless the step 8b timing says otherwise.
4. **Colour input.** The native colour input is replaced in the toolbar by a swatch that opens the new picker (the OS dialog stays reachable inside it). Say so if you want the native input to stay visible as well.
5. **Scope.** Review 2 adds roughly three steps of work (10b, 18b, 18c) on top of the first plan. They are ordered so the parity rewrite never waits on them.

---

## Implementation notes

Deviations from the plan, smallest correct change each, in step order.

- **Step 2, seeding.** The activity log lives in memory in the server process, so ops seeded before the server starts never appear in the timeline. `e2e/seed.ts` has two lists: `SEED` (run in-process before the server starts: assets, exports, graph, reviews) and `LIVE_SEED` (run through the live server after it is healthy: two draws and one expected failure), so the timeline specs have entries.
- **Step 2, base URL.** `playwright.config.ts` is evaluated before global setup picks the port, so the base URL comes from a fixture override that reads `e2e/.state.json`, not from `use.baseURL`.
- **Step 2, collapsed project rows.** Canvases inside a project are collapsed in the browser, so the smoke and viewer specs use the loose canvas `spark` for row checks.
- **Step 3, early files.** `lib/util/icons.ts`, `lib/util/dom.ts` (`renderJson`), `lib/util/jsonTokens.ts` and `viewers/types.ts` were written in step 3 (they are plain modules the step 3 tests and later steps need) rather than with their first consumer.
- **Step 3, toast bus.** `toast` / `onToast` live in `lib/util/notify.ts` (the module-level callback the plan describes), so `client.ts` can report op failures without importing a store.
- **Step 3, `refreshUiToken`.** It also keeps the fetched page HTML (`lastFetchedIndex()`), which the step 12 resync uses to compare the entry script URL, so `/` is fetched once per reconnect.
- **Step 3, `EventStream.onOpen`.** `reconnect` is `false` only for the very first `hello`; every later `hello` (after any error) is a reconnect.
- **Server, model thumbnails.** `/api/model/<n>/thumb.png` cached one image per model whatever `size` asked for. The cache key is now model + size, and `size` is clamped to 16..1024 (default 128). Test in `test/ui.test.js`.
- **Step 4, slot rules.** The legacy "viewers" block also held the shell's slot rules (`.viewers`, `.slot-wrap`, `.slot-head`, `.slot-title`, `.tabs`, `.tab`, `.slot`); they went to `legacy-shell.css` (a "slots" section) rather than `viewers.css`, since the shell owns them. Before / after shots of `01-overview` and `18-narrow` differ by 0 pixels (`scripts/shots-diff.mjs`, a small Chromium-based pixel diff; volatile parts such as clock times and the temp workspace path are masked by `AppPage.volatile()`).
