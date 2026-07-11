/**
 * PF1 Improved Energy Drain — text enrichers.
 *
 * Apply — `@EnergyDrain[amount;opts]{label}` (follows the PF1
 * `@Verb[primary;opts]{label}` convention):
 *   @EnergyDrain[2;dc=18]{Energy Drain}                 bestowed (default), DC 18
 *   @EnergyDrain[1d4;kind=temporary;duration=1h]{Enervation}
 *   @EnergyDrain[1;kind=permanent]{Raise Dead}
 * The primary argument is the level amount (number or roll formula, evaluated
 * against the source actor at click time). `label` becomes the instance name.
 *
 * Remove — `@RemoveEnergyDrain[opts]{label}`; `temporary` and `permanent=N`
 * combine in one tag:
 *   @RemoveEnergyDrain[permanent=1]{Restoration}
 *   @RemoveEnergyDrain[temporary]{Restoration}
 *   @RemoveEnergyDrain[temporary;permanent=1]{Restoration}
 * Static levels are never removable (they live on items).
 */

import { parseDuration } from "./common.mjs";
import { api } from "./energy-drain.mjs";

const APPLY_PATTERN =
  /@EnergyDrain\[(?<amount>[^;\]]+?)(?:;(?<options>[^\]]*))?\](?:\{(?<label>[^}]*)\})?/g;
const REMOVE_PATTERN =
  /@RemoveEnergyDrain\[(?<options>[^\]]*)\](?:\{(?<label>[^}]*)\})?/g;

const APPLY_CLASS = "pf1-energydrain-link";
const REMOVE_CLASS = "pf1-energydrain-remove-link";

/**
 * Parse a `key=value;flag;key=value` option string. A bare token (no `=`)
 * becomes `true`.
 *
 * @param {string} str
 * @returns {Record<string,string>}
 */
function parseOptions(str) {
  const opts = {};
  if (!str) return opts;
  for (const part of str.split(";")) {
    const [k, v] = part.split("=", 2);
    if (k.trim()) opts[k.trim()] = (v ?? "true").trim();
  }
  return opts;
}

/* -------------------------------------------- */
/*  Element construction                                                      */
/* -------------------------------------------- */

function makeLink(className, iconClasses, tooltip, text, dataset) {
  const a = document.createElement("a");
  a.classList.add(className);
  Object.assign(a.dataset, dataset);
  a.dataset.tooltip = tooltip;
  a.dataset.tooltipClass = "pf1";
  const i = document.createElement("i");
  i.classList.add(...iconClasses);
  i.inert = true;
  a.append(i, " ", text);
  return a;
}

function enrichApply(match) {
  const { amount, options, label } = match.groups;
  const opts = parseOptions(options);
  const kind = (opts.kind ?? "bestowed").toLowerCase();
  const amt = amount.trim();

  const ds = { amount: amt, kind };
  if (opts.dc != null) ds.dc = opts.dc;
  if (opts.duration != null) ds.duration = String(parseDuration(opts.duration));

  const name = label?.trim();
  if (name) ds.name = name;

  const text = name || game.i18n.format("IED.Enricher.ApplyText", { amount: amt });
  const tip = game.i18n.format("IED.Enricher.ApplyTip", { kind, amount: amt });
  return makeLink(APPLY_CLASS, ["fa-solid", "fa-skull"], tip, text, ds);
}

function enrichRemove(match) {
  const { options, label } = match.groups;
  const opts = parseOptions(options);

  const ds = {};
  if (opts.temporary != null) ds.temporary = "true";
  if (opts.permanent != null) ds.permanent = String(Math.max(0, parseInt(opts.permanent, 10) || 0));

  const bits = [];
  if (ds.temporary) bits.push(game.i18n.localize("IED.Enricher.SummaryTemporary"));
  if (ds.permanent) bits.push(game.i18n.format("IED.Enricher.SummaryPermanent", { count: ds.permanent }));
  const summary = bits.join(" + ") || game.i18n.localize("IED.Enricher.SummaryNothing");

  const name = label?.trim();
  const text = name || game.i18n.localize("IED.Enricher.RemoveText");
  const tip = game.i18n.format("IED.Enricher.RemoveTip", { summary });
  return makeLink(REMOVE_CLASS, ["fa-solid", "fa-hand-sparkles"], tip, text, ds);
}

/* -------------------------------------------- */
/*  Targeting (mirrors pf1-bleed-effects)                                     */
/* -------------------------------------------- */

function getActors(el) {
  const resolver = pf1?.chat?.enrichers?.getRelevantActors;
  if (resolver) {
    try {
      return [...resolver(el, true)];
    } catch {
      return [];
    }
  }
  if (game.user.targets.size) return [...game.user.targets].map((t) => t.actor).filter(Boolean);
  if (canvas.tokens?.controlled.length) return canvas.tokens.controlled.map((t) => t.actor).filter(Boolean);
  return game.user.character ? [game.user.character] : [];
}

function getSourceRollData(el) {
  const msgId = el.closest("[data-message-id]")?.dataset.messageId;
  const message = msgId ? game.messages.get(msgId) : null;
  const src =
    message?.actionSource ??
    message?.itemSource ??
    (message?.speaker ? ChatMessage.getSpeakerActor(message.speaker) : null);
  return src?.getRollData?.() ?? null;
}

/**
 * Evaluate the amount formula against the source actor's data, flooring to a
 * whole number of levels (minimum 1).
 *
 * @param {string} formula
 * @param {object|null} rollData
 * @returns {Promise<number>}
 */
async function rollAmount(formula, rollData) {
  try {
    const roll = await new Roll(formula, rollData ?? {}).evaluate();
    return Math.max(1, Math.floor(roll.total));
  } catch (err) {
    console.error(`pf1-improved-energy-drain | bad amount formula "${formula}"`, err);
    return 1;
  }
}

/* -------------------------------------------- */
/*  Click handling                                                            */
/* -------------------------------------------- */

async function onClick(event) {
  const apply = event.target.closest?.(`a.${APPLY_CLASS}`);
  const remove = event.target.closest?.(`a.${REMOVE_CLASS}`);
  const a = apply ?? remove;
  if (!a) return;
  event.preventDefault();
  event.stopPropagation();

  const actors = getActors(a);
  if (!actors.length) {
    ui.notifications.warn(game.i18n.localize("IED.Warn.NoTarget"));
    return;
  }

  if (apply) {
    const { amount, kind, dc, duration, name } = a.dataset;
    const amt = await rollAmount(amount, getSourceRollData(a));
    for (const actor of actors) {
      api.apply(actor, {
        kind,
        amount: amt,
        name,
        dc: dc != null ? parseInt(dc, 10) : undefined,
        duration: duration != null ? parseInt(duration, 10) : undefined,
      });
    }
  } else {
    const { temporary, permanent } = a.dataset;
    const perm = permanent != null ? parseInt(permanent, 10) : 0;
    for (const actor of actors) {
      if (temporary) api.removeTemporary(actor);
      if (perm > 0) api.removePermanent(actor, perm);
    }
  }
}

Hooks.once("setup", () => {
  CONFIG.TextEditor.enrichers.push(
    { pattern: APPLY_PATTERN, enricher: enrichApply },
    { pattern: REMOVE_PATTERN, enricher: enrichRemove }
  );
});

Hooks.once("ready", () => {
  document.body.addEventListener("click", onClick);
});
