/**
 * PF1 Improved Energy Drain — static-level item control.
 *
 * Adds an "enable + amount" control to the item sheet's Details tab, appended
 * after the creature-type section (the last base-game block, shared by
 * equipment / feat / buff / class / race / weapon). The item then confers that
 * many *static* negative levels while it is active — equipped for equipment,
 * enabled/active for features and buffs (see `item.isActive`).
 *
 * The section is collapsible so it costs one header row on the vast majority of
 * items that never confer negative levels. Its skull icon doubles as the
 * disclosure control — full strength when open, dimmed when closed — matching
 * the section headers astora-mod and pf1-defense-manager inject nearby. It
 * opens by default only when the item is actually configured; a per-sheet memo
 * keeps the user's choice across the re-render each flag write triggers.
 *
 * The inputs carry `flags.<module>.*` names, so the system's own V1 item sheet
 * persists them on change; no manual submit handling is needed. The actor
 * re-derives its total whenever an embedded item updates.
 */

import { FLAG_STATIC, FLAG_STATIC_ENABLED, MODULE_ID } from "./common.mjs";

const MARK = "ied-static-control";

/**
 * Expanded state per open sheet, keyed by `app.appId`. Undefined means "no
 * choice made yet", which falls back to the configured-or-not default.
 *
 * @type {Map<number, boolean>}
 */
const expandedByApp = new Map();

/**
 * @param {HTMLElement} section
 * @param {boolean} expanded
 */
function applyExpanded(section, expanded) {
  section.dataset.iedExpanded = expanded ? "true" : "false";
  section.classList.toggle(`${MARK}-collapsed`, !expanded);
  const body = section.querySelector(`.${MARK}-body`);
  if (body) body.style.display = expanded ? "" : "none";
}

/**
 * @param {ItemSheet} app
 * @param {JQuery|HTMLElement} html
 */
function onRenderItemSheet(app, html) {
  const item = app.item ?? app.object;
  if (!item) return;

  const root = html instanceof jQuery ? html[0] : html;
  if (root.querySelector(`.${MARK}`)) return; // already injected this render

  // Anchor after the creature-type section on the Details tab.
  const anchors = root.querySelectorAll(".form-group.creature-sub-type, .form-group.creature-type");
  const anchor = anchors[anchors.length - 1];
  if (!anchor) return;

  const enabled = !!item.getFlag(MODULE_ID, FLAG_STATIC_ENABLED);
  const amount = Number(item.getFlag(MODULE_ID, FLAG_STATIC) ?? 0);
  const configured = enabled || amount > 0;
  const expanded = expandedByApp.get(app.appId) ?? configured;

  const label = game.i18n.localize("PF1.NegativeLevels");
  // Collapsed rows still need to advertise a configured value, or the section
  // reads as empty on exactly the items where it matters.
  const badge = configured ? `<span class="${MARK}-badge">${amount}</span>` : "";

  const section = document.createElement("div");
  section.className = `${MARK} ${MARK}-section`;
  section.innerHTML = `
    <h3 class="form-header ${MARK}-header" title="${game.i18n.localize("IED.Item.ToggleSection")}">
      <i class="fa-solid fa-skull"></i>
      <span>${label}</span>
      ${badge}
    </h3>
    <div class="${MARK}-body">
      <div class="form-group">
        <label>${label}</label>
        <div class="form-fields">
          <label class="checkbox">
            <input type="checkbox" name="flags.${MODULE_ID}.${FLAG_STATIC_ENABLED}" ${enabled ? "checked" : ""}>
          </label>
          <input type="number" name="flags.${MODULE_ID}.${FLAG_STATIC}"
            value="${amount}" min="0" step="1" data-dtype="Number"
            placeholder="0" style="flex: 0 0 4em;">
        </div>
        <p class="notes">${game.i18n.localize("IED.Item.StaticNote")}</p>
      </div>
    </div>
  `;

  applyExpanded(section, expanded);

  section.querySelector(`.${MARK}-header`).addEventListener("click", (event) => {
    if (event.target.closest("a, button, input, select")) return;
    event.preventDefault();
    event.stopPropagation();
    const next = section.dataset.iedExpanded !== "true";
    expandedByApp.set(app.appId, next);
    applyExpanded(section, next);
  });

  anchor.after(section);
}

Hooks.on("renderItemSheetPF", onRenderItemSheet);
Hooks.on("renderItemSheetPF_Container", onRenderItemSheet);
Hooks.on("closeItemSheetPF", (app) => expandedByApp.delete(app.appId));
Hooks.on("closeItemSheetPF_Container", (app) => expandedByApp.delete(app.appId));
