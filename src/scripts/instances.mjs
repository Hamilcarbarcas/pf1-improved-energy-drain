/**
 * PF1 Improved Energy Drain — negative-level instance model.
 *
 * A single actor can carry negative levels from several sources at once, each
 * with its own rules. Rather than trust the system's flat
 * `system.attributes.energyDrain` counter, the module stores a list of
 * instances in an actor flag and *derives* that counter from them (see
 * energy-drain.mjs), so the system's existing penalty derivation (attack,
 * saves, skills, CMD, HP, CL, effective class level) keeps working unchanged.
 *
 * Instance kinds:
 *   - "temporary"  — expires by itself at `expires` (world time). No save.
 *                    e.g. Enervation (1d4 levels for 1 hour).
 *   - "bestowed"   — permanent-pending: at `saveDue` (world time, default
 *                    +24h) each level allows a Fortitude save; success removes
 *                    that level, failure converts it to "permanent". e.g.
 *                    Energy Drain spell, undead energy-drain attacks.
 *   - "permanent"  — fixed level with no save, timer, or source; cleared only
 *                    by removal (restoration / API). e.g. Raise Dead, or a
 *                    "bestowed" level whose save failed.
 *   - "static"     — conferred by a worn/active item; present only while
 *                    `item.isActive`. Derived from item flags, NOT stored in
 *                    the actor flag, and never hand-removable.
 *
 * @typedef {object} NegativeLevelInstance
 * @property {string}  id       Unique id ("static:<itemId>" for derived static).
 * @property {"temporary"|"bestowed"|"permanent"|"static"} kind
 * @property {number}  amount   Number of negative levels (>= 1).
 * @property {string}  name     Display label / source name.
 * @property {number}  [applied] World time (seconds) applied.
 * @property {number}  [expires] World time the instance self-removes ("temporary").
 * @property {number}  [saveDue] World time the Fort save unlocks ("bestowed").
 * @property {number}  [dc]      Fortitude DC for the removal save ("bestowed").
 * @property {string}  [sourceUuid] Conferring item uuid ("static").
 */

import {
  FLAG_INSTANCES,
  FLAG_STATIC,
  FLAG_STATIC_ENABLED,
  MODULE_ID,
  newId,
} from "./common.mjs";

const DAY_SECONDS = 24 * 60 * 60;

/** @returns {number} The current world time in seconds. */
export const now = () => game.time.worldTime;

/* -------------------------------------------- */
/*  Flag storage (temporary / bestowed / permanent only)                      */
/* -------------------------------------------- */

/**
 * Read the stored instance list. Returns a defensive deep copy so callers can
 * mutate freely before writing back.
 *
 * @param {Actor} actor
 * @returns {NegativeLevelInstance[]}
 */
export function readInstances(actor) {
  const raw = actor.getFlag(MODULE_ID, FLAG_INSTANCES) ?? [];
  return foundry.utils.deepClone(raw);
}

/**
 * Persist an instance list. Assumes the caller may write (owner/GM); routing
 * for unowned actors happens a layer up.
 *
 * @param {Actor} actor
 * @param {NegativeLevelInstance[]} list
 * @returns {Promise<Actor>}
 */
export function writeInstances(actor, list) {
  return actor.setFlag(MODULE_ID, FLAG_INSTANCES, list);
}

/* -------------------------------------------- */
/*  Construction                                                              */
/* -------------------------------------------- */

/**
 * Build a stored instance from application parameters. World-time-relative
 * fields (`expires`, `saveDue`) are baked in at creation so every client
 * agrees regardless of who applied it.
 *
 * @param {object} params
 * @param {"temporary"|"bestowed"|"permanent"} params.kind
 * @param {number} params.amount
 * @param {string} [params.name]
 * @param {number} [params.dc]        Bestowed save DC.
 * @param {number} [params.duration]  Temporary lifetime, seconds.
 * @param {number} [params.saveDelay] Bestowed save delay, seconds (default 24h).
 * @param {number} [at]               World time to anchor to (default: now()).
 * @returns {NegativeLevelInstance}
 */
export function makeInstance(params, at = now()) {
  const amount = Math.max(1, Math.trunc(params.amount ?? 1));
  const inst = {
    id: newId(),
    kind: params.kind,
    amount,
    name: params.name?.trim() || defaultName(params.kind),
    applied: at,
  };
  switch (params.kind) {
    case "temporary":
      inst.expires = at + Math.max(0, params.duration ?? 0);
      break;
    case "bestowed":
      inst.saveDue = at + (params.saveDelay ?? DAY_SECONDS);
      inst.dc = Number.isFinite(params.dc) ? params.dc : null;
      break;
    case "permanent":
      break;
    default:
      throw new Error(`pf1-improved-energy-drain: cannot author kind "${params.kind}"`);
  }
  return inst;
}

const DEFAULT_NAMES = {
  temporary: "PF1.NegativeLevels",
  bestowed: "PF1.NegativeLevels",
  permanent: "PF1.NegativeLevels",
  static: "PF1.NegativeLevels",
};

function defaultName(kind) {
  return game.i18n.localize(DEFAULT_NAMES[kind] ?? "PF1.NegativeLevels");
}

/* -------------------------------------------- */
/*  Derivation                                                                */
/* -------------------------------------------- */

/**
 * Whether an instance contributes to the effective total right now. Temporary
 * instances stop counting the instant world time passes their expiry, even
 * before the lifecycle engine prunes them; bestowed/permanent always count
 * until explicitly removed.
 *
 * @param {NegativeLevelInstance} inst
 * @param {number} at
 * @returns {boolean}
 */
export function isActiveAt(inst, at) {
  if (inst.kind === "temporary") return at < inst.expires;
  return true;
}

/**
 * Whether an item is "active" for the purpose of conferring static levels:
 * physical gear counts while **equipped** (a cursed item still curses you even
 * at 0 tracked HP, so we can't use the stricter `isActive` which also requires
 * hp/quantity), while features/buffs count while enabled/active (`isActive`).
 *
 * @param {Item} item
 * @returns {boolean}
 */
function sourceActive(item) {
  if (item.isPhysical) return item.system.equipped === true;
  return item.isActive;
}

/**
 * Static contributions derived from the actor's items: any item carrying the
 * static-levels flag counts while its source is active (equipped for gear,
 * enabled/active for features/buffs). Synthesised fresh each read; never
 * stored in the actor flag.
 *
 * @param {Actor} actor
 * @returns {NegativeLevelInstance[]}
 */
export function staticContributions(actor) {
  const out = [];
  for (const item of actor.items) {
    if (!item.getFlag(MODULE_ID, FLAG_STATIC_ENABLED)) continue;
    const amount = Math.trunc(item.getFlag(MODULE_ID, FLAG_STATIC) ?? 0);
    if (amount > 0 && sourceActive(item)) {
      out.push({
        id: `static:${item.id}`,
        kind: "static",
        amount,
        name: item.name,
        sourceUuid: item.uuid,
      });
    }
  }
  return out;
}

/**
 * The effective negative-level total: active stored instances plus active
 * static contributions. This is what `system.attributes.energyDrain` is set to.
 *
 * @param {Actor} actor
 * @param {number} [at]
 * @returns {number}
 */
export function deriveTotal(actor, at = now()) {
  let total = 0;
  for (const inst of readInstances(actor)) {
    if (isActiveAt(inst, at)) total += inst.amount;
  }
  for (const s of staticContributions(actor)) total += s.amount;
  return total;
}

/**
 * Every instance affecting the actor — stored (with live `active` / timing
 * annotations) and static — for display and inspection.
 *
 * @param {Actor} actor
 * @param {number} [at]
 * @returns {Array<NegativeLevelInstance & {active: boolean, remaining?: number, saveIn?: number}>}
 */
export function listAll(actor, at = now()) {
  const stored = readInstances(actor).map((inst) => {
    const view = { ...inst, active: isActiveAt(inst, at) };
    if (inst.kind === "temporary") view.remaining = Math.max(0, inst.expires - at);
    if (inst.kind === "bestowed") view.saveIn = inst.saveDue - at;
    return view;
  });
  return [...stored, ...staticContributions(actor).map((s) => ({ ...s, active: true }))];
}

/* -------------------------------------------- */
/*  Pure mutations (operate on and return a list)                             */
/* -------------------------------------------- */

/** Append an authored instance. */
export function addInstance(list, inst) {
  return [...list, inst];
}

/** Remove by exact id. */
export function removeById(list, id) {
  return list.filter((i) => i.id !== id);
}

/** Remove every instance sharing a name (case-insensitive). */
export function removeByName(list, name) {
  const key = name?.toLowerCase();
  return list.filter((i) => i.name.toLowerCase() !== key);
}

/** Clear all stored instances (static lives on items, so is untouched). */
export function removeAllStored() {
  return [];
}

/**
 * Remove up to `count` permanent levels, most-recently-applied first (matching
 * how restoration peels off the newest negative level). Instances are
 * decremented and dropped as they reach zero.
 *
 * @param {NegativeLevelInstance[]} list
 * @param {number} count
 * @returns {NegativeLevelInstance[]}
 */
export function removePermanentLevels(list, count) {
  let remaining = Math.max(0, Math.trunc(count));
  if (remaining === 0) return list;
  // Newest first.
  const order = [...list]
    .map((inst, idx) => ({ inst, idx }))
    .filter((e) => e.inst.kind === "permanent")
    .sort((a, b) => (b.inst.applied ?? 0) - (a.inst.applied ?? 0));

  const result = foundry.utils.deepClone(list);
  for (const { idx } of order) {
    if (remaining <= 0) break;
    const inst = result[idx];
    const take = Math.min(inst.amount, remaining);
    inst.amount -= take;
    remaining -= take;
  }
  return result.filter((i) => i.amount > 0);
}

/**
 * Remove all temporary levels — which, per the spec, includes not-yet-permanent
 * bestowed instances (a bestowed level only becomes untouchable once its save
 * has failed and converted it to "permanent").
 *
 * @param {NegativeLevelInstance[]} list
 * @returns {NegativeLevelInstance[]}
 */
export function removeTemporaryLevels(list) {
  return list.filter((i) => i.kind !== "temporary" && i.kind !== "bestowed");
}

/**
 * Resolve a single level of a bestowed instance after one Fortitude save:
 * decrement the bestowed instance by one level, and — on a failure that
 * converts (RAW mode) — add that level to a permanent instance from the same
 * source (merging with an existing one of the same name).
 *
 * @param {NegativeLevelInstance[]} list
 * @param {string} id           Bestowed instance id.
 * @param {boolean} passed      Whether the save succeeded.
 * @param {boolean} toPermanent Whether a failure becomes a permanent level.
 * @returns {NegativeLevelInstance[]}
 */
export function resolveBestowedLevel(list, id, passed, toPermanent) {
  let target = null;
  const result = [];
  for (const inst of list) {
    if (inst.id === id && !target) target = inst;
    else result.push(inst);
  }
  if (!target) return list; // already resolved/removed

  const remaining = target.amount - 1;
  if (remaining > 0) result.push({ ...target, amount: remaining });

  if (!passed && toPermanent) {
    const perm = result.find((i) => i.kind === "permanent" && i.name === target.name);
    if (perm) perm.amount += 1;
    else {
      result.push({
        id: newId(),
        kind: "permanent",
        amount: 1,
        name: target.name,
        applied: target.applied ?? now(),
      });
    }
  }
  return result;
}
