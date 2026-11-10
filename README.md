# GBA Patch & Play

A GBA emulator and ROM patcher in one static page (mGBA compiled to WebAssembly). Bring your own ROM, apply an IPS / BPS / UPS patch in the browser, play on desktop or phone, and carry your save between devices with a short code.

- **No games or patches are hosted here.** ROMs are picked from your disk and stored in this browser's IndexedDB. They are never uploaded. `*.gba` is gitignored on purpose: do not commit a ROM.
- **Patcher** (`patcher.js`): IPS, BPS, UPS (BPS/UPS verify checksums and reject the wrong base ROM), zip support, GBA header detection. xdelta is detected but not supported yet.
- **Saves:** per game, kept in the browser. **Save > Get save code** stores the save in Supabase under a random 10-character code; **Continue** restores it on any device that has the same game. Backups: download/upload `.sav`, or copy/paste the full save text.
- **Mobile:** on-screen pad with sliding d-pad and multitouch, landscape layout, screen wake lock, pauses when the tab is hidden.

## Setup
1. Run `supabase.sql` once in the Supabase SQL editor. The table is closed to direct access; only the `put_save` / `get_save` functions are exposed.
2. `config.js` holds the project URL and publishable key.
3. Serve over HTTPS. `coi-serviceworker.min.js` adds the cross-origin-isolation headers the emulator's threads need (GitHub Pages cannot set headers). The first visit reloads once.

Emulator: `@thenick775/mgba-wasm` (mGBA, MPL-2.0). `coi-serviceworker` (MIT).
