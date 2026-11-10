// Pure inspector / review logic (unit-tested): where lines, review_add arguments, meta summary,
// relation rows, the key / value rows of every kind section, and which review actions apply.
import type {
  AudioInfo, CanvasInfo, CanvasMeta, ExportFile, GraphEdge, GraphNodeInfo, ModelInfo, ProjectInfo, Review, ReviewAddArgs,
  ReviewStatus, ReviewTarget, RigInfo, SnapshotMeta,
} from '@/lib/api/types';
import { fmtBytes } from '@/lib/util/format';
import { targetToHash } from '@/lib/util/hash';
import { targetForId } from '@/lib/util/targets';
import type { ReviewDraft } from '@/viewers/types';

export type Row = readonly [string, unknown];

export const BLENDS = ['normal', 'multiply', 'screen', 'add', 'overlay', 'darken', 'lighten', 'soft-light'] as const;
export const REVIEW_CATS: readonly { value: string; label: string }[] = [
  { value: 'fix', label: 'Fix' }, { value: 'redo', label: 'Redo' }, { value: 'inconsistent', label: 'Inconsistent across views' },
  { value: 'layering', label: 'Layering' }, { value: 'style', label: 'Style' }, { value: 'question', label: 'Question' },
  { value: 'approve', label: 'Approve' },
];
export const PRIORITIES = ['low', 'normal', 'high'] as const;
export type Priority = (typeof PRIORITIES)[number];
export const STATUS_LABEL: Record<ReviewStatus, string> = { open: 'open', in_progress: 'in progress', fixed: 'fixed', accepted: 'accepted', reopened: 'reopened' };
export const META_MAX = 4000;
export const RELATIONS_MAX = 40;

const secs = (t: readonly number[]): string => `${t.map((x) => x.toFixed(2)).join('–')} s`;
const joined = (parts: (string | false | undefined | null | 0)[]): string => parts.filter(Boolean).join(' · ');

/** R4: the location line of a review card (legacy order; a point shows as `pin (x,y)`). */
export function whereLine(t: ReviewTarget | null | undefined): string {
  if (!t) return '';
  return joined([
    t.tag && `tag ${t.tag}`, t.frame !== undefined && `frame ${t.frame}`, t.view && `view ${t.view}`, t.layer && `layer ${t.layer}`,
    t.part && `part ${t.part}`, t.time && secs(t.time), t.region && `[${t.region.join(',')}]`, t.point && `pin (${t.point.join(',')})`,
  ]);
}

/** R2: the location line of the review note dialog. */
export function draftWhereLine(d: ReviewDraft): string {
  return joined([
    d.tag && `tag ${d.tag}`, d.frame !== undefined && `frame ${d.frame}`, d.view && `view ${d.view}`, d.layer && `layer ${d.layer}`,
    d.part && `parts ${d.part}`, d.region && `box [${d.region.join(',')}]`, d.point && `pin (${d.point.join(',')})`,
    d.time && secs(d.time), d.where,
  ]);
}

/** R2: preset category: the draft's, else `inconsistent` when a compare target is preset, else `fix`. */
export const defaultCategory = (d: ReviewDraft): string => d.category || (d.compare_with ? 'inconsistent' : 'fix');
export const defaultPriority = (d: ReviewDraft): Priority => (PRIORITIES as readonly string[]).includes(d.priority ?? '') ? (d.priority as Priority) : 'normal';

export interface ReviewForm {
  category: string; priority: string; note: string;
  compareWith: string; compareView: string; compareFrame: string | number | null;
}

const DRAFT_KEYS = ['frame', 'view', 'tag', 'layer', 'part', 'region', 'point', 'time', 'image', 'clip'] as const;

/** R3: op review_add arguments from the draft and the dialog fields. */
export function reviewAddArgs(d: ReviewDraft, f: ReviewForm): ReviewAddArgs {
  const args: ReviewAddArgs = {
    asset: d.asset, category: f.category, priority: f.priority,
    note: (f.note.trim() + (d.where ? ` (at ${d.where})` : '')).trim(),
  };
  const target = args as unknown as Record<string, unknown>;
  for (const k of DRAFT_KEYS) if (d[k] !== undefined) target[k] = d[k];
  const asset = f.compareWith.trim();
  if (asset) {
    const view = f.compareView.trim();
    const frame = f.compareFrame === null || f.compareFrame === undefined ? '' : String(f.compareFrame).trim();
    args.compare_with = { asset, ...(view ? { view } : {}), ...(frame !== '' && Number.isFinite(Number(frame)) ? { frame: Number(frame) } : {}) };
  }
  return args;
}

/** I4: canvas meta as JSON with anchors and the rig object summarised, capped at 4000 chars; null when empty. */
export function metaSummary(meta: CanvasMeta | null | undefined): string | null {
  if (!meta || !Object.keys(meta).length) return null;
  const m: Record<string, unknown> = { ...meta };
  if (meta.anchors) m.anchors = Object.fromEntries(Object.entries(meta.anchors).map(([k, v]) => [k, `${v.length} frames`]));
  if (meta.rig && typeof meta.rig === 'object') m.rig = `rig definition (${Object.keys(meta.rig.parts || {}).length} parts)`;
  return JSON.stringify(m, null, 1).slice(0, META_MAX);
}

export interface RelationRow { dir: 'out' | 'in'; rel: string; other: string; attrs: string; derived: boolean }

/** I12: edges out then in, without layer_of, non-derived first (stable), at most 40 (+ the rest as a count). */
export function relationRows(info: Pick<GraphNodeInfo, 'out' | 'in'> | null | undefined, max = RELATIONS_MAX): { rows: RelationRow[]; more: number; total: number } {
  if (!info) return { rows: [], more: 0, total: 0 };
  const all = [...(info.out || []).map((x) => ({ x, dir: 'out' as const })), ...(info.in || []).map((x) => ({ x, dir: 'in' as const }))]
    .filter(({ x }) => x.rel !== 'layer_of');
  all.sort((a, b) => Number(!b.x.derived) - Number(!a.x.derived));
  const row = ({ x, dir }: { x: GraphEdge; dir: 'out' | 'in' }): RelationRow => ({
    dir, rel: x.rel, other: dir === 'out' ? x.to : x.from, derived: !!x.derived,
    attrs: x.attrs ? ` {${Object.entries(x.attrs).map(([k, v]) => `${k}:${v}`).join(',')}}` : '',
  });
  return { rows: all.slice(0, max).map(row), more: Math.max(0, all.length - max), total: all.length };
}

/** R4: which card actions a review shows. */
export function reviewActions(r: Pick<Review, 'status' | 'compare_with'>): { show: true; sideBySide: boolean; accept: boolean; reopen: boolean; del: true } {
  return { show: true, sideBySide: !!r.compare_with, accept: r.status === 'fixed', reopen: r.status === 'fixed' || r.status === 'accepted', del: true };
}

/** R4: the last reply and the last 3 history images with their captions. */
export function reviewExtras(r: Pick<Review, 'history'>): { reply: string | null; images: { img: string; caption: string }[] } {
  const hist = r.history || [];
  const last = [...hist].reverse().find((h) => h.reply);
  const imgs = hist.filter((h) => h.img);
  const images = imgs.slice(-3).map((h, i) => ({ img: h.img as string, caption: i === 0 && imgs.length > 1 ? 'noted' : h.status || 'v' + (h.version ?? '') }));
  return { reply: last ? `${last.by}: ${last.reply}` : null, images };
}

export const isActive = (s: string): boolean => s === 'open' || s === 'in_progress' || s === 'reopened';

// ---------- kind sections (I4..I10) ----------

export function canvasRows(i: CanvasInfo): Row[] {
  return [
    ['size', `${i.width}×${i.frameHeight || i.height}`], ['frames', i.frames > 1 ? i.frames : ''], ['layers', i.layers.length],
    ['colours', i.colors?.unique], ['project', i.project], ['undo / redo', `${i.undo} / ${i.redo}`], ['version', i.version],
  ];
}

export interface SwatchSpec { color: string; title: string; key?: string }
/** Inherited + own palette (own keys win), then the used colours. */
export function paletteSwatches(i: Pick<CanvasInfo, 'palette' | 'inheritedPalette'>): SwatchSpec[] {
  return Object.entries({ ...(i.inheritedPalette || {}), ...(i.palette || {}) }).map(([k, v]) => ({ color: v, title: `${k}  ${v}`, key: k }));
}
export function usedSwatches(i: Pick<CanvasInfo, 'colors'>): SwatchSpec[] {
  return (i.colors?.top || []).map(({ color, count }) => ({ color, title: `${color} · ${count} px` }));
}
/** A palette key short enough to print on the swatch. */
export const swatchKey = (key: string | undefined): string | null => (key && [...key].length <= 2 ? key : null);

export function animChips(i: Pick<CanvasInfo, 'animations'>): { tag: string; label: string; title: string }[] {
  return Object.entries(i.animations || {}).map(([t, a]) => ({
    tag: t, label: `${t} · ${a.frames.length}f`, title: `${a.durations.reduce((x, y) => x + y, 0)} ms${a.loop === false ? ', no loop' : ''}`,
  }));
}

/** Preview scales: the big one fits 128 px, the small one is a quarter of it (both at least 1). */
export function previewScales(w: number, fh: number): { small: number; big: number } {
  const big = Math.max(1, Math.floor(128 / Math.max(w, fh, 1)));
  return { small: Math.max(1, Math.floor(big / 4)), big };
}

export function snapshotRows(name: string, m: SnapshotMeta | null): Row[] {
  return [['canvas', name], ['version', m?.version], ['size', m ? `${m.width}×${m.height}` : 'expired'], ['frames', m?.frames]];
}

const nameOf = (x: { name: string } | string): string => (typeof x === 'string' ? x : x.name || String(x));

export function modelRows(i: ModelInfo): Row[] {
  return [
    ['triangles', i.triangles], ['parts', i.parts_def?.length], ['materials', (i.materials || []).join(', ')],
    ['size (units)', i.size_units?.join(' × ')], ['size (cells)', i.size_cells?.join(' × ')],
    ['origin', typeof i.origin === 'string' ? i.origin : JSON.stringify(i.origin)], ['template', i.template],
  ];
}
export function modelRigRows(r: NonNullable<ModelInfo['rig']>): Row[] {
  return [
    ['nodes', (r.nodes || []).map(nameOf).join(', ')], ['sockets', (r.sockets || []).map(nameOf).join(', ')],
    ['poses', Array.isArray(r.poses) ? r.poses.join(', ') : undefined], ['clips', Array.isArray(r.clips) ? r.clips.map(nameOf).join(', ') : undefined],
  ];
}

export function rigRows(r: RigInfo): Row[] {
  return [
    ['frame', r.frame?.join('×')], ['views', r.views?.join(', ')], ['mirrored', Object.keys(r.mirror || {}).join(', ')],
    ['sampling', r.sampling], ['root', r.root?.join(', ')],
  ];
}
export function rigPartChips(r: RigInfo): string[] {
  return Object.entries(r.parts || {}).map(([n, p]) => `${n}${p.parent ? ` ← ${p.parent}` : ''} · z${p.z ?? 0}`);
}

export function audioRows(a: AudioInfo): Row[] {
  const s = a.stats || {};
  return [
    ['kind', a.kind], ['recipe', a.recipe], ['seed', a.seed], ['duration', s.duration !== undefined ? `${s.duration} s` : ''],
    ['loudness', s.lufs !== undefined ? `${s.lufs} LUFS` : ''], ['peak', s.peak_dbfs !== undefined ? `${s.peak_dbfs} dBFS` : ''],
    ['score', s.score], ['issues', (s.issues || []).join(', ')], ['intent', a.intent], ['genre', a.genre],
  ];
}

export function projectRows(p: ProjectInfo): Row[] {
  return [['canvases', p.canvases.length], ['description', p.description], ['minecraft', p.meta?.minecraft]];
}

export function exportRows(path: string, f: ExportFile | undefined): Row[] {
  return [['path', path], ['size', f ? fmtBytes(f.size) : ''], ['modified', f ? new Date(f.mtime).toLocaleString() : '']];
}

/** "data:" src for an attached crop (the model viewer sends a data URL; accept bare base64 too). */
export const imageSrc = (image: string): string => (image.startsWith('data:') ? image : `data:image/png;base64,${image}`);

/** href of a link that opens an asset id (the click handler navigates; this keeps a real deep link). */
export function linkHash(id: string): string {
  const t = targetForId(id);
  const h = t.kind === 'graph' && 'focus' in t && t.focus ? 'graph' : targetToHash(t);
  return '#' + (h ?? '');
}
