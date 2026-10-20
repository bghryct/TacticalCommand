/* =========================================================================
 * CUSTOM CONTENT — the file editor.html writes
 * =========================================================================
 *
 * This is a placeholder, and it is here so that it is not a 404.
 *
 * `tactical_command.html` and `editor.html` both carry a static
 * `<script src="assets/custom.js">`, and until now that file did not exist, so
 * every load of either page logged a failed request. The module is genuinely
 * optional — `applyCustomContent()` reads `window.TC_CUSTOM` and returns
 * immediately when it is absent — so nothing was broken; it was just noise in
 * the console, in exactly the place a real error would have to be noticed.
 *
 * WHAT REPLACES IT. Open `editor.html`, change unit stats, doodad stats or the
 * terrain texture parameters, press "⬇ Download custom.js", and drop the file
 * it gives you over this one. Its shape is one assignment:
 *
 *     window.TC_CUSTOM = {
 *       units:   { sherman: { hp: 260 }, myNewTank: { hp: 300, kind: 'tank', … } },
 *       doodads: { hedge: { cover: 0.5 } },
 *       texture: { base: 194, contrast: 132, … }
 *     };
 *
 * Units the game already knows are MERGED into; an unknown key carrying at
 * least `hp` and `kind` becomes a brand-new unit type. `localStorage.tc_custom`
 * (the editor's live edits) takes priority over this file when both exist.
 *
 * Leaving `TC_CUSTOM` undefined means "no customisation", which is what this
 * file deliberately does.
 * ====================================================================== */
