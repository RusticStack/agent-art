# Upgrading to 0.7

[Back to the README](../README.md)

Behaviour changes in 0.7.0 that affect agents and saved assets. Later releases list theirs in [CHANGELOG.md](../CHANGELOG.md) under "Intentional default changes".

- **Compact replies:** `art_info` and `art_rig` `info`, `create` and `update` reply with a summary. Rig cells come as `cells.rows` (the y of each view's band) plus `cells.parts` (`[x, w, h]`), so a cell is `[x, rows[view], w, h]`. Pass `full: true` for the old full reply or `fields: [...]` for just those fields.
- **Animation tags:** preset animations are always tagged `<preset>_<view>`: `walk` in the side view is now `walk_side` (it used to be `walk` for the first view).
- **`humanoid_hd`:** the near (`_f`) limbs now sit on the correct screen side in the 3/4, front and back views, and in the front and back views the thighs draw above the pelvis, so renders of non-side views change.
- **`mirror_pairs`:** an arm held by IK on a non-foot end (a weapon grip, a hand on a prop) keeps its side instead of swapping. Set `mirror_hands: true` on a key to swap on purpose.
- **`preview`:** the ground line is drawn at the feet, not at the root.
- **`art_critique`:** HD sprites (64x96 and up) get a 48-128 colour budget instead of 32, and ordered dither there is not flagged as noise. `style` overrides the detection.
- **Material layers:** canvas layers named `height`, `metal` or `rough` are material channels in `art_model` (normal map, metalness, roughness) and no longer show in the base colour. Rename such layers to keep them as paint.
- **Package size:** the npm package grows from about 360 kB to about 770 kB packed (2.6 MB unpacked), because the web UI vendors three.js r170 (MIT).
