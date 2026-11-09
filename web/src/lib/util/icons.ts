/*! Icons: Lucide, ISC License, https://lucide.dev */
// Raw SVG strings of the Lucide icons the UI uses, imported one by one (never the whole set).
// They are build-time constants: the only content ever rendered with {@html} / innerHTML.
import panelLeft from 'lucide-static/icons/panel-left.svg?raw';
import panelRight from 'lucide-static/icons/panel-right.svg?raw';
import circleDot from 'lucide-static/icons/circle-dot.svg?raw';
import circle from 'lucide-static/icons/circle.svg?raw';
import columns2 from 'lucide-static/icons/columns-2.svg?raw';
import flag from 'lucide-static/icons/flag.svg?raw';
import messageSquare from 'lucide-static/icons/message-square.svg?raw';
import waypoints from 'lucide-static/icons/waypoints.svg?raw';
import trash2 from 'lucide-static/icons/trash-2.svg?raw';
import circleHelp from 'lucide-static/icons/circle-help.svg?raw';
import arrowUpDown from 'lucide-static/icons/arrow-up-down.svg?raw';
import arrowLeftRight from 'lucide-static/icons/arrow-left-right.svg?raw';
import x from 'lucide-static/icons/x.svg?raw';
import star from 'lucide-static/icons/star.svg?raw';
import eyeOff from 'lucide-static/icons/eye-off.svg?raw';
import eye from 'lucide-static/icons/eye.svg?raw';
import scanEye from 'lucide-static/icons/scan-eye.svg?raw';
import squareCheck from 'lucide-static/icons/square-check.svg?raw';
import plus from 'lucide-static/icons/plus.svg?raw';
import search from 'lucide-static/icons/search.svg?raw';
import chevronRight from 'lucide-static/icons/chevron-right.svg?raw';
import pencil from 'lucide-static/icons/pencil.svg?raw';
import eraser from 'lucide-static/icons/eraser.svg?raw';
import paintBucket from 'lucide-static/icons/paint-bucket.svg?raw';
import slash from 'lucide-static/icons/slash.svg?raw';
import square from 'lucide-static/icons/square.svg?raw';
import pipette from 'lucide-static/icons/pipette.svg?raw';
import hand from 'lucide-static/icons/hand.svg?raw';
import undo2 from 'lucide-static/icons/undo-2.svg?raw';
import redo2 from 'lucide-static/icons/redo-2.svg?raw';
import zoomIn from 'lucide-static/icons/zoom-in.svg?raw';
import zoomOut from 'lucide-static/icons/zoom-out.svg?raw';
import maximize from 'lucide-static/icons/maximize.svg?raw';
import play from 'lucide-static/icons/play.svg?raw';
import pause from 'lucide-static/icons/pause.svg?raw';
import download from 'lucide-static/icons/download.svg?raw';
import check from 'lucide-static/icons/check.svg?raw';
import triangleAlert from 'lucide-static/icons/triangle-alert.svg?raw';
import circleAlert from 'lucide-static/icons/circle-alert.svg?raw';
import rotateCcw from 'lucide-static/icons/rotate-ccw.svg?raw';
import image from 'lucide-static/icons/image.svg?raw';
import layers from 'lucide-static/icons/layers.svg?raw';
import film from 'lucide-static/icons/film.svg?raw';
import frame from 'lucide-static/icons/frame.svg?raw';
import bone from 'lucide-static/icons/bone.svg?raw';
import puzzle from 'lucide-static/icons/puzzle.svg?raw';
import box from 'lucide-static/icons/box.svg?raw';
import boxes from 'lucide-static/icons/boxes.svg?raw';
import palette from 'lucide-static/icons/palette.svg?raw';
import music from 'lucide-static/icons/music.svg?raw';
import pkg from 'lucide-static/icons/package.svg?raw';
import folderKanban from 'lucide-static/icons/folder-kanban.svg?raw';
import group from 'lucide-static/icons/group.svg?raw';
import file from 'lucide-static/icons/file.svg?raw';
import sun from 'lucide-static/icons/sun.svg?raw';
import ellipsis from 'lucide-static/icons/ellipsis.svg?raw';
import copy from 'lucide-static/icons/copy.svg?raw';
import skipBack from 'lucide-static/icons/skip-back.svg?raw';
import skipForward from 'lucide-static/icons/skip-forward.svg?raw';
import chevronLeft from 'lucide-static/icons/chevron-left.svg?raw';

const RAW = {
  'panel-left': panelLeft, 'panel-right': panelRight, 'circle-dot': circleDot, circle, 'columns-2': columns2, flag,
  'message-square': messageSquare, waypoints, 'trash-2': trash2, 'circle-help': circleHelp, 'arrow-up-down': arrowUpDown,
  'arrow-left-right': arrowLeftRight, x, star, 'eye-off': eyeOff, eye, 'scan-eye': scanEye, 'square-check': squareCheck,
  plus, search, 'chevron-right': chevronRight, pencil, eraser, 'paint-bucket': paintBucket, slash, square, pipette, hand,
  'undo-2': undo2, 'redo-2': redo2, 'zoom-in': zoomIn, 'zoom-out': zoomOut, maximize, play, pause, download, check,
  'triangle-alert': triangleAlert, 'circle-alert': circleAlert, 'rotate-ccw': rotateCcw, image, layers, film, frame, bone,
  puzzle, box, boxes, palette, music, package: pkg, 'folder-kanban': folderKanban, group, file, sun, ellipsis, copy,
  'skip-back': skipBack, 'skip-forward': skipForward, 'chevron-left': chevronLeft,
} as const;

export type IconName = keyof typeof RAW;
/** The licence comment of each file is replaced by the banner above; whitespace is collapsed. */
const clean = (s: string) => s.replace(/<!--[\s\S]*?-->/, '').replace(/\n\s*/g, ' ').replace(/\s+>/g, '>').trim();
export const ICONS = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, clean(v)])) as Record<IconName, string>;
