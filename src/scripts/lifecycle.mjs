/**
 * PF1 Improved Energy Drain — lifecycle engine.
 *
 * Drives the time-based transitions, on the active GM only:
 *   - Temporary instances are pruned once world time passes their `expires`.
 *   - Bestowed instances trigger their Fortitude save once world time passes
 *     `saveDue` (see save-card.mjs); success removes them, failure converts
 *     them to permanent.
 *
 * The checks are `now >= threshold`, so a large time jump (the GM advancing
 * days at once) resolves everything due in a single pass. Runs on every
 * `updateWorldTime` and once at `ready` to catch up on time elapsed while the
 * world was closed.
 */

import { isActiveGM } from "./common.mjs";
import { mutate, useAlternateRules } from "./energy-drain.mjs";
import { readInstances } from "./instances.mjs";
import { promptBestowedSave, promptHouseRuleSave } from "./save-card.mjs";

/**
 * Every actor that might carry instances: world actors plus any token actors
 * on the canvas (covers unlinked NPCs on the active scene).
 *
 * @returns {Set<Actor>}
 */
function collectActors() {
  const actors = new Set(game.actors);
  for (const token of canvas?.tokens?.placeables ?? []) {
    if (token.actor) actors.add(token.actor);
  }
  return actors;
}

/**
 * @param {Actor} actor
 * @param {number} at - Current world time (seconds).
 */
function processActor(actor, at, rawMode) {
  const list = readInstances(actor);
  if (!list.length) return;

  // Temporary levels always expire, regardless of recovery mode.
  if (list.some((i) => i.kind === "temporary" && at >= i.expires)) {
    mutate(actor, "pruneExpired", { at });
  }

  // Standard rules only: prompt the per-level save once a bestowal is due.
  // (The alternate rules recover on rest instead — see the rest hooks below.)
  if (!rawMode) return;
  for (const inst of list) {
    if (inst.kind === "bestowed" && inst.dc != null && at >= inst.saveDue) {
      promptBestowedSave(actor, inst);
    }
  }
}

function processAll() {
  if (!isActiveGM()) return;
  const at = game.time.worldTime;
  const rawMode = !useAlternateRules();
  for (const actor of collectActors()) processActor(actor, at, rawMode);
}

Hooks.on("updateWorldTime", processAll);
Hooks.once("ready", processAll);

/**
 * House-rule recovery: on a full rest (once per day), roll one Fortitude save to
 * shed a negative level.
 *
 * Detected on the **active GM** from the rest's update context (PF1 stamps
 * `options.pf1.action = "rest"` on the actor and item updates it makes, and the
 * context is broadcast to every client). Handling it GM-side — rather than via
 * the local `pf1ActorRest` hook on the resting client — lets the GM create the
 * roll-request even when a *player* initiated the rest (`createRequest` is
 * GM-only). A rest can touch both the actor and its spell items, so a short
 * debounce keeps it to one save per rest.
 */
const restDebounce = new Set();

function onRestDetected(actor) {
  if (!actor || restDebounce.has(actor.id)) return;
  restDebounce.add(actor.id);
  setTimeout(() => restDebounce.delete(actor.id), 500);
  promptHouseRuleSave(actor);
}

function isFullRest(options) {
  return options?.pf1?.action === "rest" && !!options.pf1.restOptions?.restoreDailyUses;
}

Hooks.on("updateActor", (actor, changed, options) => {
  if (!isActiveGM() || !useAlternateRules()) return;
  if (isFullRest(options)) onRestDetected(actor);
});

Hooks.on("updateItem", (item, changed, options) => {
  if (!isActiveGM() || !useAlternateRules()) return;
  if (isFullRest(options)) onRestDetected(item.actor);
});
