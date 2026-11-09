// Asset kinds: glyphs (drawn with fillText on 2D canvases), colours and labels, plus the SVG icon name
// used by the DOM.
import type { IconName } from './icons';

export const KIND_ICON: Record<string, string> = { canvas: '▦', layer: '≡', anim: '▶', frame: '▫', rig: '☍', rigpart: '◌', model: '◆', modelpart: '◇', palette: '◍', audio: '♪', export: '⤓', project: '▣', group: '◎', file: '▤', graph: '⬡' };
export const KIND_COLOR: Record<string, string> = { canvas: '#38bdf8', layer: '#64748b', anim: '#a78bfa', frame: '#64748b', rig: '#f472b6', rigpart: '#f9a8d4', model: '#f5a524', modelpart: '#fcd34d', palette: '#22c55e', audio: '#2dd4bf', export: '#94a3b8', project: '#e5484d', group: '#c084fc', file: '#94a3b8', graph: '#c084fc' };
export const KIND_LABEL: Record<string, string> = { canvas: 'canvas', layer: 'layer', anim: 'animation', frame: 'frame', rig: 'rig', rigpart: 'rig part', model: '3D model', modelpart: 'model part', palette: 'palette', audio: 'audio', export: 'export', project: 'project', group: 'group', file: 'folder', graph: 'asset graph' };
export const KIND_ICON_NAME: Record<string, IconName> = { canvas: 'image', layer: 'layers', anim: 'film', frame: 'frame', rig: 'bone', rigpart: 'puzzle', model: 'box', modelpart: 'boxes', palette: 'palette', audio: 'music', export: 'package', project: 'folder-kanban', group: 'group', file: 'file', graph: 'waypoints' };
export const kindColor = (k: string): string => KIND_COLOR[k] ?? '#94a3b8';
