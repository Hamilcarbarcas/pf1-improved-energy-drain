# PF1 Improved Energy Drain — build plan

Working design notes. Not shipped in the package (kept out of `esmodules`/`styles`).

## Guiding principle

Do **not** re-implement the penalty math. The system already fans out −1 to
attack/saves/skills/CMD, −5 HP/level, and reduces CL and effective class level
from `system.attributes.energyDrain`. Confirmed that value is **not** a change
target, so the module can own it outright. We layer lifecycle on top.

No spell-slot loss (house rule: not used).

## Architecture: derive, don't store

- **Source of truth:** actor flag `pf1-improved-energy-drain.instances` — the
  list of *authored* instances (temporary / bestowed / permanent) plus static
  config. Registration pattern mirrors pf1-temp-hp-manager (`{value, source}`
  array, remove-by-source), but richer per-instance data.
- **Derived total:** `system.attributes.energyDrain` is recomputed each actor
  data prep (libWrapper around `ActorPF.prepareDerivedData`) as the sum of
  instances *active now* at `game.time.worldTime`. The number is therefore
  correct the instant time passes an expiry/save point, before any cleanup
  write. Lifecycle writes only mutate the flag + fire prompts.
- **Static reconciles for free:** a static contribution = sum of item flags
  where `item.isActive` (equipped / active / enabled per item type). No write
  on equip/unequip; it just re-derives.

## Kinds and settable fields (same fields via API, enricher, and GUI)

| Kind      | Fields                    | Lifecycle |
| --------- | ------------------------- | --------- |
| temporary | amount, name, duration    | self-expires at applied+duration (world time); no save |
| bestowed  | amount, name, DC          | at applied+24h, per-level Fort save; success removes, fail → permanent |
| permanent | amount, name              | fixed; removed only by API / restoration (e.g. Raise Dead) |
| static    | amount, name, source item | present while the source item isActive; no save/timer; not hand-removable |

Static is configured **on the item**: a small enable + amount control on the
item's Details tab, appended after the creature-type block
(`item-creature-type.hbs`, the last base section, shared by buff/class/
equipment/feat/race/weapon). Stored as an item flag. The levels apply only
while `item.isActive` (equipped for equipment, enabled/active for
features/buffs) — set-but-inactive contributes nothing.

## API (game.modules.get(MODULE_ID).api)

- `apply(target, { kind, amount, name, dc, duration, sourceUuid })` → instance id
- `remove(target, idOrName)` — auto id (precise) or name (all matching); non-static only
- `removeAll(target)` — clear every removable (non-static) instance
- `removePermanent(target, count)` — remove up to `count` permanent levels (clamped to total)
- `removeTemporary(target)` — remove all temporary **and** not-yet-permanent bestowed
- `list(target)` — instances + derived state (active, time left, save due)
- `getLevels(target)` — current effective total

`id` = precise handle; `name` = label + convenience bulk-remove. Two same-named
instances (e.g. two Enervations) coexist with distinct expiries.

`removePermanent`/`removeTemporary` are the restoration-style primitives:
together they model the Restoration spell line (dispel temporary levels, remove
N permanent). `removePermanent` decrements permanent instances most-recent
first, deleting instances as they reach zero. Static is never touched by any
removal path.

## Enrichers

Apply — single `@EnergyDrain[...]` enricher, `kind=` param (default **bestowed**):
- `@EnergyDrain[1d4;kind=temporary;duration=1h]{Enervation}`
- `@EnergyDrain[2;dc=18]{Energy Drain}`
- `@EnergyDrain[1;kind=permanent]{Raise Dead}`
No static enricher — static comes from items.

Remove — single `@RemoveEnergyDrain[...]` enricher; `temporary` and
`permanent=N` are independent options that combine in one tag:
- `@RemoveEnergyDrain[permanent=1]{Restoration}` — remove up to 1 permanent
- `@RemoveEnergyDrain[temporary]{Restoration}` — remove all temporary + pending bestowed
- `@RemoveEnergyDrain[temporary;permanent=1]{Restoration}` — both in one click

The handler composes `removeTemporary` + `removePermanent` for whichever options
are present. Same target/select-token click model as apply. Static is never
removable.

## Character-sheet manager

Replaces the negative-levels text input in
`public/templates/actors/parts/actor-traits.hbs` (form-group.negative-levels).
A manager (DialogV2 or injected panel) lists every instance with: name, kind,
amount, save DC, linked item, time elapsed / remaining. Manual add + remove of
temporary/bestowed/permanent; static is read-only (managed via its item).

Top-of-window bulk controls (mirror the removal API):
- Remove permanent: number input (clamped to total permanent) + button.
- Remove all temporary: button (clears temporary + not-yet-permanent bestowed).

## Lifecycle engine

- Runs on `updateWorldTime`, on the **active GM only** (`game.users.activeGM`),
  and must catch up on large time jumps (resolve all passed expiries/saves in
  one pass).
- Temporary: drop when `worldTime >= expires`.
- Bestowed: at `worldTime >= saveDue`, post ONE Fort-save card rolling N
  independent saves (per-level, RAW); successes removed, failures split off into
  a permanent instance. Two-tier request: Roll Requests if present, else a
  self-contained vanilla save card (mirrors pf1-bleed-effects burning save).
- Death check: negative levels ≥ HD → dead condition + GM spawn notification
  (no auto-creation).

## System condition icon

Once we own the number, the `energyDrain` status icon = derived `total > 0`.
Manual clicks are **intercepted**: toggle-on opens the manager (quick-add),
toggle-off offers to clear removable instances (never static). The icon itself
stays a pure reflection of the derived total.

## Open questions

- **Ability-check penalty:** verify system applies −1 to ability checks from
  energyDrain; add if missing. (Post-implementation test.)
- **Install migration:** since the module now *owns* (derives) `energyDrain`,
  existing actors with a hand-entered stored value will read as 0 once tracked
  instances are the source of truth. Before public release, add a one-time
  migration converting any stored `energyDrain > 0` into a permanent instance.

## Status

- **Phase 1 (core) — done:** `common.mjs`, `instances.mjs`, `energy-drain.mjs`.
  Derive hook (`pf1PrepareBaseActorData`, no libWrapper needed), per-actor write
  queue (fixes read-modify-write race), GM write funnel, full API. Static gated
  by `sourceActive` (equipped for physical gear, `isActive` for feats/buffs).
- **Phase 2 (surfaces) — done:**
  - `enricher.mjs` — `@EnergyDrain` / `@RemoveEnergyDrain` (combined temp+perm).
  - `item-static.mjs` — enable+amount control after the item creature-type block.
  - `manager.mjs` + `templates/manager.hbs` — ApplicationV2 manager (list, per-row
    remove, bulk remove-temporary / remove-N-permanent, add form); replaces the
    actor-sheet negative-levels field with total + open button; live re-render.
  - `condition.mjs` — the negative-levels status icon uses id `energyDrained`
    (Nevela's Automation Suite provides it; we defer when present, else register
    our own — checked at end of the `ready` tick so later registrations win).
    Self-correcting sync via `toggleStatusEffect` (active GM, mismatch only) +
    token-HUD click interception opens the manager. Ships `src/icons/
    negative-levels.svg` for the fallback.
  - Add is now a single button opening a type-aware DialogV2 (permanent: name +
    levels; temporary: + duration; bestowed: + save DC).
  - Condition/icon layer (`condition.mjs`) was **removed** — low value and
    fighting the AE system; management is via the sheet manager only.
- **Phase 3 (lifecycle) — done:** `lifecycle.mjs` + `save-card.mjs`.
  `updateWorldTime` (active GM) prunes expired temporary and prompts due
  bestowed saves; `now >= threshold` handles time jumps; `ready` catch-up.
  Two-tier Fort save (roll-requests / built-in card), resolved as a normal
  mutation (remove on pass, `convert`→permanent on fail). New mutators
  `pruneExpired`/`convert`; internal `mutate()` export.
  - Saves are now **per-level** (one Fort save per level; success removes,
    failure → permanent, merged into a same-named permanent instance).
- **House-rule mode — done:** `saveMode` world setting (`raw` | `houseRule`).
  House rule: no 24h timer, nothing becomes permanent; on a full rest
  (`pf1ActorRest` + `restoreDailyUses`) roll ONE Fort save at the lowest bestowed
  DC, success sheds one level from that source. Detected on the active GM from
  the rest's broadcast update context (`options.pf1.action === "rest"`, on
  actor or item updates, debounced) so the GM issues the roll-request even for
  player-initiated rests; falls back to a direct roll only if roll-requests is
  absent.
- **Phase 4 (death) — done:** `death.mjs` — active GM applies `dead` +
  posts notice when derived total ≥ `system.attributes.hd.total` (once, on
  crossing). No auto-revive.
- Notes: `ready` catch-up prompts due bestowed on load; bestowed with no DC never
  auto-saves (resolve via manager).
- Next: README + install migration for pre-existing stored `energyDrain`.

## Phases

1. Core: instance model, derived-total libWrapper, API, active-GM socket funnel.
2. Application surfaces: enricher, sheet manager (add/remove), static via items.
3. Lifecycle: temporary expiry, bestowed 24h Fort save (2-tier), permanent
   conversion.
4. Death check + spawn notification.

## Release plumbing (scaffolded)

Tag-triggered `release.yml`; `module.json` version stays `0.0.0`; GPL-3.0.
