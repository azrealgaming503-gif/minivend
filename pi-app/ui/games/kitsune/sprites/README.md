# Farm animal sprites

Animated top-down pixel sprites (CraftPix "Top-Down Hunt Animals" pack).
The game (`../index.html`) loads them automatically from `manifest.json`.

## Format

Each animal has two spritesheets:

```
sprites/
  fox_walk.png   fox_idle.png
  hare_walk.png  hare_idle.png
  ...
```

- Each sheet is a **grid of 32×32 frames**.
- **Rows = directions**, in this order (top to bottom):
  `0 = down (front)`, `1 = up (back)`, `2 = left`, `3 = right`.
- **Columns = animation frames.** Set the count per animal in the manifest
  (`walkCols`, `idleCols`).
- Sheets are drawn with nearest-neighbor scaling (crisp pixels) and a soft
  drop shadow blob is added by the game, so use the **Without_shadow** art.

## manifest.json fields

- `frame` — pixel size of one cell (32).
- `rows` — which row index is which direction (leave as-is unless your art
  uses a different order).
- `id` — matches the file prefix (`fox` → `fox_walk.png` / `fox_idle.png`).
- `name` — shown in the shop / as the default pet name.
- `price` — coins to buy in the shop (`0` = free starter).
- `rarity` — `common` (shows up ~3× as often as a wild critter) or `uncommon`.
- `coinsPerMin` — coins a well-cared animal earns per minute.
- `color` — placeholder tint + soft glow behind the sprite.
- `walkCols` / `idleCols` — number of animation frames in each sheet.

If a sheet is missing, that animal shows a colored placeholder with its first
letter, so the game still runs. To add a brand-new animal, drop its two PNGs
in and add a matching entry here.
