// Page object: the only file that knows selectors. Specs use these locators and actions.
import { expect, type Locator, type Page } from '@playwright/test';

export class AppPage {
  constructor(readonly page: Page) {}

  async goto(hash = '') {
    await this.page.goto('/' + (hash ? '#' + hash : ''));
    await expect(this.status()).toHaveText(/live|agent is working/, { timeout: 15_000 });
  }
  // ---- top bar ----
  status(): Locator { return this.page.locator('#statusText'); }
  async statusText() { return (await this.status().textContent()) ?? ''; }
  topButton(name: 'follow' | 'compare' | 'review' | 'notes' | 'graph' | 'cleanup' | 'help' | 'toggleBrowser' | 'toggleSide'): Locator {
    const ids = { follow: '#followBtn', compare: '#compareBtn', review: '#reviewBtn', notes: '#reviewListBtn', graph: '#graphBtn', cleanup: '#cleanupBtn', help: '#helpBtn', toggleBrowser: '#toggleBrowser', toggleSide: '#toggleSide' };
    return this.page.locator(ids[name]);
  }
  followMode(): Locator { return this.page.locator('#followMode'); }
  // ---- narrow layout (step 19): overflow menu, drawers ----
  moreButton(): Locator { return this.page.locator('#moreBtn'); }
  moreMenu(): Locator { return this.page.getByRole('menu', { name: 'More actions' }); }
  /** An overflow menu item by id: search, compare, review, notes, graph, cleanup, help, follow-canvas / -project / -off. */
  moreItem(id: string): Locator { return this.moreMenu().locator(`[data-id="${id}"]`); }
  async openMore() { await this.moreButton().click(); await expect(this.moreMenu()).toBeVisible(); }
  drawerScrim(): Locator { return this.page.locator('.drawer-scrim'); }
  sidePane(): Locator { return this.page.locator('#side'); }
  /** Does the page scroll horizontally (document wider than the viewport)? */
  async hasHorizontalScroll(): Promise<boolean> {
    return this.page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  }
  /** A short description of the focused element (tag, id, class, aria-label) for keyboard specs. */
  async focused(): Promise<{ id: string; inBrowser: boolean; inSlotAToolbar: boolean; label: string }> {
    return this.page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return {
        id: a?.id ?? '',
        inBrowser: !!a?.closest('#browser'),
        inSlotAToolbar: !!a?.closest('#slotA .vtoolbar'),
        label: a?.getAttribute('aria-label') ?? a?.textContent?.trim().slice(0, 40) ?? '',
      };
    });
  }
  /** The top bar search button (command palette, step 18b). */
  paletteButton(): Locator { return this.page.getByRole('button', { name: 'Search assets and actions (Ctrl+K)' }); }
  notesCount(): Locator { return this.page.locator('#reviewCount'); }
  workspacePath(): Locator { return this.page.locator('#wsPath'); }
  // ---- browser ----
  browserPane(): Locator { return this.page.locator('#browser'); }
  browserRow(name: string, kind = 'canvas'): Locator { return this.page.locator(`#browser .row[data-id="${kind}:${name}"]`).first(); }
  browserSection(key: string): Locator { return this.page.locator(`#browser .section[data-key="${key}"]`); }
  /** A row in the Pinned section (rows carry their section; virtua wraps each row, so no sibling selectors). */
  pinnedRow(id: string): Locator { return this.page.locator(`#browser .row[data-section="pinned"][data-id="${id}"]`); }
  filterInput(): Locator { return this.page.locator('#browser input.search'); }
  async openAsset(name: string, kind = 'canvas') {
    const row = this.browserRow(name, kind);
    if (!(await row.isVisible())) {
      const sec = { canvas: 'canvases', rig: 'rigs', model: 'models', audio: 'audio', project: 'projects', export: 'exports', group: 'groups' }[kind] ?? 'canvases';
      await this.filterInput().fill(name);
      await expect(row).toBeVisible();
      void sec;
    }
    await row.locator('.label').click();
    await expect(this.slotTitle('A')).toContainText(name);
    if (await this.filterInput().inputValue()) await this.filterInput().fill('');
  }
  rowAction(name: string, act: 'solo' | 'pin' | 'eye', kind = 'canvas'): Locator { return this.browserRow(name, kind).locator(`[data-act="${act}"]`); }
  /** The row buttons show on hover / focus: hover the row, then click. */
  async clickRowAction(name: string, act: 'solo' | 'pin' | 'eye', kind = 'canvas') { await this.browserRow(name, kind).hover(); await this.rowAction(name, act, kind).click(); }
  async enterSelectMode() { await this.browserPane().getByRole('button', { name: /Select$/ }).click(); }
  selectionBar(): Locator { return this.page.locator('#browser .selbar'); }
  showHiddenButton(): Locator { return this.browserPane().getByRole('button', { name: /^hidden$/ }); }
  tree(): Locator { return this.page.getByRole('tree', { name: 'Assets' }); }
  treeRows(): Locator { return this.page.locator('#browser [role=treeitem]'); }
  menu(): Locator { return this.page.getByRole('menu'); }
  menuItem(name: string | RegExp): Locator { return this.menu().getByRole('menuitem', typeof name === 'string' ? { name, exact: true } : { name }); }
  /** The "Compare here" drop zone shown on the right of the viewers during an asset drag. */
  dropCompare(): Locator { return this.page.locator('#viewers .drop-compare'); }
  viewers(): Locator { return this.page.locator('#viewers'); }
  // ---- viewers ----
  slot(s: 'A' | 'B'): Locator { return this.page.locator(`#slot${s}`); }
  slotWrap(s: 'A' | 'B'): Locator { return this.page.locator(`#slotWrap${s}`); }
  slotTitle(s: 'A' | 'B'): Locator { return this.page.locator(`#title${s}`); }
  tab(label: string, s: 'A' | 'B' = 'A'): Locator { return this.page.locator(`#tabs${s} .tab`, { hasText: new RegExp(`^${label}$`) }); }
  tabs(s: 'A' | 'B' = 'A'): Locator { return this.page.locator(`#tabs${s} .tab`); }
  viewer(s: 'A' | 'B' = 'A'): Locator { return this.slot(s).locator('.viewer').first(); }
  viewerStatus(s: 'A' | 'B' = 'A'): Locator { return this.slot(s).locator('.vstatus').first(); }
  pixelCanvas(s: 'A' | 'B' = 'A'): Locator { return this.slot(s).locator('canvas.pixel-canvas').first(); }
  toolButton(tool: string): Locator { return this.slot('A').locator(`.tool[data-tool="${tool}"]`); }
  toolGroup(): Locator { return this.slot('A').locator('[role=radiogroup]'); }
  colorSwatch(): Locator { return this.slot('A').locator('button.color-swatch'); }
  colorPopover(): Locator { return this.slot('A').locator('.color-pop'); }
  hexInput(): Locator { return this.colorPopover().locator('input.hex-in'); }
  zoomLabel(): Locator { return this.slot('A').locator('.zoom-label'); }
  gridToggle(): Locator { return this.slot('A').locator('label.toggle', { hasText: 'Grid' }).locator('input'); }
  animCells(s: 'A' | 'B' = 'A'): Locator { return this.slot(s).locator('canvas.anim-cell'); }
  animPlayButton(): Locator { return this.slot('A').locator('.anim-viewer .vtoolbar button[title^="Play / pause"]'); }
  sheetCanvas(s: 'A' | 'B' = 'A'): Locator { return this.slot(s).locator('canvas.sheet-canvas'); }
  audioPlay(s: 'A' | 'B' = 'A'): Locator { return this.slot(s).locator('.audio-viewer .vtoolbar .btn.primary'); }
  audioWave(s: 'A' | 'B' = 'A'): Locator { return this.slot(s).locator('canvas.wave'); }
  audioReport(s: 'A' | 'B' = 'A'): Locator { return this.slot(s).locator('.audio-report'); }
  graph(): Locator { return this.slot('A').locator('.graph-viewer'); }
  graphFlow(): Locator { return this.graph().locator('.svelte-flow'); }
  graphCards(): Locator { return this.graph().locator('.svelte-flow__node'); }
  graphCard(id: string): Locator { return this.graph().locator(`.svelte-flow__node[data-id="${id}"]`); }
  graphCounts(): Locator { return this.graph().locator('.vtoolbar .mono.muted'); }
  graphViewSelect(): Locator { return this.graph().locator('.vtoolbar select[aria-label="View"]'); }
  graphLayoutSelect(): Locator { return this.graph().locator('.vtoolbar select[title="Layout"]'); }
  /** window.agentArt.debug.viewer(slot): the slot viewer's debugInfo(), or null when the hook is absent. */
  async viewerDebug<T>(s: 'A' | 'B' = 'A'): Promise<T | null> {
    return this.page.evaluate((slot) => {
      const w = window as unknown as { agentArt?: { debug?: { viewer?(x: string): unknown } } };
      return (w.agentArt?.debug?.viewer?.(slot) ?? null) as T | null;
    }, s);
  }
  modelViewer(): Locator { return this.slot('A').locator('.viewer.model-viewer'); }
  modelCanvas(): Locator { return this.slot('A').locator('.model-stage canvas'); }
  modelFallback(): Locator { return this.slot('A').locator('.model-stage img.fallback'); }
  modelChannel(): Locator { return this.slot('A').locator('.model-viewer .vtoolbar select[title^="Material channel"]'); }
  modelClip(): Locator { return this.slot('A').locator('.model-viewer .vtoolbar select[title^="Clip"]'); }
  modelToggle(label: string): Locator { return this.slot('A').locator('.model-viewer label.toggle', { hasText: label }).locator('input'); }
  rigMode(): Locator { return this.slot('A').locator('.rig-viewer .vtoolbar select').first(); }
  rigCanvas(): Locator { return this.slot('A').locator('canvas.rig-canvas'); }
  stackRows(): Locator { return this.slot('A').locator('.stack-list > .stack-row'); }
  layersCanvas(): Locator { return this.slot('A').locator('canvas.layers-canvas'); }
  hoverInfo(): Locator { return this.slot('A').locator('.hover-info'); }
  flagButton(): Locator { return this.slot('A').locator('.layers-viewer .vtoolbar button.warn'); }
  frameLabel(): Locator { return this.slot('A').locator('.frames-controls .mono'); }
  swapButton(): Locator { return this.page.locator('#swapB'); }
  closeCompareButton(): Locator { return this.page.locator('#closeB'); }
  backToLive(): Locator { return this.slotTitle('A').getByRole('button', { name: 'Back to live' }); }
  /** The snapshot badge ("state …") in a slot title. */
  stateBadge(s: 'A' | 'B' = 'A'): Locator { return this.slotTitle(s).locator('.badge.state'); }
  // ---- compare tools (slot B header, step 18c) ----
  compareTools(): Locator { return this.slotWrap('B').getByRole('group', { name: 'Compare tools' }); }
  compareLink(): Locator { return this.compareTools().getByRole('button', { name: 'Link' }); }
  overlaySelect(): Locator { return this.compareTools().getByRole('combobox', { name: 'Overlay' }); }
  compareStatus(): Locator { return this.compareTools().getByRole('status'); }
  /** A hash of the slot's pixel canvas content, to see that something on screen changed. */
  async canvasHash(s: 'A' | 'B' = 'A'): Promise<number> {
    return this.pixelCanvas(s).evaluate((c) => {
      const cv = c as HTMLCanvasElement;
      const t = document.createElement('canvas'); t.width = cv.width; t.height = cv.height;
      const x = t.getContext('2d')!; x.drawImage(cv, 0, 0);
      const d = x.getImageData(0, 0, t.width, t.height).data;
      let h = 2166136261;
      for (let i = 0; i < d.length; i++) { h ^= d[i]; h = Math.imul(h, 16777619); }
      return h >>> 0;
    });
  }
  /** Find the swipe bar on slot A's canvas (the cursor turns col-resize over it): its page x, y. */
  async swipeBar(): Promise<{ x: number; y: number }> {
    const box = (await this.pixelCanvas('A').boundingBox())!;
    const y = box.y + box.height / 2;
    for (let x = box.x + 4; x < box.x + box.width - 4; x += 3) {
      await this.page.mouse.move(x, y);
      if (await this.pixelCanvas('A').evaluate((c) => (c as HTMLElement).style.cursor === 'col-resize')) return { x, y };
    }
    throw new Error('swipe bar not found');
  }
  // ---- layout ----
  splitter(label: 'Resize the assets pane' | 'Resize the inspector / activity pane' | 'Resize the inspector' | 'Resize the activity dock'): Locator {
    return this.page.getByRole('separator', { name: label });
  }
  bottomDock(): Locator { return this.page.locator('#bottomDock'); }
  /** window.agentArt.state() (P4). */
  async shellState<T = Record<string, unknown>>(): Promise<T> {
    return this.page.evaluate(() => (window as unknown as { agentArt: { state(): unknown } }).agentArt.state() as T);
  }
  /** Open a target through the debug handle (for slot B setups the browser cannot reach quickly). */
  async openTarget(target: Record<string, unknown>, slot: 'A' | 'B' = 'A') {
    await this.page.evaluate(([t, s]) => (window as unknown as { agentArt: { open(t: unknown, o: unknown): void } }).agentArt.open(t, { slot: s }), [target, slot] as const);
  }
  /** performance marks / paint entries by name, in ms since navigation start (null = not there). */
  async perfMark(name: string): Promise<number | null> {
    return this.page.evaluate((n) => performance.getEntriesByName(n)[0]?.startTime ?? null, name);
  }
  // ---- timeline ----
  timelinePane(): Locator { return this.page.locator('#timelinePane'); }
  timelineEntries(): Locator { return this.page.locator('#timelinePane .tl-entry'); }
  timelineCount(): Locator { return this.page.locator('#timelinePane .pane-head .mono'); }
  timelineChip(text: 'Errors' | 'This asset' | 'Agent'): Locator { return this.page.locator('#timelinePane .chip', { hasText: text }); }
  timelineSearch(): Locator { return this.page.locator('#timelinePane input.search'); }
  timelineList(): Locator { return this.page.locator('#timelinePane .tl-list'); }
  dockButton(): Locator { return this.page.locator('#timelinePane .pane-head button'); }
  /** Timeline entries that mention the text (newest first). */
  timelineEntry(hasText: string | RegExp): Locator { return this.timelineEntries().filter({ hasText }).first(); }
  /** TL11: the entry's "Compare before / after" button (⇆). */
  timelineCompare(entry: Locator): Locator { return entry.getByRole('button', { name: 'Compare before / after' }); }
  /** TL10: the entry's main line (opens the after snapshot). */
  timelineOpen(entry: Locator): Locator { return entry.locator('button.tl-open'); }
  // ---- inspector ----
  inspector(): Locator { return this.page.locator('#inspector'); }
  inspectorTitle(): Locator { return this.page.locator('#inspector .insp-title .name'); }
  inspectorSection(title: string | RegExp): Locator { return this.page.locator('#inspector .insp-sec').filter({ has: this.page.locator('.panel-label', { hasText: title }) }); }
  reviewCards(): Locator { return this.page.locator('#inspector .review-card'); }
  // ---- dialogs, toasts ----
  /** The top open dialog (Bits dialogs except Help; confirm / prompt are .dlg too). */
  dialog(): Locator { return this.page.locator('.dlg:not(.help-dialog)').last(); }
  reviewDialog(): Locator { return this.page.getByRole('dialog', { name: 'Review note' }); }
  reviewListDialog(): Locator { return this.page.getByRole('dialog', { name: /^Review notes · \d+ open$/ }); }
  alertDialog(name: string | RegExp): Locator { return this.page.getByRole('alertdialog', { name }); }
  helpDialog(): Locator { return this.page.getByRole('dialog', { name: 'Keyboard shortcuts' }); }
  // ---- command palette (step 18b) ----
  palette(): Locator { return this.page.getByRole('dialog', { name: 'Search assets and actions' }); }
  paletteInput(): Locator { return this.palette().getByRole('combobox', { name: 'Search assets and actions' }); }
  paletteOptions(): Locator { return this.palette().getByRole('option'); }
  /** The active option (aria-selected). */
  paletteActive(): Locator { return this.palette().locator('[role=option][aria-selected=true]'); }
  /** URLs of the lazy palette chunks (the `palette` group and the CommandPalette entry). */
  static readonly PALETTE_CHUNK = /\/assets\/(palette|CommandPalette)-[^/]+\.js(\?|$)/;
  async openPalette() { await this.page.keyboard.press('ControlOrMeta+k'); await expect(this.paletteInput()).toBeFocused(); }
  /** The toast stack (role=status, "Notifications") and its toasts; errors are role=alert. */
  toastRegion(): Locator { return this.page.getByRole('status', { name: 'Notifications' }); }
  toasts(): Locator { return this.toastRegion().locator('.toast'); }
  errorToasts(): Locator { return this.toastRegion().getByRole('alert'); }
  async openCleanup() { await this.topButton('cleanup').click(); await expect(this.dialog()).toBeVisible(); }
  async press(key: string) { await this.page.keyboard.press(key); }
  /** Parts that differ between runs (clock times, durations, the temp workspace path): masked in shots. */
  volatile(): Locator[] {
    return [this.workspacePath(), this.page.locator('.tl-time'), this.page.locator('.tl-ms')];
  }
  // ---- documentation shots (screenshots.spec.ts) ----
  /** Anything that says "still loading": spinners, the browser skeleton, aria-busy regions. */
  busy(): Locator { return this.page.locator('.spinner:visible, .skeleton:visible, [aria-busy="true"]:visible'); }
  graphStage(): Locator { return this.graph().locator('.graph-stage'); }
  layersViewSelect(): Locator { return this.slot('A').locator('.layers-viewer .vtoolbar select[title="View"]'); }
  layersClipSelect(): Locator { return this.slot('A').locator('.layers-viewer .vtoolbar select[title^="Clip"]'); }
  reviewField(name: 'Category' | 'Priority' | 'Note' | 'Compare with' | 'Compare view'): Locator {
    const d = this.reviewDialog();
    if (name === 'Category' || name === 'Priority') return d.locator('label', { hasText: name }).locator('select');
    return d.getByLabel(name, { exact: true });
  }
  /** The 3D shading row: a mode radio (wire / solid / material / rendered) and its selects by title prefix. */
  shadingRadio(mode: string): Locator { return this.slot('A').locator(`.model-viewer .vtoolbar.shading [role=radiogroup] [role=radio][data-mode="${mode}"]`); }
  shadingSelect(title: string): Locator { return this.slot('A').locator(`.model-viewer .vtoolbar.shading select[title^="${title}"]`); }
  /** The Z pie menu of the 3D viewer. */
  shadingPie(): Locator { return this.page.locator('[role=menu]').filter({ has: this.page.locator('[role=menuitemradio]') }); }
  /** Expand a tree row with children (a project, a rig, a canvas with layers) when it is collapsed. */
  async expandRow(name: string, kind = 'canvas') {
    const row = this.browserRow(name, kind);
    if ((await row.getAttribute('aria-expanded')) === 'false') await row.locator('[data-act="toggle"]').click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
  }
  planDialog(): Locator { return this.page.getByRole('dialog', { name: /^Plan cleanup · \d+ selected$/ }); }
  cleanupDialog(): Locator { return this.page.getByRole('dialog', { name: 'Cleanup' }); }
  planCleanupButton(): Locator { return this.selectionBar().getByRole('button', { name: 'Plan cleanup…' }); }
  /** Wait until every visible image has decoded. */
  async imagesDecoded() {
    await this.page.waitForFunction(() => [...document.images].filter((i) => i.offsetParent !== null).every((i) => i.complete && (i.naturalWidth > 0 || i.classList.contains('gone'))));
  }
  /** Move focus off any input so global shortcuts apply. */
  async blur() { await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()); }
}
