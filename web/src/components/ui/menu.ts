// Item model shared by Menu (dropdown), ContextMenu and the top bar's OverflowMenu (both via PopupMenu).
import type { IconName } from '@/lib/util/icons';

export interface MenuAction {
  id: string;
  label: string;
  icon?: IconName;
  /** SHORTCUTS-style keys string, shown right-aligned */
  shortcut?: string;
  disabled?: boolean;
  danger?: boolean;
  /** a toggle (menuitemcheckbox) or, with `radio`, one choice of a group (menuitemradio); undefined = a plain item */
  checked?: boolean;
  radio?: boolean;
  /** a short count shown as a badge after the label (e.g. open review notes); '' or 0 hides it */
  badge?: string | number;
  onselect: () => void;
}
export interface MenuSeparator { separator: true; id: string }
export type MenuItem = MenuAction | MenuSeparator;

export const isSeparator = (m: MenuItem): m is MenuSeparator => 'separator' in m;

/** The ARIA role of an item: menuitem, menuitemcheckbox (a toggle) or menuitemradio (one of a group). */
export const itemRole = (m: MenuAction): 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' =>
  m.checked === undefined ? 'menuitem' : m.radio ? 'menuitemradio' : 'menuitemcheckbox';
