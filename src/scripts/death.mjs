/**
 * PF1 Improved Energy Drain — death check.
 *
 * A creature whose negative levels equal or exceed its Hit Dice dies. On the
 * active GM, whenever an actor's total might have changed, apply the `dead`
 * condition (once, on crossing the threshold) and post a notice. Removing the
 * levels does not auto-revive — that is left to the GM.
 */

import { MODULE_ID, isActiveGM } from "./common.mjs";
import { deriveTotal } from "./instances.mjs";

async function checkDeath(actor) {
  if (!isActiveGM()) return;
  const hd = actor?.system?.attributes?.hd?.total;
  if (!hd) return; // no Hit Dice recorded → skip
  if (actor.statuses?.has?.("dead")) return;

  const total = deriveTotal(actor);
  if (total < hd) return;

  try {
    await actor.setCondition("dead", true);
  } catch (err) {
    console.error(`${MODULE_ID} | failed to apply dead condition`, err);
  }
  const message = game.i18n.format("IED.Death.Message", {
    actor: `<strong>${foundry.utils.escapeHTML(actor.name)}</strong>`,
    total,
    hd,
  });
  ChatMessage.create({
    content: `<div class="pf1-ied-card pf1-ied-fail">
      <p><i class="fa-solid fa-skull-crossbones"></i> ${message}</p>
    </div>`,
    speaker: ChatMessage.getSpeaker({ actor }),
  });
}

Hooks.on("updateActor", (actor) => checkDeath(actor));
Hooks.on("createItem", (item) => item.actor && checkDeath(item.actor));
Hooks.on("updateItem", (item) => item.actor && checkDeath(item.actor));
Hooks.on("deleteItem", (item) => item.actor && checkDeath(item.actor));
