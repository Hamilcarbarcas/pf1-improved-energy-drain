/**
 * PF1 Improved Energy Drain — Fortitude saves against bestowed levels.
 *
 * Two recovery models, chosen by the "Alternate energy drain rules" setting:
 *
 *  - **Standard (raw):** 24h after a bestowal (driven by the lifecycle engine),
 *    the creature rolls **one save per level**. Each success removes a level;
 *    each failure converts a level to permanent. The save uses pf1-roll-requests
 *    when present (single-level bestowals get a targeted request card), else a
 *    built-in card that rolls every level on click.
 *
 *  - **House rule:** triggered on a full rest (once per day). One Fortitude save
 *    at the **lowest** DC among the creature's bestowed levels; success removes a
 *    single level from that source. Nothing ever becomes permanent. Rolled
 *    directly on the resting owner's client.
 *
 * NPC saves skip the situational dialog; player-owned saves show it.
 */

import { MODULE_ID, resolveActor } from "./common.mjs";
import { mutate } from "./energy-drain.mjs";
import { readInstances } from "./instances.mjs";

const ROLL_REQUESTS_ID = "pf1-roll-requests";

/** Escape user-controlled text before inserting it into chat-card HTML. */
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));

/** Instance ids with a standard save outstanding (dedupe re-prompts). */
const pendingSaves = new Set();
/** Chat message ids whose save button has already been used. */
const resolvedCards = new Set();

const rrAvailable = () =>
  game.modules.get(ROLL_REQUESTS_ID)?.active && !!game.pf1RollRequests?.createRequest;

/* -------------------------------------------- *
 *  Standard (raw), per-level
 * -------------------------------------------- */

/**
 * Prompt the standard per-level save for a due bestowed instance.
 *
 * @param {Actor} actor
 * @param {NegativeLevelInstance} inst
 */
export async function promptBestowedSave(actor, inst) {
  const key = `${actor.id}:${inst.id}`;
  if (pendingSaves.has(key)) return;
  pendingSaves.add(key);

  const token = actor.token ?? actor.getActiveTokens(false, true)[0] ?? null;
  if (rrAvailable() && token) {
    return requestViaRollRequests(actor, inst, token, key);
  }
  return postSaveCard(actor, inst);
}

/**
 * Roll-requests branch. A targeted request locks a target after one roll, so a
 * multi-level bestowal issues one request per level — each an independent
 * per-level save. (Single-level bestowals, the common case, are just one card.)
 *
 * @param {Actor} actor
 * @param {NegativeLevelInstance} inst
 * @param {TokenDocument} token
 * @param {string} key
 */
async function requestViaRollRequests(actor, inst, token, key) {
  const total = inst.amount;
  let resolved = 0;
  const target = {
    id: token.id,
    tokenUUID: token.uuid,
    name: token.name,
    img: token.texture?.src ?? actor.img,
    isHidden: !!token.hidden,
  };

  for (let i = 0; i < total; i++) {
    let done = false;
    await game.pf1RollRequests.createRequest({
      type: "save",
      key: "fort",
      dc: inst.dc,
      mode: "targeted",
      showDC: true,
      showResults: true,
      name: game.i18n.format("IED.Save.RequestName", { name: inst.name }),
      targetedActors: [{ ...target }],
      onResult: (payload) => {
        if (done) return;
        if (payload?.rollType === "cancelled") return;
        const passed = payload?.result?.passed;
        if (passed == null) return;
        done = true;
        resolved++;
        applyRawResults(actor, inst, [passed]);
        if (resolved >= total) pendingSaves.delete(key);
      },
    });
  }
}

async function postSaveCard(actor, inst) {
  const n = inst.amount;
  const sentence = game.i18n.format("IED.Card.MayBecomePermanent", {
    actor: `<strong>${esc(actor.name)}</strong>`,
    levels: game.i18n.format("IED.Levels", { count: n }),
    source: `<em>${esc(inst.name)}</em>`,
  });
  const button = game.i18n.format("IED.Card.RollSaves", { count: n, dc: inst.dc });
  const content = `<div class="pf1-ied-card" data-actor-uuid="${actor.uuid}" data-instance-id="${inst.id}" data-dc="${inst.dc}" data-count="${n}" data-name="${esc(inst.name)}">
    <p><i class="fa-solid fa-skull"></i> ${sentence}</p>
    <button type="button" class="pf1-ied-save" data-actor-uuid="${actor.uuid}" data-instance-id="${inst.id}" data-dc="${inst.dc}" data-count="${n}" data-name="${esc(inst.name)}">
      <i class="fa-solid fa-shield-halved"></i> ${button}
    </button>
  </div>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

/**
 * Delegated click handler for the built-in save button. Rolls one Fort save per
 * remaining level, then applies the tally.
 *
 * @param {MouseEvent} event
 */
async function onSaveButtonClick(event) {
  const button = event.target.closest?.("button.pf1-ied-save");
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();

  const messageId = button.closest("[data-message-id]")?.dataset.messageId;
  if (messageId && resolvedCards.has(messageId)) return;

  const actor = resolveActor(button.dataset.actorUuid);
  if (!actor) return;
  if (!actor.isOwner) {
    ui.notifications.warn(game.i18n.format("IED.Warn.NotOwner", { name: actor.name }));
    return;
  }

  if (messageId) resolvedCards.add(messageId);
  button.disabled = true;

  const dc = Number(button.dataset.dc) || 0;
  const count = Number(button.dataset.count) || 1;
  const inst = { id: button.dataset.instanceId, dc, amount: count, name: button.dataset.name };
  const skipDialog = !actor.hasPlayerOwner;

  const results = [];
  for (let i = 0; i < count; i++) {
    let msg;
    try {
      msg = await actor.rollSavingThrow("fort", { dc, skipDialog });
    } catch (err) {
      console.error(`${MODULE_ID} | Fort save failed to roll`, err);
    }
    const roll = msg?.rolls?.[0];
    if (!roll) break; // cancelled — stop rolling further levels
    results.push(roll.isSuccess ?? roll.total >= dc);
  }

  if (!results.length) {
    if (messageId) resolvedCards.delete(messageId);
    button.disabled = false;
    return;
  }

  pendingSaves.delete(`${actor.id}:${inst.id}`);
  applyRawResults(actor, inst, results);
}

/**
 * Apply an array of per-level results (raw mode): remove on success, convert to
 * permanent on failure, then post a summary.
 *
 * @param {Actor} actor
 * @param {{id:string,name:string}} inst
 * @param {boolean[]} results
 */
function applyRawResults(actor, inst, results) {
  let removed = 0;
  let permanent = 0;
  for (const passed of results) {
    mutate(actor, "resolveLevel", { id: inst.id, passed, toPermanent: true });
    if (passed) removed++;
    else permanent++;
  }
  const parts = [];
  if (removed) parts.push(game.i18n.format("IED.Result.ShakenOff", { count: removed }));
  if (permanent) parts.push(game.i18n.format("IED.Result.NowPermanent", { count: permanent }));
  postResult(
    actor,
    permanent === 0,
    game.i18n.format("IED.Result.Summary", { source: esc(inst.name), parts: parts.join(", ") })
  );
}

/* -------------------------------------------- *
 *  House rule — one save per rest
 * -------------------------------------------- */

/**
 * Roll the once-per-day house-rule save on rest. One Fort save at the lowest DC;
 * success removes a single level from that source, never permanent.
 *
 * @param {Actor} actor
 */
export async function promptHouseRuleSave(actor) {
  const bestowed = readInstances(actor).filter((i) => i.kind === "bestowed" && i.dc != null);
  if (!bestowed.length) return;

  const dc = Math.min(...bestowed.map((i) => i.dc));
  const inst = bestowed
    .filter((i) => i.dc === dc)
    .sort((a, b) => (a.applied ?? 0) - (b.applied ?? 0))[0];

  const token = actor.token ?? actor.getActiveTokens(false, true)[0] ?? null;

  // Use a roll-request when we can create one (GM client). Rests are often
  // player-initiated, and createRequest is GM-only, so fall back to a direct
  // roll on the resting owner's client.
  if (rrAvailable() && game.user.isGM && token) {
    let done = false;
    await game.pf1RollRequests.createRequest({
      type: "save",
      key: "fort",
      dc,
      mode: "targeted",
      showDC: true,
      showResults: true,
      name: game.i18n.format("IED.Save.RequestName", { name: inst.name }),
      targetedActors: [
        {
          id: token.id,
          tokenUUID: token.uuid,
          name: token.name,
          img: token.texture?.src ?? actor.img,
          isHidden: !!token.hidden,
        },
      ],
      onResult: (payload) => {
        if (done) return;
        if (payload?.rollType === "cancelled") return;
        const passed = payload?.result?.passed;
        if (passed == null) return;
        done = true;
        applyHouseResult(actor, inst, passed);
      },
    });
    return;
  }

  const skipDialog = !actor.hasPlayerOwner;
  let msg;
  try {
    msg = await actor.rollSavingThrow("fort", { dc, skipDialog });
  } catch (err) {
    console.error(`${MODULE_ID} | house-rule Fort save failed to roll`, err);
  }
  const roll = msg?.rolls?.[0];
  if (!roll) return;
  applyHouseResult(actor, inst, roll.isSuccess ?? roll.total >= dc);
}

function applyHouseResult(actor, inst, passed) {
  if (passed) mutate(actor, "resolveLevel", { id: inst.id, passed: true, toPermanent: false });
  const key = passed ? "IED.Result.HouseRecover" : "IED.Result.HouseAfflicted";
  postResult(actor, passed, game.i18n.format(key, { source: esc(inst.name) }));
}

/* -------------------------------------------- *
 *  Result card
 * -------------------------------------------- */

async function postResult(actor, good, text) {
  const icon = good ? "fa-heart-pulse" : "fa-skull";
  const line = game.i18n.format("IED.Result.Line", {
    actor: `<strong>${esc(actor.name)}</strong>`,
    text,
  });
  const content = `<div class="pf1-ied-card pf1-ied-${good ? "pass" : "fail"}">
    <p><i class="fa-solid ${icon}"></i> ${line}</p>
  </div>`;
  await ChatMessage.create({ content, speaker: ChatMessage.getSpeaker({ actor }) });
}

Hooks.once("ready", () => {
  document.body.addEventListener("click", onSaveButtonClick);
});
