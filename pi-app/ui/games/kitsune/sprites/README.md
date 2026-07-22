# Farm animal sprites

Drop your animal art in this folder. The game (`../index.html`) loads them
automatically — no code changes needed.

## Naming

For each animal listed in `manifest.json`, add a file named `<id>.png`:

```
sprites/
  fox.png
  cat.png
  chicken.png
  duck.png
  rabbit.png
  sheep.png
  pig.png
  cow.png
```

- **Top-down view** looks best (it's a top-down farm), facing right or
  downward. The game flips the sprite horizontally as the animal walks.
- **~128×128 px**, **transparent background** (PNG). Bigger is fine; it's
  scaled down.
- If a sprite file is missing, that animal shows a soft colored placeholder
  (using the `color` in the manifest) with its first letter, so the game
  still works before all the art is in.

## Adding / changing animals

Edit `manifest.json`:

- `id` — must match the PNG filename (`fox` → `fox.png`).
- `name` — shown in the shop and as the default pet name.
- `price` — coins to buy one in the shop (`0` = free/starter).
- `rarity` — `common` or `uncommon`; affects how often it appears as a
  random wild critter (`common` shows up more).
- `coinsPerMin` — how many coins a well-cared animal earns per minute.
- `color` — placeholder tint (also used for a soft glow behind the sprite).

Use real `.png` files. (For animated sprites / spritesheets, let me know and
I'll add frame-based animation support.)
