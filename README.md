# PF1 Improved Energy Drain

Completes the Pathfinder 1e **energy drain** / negative level rules that the base system leaves to the GM.

The PF1 system already applies the *penalties* of negative levels (−1 to attack, saves, skills, CMD; −5 HP each; reduced caster level and effective class level). This module adds the parts it doesn't automate: the **lifecycle** of negative levels — how they arrive, count down, get their save, become permanent, recover, or kill.

It does this without replacing the system's math: each source of negative levels is tracked separately, and their sum is fed back into the system's own `energyDrain` value, so every downstream penalty keeps working exactly as before.

## The four kinds of negative level

| Kind | Behaviour | Example |
| --- | --- | --- |
| **Temporary** | Expires on its own after a set duration. No save. | *Enervation* (1d4 levels for 1 hour) |
| **Bestowed** | After 24 hours, one Fortitude save **per level**; success removes the level, failure makes it permanent. | *Energy Drain* spell, undead slams |
| **Permanent** | Fixed. No save, no timer, no source. Removed only deliberately (e.g. *restoration*). | *Raise Dead*, or a failed bestowed save |
| **Static** | Present only while a worn/active item is equipped or enabled. Not hand-removable. | Cursed items |

## Applying negative levels

### From the character sheet

The **Negative Levels** row on the actor's sheet shows the current total and a **manage** button (the list icon). It opens the **Negative Level Manager**, which lists every negative level on the creature — kind, source name, count, and live timing (time to expiry, or time until the save is due) — and lets you:

- **Add** a level with the type-aware **Add** dialog (permanent needs only a name and count; temporary adds a duration; bestowed adds a save DC).
- **Remove** any individual entry (static entries are read-only — manage them on their item).
- **Remove all temporary** levels (this also clears not-yet-permanent bestowed levels).
- **Remove a set number of permanent** levels — the *restoration* primitive.

All removals ask for confirmation.

### With the `@EnergyDrain` text button

`@EnergyDrain` extends PF1's built-in text enrichers (the same system behind `@Damage`, `@Condition`, etc.). Type it into any description, journal, or chat message and it renders as a clickable button. **Target** (or select) the creature(s) and click.

| You type | What it does |
| --- | --- |
| `@EnergyDrain[2;dc=18]{Energy Drain}` | 2 **bestowed** levels, Fort DC 18 (bestowed is the default kind) |
| `@EnergyDrain[1d4;kind=temporary;duration=1h]{Enervation}` | 1d4 **temporary** levels lasting 1 hour |
| `@EnergyDrain[1;kind=permanent]{Raise Dead}` | 1 **permanent** level |

Options after the amount (separated by `;`):

- **`kind`** — `bestowed` (default), `temporary`, or `permanent`.
- **`dc`** — the Fortitude DC (bestowed only). *A bestowed level with no DC never rolls its save — always give bestowed a `dc`.*
- **`duration`** — how long a temporary level lasts: `30s`, `10m`, `1h`, `2d`, or a plain number of seconds. *A temporary level with no duration expires immediately — always give temporary a `duration`.*

The amount may be a number or a roll formula (e.g. `1d4`), evaluated against the **source** actor at click time.

### Removing with `@RemoveEnergyDrain`

The restoration counterpart. `temporary` and `permanent=N` can be combined in one button:

| You type | What it does |
| --- | --- |
| `@RemoveEnergyDrain[temporary]{Restoration}` | Removes all temporary + pending bestowed levels |
| `@RemoveEnergyDrain[permanent=1]{Restoration}` | Removes up to 1 permanent level |
| `@RemoveEnergyDrain[temporary;permanent=1]{Restoration}` | Both, in one click |

### From items (static levels)

On any item's **Details** tab, below the creature-type section, is a collapsible **Negative Levels** section: click the header to expand it (the skull icon is the control — full strength when open, dimmed when closed), then tick the box and set an amount. That item then confers that many negative levels **while it is active** — equipped for gear, enabled/active for features and buffs. Unequip or disable the item and the levels go away. These show up as read-only **Static** rows in the manager.

The section starts collapsed on items that have nothing configured, and expanded on items that do — a configured item also shows its level count as a badge on the header, so you can see it without expanding. The choice lasts as long as the sheet stays open and is not saved to the item.

## Recovery (the save)

How bestowed levels recover depends on the **Alternate energy drain rules** world setting (a checkbox):

- **Off** *(default, rules-as-written)* — 24 hours after a bestowal, the creature rolls **one Fortitude save per level**. Each success removes a level; each failure makes it permanent.
- **On** — bestowed levels **never** become permanent, and there is no 24-hour timer. Instead, on each **full rest** (once per day) the creature makes **one** Fortitude save against the **lowest** DC among its negative levels; success sheds a single level from that source.

When [PF1 Roll Requests](https://github.com/) is installed, the save is posted as a targeted roll-request card the affected player rolls themselves; otherwise the module posts its own self-contained Fortitude-save button card. Under the house rule, the GM issues the request even when a player initiates the rest.

## Death

When a creature's negative levels equal or exceed its Hit Dice, it dies — the module applies the **dead** condition and posts a notice. Removing the levels afterward does not automatically revive it (that's left to the GM).

## Settings

- **Alternate energy drain rules** — checkbox, world-scoped. Off: rules-as-written (per-level saves 24h after a bestowal, failures become permanent). On: bestowed levels never become permanent and are instead shed one at a time by a Fortitude save on each full rest, against the lowest DC.

## API

Available as `game.modules.get("pf1-improved-energy-drain").api` (also `pf1EnergyDrain` for convenience). Targets may be an Actor, Token, TokenDocument, or UUID string.

```js
const ed = pf1EnergyDrain;

// Apply. Returns the new instance id.
ed.apply(actor, { kind: "bestowed", amount: 2, name: "Wight", dc: 16 });
ed.apply(actor, { kind: "temporary", amount: 1, name: "Enervation", duration: 3600 });
ed.apply(actor, { kind: "permanent", amount: 1, name: "Raise Dead" });

// Remove.
ed.remove(actor, idOrName);   // one entry, by instance id or by name (all matching)
ed.removeAll(actor);          // every removable (non-static) entry
ed.removePermanent(actor, 1); // up to N permanent levels (restoration)
ed.removeTemporary(actor);    // all temporary + not-yet-permanent bestowed

// Inspect.
ed.getLevels(actor); // current effective total (number)
ed.list(actor);      // every entry (stored + static) with live timing
```

`apply` params: `kind` (`temporary` | `bestowed` | `permanent`), `amount`, `name`, `dc` (bestowed), `duration` (temporary, seconds), `saveDelay` (bestowed, seconds; default 24h).

## Compatibility

- Foundry VTT v13, Pathfinder 1e system v11+.
- Optional: **PF1 Roll Requests** (nicer, player-driven save cards).
- Coexists with **Nevela's Automation Suite**.
