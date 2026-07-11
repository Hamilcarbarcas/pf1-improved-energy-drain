/**
 * PF1 Improved Energy Drain — module entry point.
 *
 * Owns three things in Phase 1:
 *   1. The derived total — on every actor data prep, `system.attributes.
 *      energyDrain` is set to the sum of active instances + static item
 *      contributions, so the system derives all downstream penalties itself.
 *   2. The write funnel — mutations run locally when this client owns the
 *      actor, otherwise they are routed to the active GM over the socket.
 *   3. The public API (game.modules.get(MODULE_ID).api).
 *
 * Public API:
 *   apply(target, { kind, amount, name, dc, duration, saveDelay }) -> id
 *   remove(target, idOrName)     removeAll(target)
 *   removePermanent(target, n)   removeTemporary(target)
 *   list(target)                 getLevels(target)
 */

import {
  MODULE_ID,
  canWrite,
  emitToGM,
  registerSocket,
  resolveActor,
} from "./common.mjs";
import {
  addInstance,
  deriveTotal,
  listAll,
  makeInstance,
  readInstances,
  removeAllStored,
  removeById,
  removeByName,
  removePermanentLevels,
  removeTemporaryLevels,
  resolveBestowedLevel,
  writeInstances,
} from "./instances.mjs";

/** World setting: enable the alternate (house-rule) energy-drain recovery. */
export const SETTING_ALT_RULES = "alternateRules";

/** @returns {boolean} Whether the alternate energy-drain rules are enabled. */
export const useAlternateRules = () => game.settings.get(MODULE_ID, SETTING_ALT_RULES) === true;

/* -------------------------------------------- */
/*  Derived total                                                             */
/* -------------------------------------------- */

/**
 * Set `system.attributes.energyDrain` from the tracked instances. Fires inside
 * `prepareBaseData`, before any consumer reads the value in the derived phase.
 * Wrapped so a failure here can never break actor preparation.
 *
 * @param {Actor} actor
 */
function onPrepareBaseData(actor) {
  try {
    const attrs = actor.system?.attributes;
    if (!attrs || !("energyDrain" in attrs)) return; // e.g. haunt/vehicle
    attrs.energyDrain = deriveTotal(actor);
  } catch (err) {
    console.error(`${MODULE_ID} | failed to derive energyDrain`, err, actor);
  }
}

/* -------------------------------------------- */
/*  Write funnel                                                              */
/* -------------------------------------------- */

/** Named list transforms; keyed so the same code path runs locally and on the GM. */
const MUTATORS = {
  add: (list, args) => addInstance(list, args.instance),
  remove: (list, args) => {
    const byId = removeById(list, args.key);
    return byId.length !== list.length ? byId : removeByName(list, args.key);
  },
  removeAll: () => removeAllStored(),
  removePermanent: (list, args) => removePermanentLevels(list, args.count),
  removeTemporary: (list) => removeTemporaryLevels(list),
  // Lifecycle-driven:
  pruneExpired: (list, args) =>
    list.filter((i) => !(i.kind === "temporary" && args.at >= i.expires)),
  resolveLevel: (list, args) =>
    resolveBestowedLevel(list, args.id, args.passed, args.toPermanent),
};

/**
 * Per-actor write queue. `setFlag` is async, so back-to-back mutations (a macro
 * loop, two enrichers resolving together) would otherwise each read the same
 * stale list and clobber one another — last write wins. Chaining every
 * mutation for an actor onto the previous one guarantees each read-modify-write
 * sees the prior write's result.
 *
 * @type {Map<string, Promise<unknown>>}
 */
const _queues = new Map();

/**
 * Enqueue `task` to run after any pending mutation for the same actor.
 *
 * @param {Actor} actor
 * @param {() => Promise<unknown>} task
 * @returns {Promise<unknown>}
 */
function enqueue(actor, task) {
  const key = actor.uuid;
  const prev = _queues.get(key) ?? Promise.resolve();
  const run = prev
    .then(() => task())
    .catch((err) => console.error(`${MODULE_ID} | mutation failed`, err));
  _queues.set(key, run);
  run.finally(() => {
    if (_queues.get(key) === run) _queues.delete(key);
  });
  return run;
}

/**
 * Apply a named mutation to the actor's instance list and persist it, serialized
 * per actor. Runs on a client that can write (owner/GM).
 *
 * @param {Actor} actor
 * @param {keyof MUTATORS} action
 * @param {object} args
 * @returns {Promise<unknown>}
 */
function runMutation(actor, action, args) {
  return enqueue(actor, () => {
    const next = MUTATORS[action](readInstances(actor), args);
    return writeInstances(actor, next);
  });
}

/**
 * Run a mutation here if we can write, otherwise route it to the active GM.
 *
 * @param {Actor} actor
 * @param {keyof MUTATORS} action
 * @param {object} args
 */
function dispatch(actor, action, args) {
  if (canWrite(actor)) return runMutation(actor, action, args);
  if (!game.users.activeGM) {
    ui.notifications.warn(game.i18n.localize("IED.Warn.NoGM"));
    return Promise.resolve();
  }
  emitToGM({ action, actorUuid: actor.uuid, args });
  return Promise.resolve(); // routed; the GM performs the write
}

/** Active-GM-only socket handler (guarded inside registerSocket). */
function onSocket(payload) {
  const actor = resolveActor(payload.actorUuid);
  if (!actor) return;
  runMutation(actor, payload.action, payload.args);
}

/* -------------------------------------------- */
/*  Public API                                                                */
/* -------------------------------------------- */

const api = {
  /**
   * Apply negative levels.
   *
   * @param {Actor|Token|string} target
   * @param {object} params - kind, amount, name, dc, duration, saveDelay.
   * @returns {string|null} The new instance id, or null if the target is invalid.
   */
  apply(target, params = {}) {
    const actor = resolveActor(target);
    if (!actor) return null;
    let inst;
    try {
      inst = makeInstance(params); // throws on a non-authorable kind (e.g. static)
    } catch (err) {
      console.error(`${MODULE_ID} | apply failed`, err);
      return null;
    }
    dispatch(actor, "add", { instance: inst });
    return inst.id;
  },

  /**
   * Remove a single instance by id or by name (all matching). Cannot target
   * static instances (they live on items).
   *
   * @param {Actor|Token|string} target
   * @param {string} idOrName
   */
  remove(target, idOrName) {
    const actor = resolveActor(target);
    return actor ? dispatch(actor, "remove", { key: idOrName }) : Promise.resolve();
  },

  /** Remove every removable (non-static) instance. */
  removeAll(target) {
    const actor = resolveActor(target);
    return actor ? dispatch(actor, "removeAll", {}) : Promise.resolve();
  },

  /**
   * Remove up to `count` permanent levels (restoration-style).
   *
   * @param {Actor|Token|string} target
   * @param {number} count
   */
  removePermanent(target, count) {
    const actor = resolveActor(target);
    return actor ? dispatch(actor, "removePermanent", { count }) : Promise.resolve();
  },

  /** Remove all temporary levels, including not-yet-permanent bestowed. */
  removeTemporary(target) {
    const actor = resolveActor(target);
    return actor ? dispatch(actor, "removeTemporary", {}) : Promise.resolve();
  },

  /**
   * Inspect every instance affecting the actor (stored + static) with live
   * timing annotations.
   *
   * @param {Actor|Token|string} target
   * @returns {object[]}
   */
  list(target) {
    const actor = resolveActor(target);
    return actor ? listAll(actor) : [];
  },

  /**
   * Current effective negative-level total.
   *
   * @param {Actor|Token|string} target
   * @returns {number}
   */
  getLevels(target) {
    const actor = resolveActor(target);
    return actor ? deriveTotal(actor) : 0;
  },
};

/* -------------------------------------------- */
/*  Wiring                                                                    */
/* -------------------------------------------- */

// Register the derive hook at load; it self-guards on actor type.
Hooks.on("pf1PrepareBaseActorData", onPrepareBaseData);

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, SETTING_ALT_RULES, {
    name: "IED.Settings.AltRules.Name",
    hint: "IED.Settings.AltRules.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });

  game.modules.get(MODULE_ID).api = api;
  globalThis.pf1EnergyDrain = api; // macro convenience
});

Hooks.once("setup", () => {
  registerSocket(onSocket);
});

/**
 * Internal mutation entry point for other module files (lifecycle, save cards).
 * Runs the named mutation locally when this client can write, else routes it to
 * the active GM. Same funnel + per-actor queue as the public API.
 *
 * @param {Actor} actor
 * @param {keyof MUTATORS} action
 * @param {object} args
 */
export function mutate(actor, action, args) {
  return dispatch(actor, action, args);
}

export { api };
