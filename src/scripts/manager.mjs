/**
 * PF1 Improved Energy Drain — negative-level manager window.
 *
 * An ApplicationV2 that lists every negative-level instance on an actor
 * (stored + static) with live timing, offers per-row removal, bulk removal
 * (all temporary / N permanent), and a manual add form. Opened from the
 * actor sheet, which has its Negative Levels field replaced by a total +
 * a button.
 *
 * Static rows are read-only (managed on their item). The window re-renders
 * whenever the actor or its items change, so time-based and external updates
 * stay reflected.
 */

import { MODULE_ID, formatDuration, parseDuration } from "./common.mjs";
import { api } from "./energy-drain.mjs";
import { deriveTotal, listAll } from "./instances.mjs";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const kindLabel = (kind) => game.i18n.localize(`IED.Kind.${kind}`);

export class NegativeLevelManager extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "ied-manager",
    classes: ["pf1-v2", "ied-manager-app"],
    tag: "div",
    window: {
      icon: "fa-solid fa-skull",
      resizable: true,
    },
    position: {
      width: 520,
      height: "auto",
    },
    actions: {
      addInstance: NegativeLevelManager._onAdd,
      removeInstance: NegativeLevelManager._onRemove,
      removeTemporary: NegativeLevelManager._onRemoveTemporary,
      removePermanent: NegativeLevelManager._onRemovePermanent,
    },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/src/templates/manager.hbs` },
  };

  /**
   * @param {Actor} actor
   * @param {object} [options]
   */
  constructor(actor, options = {}) {
    super(options);
    this.actor = actor;
  }

  /** One window per actor; reuse an open one. */
  static open(actor) {
    const id = `ied-manager-${actor.id}`;
    const existing = foundry.applications.instances.get(id);
    if (existing) return existing.bringToFront(), existing;
    const app = new NegativeLevelManager(actor, { id });
    app.render(true);
    return app;
  }

  get title() {
    return `${game.i18n.localize("PF1.NegativeLevels")} — ${this.actor.name}`;
  }

  /** @override */
  async _prepareContext() {
    const at = game.time.worldTime;
    const rows = listAll(this.actor, at);
    const instances = rows.map((v) => this._view(v));
    const permanentTotal = rows
      .filter((i) => i.kind === "permanent")
      .reduce((sum, i) => sum + i.amount, 0);
    return {
      total: deriveTotal(this.actor, at),
      instances,
      permanentTotal,
      hasTemporary: rows.some((i) => i.kind === "temporary" || i.kind === "bestowed"),
    };
  }

  /**
   * Turn a listAll() row into a display view.
   *
   * @param {object} v
   * @returns {object}
   */
  _view(v) {
    let detail = game.i18n.localize("IED.Detail.None");
    switch (v.kind) {
      case "temporary":
        detail = game.i18n.format("IED.Detail.ExpiresIn", { time: formatDuration(v.remaining ?? 0) });
        break;
      case "bestowed": {
        const dc = v.dc ?? game.i18n.localize("IED.Detail.DcNone");
        detail =
          v.saveIn > 0
            ? game.i18n.format("IED.Detail.SaveIn", { dc, time: formatDuration(v.saveIn) })
            : game.i18n.format("IED.Detail.SaveDue", { dc });
        break;
      }
      case "static":
        detail = game.i18n.localize("IED.Detail.Static");
        break;
    }
    return {
      id: v.id,
      kind: v.kind,
      kindLabel: kindLabel(v.kind),
      name: v.name,
      amount: v.amount,
      detail,
      active: v.active !== false,
      removable: v.kind !== "static",
    };
  }

  /* ---------------------------------------- */
  /*  Live refresh                                                            */
  /* ---------------------------------------- */

  /** @override */
  _onFirstRender(context, options) {
    super._onFirstRender(context, options);
    const refresh = (doc) => {
      const actor = doc?.actor ?? doc; // Item -> its actor, or Actor itself
      if (actor === this.actor && this.rendered) this.render();
    };
    const refreshTime = () => {
      if (this.rendered) this.render();
    };
    this._hooks = [
      ["updateActor", Hooks.on("updateActor", refresh)],
      ["updateItem", Hooks.on("updateItem", refresh)],
      ["createItem", Hooks.on("createItem", refresh)],
      ["deleteItem", Hooks.on("deleteItem", refresh)],
      ["updateWorldTime", Hooks.on("updateWorldTime", refreshTime)],
    ];
  }

  /** @override */
  _onClose(options) {
    super._onClose(options);
    for (const [event, id] of this._hooks ?? []) Hooks.off(event, id);
    this._hooks = null;
  }

  /* ---------------------------------------- */
  /*  Actions                                                                 */
  /* ---------------------------------------- */

  static async _onAdd() {
    const params = await promptAddInstance();
    if (params) await api.apply(this.actor, params);
    // Re-render is driven by the updateActor hook once the write lands.
  }

  static async _onRemove(event, target) {
    const id = target.dataset.instanceId;
    const inst = listAll(this.actor).find((i) => i.id === id);
    const label = inst
      ? game.i18n.format("IED.Confirm.RemoveLabel", {
          amount: inst.amount,
          kind: kindLabel(inst.kind),
          name: foundry.utils.escapeHTML(inst.name),
        })
      : game.i18n.localize("IED.Confirm.RemoveEntry");
    if (await confirmRemoval(game.i18n.format("IED.Confirm.Remove", { label }))) {
      await api.remove(this.actor, id);
    }
  }

  static async _onRemoveTemporary() {
    if (await confirmRemoval(game.i18n.localize("IED.Confirm.RemoveTemporary"))) {
      await api.removeTemporary(this.actor);
    }
  }

  static async _onRemovePermanent() {
    const count = parseInt(this.element.querySelector(".ied-perm-count").value, 10) || 0;
    if (count <= 0) return;
    if (await confirmRemoval(game.i18n.format("IED.Confirm.RemovePermanent", { count }))) {
      await api.removePermanent(this.actor, count);
    }
  }
}

/**
 * Yes/no confirmation before a manual removal.
 *
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function confirmRemoval(question) {
  return foundry.applications.api.DialogV2.confirm({
    window: { title: game.i18n.localize("PF1.NegativeLevels"), icon: "fa-solid fa-trash" },
    content: `<p>${question}</p>`,
    classes: ["pf1-v2"],
    modal: true,
    rejectClose: false,
  });
}

/* -------------------------------------------- */
/*  Add dialog                                                                */
/* -------------------------------------------- */

/**
 * Prompt for a new instance. Fields shown depend on the selected kind:
 * permanent = name + levels; temporary = + duration; bestowed = + save DC.
 *
 * @returns {Promise<object|null>} apply() params, or null if cancelled.
 */
async function promptAddInstance() {
  const { DialogV2 } = foundry.applications.api;
  const negLevels = game.i18n.localize("PF1.NegativeLevels");
  const content = `
    <form class="ied-add-form">
      <div class="form-group">
        <label>${game.i18n.localize("IED.Field.Type")}</label>
        <select name="kind">
          <option value="temporary">${kindLabel("temporary")}</option>
          <option value="bestowed" selected>${kindLabel("bestowed")}</option>
          <option value="permanent">${kindLabel("permanent")}</option>
        </select>
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("IED.Field.Name")}</label>
        <input type="text" name="name" placeholder="${negLevels}">
      </div>
      <div class="form-group">
        <label>${game.i18n.localize("IED.Field.Levels")}</label>
        <input type="number" name="amount" value="1" min="1" step="1" autofocus>
      </div>
      <div class="form-group ied-field-dc">
        <label>${game.i18n.localize("IED.Field.SaveDC")}</label>
        <input type="number" name="dc" min="0" step="1" placeholder="—">
      </div>
      <div class="form-group ied-field-duration">
        <label>${game.i18n.localize("IED.Field.Duration")}</label>
        <input type="text" name="duration" placeholder="1h">
      </div>
    </form>`;

  return DialogV2.wait({
    window: { title: negLevels, icon: "fa-solid fa-skull" },
    classes: ["pf1-v2", "ied-add-dialog"],
    position: { width: 360 },
    content,
    rejectClose: false,
    close: () => null,
    render: (event, html) => {
      const root = html instanceof DialogV2 ? html.element : html;
      const form = root.querySelector("form");
      const dcRow = form.querySelector(".ied-field-dc");
      const durRow = form.querySelector(".ied-field-duration");
      const addBtn = root.querySelector('button[data-action="add"]');
      const refresh = () => {
        const kind = form.elements.kind.value;
        dcRow.style.display = kind === "bestowed" ? "" : "none";
        durRow.style.display = kind === "temporary" ? "" : "none";

        // Required fields per kind: amount always; bestowed needs a DC; temporary
        // needs a real duration. Keep Add disabled until they're valid so a level
        // can't be created that would silently never save / instantly expire.
        const amount = parseInt(form.elements.amount.value, 10);
        let valid = Number.isInteger(amount) && amount >= 1;
        if (kind === "bestowed") {
          const dc = parseInt(form.elements.dc.value, 10);
          valid &&= Number.isInteger(dc) && dc >= 0;
        }
        if (kind === "temporary") valid &&= parseDuration(form.elements.duration.value) > 0;
        if (addBtn) addBtn.disabled = !valid;
      };
      form.addEventListener("input", refresh);
      form.addEventListener("change", refresh);
      refresh();
    },
    buttons: [
      {
        icon: "fa-solid fa-plus",
        label: game.i18n.localize("IED.Button.Add"),
        action: "add",
        default: true,
        callback: (event, button, html) => {
          const root = html instanceof DialogV2 ? html.element : html;
          const form = root.querySelector("form");
          const kind = form.elements.kind.value;
          const amount = parseInt(form.elements.amount.value, 10) || 1;
          const name = form.elements.name.value.trim();
          const params = { kind, amount, name: name || undefined };
          if (kind === "bestowed" && form.elements.dc.value !== "") {
            params.dc = parseInt(form.elements.dc.value, 10);
          }
          if (kind === "temporary") params.duration = parseDuration(form.elements.duration.value);
          return params;
        },
      },
      {
        icon: "fa-solid fa-xmark",
        label: game.i18n.localize("IED.Button.Cancel"),
        action: "cancel",
        callback: () => null,
      },
    ],
  });
}

/* -------------------------------------------- */
/*  Actor-sheet field replacement                                             */
/* -------------------------------------------- */

function onRenderActorSheet(app, html) {
  const actor = app.actor ?? app.document;
  if (!actor) return;
  const $html = html instanceof jQuery ? html : $(html);
  const group = $html.find(".form-group.negative-levels");
  if (!group.length) return;

  const total = deriveTotal(actor);
  // Mirror the sibling trait rows (senses, resistances): a flex-growing
  // traits-list holding the value, then a right-justified edit button.
  const replacement = $(`
    <ul class="traits-list tag-list ied-neg-list"><li class="tag">${total}</li></ul>
    <a class="ied-open-manager trait-selector" data-tooltip="${game.i18n.localize("IED.Tooltip.Manage")}"><i class="fa-solid fa-list-ul fa-fw" inert></i></a>
  `);
  const input = group.find('input[name="system.attributes.energyDrain"]');
  if (input.length) input.replaceWith(replacement);
  else group.append(replacement);

  group.find("a.ied-open-manager").on("click", (ev) => {
    ev.preventDefault();
    NegativeLevelManager.open(actor);
  });
}

Hooks.on("renderActorSheetPF", onRenderActorSheet);
