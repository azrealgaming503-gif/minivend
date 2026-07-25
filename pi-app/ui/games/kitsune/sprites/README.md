# Farm sprites

Animated top-down pixel sprites plus a few farm props. Hunt animals come from
CraftPix "Top-Down Hunt Animals"; the farm animals, grass, water ripple and
buildings come from CraftPix "Top-Down Farm with Animals". The game
(`../index.html`) loads the animals automatically from `manifest.json`.

## Animal spritesheets

Each animal has two spritesheets:

```
sprites/
  fox_walk.png      fox_idle.png       chicken_walk.png  chicken_idle.png
  hare_walk.png     hare_idle.png      pig_walk.png      pig_idle.png
  grouse_walk.png   grouse_idle.png    cow_walk.png      cow_idle.png
  deer_walk.png     deer_idle.png      boar_walk.png     boar_idle.png
```

- Each sheet is a **grid of square frames** (hunt animals are 32×32; the cow is
  64×64). The engine scales the whole sheet, so cell size can differ per animal
  as long as cells are square.
- **Rows = directions**, in this order (top to bottom):
  `0 = down (front)`, `1 = up (back)`, `2 = left`, `3 = right`.
- **Columns = animation frames.** Set the count per animal in the manifest
  (`walkCols`, `idleCols`).
- Sheets are drawn with nearest-neighbor scaling (crisp pixels) and a soft
  drop shadow blob is added by the game, so use the **Without_shadow** art.

The farm animals were repacked from the source pack (which stores columns =
direction, rows = frames) into this row = direction layout with
`scripts/_tmp_repack.ps1` (kept in git history for reference).

## manifest.json fields

- `frame` — default cell size hint (32); cows use 64px art but render the same.
- `rows` — which row index is which direction (leave as-is unless your art
  uses a different order).
- `id` — matches the file prefix (`fox` → `fox_walk.png` / `fox_idle.png`).
- `name` — shown in the shop / as the default pet name.
- `price` — coins to buy in the shop (`0` = free starter).
- `rarity` — `common` (shows up ~3× as often as a wild critter) or `uncommon`.
- `coinsPerMin` — coins a well-cared animal earns per minute.
- `color` — placeholder tint + soft glow behind the sprite.
- `walkCols` / `idleCols` — number of animation frames in each sheet.
- `scale` — optional on-field size multiplier (default `1`; e.g. `0.7` = 70%,
  `2` = 200%). Only affects the animal roaming the farm, not the shop tile.

If a sheet is missing, that animal shows a colored placeholder with its first
letter, so the game still runs. To add a brand-new animal, drop its two PNGs
in and add a matching entry here.

## Props (not in the manifest)

These are referenced directly by the game, not the manifest:

- `grass.png` — 32×32 tile used as the field background (tiled at 2×).
- `pond_ripple.png` — 64×64 ripple overlay that drifts across the pond.
- `fish_splash.png` — 9-frame (32px) leap/splash strip; a fish occasionally
  jumps in the pond.
- `barn.png`, `feed_trough.png`, `water_trough.png` — purchasable structures.
  The barn adds animal capacity; tapping the feed/water troughs feeds/waters
  every animal at once. The troughs sit to either side of the barn
  (`STRUCT_LAYOUT` in `../index.html`).
- `dirt.png` — 48×48 soil fill tile. Tiled inside a soft-edged ellipse to
  form the dirt "farmyard" the barn + troughs stand on (`.f-yard`).
- `tree1.png`, `tree2.png`, `bush.png` — larger scenery scattered around the
  field edges (`DECOR` list in `../index.html`).
- `tuft.png`, `tuft2.png`, `pebble.png` — small ground detail (grass tufts,
  grass blades, dirt/pebble clumps) scattered over the grass to add terrain
  texture. Placement is the `GROUND` list in `../index.html`; they render in
  the `#ground` layer beneath everything else.
