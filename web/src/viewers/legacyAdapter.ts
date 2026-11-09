// Temporary (deleted in step 18): lets the legacy App (web/app.js) host the new viewer classes.
// It builds a ViewerHostApi from the legacy app object and turns the legacy calls (open, setToolUI,
// setColorUI, view.render, keydown, onEvent, undo, destroy) into mount / update / onEvent / onKey.
import type { AnyEvent, AssetIndex, ReviewMark } from '@/lib/api/types';
import type { CompareOverlay, ReviewDraft, SlotId, Target, Tool, Viewer, ViewerCtor, ViewerEnv, ViewerHostApi } from './types';

/** The parts of the legacy App the adapter uses. */
export interface LegacyApp {
  tool: Tool;
  color: { hex: string; hex8: string };
  reviewMode: boolean;
  following: boolean;
  followMode?: 'canvas' | 'project' | 'off';
  assets: AssetIndex | null;
  slots: Record<SlotId, { viewer: unknown }>;
  isHidden(id: string): boolean;
  isPinned?(id: string): boolean;
  togglePinned?(id: string): void;
  toggleHidden?(id: string): void;
  reviewMarks(t: { kind: string; name: string }): ReviewMark[];
  open(t: Target, o?: { slot?: SlotId }): unknown;
  openNode(id: string): void;
  inspectNode(id: string): void;
  reviewPrompt(draft: ReviewDraft): unknown;
  setTool(t: Tool): void;
  setColor(hex: string): void;
  toast(text: string, kind?: 'info' | 'ok' | 'error'): void;
  inspector?: { refreshFor?(v: { name: string }): void };
}

export interface LegacyViewer {
  open(target: Target): Promise<void>;
  onEvent(ev: AnyEvent): void;
  keydown(e: KeyboardEvent, k: string): boolean;
  undo(redo: boolean): void;
  setToolUI(): void;
  setColorUI(): void;
  readonly view: { render(): void };
  readonly inner: Viewer;
  destroy(): void;
}

export function adapt(Ctor: ViewerCtor): new (hostEl: HTMLElement, ctx: { app: LegacyApp; readOnly?: boolean; slot: SlotId }) => LegacyViewer {
  return class LegacyViewerImpl implements LegacyViewer {
    readonly inner: Viewer;
    private el: HTMLElement;
    private owner: LegacyApp;
    private mounted = false;
    private target: Target | null = null;
    private reviewsRev = 0;
    private env: ViewerEnv;

    constructor(hostEl: HTMLElement, { app, readOnly: ro, slot }: { app: LegacyApp; readOnly?: boolean; slot: SlotId }) {
      this.el = hostEl;
      this.owner = app;
      const readOnly = !!ro;
      const other = (): SlotId => (slot === 'A' ? 'B' : 'A');
      const host: ViewerHostApi = {
        slot,
        readOnly,
        assets: () => app.assets,
        isHidden: (id) => app.isHidden(id),
        reviewMarks: (a) => app.reviewMarks?.(a) || [],
        open: (t, o) => { void app.open(t, o); },
        openNode: (id) => app.openNode(id),
        inspectNode: (id) => app.inspectNode(id),
        requestReview: (d) => { void app.reviewPrompt(d); },
        setTool: (t) => app.setTool(t),
        setColor: (hex) => app.setColor(hex),
        canvasInfoChanged: (name) => app.inspector?.refreshFor?.({ name }),
        toast: (t, k) => app.toast(t, k),
        peerViewer: () => ((app.slots[other()]?.viewer as LegacyViewer | null)?.inner ?? null),
        notifyPeer: () => {},
        compareStatus: () => {},
        setCompareOverlay: (_m: CompareOverlay) => {},
        togglePinned: (id) => app.togglePinned?.(id),
        toggleHidden: (id) => app.toggleHidden?.(id),
        isPinned: (id) => !!app.isPinned?.(id),
        followMode: () => app.followMode ?? (app.following ? 'canvas' : 'off'),
      };
      this.inner = new Ctor(host);
      this.env = this.readEnv();
    }

    private readEnv(): ViewerEnv {
      const a = this.owner;
      return { tool: a.tool, color: { ...a.color }, reviewMode: a.reviewMode, following: a.following, reviewsRev: this.reviewsRev, assetsRev: 0, compareLink: false, compareOverlay: 'off', peerRev: 0 };
    }
    private pushEnv(): void {
      this.env = this.readEnv();
      if (this.mounted && this.target) void Promise.resolve(this.inner.update({ target: this.target, env: this.env })).catch(() => {});
    }

    async open(target: Target): Promise<void> {
      this.target = target;
      this.env = this.readEnv();
      if (!this.mounted) { this.mounted = true; await this.inner.mount(this.el, { target, env: this.env }); }
      else await this.inner.update({ target, env: this.env });
    }
    onEvent(ev: AnyEvent): void {
      // following can change at any time; refresh it before the viewer decides
      if (this.owner.following !== this.env.following) this.pushEnv();
      this.inner.onEvent?.(ev);
    }
    keydown(e: KeyboardEvent, k: string): boolean { return this.inner.onKey?.(e, k) ?? false; }
    undo(redo: boolean): void { this.inner.undo?.(redo); }
    setToolUI(): void { this.pushEnv(); }
    setColorUI(): void { this.pushEnv(); }
    get view(): { render(): void } { return { render: () => { this.reviewsRev++; this.pushEnv(); } }; }
    destroy(): void { this.inner.destroy(); }
  };
}
