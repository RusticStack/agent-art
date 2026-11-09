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
  notesCount(): Locator { return this.page.locator('#reviewCount'); }
  workspacePath(): Locator { return this.page.locator('#wsPath'); }
  // ---- browser ----
  browserPane(): Locator { return this.page.locator('#browser'); }
  browserRow(name: string, kind = 'canvas'): Locator { return this.page.locator(`#browser .row[data-id="${kind}:${name}"]`).first(); }
  browserSection(key: string): Locator { return this.page.locator(`#browser .section[data-key="${key}"]`); }
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
  async enterSelectMode() { await this.browserPane().getByRole('button', { name: /Select$/ }).click(); }
  selectionBar(): Locator { return this.page.locator('#browser .selbar'); }
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
  frameLabel(): Locator { return this.slot('A').locator('.frames-controls .mono'); }
  swapButton(): Locator { return this.page.locator('#swapB'); }
  closeCompareButton(): Locator { return this.page.locator('#closeB'); }
  backToLive(): Locator { return this.slotTitle('A').getByRole('button', { name: 'Back to live' }); }
  // ---- timeline ----
  timelinePane(): Locator { return this.page.locator('#timelinePane'); }
  timelineEntries(): Locator { return this.page.locator('#timelinePane .tl-entry'); }
  timelineCount(): Locator { return this.page.locator('#timelinePane .pane-head .mono'); }
  timelineChip(text: 'Errors' | 'This asset' | 'Agent'): Locator { return this.page.locator('#timelinePane .chip', { hasText: text }); }
  timelineSearch(): Locator { return this.page.locator('#timelinePane input.search'); }
  timelineList(): Locator { return this.page.locator('#timelinePane .tl-list'); }
  dockButton(): Locator { return this.page.locator('#timelinePane .pane-head button'); }
  // ---- inspector ----
  inspector(): Locator { return this.page.locator('#inspector'); }
  inspectorTitle(): Locator { return this.page.locator('#inspector .insp-title .name'); }
  inspectorSection(title: string | RegExp): Locator { return this.page.locator('#inspector .insp-sec').filter({ has: this.page.locator('.panel-label', { hasText: title }) }); }
  reviewCards(): Locator { return this.page.locator('#inspector .review-card'); }
  // ---- dialogs, toasts ----
  dialog(): Locator { return this.page.locator('.modal:not(#help):not([hidden])').last(); }
  helpDialog(): Locator { return this.page.locator('#help'); }
  toasts(): Locator { return this.page.locator('#toasts .toast'); }
  async openCleanup() { await this.topButton('cleanup').click(); await expect(this.dialog()).toBeVisible(); }
  async press(key: string) { await this.page.keyboard.press(key); }
  /** Parts that differ between runs (clock times, durations, the temp workspace path): masked in shots. */
  volatile(): Locator[] {
    return [this.workspacePath(), this.page.locator('.tl-time'), this.page.locator('.tl-ms')];
  }
  /** Wait until every visible image has decoded. */
  async imagesDecoded() {
    await this.page.waitForFunction(() => [...document.images].filter((i) => i.offsetParent !== null).every((i) => i.complete && (i.naturalWidth > 0 || i.classList.contains('gone'))));
  }
  /** Move focus off any input so global shortcuts apply. */
  async blur() { await this.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.()); }
}
