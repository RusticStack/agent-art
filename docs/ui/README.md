# Web UI

[Back to the README](../../README.md)

The UI shows everything the agent does, live, and lets you steer it.

![Agent Art web UI](../ui/01-overview.png)

- **Activity timeline.** Every MCP tool call is an entry: tool, action, key arguments, duration, result summary or error, and before/after thumbnails of the canvases and models it changed. Filter by tool, by the open asset, by errors or by source, and search. Clicking an entry opens the asset as it was after that call; `⇆` compares before and after. Dock it right or at the bottom (`P`).
- **Asset browser.** One tree of the workspace: pinned items, groups, projects, canvases (layers and animation tags), rigs (parts canvas, clips, poses), 3D models (named parts, clips), audio and exported files. Each item can be hidden (eye), pinned or soloed; hidden and pinned state is saved per workspace. New assets appear as the agent makes them. The tree works from the keyboard (arrows, `Home` / `End`, `Enter` opens, `Shift+F10` opens the row menu). Right-click a row for its context menu (open, open in compare, pin, hide, solo, show in graph, add a review note, copy name or link, select, plan cleanup), or drag a row onto the viewers and drop it on "Compare here".
- **Viewers.** Canvas editor (zoom at the cursor, pan, pixel grid, 3×3 tile, frame scrubber, onion skin, per-layer view, the paint tools, and a colour picker popover with hex / alpha entry and recent colours). Animation player with fps, loop and a per-view grid that plays all 8 directions of a rig animation as a compass. Rig viewer with the skeleton drawn from the per-frame part anchors, plus pose previews per view. 3D viewer (three.js, bundled and loaded on first use) with orbit, wireframe, vertex normals, UV checker, glTF clips, sockets, pivots and triangle stats; shading modes Wireframe, Solid, Material preview and Rendered (keys `1`–`4`, or the `Z` pie), shadows, AO and baked lighting; view presets (Front, Back, Right, Left, Top, Bottom, numpad keys) and an axis gizmo. Audio player with waveform, spectrum, loop and range selection, and the analysis report the agent reads. Sprite sheet / export preview with frames and anchors. Project overview grid.
- **Layers view.** The draw order of a rig clip or a canvas for the current view and frame (name, z, the rule that placed it), view-only eye and solo, a debug tint by draw order with overlap highlighting, hover to see which part drew a pixel and what is underneath, and a z-order lane chart across frames.
- **Asset graph.** `art_graph` as thumbnail cards with a minimap and zoom controls (keyboard-focusable), in a Force, Layered or Hierarchy layout: colours by kind, relation labels, filters by relation or tag, collapsible groups, review and cleanup badges. Large graphs switch to a fast canvas renderer on their own.
- **Review notes.** Press `M`, drag a box or click a pin (on a canvas, an animation view, a rig clip, the 3D view or an audio range) and leave a note: `fix`, `redo`, `inconsistent` (across views), `layering`, `style`, `question` or `approve`, with a priority and an optional asset/view to compare with. The agent sees open notes in `art_review list` and as one line in the reply of any tool that touches that asset; it marks them `fixed` and you accept or reopen them. Approving an asset makes the agent's replies warn before it changes it.
- **Compare** (`C`) puts two assets or two states side by side, with linked zoom and an overlay (`D` cycles Difference, Swipe, Blink) that counts the pixels that differ. **Follow** (`F`) switches the viewer to whatever the agent is touching; turn it off to browse while events keep streaming.
- **Command palette** (`Ctrl+K`): search every asset and action (tabs, tools, shading, view presets, follow / compare / review) and run it from the keyboard; `Alt+Enter` opens an asset in compare.
- Resizable panes, keyboard shortcuts (`?`) and full keyboard access, dark theme, and a narrow-screen layout with drawers and an overflow menu for the top bar buttons. Confirmations (delete a note, reopen, empty the trash) are styled dialogs, not browser pop-ups. If the server goes away the status shows "disconnected — retrying"; the UI reconnects on its own and catches the timeline up. Thumbnails are cached by version and load lazily, so hundreds of canvases stay fast.

The agent's side of the graph and the notes:

```jsonc
// art_graph: record a relation, then ask what is connected (a few hundred characters)
{ "action": "link", "from": "helmet_side", "rel": "variant_of", "to": "helmet_front", "attrs": { "view": "side" } }
{ "action": "query", "node": "helmet_front" }
// art_review: open notes, one line each; the marked region as an image; resolve it
{ "action": "list" }
{ "action": "get", "id": "r1" }
{ "action": "update", "id": "r1", "status": "fixed", "reply": "closed the outline gap" }
```

## Screenshots

| Timeline | 8-direction animation | Rig skeleton |
| --- | --- | --- |
| ![timeline](02-timeline.png) | ![8 directions](03-animation-8-directions.png) | ![rig](04-rig-skeleton.png) |
| **Layers debug** | **Model viewer** | **Wireframe, UVs, normals** |
| ![layers](05-layers-debug.png) | ![model](07-model-viewer.png) | ![wire](08-model-wire-uv-normals.png) |
| **Audio player** | **Sheet with anchors** | **Export preview** |
| ![audio](09-audio-player.png) | ![sheet](10-sheet-anchors.png) | ![export](11-export-preview.png) |
| **Asset graph** | **Review mark** | **Review notes** |
| ![graph](12-asset-graph.png) | ![mark](13-review-mark-dialog.png) | ![notes](14-review-notes.png) |
| **art_review get** | **Compare** | **Narrow layout** |
| ![get](15-art-review-get.png) | ![compare](16-compare-side-by-side.png) | ![narrow](18-narrow.png) |
| **Graph hierarchy** | **Large graph (canvas)** | **Command palette** |
| ![hierarchy](31-graph-hierarchy.png) | ![large graph](32-graph-canvas-large.png) | ![palette](33-command-palette.png) |
| **Compare: difference** | **Colour picker** | **Asset context menu** |
| ![difference](34-compare-difference.png) | ![colour picker](35-colour-picker.png) | ![context menu](36-asset-context-menu.png) |

Cleanup screens (select, plan, trash, disk usage) are in [docs/cleanup/README.md](../cleanup/README.md).
