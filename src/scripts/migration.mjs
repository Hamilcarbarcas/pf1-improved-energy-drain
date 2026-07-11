/**
 * PF1 Improved Energy Drain — one-time migration.
 *
 * Because the module now *derives* `system.attributes.energyDrain` from tracked
 * instances, an actor's previously hand-entered value would otherwise read as 0.
 * This settings-menu button converts each world actor's stored value into a
 * single permanent negative-level entry (and zeroes the now-owned field). Actors
 * that already have tracked instances are skipped.
 */

import { FLAG_INSTANCES, MODULE_ID } from "./common.mjs";
import { makeInstance } from "./instances.mjs";

async function runMigration() {
  let migrated = 0;
  for (const actor of game.actors) {
    const stored = Number(foundry.utils.getProperty(actor._source, "system.attributes.energyDrain")) || 0;
    if (stored <= 0) continue;
    if ((actor.getFlag(MODULE_ID, FLAG_INSTANCES) ?? []).length) continue;

    const inst = makeInstance({
      kind: "permanent",
      amount: stored,
      name: game.i18n.localize("IED.Migration.SourceName"),
    });
    await actor.update({
      [`flags.${MODULE_ID}.${FLAG_INSTANCES}`]: [inst],
      "system.attributes.energyDrain": 0,
    });
    migrated++;
  }
  ui.notifications.info(game.i18n.format("IED.Migration.Done", { count: migrated }));
}

/** Settings-menu entry: confirm, then run — no window of its own. */
class MigrationMenu extends foundry.applications.api.ApplicationV2 {
  static DEFAULT_OPTIONS = { id: "ied-migration", tag: "div" };

  /** @override */
  async render() {
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: {
        title: game.i18n.localize("IED.Migration.Title"),
        icon: "fa-solid fa-arrow-right-arrow-left",
      },
      content: `<p>${game.i18n.localize("IED.Migration.Prompt")}</p>`,
      classes: ["pf1-v2"],
      modal: true,
      rejectClose: false,
    });
    if (ok) await runMigration();
    return this;
  }
}

Hooks.once("init", () => {
  game.settings.registerMenu(MODULE_ID, "migrate", {
    name: "IED.Migration.MenuName",
    label: "IED.Migration.MenuLabel",
    hint: "IED.Migration.MenuHint",
    icon: "fa-solid fa-arrow-right-arrow-left",
    type: MigrationMenu,
    restricted: true,
  });
});
