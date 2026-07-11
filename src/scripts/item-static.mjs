/**
 * PF1 Improved Energy Drain — static-level item control.
 *
 * Adds an "enable + amount" control to the item sheet's Details tab, appended
 * after the creature-type section (the last base-game block, shared by
 * equipment / feat / buff / class / race / weapon). The item then confers that
 * many *static* negative levels while it is active — equipped for equipment,
 * enabled/active for features and buffs (see `item.isActive`).
 *
 * The inputs carry `flags.<module>.*` names, so the system's own V1 item sheet
 * persists them on change; no manual submit handling is needed. The actor
 * re-derives its total whenever an embedded item updates.
 */

import { FLAG_STATIC, FLAG_STATIC_ENABLED, MODULE_ID } from "./common.mjs";

const MARK = "ied-static-control";

/**
 * @param {ItemSheet} app
 * @param {JQuery|HTMLElement} html
 */
function onRenderItemSheet(app, html) {
  const item = app.item ?? app.object;
  if (!item) return;

  const $html = html instanceof jQuery ? html : $(html);
  if ($html.find(`.${MARK}`).length) return; // already injected this render

  // Anchor after the creature-type section on the Details tab.
  const anchor =
    $html.find(".form-group.creature-sub-type").last().get(0) ??
    $html.find(".form-group.creature-type").last().get(0);
  if (!anchor) return;

  const enabled = item.getFlag(MODULE_ID, FLAG_STATIC_ENABLED) ? "checked" : "";
  const amount = Number(item.getFlag(MODULE_ID, FLAG_STATIC) ?? 0);

  const block = $(`
    <h3 class="form-header ${MARK}">${game.i18n.localize("PF1.NegativeLevels")}</h3>
    <div class="form-group ${MARK}">
      <label>${game.i18n.localize("PF1.NegativeLevels")}</label>
      <div class="form-fields">
        <label class="checkbox">
          <input type="checkbox" name="flags.${MODULE_ID}.${FLAG_STATIC_ENABLED}" ${enabled}>
        </label>
        <input type="number" name="flags.${MODULE_ID}.${FLAG_STATIC}"
          value="${amount}" min="0" step="1" data-dtype="Number"
          placeholder="0" style="flex: 0 0 4em;">
      </div>
      <p class="notes">${game.i18n.localize("IED.Item.StaticNote")}</p>
    </div>
  `);

  $(anchor).after(block);
}

Hooks.on("renderItemSheetPF", onRenderItemSheet);
Hooks.on("renderItemSheetPF_Container", onRenderItemSheet);
