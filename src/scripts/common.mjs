/**
 * PF1 Improved Energy Drain — shared primitives.
 *
 * Stateless helpers shared across the module: the module id, socket channel,
 * actor resolution, the active-GM check, and a tiny socket dispatch used to
 * funnel writes on unowned actors through one GM client.
 */

export const MODULE_ID = "pf1-improved-energy-drain";

/** The module's socket channel. */
export const SOCKET = `module.${MODULE_ID}`;

/** Actor flag key under which the negative-level instance list is stored. */
export const FLAG_INSTANCES = "instances";

/** Item flag key holding the static negative-level amount an item confers. */
export const FLAG_STATIC = "staticLevels";

/** Item flag key toggling whether the item confers static negative levels. */
export const FLAG_STATIC_ENABLED = "staticEnabled";

/** @returns {string} A fresh 16-char id. */
export const newId = () => foundry.utils.randomID();

/**
 * Resolve an Actor from an Actor, Token, TokenDocument, or UUID string.
 *
 * @param {Actor|Token|TokenDocument|string} ref
 * @returns {Actor|null}
 */
export function resolveActor(ref) {
  if (!ref) return null;
  if (ref instanceof Actor) return ref;
  if (ref.actor instanceof Actor) return ref.actor;
  if (typeof ref === "string") {
    const doc = fromUuidSync(ref);
    return doc instanceof Actor ? doc : (doc?.actor ?? null);
  }
  return null;
}

/**
 * Whether this client is the single GM designated to process shared work
 * (time ticks, writes routed from players). Mirrors the pattern used to avoid
 * every connected GM acting on the same socket message.
 *
 * @returns {boolean}
 */
export const isActiveGM = () => game.users.activeGM?.isSelf === true;

/**
 * Whether this client may write to the actor directly (owner or GM). A GM is
 * owner of every actor, so this collapses to a single ownership test.
 *
 * @param {Actor} actor
 * @returns {boolean}
 */
export const canWrite = (actor) => actor?.isOwner === true;

let _handler = null;

/**
 * Register the module socket. `handler(payload)` runs only on the active GM,
 * so callers can emit freely and trust exactly one client acts.
 *
 * @param {(payload: object) => void} handler
 */
export function registerSocket(handler) {
  _handler = handler;
  game.socket.on(SOCKET, (payload) => {
    if (isActiveGM()) _handler?.(payload);
  });
}

/**
 * Send a payload to the active GM for handling. No-op guard: if this client is
 * itself able to write it should act directly rather than emit.
 *
 * @param {object} payload
 */
export function emitToGM(payload) {
  game.socket.emit(SOCKET, payload);
}

const UNIT_SECONDS = { s: 1, m: 60, h: 3600, d: 86400 };

/**
 * Parse a duration like `1h`, `30m`, `90s`, `2d`, or a plain number of seconds.
 *
 * @param {string|number} str
 * @returns {number} seconds (0 if unparseable)
 */
export function parseDuration(str) {
  if (str == null || str === "") return 0;
  const m = /^(\d+(?:\.\d+)?)\s*([smhd])?$/i.exec(String(str).trim());
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * (UNIT_SECONDS[m[2]?.toLowerCase()] ?? 1));
}

/**
 * Format a number of seconds as a short human string (e.g. "1h 30m", "45s").
 * Shows at most the two most-significant non-zero units.
 *
 * @param {number} seconds
 * @returns {string}
 */
export function formatDuration(seconds) {
  let s = Math.max(0, Math.round(seconds));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  if (s && !d && !h) parts.push(`${s}s`);
  return parts.slice(0, 2).join(" ") || "0s";
}
