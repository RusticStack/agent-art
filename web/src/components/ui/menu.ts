// Item model shared by Menu (dropdown) and ContextMenu.
import type { IconName } from '@/lib/util/icons';

export interface MenuAction {
  id: string;
  label: string;
  icon?: IconName;
  /** SHORTCUTS-style keys string, shown right-aligned */
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  onselect: () => void;
}
export interface MenuSeparator { separator: true; id: string }
export type MenuItem = MenuAction | MenuSeparator;

export const isSeparator = (m: MenuItem): m is MenuSeparator => 'separator' in m;
