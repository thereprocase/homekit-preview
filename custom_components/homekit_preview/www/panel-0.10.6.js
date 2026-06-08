const ICON_URL = "/homekit_preview_static/icon.svg";
const PANEL_TAG = "homekit-preview-panel-v0106";
const BUILD_LABEL = "0.10.6 · filter-feedback";
const EMPTY_FILTER = {
  include_domains: [], include_entities: [], include_entity_globs: [],
  exclude_domains: [], exclude_entities: [], exclude_entity_globs: [],
};

class HomeKitPreviewPanel extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._data = this._data || null;
    this._selected = this._selected || "";
    if (!this._initialized) {
      this._tab = "preview";
      this._initialized = true;
    } else {
      this._tab = this._tab || "preview";
    }
    this._deviceKey = this._deviceKey || "";
    this._filters = this._filters || {
      preview: { room: "all", search: "" },
      device: { room: "all", search: "" },
      raw: { room: "all", search: "" },
    };
    this._proxyDraft = this._proxyDraft || null;
    this._focusProxyBuilder = this._focusProxyBuilder || false;
    this._focusTarget = this._focusTarget || null;
    this._confirm = this._confirm || null;
    this._confirmResolve = this._confirmResolve || null;
    this._confirmReturnFocus = this._confirmReturnFocus || "";
    this._drafts = this._drafts || {};
    this._loading = false;
    this._loadedOnce = this._loadedOnce || false;
    this._message = "";
    this.render();
    this.maybeLoad();
  }

  set hass(hass) { this._hass = hass; this.maybeLoad(); }

  maybeLoad() {
    if (this._hass && !this._loadedOnce && !this._loading) this.loadData(false);
  }

  async loadData(scan) {
    if (!this._hass) return;
    this._loading = true;
    this._message = "";
    this.render();
    try {
      const data = scan
        ? await this._hass.callApi("POST", "homekit_preview/scan")
        : await this._hass.callApi("GET", "homekit_preview/preview");
      this._data = data || {};
      this._loadedOnce = true;
      const entries = this._data.entries || [];
      if (!this._selected && entries.length) this._selected = entries[0].entry_id;
      if (entries.length && !entries.some((entry) => entry.entry_id === this._selected)) this._selected = entries[0].entry_id;
      this.ensureDraft(this.selectedEntry());
    } catch (err) {
      this._message = `Load failed: ${err?.message || err}`;
      this._loadedOnce = true;
    } finally {
      this._loading = false;
      this.render();
    }
  }

  selectedEntry() {
    const entries = this._data?.entries || [];
    return entries.find((entry) => entry.entry_id === this._selected) || entries[0] || null;
  }

  candidates(entry) { return entry?.candidate_entities || entry?.exposed_entities || []; }
  liveIds(entry) { return new Set(this.candidates(entry).filter((e) => e.currently_exposed).map((e) => e.entity_id)); }
  entityById(entry, entityId) { return this.candidates(entry).find((e) => e.entity_id === entityId) || null; }


  filterFor(tab = this._tab) {
    if (!this._filters[tab]) this._filters[tab] = { room: "all", search: "" };
    return this._filters[tab];
  }

  clearFilters(tab = this._tab) {
    const filter = this.filterFor(tab);
    filter.room = "all";
    filter.search = "";
    if (tab === "device") this._deviceKey = "";
    this.render();
  }

  hasFilters(tab = this._tab) {
    const filter = this.filterFor(tab);
    return filter.room !== "all" || Boolean(filter.search.trim());
  }

  dropById(entry, entityId) {
    return (entry?.explicit_include_not_exposed || []).find((item) => item.entity_id === entityId) || this.entityById(entry, entityId);
  }

  proxyProfilesFor(item) {
    const direct = item?.proxy_profiles || [];
    if (direct.length) return direct;
    const unit = item?.unit_of_measurement;
    return (this._data?.proxy_profiles || []).filter((profile) => profile.unit === unit);
  }

  slugPreview(value) {
    return String(value || "proxy")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "proxy";
  }
  ensureDraft(entry) {
    if (!entry) return new Set();
    if (!this._drafts[entry.entry_id]) this._drafts[entry.entry_id] = Array.from(this.liveIds(entry)).sort();
    return new Set(this._drafts[entry.entry_id]);
  }

  saveDraft(entry, set) { this._drafts[entry.entry_id] = Array.from(set).sort(); }
  exactFilter(entry) { return { ...EMPTY_FILTER, include_entities: Array.from(this.ensureDraft(entry)).sort() }; }

  draftStats(entry) {
    const live = this.liveIds(entry);
    const draft = this.ensureDraft(entry);
    let added = 0, removed = 0;
    for (const id of draft) if (!live.has(id)) added += 1;
    for (const id of live) if (!draft.has(id)) removed += 1;
    return { live: live.size, draft: draft.size, added, removed, changed: added + removed };
  }

  toggleEntity(entry, entityId, on) {
    const entity = this.entityById(entry, entityId);
    if (on && entity?.selectable === false) return;
    const draft = this.ensureDraft(entry);
    if (on === undefined) draft.has(entityId) ? draft.delete(entityId) : draft.add(entityId);
    else if (on) draft.add(entityId);
    else draft.delete(entityId);
    this.saveDraft(entry, draft);
    this.render();
  }

  setEntities(entry, entities, on) {
    const draft = this.ensureDraft(entry);
    for (const entity of entities) {
      if (on && entity.selectable === false) continue;
      on ? draft.add(entity.entity_id) : draft.delete(entity.entity_id);
    }
    this.saveDraft(entry, draft);
    this.render();
  }

  resetDraft(entry) { delete this._drafts[entry.entry_id]; this.ensureDraft(entry); this.render(); }
  clearDraft(entry) { this._drafts[entry.entry_id] = []; this.render(); }

  async applyDraft(entry) {
    if (!entry) return;
    const filter = this.exactFilter(entry);
    const ok = await this.confirmAction({
      title: "Apply exact HomeKit list",
      body: `Write ${filter.include_entities.length} explicit entities to ${entry.title} and reload that HomeKit entry. Domain-wide includes are replaced by this exact list.`,
      confirmLabel: "Apply exact list",
      tone: "warn",
      meta: [`${filter.include_entities.length} entities`, "Reloads bridge entry"],
    });
    if (!ok) return;
    this._loading = true;
    this._message = "Applying filter...";
    this.render();
    try {
      const data = await this._hass.callApi("POST", "homekit_preview/update_filter", {
        entry_id: entry.entry_id,
        filter,
        reload: true,
      });
      this._data = data || this._data;
      delete this._drafts[entry.entry_id];
      this.ensureDraft(this.selectedEntry());
      this._message = "Applied. HomeKit entry reloaded.";
    } catch (err) {
      this._message = `Apply failed: ${err?.message || err}`;
    } finally {
      this._loading = false;
      this.render();
    }
  }


  startProxy(entry, entityId) {
    const source = this.dropById(entry, entityId);
    const profiles = this.proxyProfilesFor(source);
    if (!source || !profiles.length) {
      this._message = "No same-unit HomeKit helper target is available for that entity.";
      this.render();
      return;
    }
    const defaultName = source.name || source.entity_id;
    this._proxyDraft = {
      entry_id: entry.entry_id,
      source_entity_id: source.entity_id,
      target_profile_id: profiles[0].id,
      name: defaultName,
      include_in_bridge: true,
      replace_source: true,
    };
    this._tab = "preview";
    this._focusProxyBuilder = true;
    this._message = `Proxy helper draft opened for ${source.entity_id}.`;
    this.render();
  }

  async createProxy(entry) {
    if (!this._hass || !this._proxyDraft) return;
    const nameInput = this.shadowRoot?.getElementById("proxyName");
    const profileSelect = this.shadowRoot?.getElementById("proxyProfile");
    const include = this.shadowRoot?.getElementById("proxyIncludeBridge");
    const replace = this.shadowRoot?.getElementById("proxyReplaceSource");
    const name = String(nameInput?.value || "").trim();
    if (!name) {
      this._message = "Helper name is required.";
      this.render();
      return;
    }
    this._proxyDraft.name = name;
    this._proxyDraft.target_profile_id = profileSelect?.value || this._proxyDraft.target_profile_id;
    this._proxyDraft.include_in_bridge = include?.checked !== false;
    this._proxyDraft.replace_source = replace?.checked !== false;
    const sourceId = this._proxyDraft.source_entity_id;
    const ok = await this.confirmAction({
      title: "Create proxy helper",
      body: `Create a Home Assistant helper for ${sourceId}. Apple Home will see the helper entity with supported HomeKit metadata, not the original unsupported source.`,
      confirmLabel: "Create helper",
      tone: "warn",
      meta: [name, sourceId],
    });
    if (!ok) return;
    this._loading = true;
    this._message = "Creating helper entity...";
    this.render();
    try {
      const data = await this._hass.callApi("POST", "homekit_preview/proxies", {
        source_entity_id: this._proxyDraft.source_entity_id,
        target_profile_id: this._proxyDraft.target_profile_id,
        name,
        bridge_entry_id: entry.entry_id,
        include_in_bridge: this._proxyDraft.include_in_bridge,
        replace_source: this._proxyDraft.replace_source,
      });
      this._data = data || this._data;
      delete this._drafts[entry.entry_id];
      this.ensureDraft(this.selectedEntry());
      const proxy = data?.created_proxy;
      this._proxyDraft = null;
      this._message = proxy?.entity_id ? `Created helper ${proxy.entity_id} and refreshed HomeKit Preview.` : "Created helper entity.";
    } catch (err) {
      this._message = `Helper failed: ${err?.message || err}`;
    } finally {
      this._loading = false;
      this.render();
    }
  }

  homeKitTypeBadge(entity) {
    const profiles = this.proxyProfilesFor(entity);
    if (entity?.homekit_supported) {
      return `<span class="statusBadge good">${this.escape(entity.homekit_type || "HomeKit")}</span>`;
    }
    if (profiles.length) {
      return `<span class="statusBadge warn">Available by proxy</span>`;
    }
    return `<span class="statusBadge bad">${this.escape(entity?.homekit_type || "unsupported")}</span>`;
  }

  colgroup(widths) {
    return `<colgroup>${widths.map((width) => `<col style="width:${width}">`).join("")}</colgroup>`;
  }

  proxyReadyDropCount(entry) {
    return (entry?.explicit_include_not_exposed || []).filter((item) => this.proxyProfilesFor(item).length).length;
  }

  sectionHead(title, meta = [], note = "") {
    const chips = meta.filter(Boolean).map((item) => `<span class="chip">${this.escape(item)}</span>`).join("");
    return `<div class="sectionHead"><div><div class="sectionTitle">${this.escape(title)}</div>${note ? `<div class="sectionNote">${this.escape(note)}</div>` : ""}</div>${chips ? `<div class="sectionMeta">${chips}</div>` : ""}</div>`;
  }

  confirmAction({ title, body, confirmLabel = "Continue", cancelLabel = "Cancel", tone = "", meta = [] }) {
    if (this._confirmResolve) this._confirmResolve(false);
    const active = this.shadowRoot?.activeElement;
    this._confirmReturnFocus = active?.id || "";
    return new Promise((resolve) => {
      this._confirmResolve = resolve;
      this._confirm = { title, body, confirmLabel, cancelLabel, tone, meta };
      this.render();
      requestAnimationFrame(() => this.shadowRoot?.getElementById("confirmPrimary")?.focus());
    });
  }

  resolveConfirm(result) {
    const resolve = this._confirmResolve;
    const returnFocus = !result ? this._confirmReturnFocus : "";
    this._confirmResolve = null;
    this._confirmReturnFocus = "";
    this._confirm = null;
    this.render();
    if (returnFocus) requestAnimationFrame(() => this.shadowRoot?.getElementById(returnFocus)?.focus());
    resolve?.(result);
  }

  handleConfirmKey(ev) {
    if (ev.key === "Escape") {
      ev.preventDefault();
      this.resolveConfirm(false);
      return;
    }
    if (ev.key !== "Tab") return;
    const buttons = Array.from(this.shadowRoot?.querySelectorAll("#confirmDialog button") || []).filter((item) => !item.disabled);
    if (!buttons.length) return;
    const current = this.shadowRoot?.activeElement;
    const index = buttons.indexOf(current);
    if (ev.shiftKey && index <= 0) {
      ev.preventDefault();
      buttons[buttons.length - 1].focus();
    } else if (!ev.shiftKey && index === buttons.length - 1) {
      ev.preventDefault();
      buttons[0].focus();
    }
  }

  renderConfirmDialog() {
    const dialog = this._confirm;
    if (!dialog) return "";
    const meta = (dialog.meta || []).filter(Boolean).map((item) => `<span class="chip">${this.escape(item)}</span>`).join("");
    return `<div class="confirmScrim" role="presentation">
      <section id="confirmDialog" class="confirmDialog ${this.escape(dialog.tone || "")}" role="dialog" aria-modal="true" aria-labelledby="confirmTitle" aria-describedby="confirmBody" tabindex="-1">
        <div class="confirmTitle" id="confirmTitle">${this.escape(dialog.title)}</div>
        <div class="confirmBody" id="confirmBody">${this.escape(dialog.body)}</div>
        ${meta ? `<div class="confirmMeta">${meta}</div>` : ""}
        <div class="confirmActions"><button class="secondary" id="confirmCancel">${this.escape(dialog.cancelLabel || "Cancel")}</button><button id="confirmPrimary" class="${dialog.tone === "danger" ? "danger" : ""}">${this.escape(dialog.confirmLabel || "Continue")}</button></div>
      </section>
    </div>`;
  }

  async reloadPreview() {
    if (!this._hass) return;
    const ok = await this.confirmAction({
      title: "Reload HomeKit Preview",
      body: "Reload the helper integration only. HomeKit Bridge entries keep running. Python code changes still need a Home Assistant Core restart before this button can use the new code.",
      confirmLabel: "Reload Preview",
      meta: ["HomeKit Bridge unchanged"],
    });
    if (!ok) return;
    this._loading = true;
    this._message = "Reloading HomeKit Preview...";
    this.render();
    try {
      const result = await this._hass.callApi("POST", "homekit_preview/reload_self");
      await new Promise((resolve) => setTimeout(resolve, 1000));
      this._loading = false;
      await this.loadData(true);
      this._message = result?.message || "Reloaded HomeKit Preview.";
    } catch (err) {
      this._message = `Reload failed: ${err?.message || err}`;
    } finally {
      this._loading = false;
      this.render();
    }
  }

  async copyText(text, label) {
    try { await navigator.clipboard.writeText(text); this._message = `${label} copied.`; }
    catch (err) { this._message = `Copy failed: ${err?.message || err}`; }
    this.render();
  }

  jumpTo(tab, targetId, message = "") {
    this._tab = tab || this._tab;
    this._focusTarget = targetId || null;
    if (message) this._message = message;
    this.render();
  }

  focusTarget(targetId) {
    if (!targetId) return;
    requestAnimationFrame(() => {
      const target = this.shadowRoot?.getElementById(targetId);
      target?.scrollIntoView({ block: "start", behavior: "smooth" });
      target?.focus?.({ preventScroll: true });
    });
  }


  rooms(entry) {
    const names = new Set(this.candidates(entry).map((e) => e.area || "No room"));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }

  deviceKey(entity) { return `${entity.area || "No room"}|||${entity.device || "No device"}|||${entity.device_id || ""}`; }

  deviceCount(entry) {
    return new Set(this.candidates(entry).map((entity) => this.deviceKey(entity))).size;
  }

  devices(entry) {
    const filter = this.filterFor("device");
    const q = filter.search.trim().toLowerCase();
    const groups = new Map();
    for (const entity of this.candidates(entry)) {
      const room = entity.area || "No room";
      if (filter.room !== "all" && room !== filter.room) continue;
      const hay = [entity.entity_id, entity.name, entity.domain, entity.area, entity.device, entity.state, entity.inclusion_reason, entity.simulation_reason].filter(Boolean).join(" ").toLowerCase();
      if (q && !hay.includes(q)) continue;
      const key = this.deviceKey(entity);
      if (!groups.has(key)) groups.set(key, { key, room, name: entity.device || "No device", entities: [] });
      groups.get(key).entities.push(entity);
    }
    const devices = Array.from(groups.values()).sort((a, b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
    if (devices.length && !devices.some((device) => device.key === this._deviceKey)) this._deviceKey = devices[0].key;
    if (!devices.length) this._deviceKey = "";
    return devices;
  }

  selectedDevice(entry) { return this.devices(entry).find((device) => device.key === this._deviceKey) || this.devices(entry)[0] || null; }

  rowMatches(entity, tab = "preview") {
    const q = this.filterFor(tab).search.trim().toLowerCase();
    if (!q) return true;
    return [entity.entity_id, entity.name, entity.domain, entity.area, entity.device, entity.state, entity.inclusion_reason, entity.simulation_reason, entity.support_reason]
      .filter(Boolean).join(" ").toLowerCase().includes(q);
  }

  filteredPreviewRows(entry) {
    const filter = this.filterFor("preview");
    return (entry?.exposed_entities || []).filter((entity) => {
      if (filter.room !== "all" && (entity.area || "No room") !== filter.room) return false;
      return this.rowMatches(entity, "preview");
    });
  }

  scheduleSearch(tab, value) {
    const filter = this.filterFor(tab);
    filter.search = value;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      const inputId = `entitySearch-${tab}`;
      const input = this.shadowRoot?.getElementById(inputId);
      const selection = typeof input?.selectionStart === "number" ? input.selectionStart : filter.search.length;
      this.render();
      const next = this.shadowRoot?.getElementById(inputId);
      if (next) {
        next.focus();
        const pos = Math.min(selection, next.value.length);
        next.setSelectionRange?.(pos, pos);
      }
    }, 220);
  }


  renderStyles() {
    return `<style>
      :host {
        --hp-radius: 8px;
        --hp-gap: 14px;
        --hp-surface: var(--card-background-color);
        --hp-surface-soft: color-mix(in srgb, var(--secondary-background-color) 72%, var(--card-background-color));
        --hp-border: 1px solid var(--divider-color);
        --hp-shadow: var(--ha-card-box-shadow, 0 1px 3px rgba(0, 0, 0, .16));
        display: block;
        min-height: 100vh;
        box-sizing: border-box;
        padding: 20px;
        color: var(--primary-text-color);
        background: var(--primary-background-color);
      }
      * { box-sizing: border-box; }
      .wrap { max-width: 1440px; margin: 0 auto; min-width: 0; }
      .wrap > *, .stack > *, .layout > *, .panel, .notice, .card, .controlBar, .tableWrap { min-width: 0; }
      .stack { display: flex; flex-direction: column; gap: var(--hp-gap); }
      .top { display: grid; grid-template-columns: minmax(260px, 1fr) minmax(360px, 560px); gap: var(--hp-gap); align-items: stretch; margin-bottom: 12px; }
      .brandBlock, .bridgeBlock, .metric, .card, .panel, .notice, .controlBar, .tableWrap, .stateCard { border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface); box-shadow: var(--hp-shadow); }
      .brandBlock { display: flex; gap: 12px; align-items: center; min-width: 0; padding: 14px; }
      .bridgeBlock { min-width: 0; display: flex; flex-direction: column; gap: 8px; padding: 14px; }
      .appIcon { width: 46px; height: 46px; border-radius: var(--hp-radius); flex: 0 0 auto; }
      h1 { margin: 0; font-size: 24px; line-height: 1.15; font-weight: 800; letter-spacing: 0; }
      .sub, .muted { color: var(--secondary-text-color); }
      .sub { margin-top: 4px; font-size: 13px; }
      .bridgeTitle { font-size: 13px; color: var(--secondary-text-color); font-weight: 700; text-transform: uppercase; letter-spacing: 0; }
      .bridgeActions, .controls, .toolbar, .actionRow, .sectionHead, .sectionMeta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .bridgeActions select { flex: 1 1 180px; min-width: 0; max-width: 100%; }
      .bridgeActions button { flex: 0 0 auto; }
      select, input, button { min-height: 34px; max-width: 100%; font: inherit; border-radius: var(--hp-radius); border: var(--hp-border); background: var(--hp-surface); color: var(--primary-text-color); padding: 6px 9px; line-height: 1.2; }
      select { overflow: hidden; text-overflow: ellipsis; }
      input { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      button { cursor: pointer; border-color: var(--primary-color); background: var(--primary-color); color: var(--text-primary-color); font-weight: 700; white-space: nowrap; overflow-wrap: normal; }
      button.secondary { background: var(--hp-surface); color: var(--primary-text-color); border-color: var(--divider-color); }
      button.danger { background: var(--error-color, #db4437); border-color: var(--error-color, #db4437); color: white; }
      button[disabled] { opacity: .52; cursor: not-allowed; }
      button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 2px; }
      .tabs { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 4px; margin: 0 0 12px; border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface-soft); max-width: 100%; }
      .tab, .pill, .miniBtn { min-height: 32px; border-radius: calc(var(--hp-radius) - 2px); border-color: transparent; background: transparent; color: var(--primary-text-color); padding: 6px 9px; font-size: 13px; }
      .tab { display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
      .tabText.short { display: none; }
      .miniBtn { display: inline-flex; align-items: center; justify-content: center; }
      .tab.active, .pill.active { background: var(--primary-color); color: var(--text-primary-color); }
      .tabBadge { min-width: 22px; min-height: 20px; padding: 2px 6px; border-radius: 999px; background: var(--hp-surface); border: var(--hp-border); color: var(--secondary-text-color); font-size: 12px; font-weight: 850; line-height: 1.2; }
      .tab.active .tabBadge { background: color-mix(in srgb, var(--text-primary-color) 18%, transparent); border-color: color-mix(in srgb, var(--text-primary-color) 46%, transparent); color: var(--text-primary-color); }
      .overviewGrid { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 10px; margin: 0 0 10px; }
      .overviewCard { padding: 13px; min-width: 0; border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface); box-shadow: var(--hp-shadow); border-top: 4px solid transparent; }
      .overviewCard.primary { border-top-color: var(--primary-color); }
      .overviewCard.goodCard { border-top-color: var(--success-color, #0b8043); }
      .overviewCard.warnCard { border-top-color: var(--warning-color, #ffa600); }
      .overviewCard.badCard { border-top-color: var(--error-color, #db4437); }
      .overviewValue { font-size: 28px; font-weight: 850; line-height: 1; overflow-wrap: anywhere; }
      .overviewLabel { margin-top: 7px; color: var(--primary-text-color); font-size: 13px; font-weight: 800; }
      .overviewNote { margin-top: 4px; color: var(--secondary-text-color); font-size: 12px; line-height: 1.35; }
      .actionSummary { display: grid; grid-template-columns: minmax(220px, 1.15fr) repeat(3, minmax(160px, 1fr)); gap: 10px; margin: 0 0 10px; }
      .actionTile { border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface); box-shadow: var(--hp-shadow); padding: 12px; min-width: 0; display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 10px; align-items: start; border-left: 4px solid var(--divider-color); }
      .actionTile.good { border-left-color: var(--success-color, #0b8043); }
      .actionTile.warn { border-left-color: var(--warning-color, #ffa600); }
      .actionTile.bad { border-left-color: var(--error-color, #db4437); }
      .actionIcon { width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-weight: 850; background: var(--hp-surface-soft); color: var(--primary-text-color); }
      .actionTile.good .actionIcon { color: var(--success-color, #0b8043); }
      .actionTile.warn .actionIcon { color: var(--warning-color, #ffa600); }
      .actionTile.bad .actionIcon { color: var(--error-color, #db4437); }
      .actionTitle { font-weight: 850; line-height: 1.2; overflow-wrap: anywhere; }
      .actionNote { margin-top: 3px; color: var(--secondary-text-color); font-size: 12px; line-height: 1.35; overflow-wrap: anywhere; }
      .actionLink { margin-top: 9px; min-height: 28px; padding: 4px 8px; border-radius: 6px; font-size: 12px; line-height: 1.2; }
      .diagnosticStrip { display: flex; gap: 7px; flex-wrap: wrap; align-items: center; margin: 0 0 var(--hp-gap); padding: 9px 10px; border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface-soft); }
      .diagnosticLabel { color: var(--secondary-text-color); font-size: 12px; font-weight: 800; }
      .draftBar { position: sticky; bottom: 12px; z-index: 3; display: grid; grid-template-columns: minmax(220px, 1fr) auto; gap: 10px; align-items: center; padding: 12px; border: var(--hp-border); border-top: 3px solid var(--primary-color); border-radius: var(--hp-radius); background: color-mix(in srgb, var(--hp-surface) 94%, var(--primary-background-color)); box-shadow: 0 10px 26px rgba(0, 0, 0, .18); backdrop-filter: blur(8px); }
      .draftState { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
      .draftTitle { font-size: 16px; font-weight: 850; line-height: 1.2; }
      .draftMeta { display: flex; gap: 7px; flex-wrap: wrap; }
      .draftActions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .draftActions button { min-height: 34px; }
      .debugSummary { display: grid; grid-template-columns: repeat(4, minmax(150px, 1fr)); gap: 10px; }
      .debugTile { border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface); box-shadow: var(--hp-shadow); padding: 12px; min-width: 0; border-left: 4px solid var(--primary-color); }
      .debugTile.warn { border-left-color: var(--warning-color, #ffa600); }
      .debugTile.bad { border-left-color: var(--error-color, #db4437); }
      .debugTileValue { font-size: 22px; line-height: 1.05; font-weight: 850; overflow-wrap: anywhere; }
      .debugTileLabel { margin-top: 6px; color: var(--secondary-text-color); font-size: 12px; line-height: 1.35; }
      .debugGrid { display: grid; grid-template-columns: minmax(260px, 420px) minmax(0, 1fr); gap: var(--hp-gap); align-items: start; }
      .debugPanel { min-width: 0; }
      .debugPanel pre { max-height: 64vh; font-size: 12px; line-height: 1.45; }
      .debugActions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
      .summaryGrid { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 10px; margin: 0 0 var(--hp-gap); }
      .metric { padding: 12px; min-width: 0; border-left: 4px solid transparent; }
      .metric.primary { border-left-color: var(--primary-color); }
      .metric.warn { border-left-color: var(--warning-color, #ffa600); }
      .metric.badMetric { border-left-color: var(--error-color, #db4437); }
      .metricValue { font-size: 24px; font-weight: 850; line-height: 1.05; overflow-wrap: anywhere; }
      .metricLabel { margin-top: 6px; color: var(--secondary-text-color); font-size: 13px; }
      .card, .panel, .notice { padding: 14px; }
      .notice { border-left: 4px solid var(--success-color, #0b8043); margin-bottom: var(--hp-gap); overflow-wrap: anywhere; }
      .statusNotice { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 10px; align-items: start; padding: 11px 12px; }
      .statusNoticeText { min-width: 0; line-height: 1.35; }
      .dismissNotice { min-width: 30px; min-height: 30px; padding: 3px 8px; border-radius: 6px; }
      .compactNotice { margin-bottom: 0; }
      .notice.warn, .warn { border-left-color: var(--warning-color, #ffa600); }
      .notice.error, .error { border-left-color: var(--error-color, #db4437); }
      .notice.ok, .ok { border-left-color: var(--success-color, #0b8043); }
      .sectionTitle { font-size: 17px; font-weight: 800; margin: 0; }
      .sectionHead { justify-content: space-between; align-items: flex-start; margin: 0 0 10px; }
      .sectionHead > div:first-child { min-width: 0; }
      .sectionMeta { justify-content: flex-end; gap: 6px; min-width: 0; }
      .sectionMeta .chip { max-width: min(220px, 100%); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .sectionNote { margin-top: 5px; color: var(--secondary-text-color); line-height: 1.4; }
      .tableCard { border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface); box-shadow: var(--hp-shadow); overflow: hidden; min-width: 0; scroll-margin-top: 12px; }
      .tableCard:focus, .panel:focus, .draftBar:focus { outline: 2px solid var(--primary-color); outline-offset: 2px; }
      .tableCard > .sectionHead { padding: 12px 14px 10px; margin: 0; }
      .tableCard > .tableWrap { border: 0; border-top: var(--hp-border); border-radius: 0; box-shadow: none; }
      .warnCard { border-left: 4px solid var(--warning-color, #ffa600); }
      .layout { display: grid; grid-template-columns: minmax(240px, 320px) minmax(0, 1fr); gap: var(--hp-gap); align-items: start; }
      .deviceList { display: flex; flex-direction: column; gap: 7px; max-height: 64vh; overflow: auto; padding-right: 2px; }
      .deviceCard { appearance: none; width: 100%; text-align: left; background: var(--hp-surface); color: var(--primary-text-color); border: var(--hp-border); border-radius: var(--hp-radius); padding: 10px; cursor: pointer; border-left: 4px solid transparent; overflow: hidden; white-space: normal; overflow-wrap: anywhere; font-weight: inherit; line-height: 1.32; }
      .deviceCard.active { border-color: var(--primary-color); box-shadow: inset 3px 0 0 var(--primary-color); }
      .deviceCard.attention { border-left-color: var(--warning-color, #ffa600); }
      .deviceCard.dropAttention { border-left-color: var(--error-color, #db4437); }
      .deviceCardTop { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, max-content); align-items: start; gap: 8px; min-width: 0; }
      .deviceCardTitle { min-width: 0; max-width: 100%; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; font-weight: 850; line-height: 1.25; overflow-wrap: anywhere; word-break: break-word; }
      .deviceCue { flex: 0 0 auto; justify-self: end; justify-content: center; max-width: 122px; text-align: center; }
      .deviceCard .muted { margin-top: 3px; font-size: 12px; line-height: 1.3; }
      .deviceCard .chips { gap: 5px; margin-top: 7px; }
      .deviceCard .chip { min-height: 20px; padding: 2px 6px; font-size: 11px; }
      .chips { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 8px; min-width: 0; }
      .chip, .statusBadge { display: inline-flex; align-items: center; max-width: 100%; min-width: 0; min-height: 22px; padding: 3px 7px; border-radius: 999px; border: var(--hp-border); background: var(--hp-surface-soft); font-size: 12px; line-height: 1.2; overflow-wrap: anywhere; white-space: normal; }
      .filterChip { gap: 5px; max-width: min(100%, 520px); }
      .filterChip b { flex: 0 0 auto; }
      .filterChipText { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .filterChipMore { flex: 0 0 auto; color: var(--secondary-text-color); font-weight: 800; }
      .statusBadge.good { border-color: color-mix(in srgb, var(--success-color, #0b8043) 50%, var(--divider-color)); background: color-mix(in srgb, var(--success-color, #0b8043) 12%, var(--hp-surface)); }
      .statusBadge.bad { border-color: color-mix(in srgb, var(--error-color, #db4437) 55%, var(--divider-color)); background: color-mix(in srgb, var(--error-color, #db4437) 12%, var(--hp-surface)); }
      .statusBadge.warn, .warnChip { border-color: color-mix(in srgb, var(--warning-color, #ffa600) 60%, var(--divider-color)); background: color-mix(in srgb, var(--warning-color, #ffa600) 16%, var(--hp-surface)); }
      .hkDrop { border-color: var(--error-color, #db4437); background: color-mix(in srgb, var(--error-color, #db4437) 16%, var(--hp-surface)); color: var(--error-color, #db4437); font-weight: 850; }
      .controlBar { display: grid; grid-template-columns: minmax(132px, 210px) minmax(220px, 1fr) max-content; gap: 7px; padding: 7px; margin-bottom: 12px; align-items: center; }
      .controlField { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: 7px; min-width: 0; }
      .fieldLabel { flex: 0 0 auto; color: var(--secondary-text-color); font-size: 12px; font-weight: 800; white-space: nowrap; }
      .controlBar select, .controlBar input { min-width: 0; width: 100%; }
      .filterReset { align-self: center; min-width: 96px; white-space: nowrap; }
      .filterSummary { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; margin: -6px 0 12px; padding: 8px 10px; border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface-soft); color: var(--secondary-text-color); font-size: 12px; line-height: 1.3; }
      .filterSummary strong { color: var(--primary-text-color); }
      .filterSummary .filterReset { min-height: 28px; min-width: 0; padding: 4px 8px; margin-left: auto; font-size: 12px; }
      .tableWrap { overflow-x: auto; overflow-y: hidden; max-width: 100%; overscroll-behavior-x: contain; scrollbar-gutter: stable; }
      table { width: 100%; min-width: 720px; border-collapse: collapse; table-layout: fixed; }
      .deviceTable { min-width: 780px; }
      .dropTable { min-width: 760px; }
      .previewTable { min-width: 780px; }
      th, td { text-align: left; padding: 7px 9px; border-bottom: 1px solid var(--divider-color); vertical-align: top; overflow-wrap: anywhere; word-break: normal; line-height: 1.34; }
      th { position: sticky; top: 0; z-index: 1; color: var(--secondary-text-color); background: var(--hp-surface-soft); font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
      tr:last-child td { border-bottom: 0; }
      .selectedRow td { background: color-mix(in srgb, var(--success-color, #0b8043) 10%, transparent); }
      .entityCell code { display: inline-block; max-width: 100%; }
      .actionCell { text-align: right; }
      .actionCell .miniBtn { width: 100%; justify-content: center; }
      .quietCell { color: var(--secondary-text-color); }
      .blockedRow td { opacity: .68; }
      .hkDropRow td { background: color-mix(in srgb, var(--error-color, #db4437) 8%, var(--hp-surface)); }
      code, pre { background: var(--hp-surface-soft); border: var(--hp-border); border-radius: 6px; padding: 2px 5px; overflow-wrap: anywhere; white-space: normal; }
      pre { padding: 14px; overflow: auto; white-space: pre-wrap; }
      .good { color: var(--success-color, #0b8043); font-weight: 800; }
      .bad { color: var(--error-color, #db4437); font-weight: 800; }
      .reasonWarn { color: var(--warning-color, #ffa600); font-weight: 800; }
      .empty { text-align: center; padding: 26px; color: var(--secondary-text-color); }
      .emptyPanel { display: flex; flex-direction: column; align-items: center; gap: 10px; }
      .emptyTitle { color: var(--primary-text-color); font-weight: 850; font-size: 16px; }
      .emptyText { max-width: 520px; line-height: 1.4; }
      .stateCard { min-height: 260px; padding: 28px; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; gap: 12px; border-top: 4px solid var(--primary-color); }
      .stateIcon { width: 52px; height: 52px; border-radius: 50%; display: grid; place-items: center; background: var(--hp-surface-soft); color: var(--primary-color); border: 2px solid color-mix(in srgb, var(--primary-color) 42%, var(--divider-color)); font-size: 13px; font-weight: 900; letter-spacing: 0; }
      .stateIcon.loading { color: var(--primary-color); animation: hpPulse 1.35s ease-in-out infinite; }
      .stateIcon.error { color: var(--error-color, #db4437); border-color: color-mix(in srgb, var(--error-color, #db4437) 55%, var(--divider-color)); background: color-mix(in srgb, var(--error-color, #db4437) 12%, var(--hp-surface)); }
      .stateIcon.empty { color: var(--warning-color, #ffa600); border-color: color-mix(in srgb, var(--warning-color, #ffa600) 55%, var(--divider-color)); background: color-mix(in srgb, var(--warning-color, #ffa600) 14%, var(--hp-surface)); }
      .stateTitle { font-size: 19px; font-weight: 850; }
      .stateText { max-width: 560px; color: var(--secondary-text-color); line-height: 1.45; }
      .loadingBar { width: min(320px, 100%); height: 5px; border-radius: 999px; background: var(--hp-surface-soft); overflow: hidden; }
      .loadingBar::before { content: ""; display: block; width: 42%; height: 100%; border-radius: inherit; background: var(--primary-color); animation: hpLoad 1.15s ease-in-out infinite; }
      @keyframes hpLoad { 0% { transform: translateX(-110%); } 100% { transform: translateX(250%); } }
      @keyframes hpPulse { 0%, 100% { transform: scale(1); opacity: .86; } 50% { transform: scale(1.05); opacity: 1; } }
      .hint { line-height: 1.45; }
      .hint p { margin: 6px 0 0; }
      .formGrid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; margin-top: 12px; }
      .formGrid label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--secondary-text-color); }
      .checkboxRow { display: flex; align-items: center; gap: 8px; margin-top: 10px; color: var(--primary-text-color); }
      .checkboxRow input { min-width: unset; min-height: unset; }
      .optionGrid { display: grid; grid-template-columns: repeat(2, minmax(180px, 1fr)); gap: 10px; margin-top: 12px; }
      .optionCard { display: flex; align-items: flex-start; gap: 9px; padding: 10px; border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface-soft); line-height: 1.35; min-width: 0; }
      .optionCard input { min-width: unset; min-height: unset; margin-top: 2px; }
      .optionText { display: flex; flex-direction: column; gap: 3px; }
      .optionTitle { color: var(--primary-text-color); font-weight: 850; }
      .optionNote { color: var(--secondary-text-color); font-size: 12px; }
      .proxySummary { display: grid; grid-template-columns: minmax(220px, 320px) minmax(180px, 1fr) minmax(220px, 1fr); gap: var(--hp-gap); align-items: stretch; margin-top: 12px; }
      .sourceTile, .homeTile, .updateTile { border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface-soft); padding: 13px; min-height: 126px; display: flex; flex-direction: column; justify-content: space-between; min-width: 0; overflow: hidden; }
      .homeTile { border-color: color-mix(in srgb, var(--primary-color) 42%, var(--divider-color)); background: color-mix(in srgb, var(--primary-color) 8%, var(--hp-surface)); }
      .tileKicker { color: var(--secondary-text-color); font-size: 12px; font-weight: 850; text-transform: uppercase; }
      .homeTileValue { font-size: 26px; font-weight: 850; line-height: 1.1; overflow-wrap: anywhere; }
      .homeTileType { font-size: 13px; color: var(--secondary-text-color); }
      .homeTileMeta { display: flex; flex-direction: column; gap: 6px; line-height: 1.45; }
      .inlineMeta { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
      .proxyBuilder { border-top: 4px solid var(--primary-color); scroll-margin-top: 12px; }
      .proxyBuilder:focus { outline: none; }
      .proxyFlow { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
      .proxyStep { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 8px; align-items: center; padding: 10px; border: var(--hp-border); border-radius: var(--hp-radius); background: var(--hp-surface-soft); min-width: 0; }
      .proxyStepNumber { width: 24px; height: 24px; border-radius: 999px; display: grid; place-items: center; background: var(--primary-color); color: var(--text-primary-color); font-weight: 900; font-size: 12px; }
      .proxyStepTitle { font-weight: 850; line-height: 1.2; overflow-wrap: anywhere; }
      .proxyStepNote { margin-top: 2px; color: var(--secondary-text-color); font-size: 12px; line-height: 1.25; overflow-wrap: anywhere; }
      .proxyWarning { margin-top: 12px; padding: 11px; border: var(--hp-border); border-left: 4px solid var(--warning-color, #ffa600); border-radius: var(--hp-radius); background: color-mix(in srgb, var(--warning-color, #ffa600) 10%, var(--hp-surface)); }
      .confirmScrim { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 18px; background: rgba(0, 0, 0, .42); backdrop-filter: blur(2px); }
      .confirmDialog { width: min(520px, 100%); max-height: min(620px, calc(100vh - 36px)); overflow: auto; border: var(--hp-border); border-top: 4px solid var(--primary-color); border-radius: var(--hp-radius); background: var(--hp-surface); box-shadow: 0 18px 52px rgba(0, 0, 0, .32); padding: 16px; }
      .confirmDialog:focus { outline: none; }
      .confirmDialog.warn { border-top-color: var(--warning-color, #ffa600); }
      .confirmDialog.danger { border-top-color: var(--error-color, #db4437); }
      .confirmTitle { font-size: 18px; font-weight: 900; line-height: 1.2; }
      .confirmBody { margin-top: 8px; color: var(--secondary-text-color); line-height: 1.45; overflow-wrap: anywhere; }
      .confirmMeta { display: flex; gap: 7px; flex-wrap: wrap; margin-top: 12px; }
      .confirmActions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 16px; }
      .mobileList { display: none; }
      .mobileEntityRow { border-top: var(--hp-border); padding: 12px 14px; display: grid; gap: 8px; min-width: 0; }
      .mobileEntityRow:first-child { border-top: 0; }
      .mobileEntityRow.selected { background: color-mix(in srgb, var(--success-color, #0b8043) 8%, transparent); }
      .mobileEntityRow.blocked { opacity: .74; }
      .mobileEntityRow.hkDropMobile { background: color-mix(in srgb, var(--error-color, #db4437) 7%, var(--hp-surface)); }
      .mobileEntityTop { display: flex; justify-content: space-between; align-items: flex-start; gap: 10px; min-width: 0; }
      .mobileEntityMain { min-width: 0; display: grid; gap: 4px; }
      .mobileEntityName { color: var(--secondary-text-color); font-size: 12px; line-height: 1.3; overflow-wrap: anywhere; }
      .mobileEntityMeta { display: flex; gap: 6px; flex-wrap: wrap; }
      .mobileMetaItem { display: inline-flex; gap: 4px; align-items: center; max-width: 100%; min-height: 22px; padding: 3px 7px; border-radius: 999px; background: var(--hp-surface-soft); border: var(--hp-border); color: var(--secondary-text-color); font-size: 12px; line-height: 1.2; overflow-wrap: anywhere; }
      .mobileMetaItem b { color: var(--primary-text-color); }
      .mobileReason { color: var(--secondary-text-color); line-height: 1.35; overflow-wrap: anywhere; }
      .mobileEntityAction { flex: 0 0 auto; display: flex; justify-content: flex-end; }
      .mobileCheck { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 9px; align-items: flex-start; min-width: 0; }
      .mobileCheck input { min-width: unset; min-height: unset; margin-top: 3px; }
      @media (max-width: 980px) {
        :host { padding: 14px; }
        .top, .layout, .proxySummary, .proxyFlow, .draftBar, .debugGrid { grid-template-columns: 1fr; }
        .debugSummary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .optionGrid { grid-template-columns: 1fr; }
        .bridgeBlock { min-width: 0; }
        .overviewGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .actionSummary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .summaryGrid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      }
      @media (max-width: 620px) {
        :host { padding: 10px; }
        .brandBlock { align-items: flex-start; }
        .appIcon { width: 40px; height: 40px; }
        h1 { font-size: 21px; }
        .overviewGrid, .actionSummary, .debugSummary, .summaryGrid { grid-template-columns: 1fr; }
        .actionTile, .debugTile { padding: 11px; }
        input, .controlBar input, .controlBar select, .bridgeActions select { min-width: 0; width: 100%; }
        .bridgeActions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .bridgeActions select { grid-column: 1 / -1; }
        .bridgeActions button { width: auto; }
        .controlBar { grid-template-columns: minmax(0, 1fr) minmax(92px, max-content); gap: 7px; padding: 6px; }
        .controlField { align-items: center; }
        .searchField { grid-column: 1 / -1; }
        .fieldLabel { width: 52px; padding-top: 0; }
        .filterReset { align-self: stretch; width: auto; min-width: 92px; grid-column: 2; grid-row: 1; }
        .filterSummary { margin-top: -4px; }
        .filterSummary .filterReset { margin-left: 0; }
        .draftBar { bottom: 8px; padding: 10px; }
        .actionRow, .draftActions, .debugActions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .actionRow button, .draftActions button, .debugActions button, .confirmActions button { width: auto; white-space: normal; }
        .draftActions, .debugActions, .confirmActions { justify-content: stretch; }
        .tableWrap { display: none; }
        .mobileList { display: block; }
        .mobileEntityRow { padding: 10px; }
        .statusNotice { grid-template-columns: minmax(0, 1fr); }
        .dismissNotice { justify-self: start; }
        .confirmScrim { padding: 10px; align-items: end; }
        .confirmDialog { max-height: calc(100vh - 20px); }
        .filterChip { max-width: 100%; }
        .tabs { display: flex; }
        .tab { flex: 1 1 0; min-width: 0; padding-inline: 7px; }
        .tabText.full { display: none; }
        .tabText.short { display: inline; }
      }
    </style>`;
  }

  renderMessage() {
    if (!this._message) return "";
    const failed = /failed|fail|error/i.test(this._message);
    const label = failed ? "Dismiss error message" : "Dismiss status message";
    return `<div class="notice statusNotice ${failed ? "error" : "ok"}" role="status" aria-live="polite"><div class="statusNoticeText">${this.escape(this._message)}</div><button class="secondary dismissNotice" data-dismiss-message aria-label="${label}" title="Dismiss">OK</button></div>`;
  }

  renderWarnings(data) {
    const warnings = data.warnings || [];
    if (!warnings.length) return "";
    return `<div class="notice warn"><b>Warnings</b><ul>${warnings.map((w) => `<li>${this.escape(w)}</li>`).join("")}</ul></div>`;
  }

  renderHeader(entries, entry) {
    const options = entries.length
      ? entries.map((item) => `<option value="${this.escape(item.entry_id)}" ${item.entry_id === this._selected ? "selected" : ""}>${this.escape(item.title || "HomeKit entry")} · ${this.escape(item.port || "unknown port")}</option>`).join("")
      : `<option>${this._loading ? "Loading bridges" : "No bridges loaded"}</option>`;
    const statusChip = this._loading ? "Loading" : entries.length ? "Ready" : this._loadedOnce ? "No entries" : "Waiting";
    const chips = entry
      ? `<span class="chip">Port ${this.escape(entry.port || "unknown")}</span><span class="chip">Mode ${this.escape(entry.mode || "unknown")}</span><span class="chip">Source ${this.escape(entry.exposure_source || "unknown")}</span>`
      : `<span class="chip">Status ${this.escape(statusChip)}</span>`;
    return `<div class="top">
      <div class="brandBlock">
        <img class="appIcon" src="${ICON_URL}" alt="">
        <div>
          <h1>HomeKit Preview</h1>
          <div class="sub">Live bridge exposure, HomeKit drop reasons, and exact-list tools · build ${this.escape(BUILD_LABEL)}</div>
        </div>
      </div>
      <div class="bridgeBlock">
        <div class="bridgeTitle">Selected bridge</div>
        <div class="bridgeActions">
          <select id="bridgeSelect" aria-label="HomeKit bridge" ${entries.length ? "" : "disabled"}>${options}</select>
          <button id="refresh" ${this._loading ? "disabled" : ""}>${this._loading ? "Scanning..." : "Scan"}</button>
          <button class="secondary" id="reloadPreview" title="Reload only HomeKit Preview, not HomeKit Bridge" ${this._loading ? "disabled" : ""}>Reload Preview</button>
        </div>
        <div class="chips">${chips}</div>
      </div>
    </div>`;
  }

  renderTabs(entry) {
    const liveCount = entry?.exposed_count ?? 0;
    const deviceCount = entry ? this.deviceCount(entry) : 0;
    const rawCount = entry ? "JSON" : "-";
    return `<div class="tabs" role="tablist" aria-label="HomeKit Preview views">
      <button class="tab ${this._tab === "preview" ? "active" : ""}" data-tab="preview" role="tab" aria-selected="${this._tab === "preview"}"><span class="tabText full">Live Preview</span><span class="tabText short">Live</span> <span class="tabBadge">${liveCount}</span></button>
      <button class="tab ${this._tab === "device" ? "active" : ""}" data-tab="device" role="tab" aria-selected="${this._tab === "device"}"><span class="tabText full">Device Picker</span><span class="tabText short">Devices</span> <span class="tabBadge">${deviceCount}</span></button>
      <button class="tab ${this._tab === "raw" ? "active" : ""}" data-tab="raw" role="tab" aria-selected="${this._tab === "raw"}"><span class="tabText full">Debug</span><span class="tabText short">Debug</span> <span class="tabBadge">${rawCount}</span></button>
    </div>`;
  }

  renderEntryState() {
    if (!this._hass) {
      return `<div class="stateCard"><div class="stateIcon">HA</div><div class="stateTitle">Waiting for Home Assistant</div><div class="stateText">The panel is ready and waiting for the Home Assistant frontend connection.</div></div>`;
    }
    if (this._loading && !this._loadedOnce) {
      return `<div class="stateCard"><div class="stateIcon loading">RUN</div><div class="stateTitle">Loading HomeKit bridges</div><div class="stateText">Reading HomeKit Preview data from Home Assistant.</div><div class="loadingBar" aria-hidden="true"></div></div>`;
    }
    if (/failed|fail|error/i.test(this._message || "")) {
      return `<div class="stateCard"><div class="stateIcon error">ERR</div><div class="stateTitle">Preview data did not load</div><div class="stateText">${this.escape(this._message)}</div><button data-scan>Try again</button></div>`;
    }
    return `<div class="stateCard"><div class="stateIcon empty">NO</div><div class="stateTitle">No HomeKit bridge entries found</div><div class="stateText">Run a scan after HomeKit Bridge is configured. HomeKit Preview will show live exposure once Home Assistant reports bridge entries.</div><button data-scan ${this._loading ? "disabled" : ""}>Scan now</button></div>`;
  }

  renderSummary(data, entry, stats) {
    const drops = entry?.explicit_include_not_exposed?.length || 0;
    const proxyReady = this.proxyReadyDropCount(entry);
    const hiddenSkips = entry?.post_filter_skip_count ?? 0;
    const unsupported = entry?.unsupported_count ?? 0;
    const live = entry?.exposed_count ?? 0;
    const draftClass = stats.changed ? "warnCard" : "goodCard";
    const dropClass = drops ? "badCard" : "goodCard";
    const proxyNote = proxyReady ? "same-unit helper available" : "no helper candidates";
    const draftNote = stats.changed ? `${stats.added} add / ${stats.removed} remove` : "matches live runtime";
    const attentionTone = drops ? "bad" : proxyReady || stats.changed || hiddenSkips ? "warn" : "good";
    const attentionTitle = drops ? `${drops} HomeKit drop${drops === 1 ? "" : "s"}` : proxyReady ? `${proxyReady} proxy candidate${proxyReady === 1 ? "" : "s"}` : stats.changed ? "Draft has changes" : "Bridge looks aligned";
    const attentionNote = drops ? "Review dropped explicit includes first." : proxyReady ? "Unsupported same-unit sensors can be proxied." : stats.changed ? "Apply, reset, or copy the exact-list draft." : "Live runtime and exact-list draft are in sync.";
    const attentionIcon = attentionTone === "good" ? "OK" : "!";
    const attentionAction = drops || proxyReady ? `<button class="secondary actionLink" data-jump-tab="preview" data-jump-target="hkDrops">Review HK drops</button>` : stats.changed ? `<button class="secondary actionLink" data-jump-tab="device" data-jump-target="draftBar">Review draft</button>` : `<button class="secondary actionLink" data-jump-tab="preview" data-jump-target="liveEntities">View live list</button>`;
    return `<div class="actionSummary">
      <div class="actionTile ${attentionTone}"><div class="actionIcon">${attentionIcon}</div><div><div class="actionTitle">${this.escape(attentionTitle)}</div><div class="actionNote">${this.escape(attentionNote)}</div>${attentionAction}</div></div>
      <div class="actionTile ${live ? "good" : "warn"}"><div class="actionIcon">${live}</div><div><div class="actionTitle">Live in Apple Home</div><div class="actionNote">${this.escape(entry?.title || "Selected bridge")}</div><button class="secondary actionLink" data-jump-tab="preview" data-jump-target="liveEntities">View live list</button></div></div>
      <div class="actionTile ${unsupported ? "warn" : "good"}"><div class="actionIcon">${unsupported}</div><div><div class="actionTitle">Unsupported candidates</div><div class="actionNote">Filtered by HomeKit support rules.</div><button class="secondary actionLink" data-jump-tab="device" data-jump-target="devicePicker">Open picker</button></div></div>
      <div class="actionTile ${stats.changed ? "warn" : "good"}"><div class="actionIcon">${stats.changed}</div><div><div class="actionTitle">Draft delta</div><div class="actionNote">${this.escape(draftNote)}</div><button class="secondary actionLink" data-jump-tab="device" data-jump-target="draftBar">Review draft</button></div></div>
    </div>
    <div class="overviewGrid">
      <div class="overviewCard primary"><div class="overviewValue">${live}</div><div class="overviewLabel">Live in selected bridge</div><div class="overviewNote">${this.escape(entry?.title || "HomeKit bridge")}</div></div>
      <div class="overviewCard ${dropClass}"><div class="overviewValue">${drops}</div><div class="overviewLabel">HK drops</div><div class="overviewNote">explicit includes HomeKit will not serve</div></div>
      <div class="overviewCard ${proxyReady ? "warnCard" : "goodCard"}"><div class="overviewValue">${proxyReady}</div><div class="overviewLabel">Proxy-ready</div><div class="overviewNote">${proxyNote}</div></div>
      <div class="overviewCard ${draftClass}"><div class="overviewValue">${stats.draft}</div><div class="overviewLabel">Exact-list draft</div><div class="overviewNote">${draftNote}</div></div>
    </div>
    <div class="diagnosticStrip">
      <span class="diagnosticLabel">Diagnostics</span>
      <span class="chip">Total live ${data.total_exposed ?? 0}</span>
      <span class="chip">Unsupported ${unsupported}</span>
      <span class="chip">Hidden/category skips ${hiddenSkips}</span>
      <span class="chip">ALL-domain traps ${entry?.domain_wide_include_count ?? 0}</span>
      <span class="chip">Entries ${data.entry_count ?? 0}</span>
      <span class="chip">Source ${this.escape(entry?.exposure_source || "n/a")}</span>
    </div>`;
  }

  render() {
    if (!this.shadowRoot) return;
    const data = this._data || {};
    const entries = data.entries || [];
    const entry = this.selectedEntry();
    const stats = entry ? this.draftStats(entry) : { live: 0, draft: 0, added: 0, removed: 0, changed: 0 };
    const rooms = entry ? this.rooms(entry) : [];
    const devices = entry ? this.devices(entry) : [];
    const selectedDevice = entry ? this.selectedDevice(entry) : null;
    const previewRows = entry ? this.filteredPreviewRows(entry) : [];

    this.shadowRoot.innerHTML = `
      ${this.renderStyles()}
      <div class="wrap">
        ${this.renderHeader(entries, entry)}
        ${this.renderTabs(entry)}
        ${this.renderMessage()}
        ${this.renderWarnings(data)}
        ${entry ? this.renderSummary(data, entry, stats) : ""}
        ${entry ? (this._tab === "device" ? this.renderDevicePicker(entry, rooms, devices, selectedDevice, stats) : this._tab === "raw" ? this.renderRaw(entry) : this.renderPreview(entry, previewRows, rooms)) : this.renderEntryState()}
      </div>
      ${this.renderConfirmDialog()}`;
    this.bind(entry);
    if (this._focusTarget) {
      const target = this._focusTarget;
      this._focusTarget = null;
      this.focusTarget(target);
    }
    if (this._focusProxyBuilder) {
      this._focusProxyBuilder = false;
      requestAnimationFrame(() => {
        const builder = this.shadowRoot?.getElementById("proxyBuilder");
        const input = this.shadowRoot?.getElementById("proxyName");
        builder?.scrollIntoView({ block: "start", behavior: "smooth" });
        builder?.focus({ preventScroll: true });
        input?.focus({ preventScroll: true });
        input?.select?.();
      });
    }
  }

  bind(entry) {
    this.shadowRoot.getElementById("refresh")?.addEventListener("click", () => this.loadData(true));
    this.shadowRoot.querySelectorAll("[data-scan]").forEach((el) => el.addEventListener("click", () => this.loadData(true)));
    this.shadowRoot.getElementById("reloadPreview")?.addEventListener("click", () => this.reloadPreview());
    this.shadowRoot.getElementById("confirmCancel")?.addEventListener("click", () => this.resolveConfirm(false));
    this.shadowRoot.getElementById("confirmPrimary")?.addEventListener("click", () => this.resolveConfirm(true));
    this.shadowRoot.getElementById("confirmDialog")?.addEventListener("keydown", (ev) => this.handleConfirmKey(ev));
    this.shadowRoot.querySelector(".confirmScrim")?.addEventListener("click", (ev) => { if (ev.target === ev.currentTarget) this.resolveConfirm(false); });
    this.shadowRoot.querySelectorAll("[data-dismiss-message]").forEach((el) => el.addEventListener("click", () => { this._message = ""; this.render(); }));
    this.shadowRoot.getElementById("bridgeSelect")?.addEventListener("change", (ev) => { this._selected = ev.target.value; this._deviceKey = ""; this._proxyDraft = null; this.render(); });
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((el) => el.addEventListener("click", () => { this._tab = el.dataset.tab; this.render(); }));
    this.shadowRoot.querySelectorAll("[data-room-filter]").forEach((el) => el.addEventListener("change", (ev) => { const tab = el.dataset.roomFilter; this.filterFor(tab).room = ev.target.value; if (tab === "device") this._deviceKey = ""; this.render(); }));
    this.shadowRoot.querySelectorAll("[data-search-filter]").forEach((el) => el.addEventListener("input", (ev) => this.scheduleSearch(el.dataset.searchFilter, ev.target.value)));
    this.shadowRoot.querySelectorAll("[data-clear-filters]").forEach((el) => el.addEventListener("click", () => this.clearFilters(el.dataset.clearFilters)));
    this.shadowRoot.querySelectorAll("[data-jump-target]").forEach((el) => el.addEventListener("click", () => this.jumpTo(el.dataset.jumpTab, el.dataset.jumpTarget)));
    this.shadowRoot.querySelectorAll("[data-device]").forEach((el) => el.addEventListener("click", () => { this._deviceKey = el.dataset.device; this.render(); }));
    this.shadowRoot.querySelectorAll("[data-toggle-entity]").forEach((el) => el.addEventListener("change", () => this.toggleEntity(entry, el.dataset.toggleEntity, el.checked)));
    this.shadowRoot.getElementById("addDevice")?.addEventListener("click", () => this.setEntities(entry, this.selectedDevice(entry)?.entities || [], true));
    this.shadowRoot.getElementById("removeDevice")?.addEventListener("click", () => this.setEntities(entry, this.selectedDevice(entry)?.entities || [], false));
    this.shadowRoot.getElementById("resetDraft")?.addEventListener("click", () => this.resetDraft(entry));
    this.shadowRoot.getElementById("clearDraft")?.addEventListener("click", () => this.clearDraft(entry));
    this.shadowRoot.getElementById("applyDraft")?.addEventListener("click", () => this.applyDraft(entry));
    this.shadowRoot.getElementById("copyDraft")?.addEventListener("click", () => this.copyText(JSON.stringify({ filter: this.exactFilter(entry) }, null, 2), "Exact filter"));
    this.shadowRoot.getElementById("copyRawFilter")?.addEventListener("click", () => this.copyText(JSON.stringify({ filter: this.exactFilter(entry) }, null, 2), "Exact filter"));
    this.shadowRoot.getElementById("copyRawEntry")?.addEventListener("click", () => this.copyText(JSON.stringify(entry, null, 2), "Raw entry"));
    this.shadowRoot.querySelectorAll("[data-proxy-source]").forEach((el) => el.addEventListener("click", () => this.startProxy(entry, el.dataset.proxySource)));
    this.shadowRoot.getElementById("proxyCancel")?.addEventListener("click", () => { this._proxyDraft = null; this.render(); });
    this.shadowRoot.getElementById("proxyCreate")?.addEventListener("click", () => this.createProxy(entry));
    this.shadowRoot.getElementById("proxyProfile")?.addEventListener("change", (ev) => { if (this._proxyDraft) { this._proxyDraft.target_profile_id = ev.target.value; this.render(); } });
    this.shadowRoot.getElementById("proxyName")?.addEventListener("change", (ev) => { if (this._proxyDraft) { this._proxyDraft.name = ev.target.value; this.render(); } });
  }

  renderControls(rooms, tab) {
    tab = tab || this._tab;
    const filter = this.filterFor(tab);
    const hasFilters = this.hasFilters(tab);
    return `<div class="controlBar">
      <div class="controlField"><span class="fieldLabel">Room</span><select data-room-filter="${this.escape(tab)}">
        <option value="all">All rooms</option>
        ${rooms.map((room) => `<option value="${this.escape(room)}" ${room === filter.room ? "selected" : ""}>${this.escape(room)}</option>`).join("")}
      </select></div>
      <div class="controlField searchField"><span class="fieldLabel">Search</span><input id="entitySearch-${this.escape(tab)}" data-search-filter="${this.escape(tab)}" placeholder="Entity, room, device, state, or reason" value="${this.escape(filter.search)}" autocomplete="off"></div>
      <button class="secondary filterReset" data-clear-filters="${this.escape(tab)}" ${hasFilters ? "" : "disabled"}>Clear filters</button>
    </div>`;
  }

  renderFilterSummary(tab, shown, total, noun) {
    const hasFilters = this.hasFilters(tab);
    const filter = this.filterFor(tab);
    const plural = noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`;
    const label = (count) => count === 1 ? noun : plural;
    const parts = [`<strong>${shown}</strong> of ${total} ${label(total)}`];
    if (filter.room !== "all") parts.push(`room ${this.escape(filter.room)}`);
    if (filter.search.trim()) parts.push(`search "${this.escape(filter.search.trim())}"`);
    const text = hasFilters ? `Showing ${parts.join(" · ")}` : `Showing all ${total} ${label(total)}`;
    return `<div class="filterSummary"><span>${text}</span>${hasFilters ? `<button class="secondary filterReset" data-clear-filters="${this.escape(tab)}">Reset filters</button>` : ""}</div>`;
  }

  renderFilteredEmpty(tab, filteredTitle, emptyTitle, filteredText, emptyText) {
    const filtered = this.hasFilters(tab);
    return `<div class="card empty emptyPanel"><div class="emptyTitle">${this.escape(filtered ? filteredTitle : emptyTitle)}</div><div class="emptyText">${this.escape(filtered ? filteredText : emptyText)}</div>${filtered ? `<button class="secondary" data-clear-filters="${this.escape(tab)}">Clear filters</button>` : ""}</div>`;
  }

  renderDraftBar(stats) {
    const changed = stats.changed > 0;
    const title = changed ? "Draft changes ready" : "Exact-list draft matches live";
    const tone = changed ? "warnChip" : "";
    return `<div id="draftBar" class="draftBar" tabindex="-1">
      <div class="draftState">
        <div class="draftTitle">${title}</div>
        <div class="draftMeta"><span class="chip">${stats.draft} selected</span><span class="chip">${stats.live} live now</span><span class="chip ${tone}">${stats.added} add</span><span class="chip ${stats.removed ? "hkDrop" : ""}">${stats.removed} remove</span></div>
      </div>
      <div class="draftActions"><button id="applyDraft" ${this._loading ? "disabled" : ""}>Apply exact list</button><button class="secondary" id="resetDraft">Reset</button><button class="secondary" id="clearDraft">Clear</button><button class="secondary" id="copyDraft">Copy JSON</button></div>
    </div>`;
  }

  renderDevicePicker(entry, rooms, devices, selectedDevice, stats) {
    const draft = this.ensureDraft(entry);
    const deviceCards = devices.map((device) => {
      const selected = device.entities.filter((e) => draft.has(e.entity_id)).length;
      const live = device.entities.filter((e) => e.currently_exposed).length;
      const supported = device.entities.filter((e) => e.selectable !== false).length;
      const dropped = device.entities.filter((e) => e.selectable === false && !e.currently_exposed).length;
      const proxyReady = device.entities.filter((e) => e.selectable === false && this.proxyProfilesFor(e).length).length;
      const cueClass = dropped ? "dropAttention" : proxyReady ? "attention" : "";
      const cue = dropped ? `<span class="statusBadge hkDrop deviceCue">${dropped} dropped</span>` : proxyReady ? `<span class="statusBadge warn deviceCue">${proxyReady} proxy-ready</span>` : live ? `<span class="statusBadge good deviceCue">live</span>` : `<span class="statusBadge deviceCue">not live</span>`;
      return `<button class="deviceCard ${device.key === selectedDevice?.key ? "active" : ""} ${cueClass}" data-device="${this.escape(device.key)}">
        <div class="deviceCardTop"><span class="deviceCardTitle" title="${this.escape(device.name)}">${this.escape(device.name)}</span>${cue}</div>
        <div class="muted">${this.escape(device.room)} · ${device.entities.length} entities</div>
        <div class="chips"><span class="chip">${selected} selected</span><span class="chip">${live} live</span><span class="chip">${supported} supportable</span>${proxyReady ? `<span class="chip warnChip">${proxyReady} can proxy</span>` : ""}</div>
      </button>`;
    }).join("") || this.renderFilteredEmpty("device", "No matching devices", "No devices found", "Current room or search filters hide every device.", "No candidate devices are available for this bridge yet.");
    return `<div id="devicePicker" class="stack" tabindex="-1">
      <div class="notice warn compactNotice"><b>Exact-list editor</b><div class="sectionNote">Draft a precise HomeKit include list from supportable entities. Rows marked <b>Available by proxy</b> can create HA helper entities for unsupported same-unit sensors.</div></div>
      ${this.renderDomainHints(entry)}
      ${this.renderControls(rooms)}
      ${this.renderFilterSummary("device", devices.length, this.deviceCount(entry), "device")}
      ${this.renderDraftBar(stats)}
      <div class="layout">
        <div class="panel">${this.sectionHead("Devices", [`${devices.length} shown`])}<div class="deviceList">${deviceCards}</div></div>
        <div>${selectedDevice ? this.renderDeviceEntities(entry, selectedDevice) : `<div class="card empty">Pick a device.</div>`}</div>
      </div>
    </div>`;
  }

  renderMobileMeta(items) {
    return items
      .filter(([, value]) => value !== undefined && value !== null && String(value) !== "")
      .map(([label, value]) => `<span class="mobileMetaItem"><b>${this.escape(label)}</b>${this.escape(value)}</span>`)
      .join("");
  }

  renderDeviceEntities(entry, device) {
    const draft = this.ensureDraft(entry);
    const selected = device.entities.filter((e) => draft.has(e.entity_id)).length;
    const live = device.entities.filter((e) => e.currently_exposed).length;
    const supported = device.entities.filter((e) => e.selectable !== false).length;
    const rows = device.entities.map((entity) => {
      const checked = draft.has(entity.entity_id);
      const blocked = entity.selectable === false;
      const reason = entity.currently_exposed ? entity.inclusion_reason : (entity.simulation_reason || entity.inclusion_reason);
      const profiles = this.proxyProfilesFor(entity);
      const helperAction = blocked && profiles.length
        ? `<button class="secondary miniBtn" title="Create helper entity" data-proxy-source="${this.escape(entity.entity_id)}">Proxy</button>`
        : `<span class="quietCell">-</span>`;
      return `<tr class="${checked ? "selectedRow" : ""} ${blocked ? "blockedRow" : ""}">
        <td><input type="checkbox" aria-label="Include ${this.escape(entity.entity_id)}" data-toggle-entity="${this.escape(entity.entity_id)}" ${checked ? "checked" : ""} ${blocked ? "disabled" : ""}></td>
        <td class="entityCell"><code>${this.escape(entity.entity_id)}</code></td>
        <td>${this.escape(entity.name || "")}</td>
        <td>${this.escape(entity.domain)}</td>
        <td><span class="statusBadge ${entity.currently_exposed ? "good" : ""}">${entity.currently_exposed ? "live" : "not live"}</span></td>
        <td>${this.homeKitTypeBadge(entity)}</td>
        <td><code>${this.escape(entity.state || "")}</code></td>
        <td class="${String(reason || "").startsWith("ALL") ? "reasonWarn" : ""}">${this.escape(reason || "")}</td>
        <td class="actionCell">${helperAction}</td>
      </tr>`;
    }).join("");
    const mobileRows = device.entities.map((entity) => {
      const checked = draft.has(entity.entity_id);
      const blocked = entity.selectable === false;
      const reason = entity.currently_exposed ? entity.inclusion_reason : (entity.simulation_reason || entity.inclusion_reason);
      const profiles = this.proxyProfilesFor(entity);
      const helperAction = blocked && profiles.length
        ? `<button class="secondary miniBtn" title="Create helper entity" data-proxy-source="${this.escape(entity.entity_id)}">Proxy</button>`
        : "";
      return `<div class="mobileEntityRow ${checked ? "selected" : ""} ${blocked ? "blocked" : ""}">
        <div class="mobileEntityTop">
          <label class="mobileCheck"><input type="checkbox" aria-label="Include ${this.escape(entity.entity_id)}" data-toggle-entity="${this.escape(entity.entity_id)}" ${checked ? "checked" : ""} ${blocked ? "disabled" : ""}><span class="mobileEntityMain"><code>${this.escape(entity.entity_id)}</code><span class="mobileEntityName">${this.escape(entity.name || "")}</span></span></label>
          <div class="mobileEntityAction">${helperAction}</div>
        </div>
        <div class="mobileEntityMeta"><span class="statusBadge ${entity.currently_exposed ? "good" : ""}">${entity.currently_exposed ? "live" : "not live"}</span>${this.homeKitTypeBadge(entity)}${this.renderMobileMeta([["State", entity.state], ["Domain", entity.domain]])}</div>
        <div class="mobileReason ${String(reason || "").startsWith("ALL") ? "reasonWarn" : ""}">${this.escape(reason || "")}</div>
      </div>`;
    }).join("");
    return `<div class="stack">
      <div class="panel">
        ${this.sectionHead(device.name, [`${device.room}`, `${device.entities.length} entities`, `${selected} selected`, `${live} live`, `${supported} supportable`])}
        <div class="actionRow" style="margin-top:12px;"><button id="addDevice">Add supportable</button><button class="secondary" id="removeDevice">Remove all</button></div>
      </div>
      <div class="tableCard">${this.sectionHead("Device entities", [`${device.entities.length} rows`])}<div class="tableWrap"><table class="deviceTable">${this.colgroup(["5%", "23%", "13%", "7%", "8%", "14%", "7%", "14%", "9%"])}<thead><tr><th>Draft</th><th>Entity</th><th>Name</th><th>Domain</th><th>Live</th><th>HomeKit type</th><th>State</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div><div class="mobileList">${mobileRows}</div></div>
    </div>`;
  }

  renderPreview(entry, rows, rooms) {
    return `<div class="stack">
      ${this.renderDomainHints(entry)}
      ${this.renderControls(rooms)}
      ${this.renderFilterSummary("preview", rows.length, entry.exposed_entities?.length || 0, "live entity")}
      <div class="panel">
        ${this.sectionHead(entry.title, [`Port ${entry.port || "unknown"}`, `Mode ${entry.mode || "unknown"}`, `Source ${entry.exposure_source || "unknown"}`])}
        <div class="chips">${this.filterChips(entry)}</div>
      </div>
      ${this.renderExplicitIncludeSkips(entry)}
      ${this.renderProxyBuilder(entry)}
      ${this.renderPreviewTable(rows)}
    </div>`;
  }

  renderExplicitIncludeSkips(entry) {
    const skipped = entry.explicit_include_not_exposed || [];
    if (!skipped.length) return "";
    const proxyReady = skipped.filter((item) => this.proxyProfilesFor(item).length).length;
    const rows = skipped.map((item) => {
      const profiles = this.proxyProfilesFor(item);
      const classUnit = [item.device_class, item.unit_of_measurement].filter(Boolean).join(" / ") || "n/a";
      const action = profiles.length ? `<button class="secondary miniBtn" title="Create helper entity" data-proxy-source="${this.escape(item.entity_id)}">Proxy</button>` : `<span class="muted">No helper</span>`;
      return `<tr class="hkDropRow"><td><span class="statusBadge hkDrop">HK drops</span></td><td class="entityCell"><code>${this.escape(item.entity_id)}</code><div class="muted">${this.escape(item.name || "")}</div></td><td><code>${this.escape(item.state || "")}</code></td><td>${this.escape(classUnit)}</td><td>${this.homeKitTypeBadge(item)}</td><td>${this.escape(item.reason || "not exposed")}</td><td class="actionCell">${action}</td></tr>`;
    }).join("");
    const mobileRows = skipped.map((item) => {
      const profiles = this.proxyProfilesFor(item);
      const classUnit = [item.device_class, item.unit_of_measurement].filter(Boolean).join(" / ") || "n/a";
      const action = profiles.length ? `<button class="secondary miniBtn" title="Create helper entity" data-proxy-source="${this.escape(item.entity_id)}">Proxy</button>` : `<span class="muted">No helper</span>`;
      return `<div class="mobileEntityRow hkDropMobile">
        <div class="mobileEntityTop"><div class="mobileEntityMain"><code>${this.escape(item.entity_id)}</code><span class="mobileEntityName">${this.escape(item.name || "")}</span></div><div class="mobileEntityAction">${action}</div></div>
        <div class="mobileEntityMeta"><span class="statusBadge hkDrop">HK drops</span>${this.homeKitTypeBadge(item)}${this.renderMobileMeta([["State", item.state], ["Class", classUnit]])}</div>
        <div class="mobileReason">${this.escape(item.reason || "not exposed")}</div>
      </div>`;
    }).join("");
    return `<div id="hkDrops" class="tableCard warnCard" tabindex="-1">${this.sectionHead("HK drops", [`${skipped.length} explicit includes`, `${proxyReady} proxy-ready`], "In the bridge filter, then dropped by HomeKit support rules.")}<div class="tableWrap"><table class="dropTable">${this.colgroup(["10%", "27%", "8%", "13%", "15%", "17%", "10%"])}<thead><tr><th>Status</th><th>Entity</th><th>State</th><th>Class / unit</th><th>HomeKit type</th><th>Reason</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table></div><div class="mobileList">${mobileRows}</div></div>`;
  }



  renderProxyBuilder(entry) {
    const draft = this._proxyDraft;
    if (!draft || draft.entry_id !== entry.entry_id) return "";
    const source = this.dropById(entry, draft.source_entity_id);
    const profiles = this.proxyProfilesFor(source);
    if (!source || !profiles.length) return `<div class="notice warn">No same-unit HomeKit helper target is available.</div>`;
    const profile = profiles.find((item) => item.id === draft.target_profile_id) || profiles[0];
    const name = draft.name || source.name || source.entity_id;
    const unit = source.unit_of_measurement || profile.unit || "";
    const value = `${source.state ?? ""}${unit ? ` ${unit}` : ""}`;
    const entityPreview = `sensor.homekit_proxy_${this.slugPreview(name)}`;
    return `<div id="proxyBuilder" class="panel proxyBuilder" tabindex="-1">
      ${this.sectionHead("Create proxy helper", [`Source ${source.unit_of_measurement || "unitless"}`, `HomeKit ${profile.customer_facing_type || profile.homekit_type}`], `Convert a HomeKit-dropped source into a Home Assistant helper that Apple Home can display.`)}
      <div class="proxyFlow" aria-label="Proxy helper flow"><div class="proxyStep"><span class="proxyStepNumber">1</span><div><div class="proxyStepTitle">Dropped source</div><div class="proxyStepNote">Unsupported by HomeKit</div></div></div><div class="proxyStep"><span class="proxyStepNumber">2</span><div><div class="proxyStepTitle">Helper entity</div><div class="proxyStepNote">Same unit, supported type</div></div></div><div class="proxyStep"><span class="proxyStepNumber">3</span><div><div class="proxyStepTitle">Apple Home</div><div class="proxyStepNote">Shows the helper name and value</div></div></div></div>
      <div class="formGrid"><label>Apple Home name<input id="proxyName" value="${this.escape(name)}" autocomplete="off"></label><label>HomeKit-compatible type<select id="proxyProfile">${profiles.map((item) => `<option value="${this.escape(item.id)}" ${item.id === profile.id ? "selected" : ""}>${this.escape(item.label)} (${this.escape(item.homekit_type)})</option>`).join("")}</select></label></div>
      <div class="proxySummary"><div class="sourceTile"><div><div class="tileKicker">Dropped source</div><b>${this.escape(source.name || source.entity_id)}</b></div><div><code>${this.escape(source.entity_id)}</code></div><div class="homeTileType">${this.escape(source.device_class || "sensor")} ${this.escape(source.unit_of_measurement || "")}</div></div><div class="homeTile"><div><div class="tileKicker">Apple Home</div><b>${this.escape(name)}</b><div class="homeTileType">${this.escape(profile.label)}</div></div><div class="homeTileValue">${this.escape(value)}</div><div class="homeTileType">${this.escape(profile.customer_facing_type || profile.homekit_type)}</div></div><div class="updateTile"><div><div class="tileKicker">Bridge update</div><b>${draft.include_in_bridge ? "Include helper" : "Create only"}</b></div><div class="homeTileType">${draft.replace_source ? "Original source will be removed from this bridge filter." : "Original source remains in this bridge filter."}</div><div><code>${this.escape(entityPreview)}</code></div></div></div>
      <div class="proxyWarning"><div><b>Semantic note</b></div><div>${this.escape(profile.semantic_warning || "This helper changes HomeKit semantics while preserving the unit and value.")}</div><div class="inlineMeta"><span class="chip">Source ${this.escape(source.device_class || "sensor")} ${this.escape(source.unit_of_measurement || "")}</span><span class="chip">Helper ${this.escape(profile.device_class)} ${this.escape(profile.unit || "")}</span><span class="chip">Same unit ${this.escape(profile.unit || source.unit_of_measurement || "")}</span></div></div>
      <div class="optionGrid"><label class="optionCard"><input type="checkbox" id="proxyIncludeBridge" ${draft.include_in_bridge ? "checked" : ""}><span class="optionText"><span class="optionTitle">Add helper to this bridge</span><span class="optionNote">The helper is included in the HomeKit Bridge filter after creation.</span></span></label><label class="optionCard"><input type="checkbox" id="proxyReplaceSource" ${draft.replace_source ? "checked" : ""}><span class="optionText"><span class="optionTitle">Replace dropped source</span><span class="optionNote">Remove the unsupported source from this bridge filter.</span></span></label></div>
      <div class="actionRow" style="margin-top:14px;"><button id="proxyCreate" ${this._loading ? "disabled" : ""}>Create proxy helper</button><button class="secondary" id="proxyCancel">Cancel</button></div>
    </div>`;
  }

  renderPreviewTable(rows) {
    if (!rows.length) return `<div id="liveEntities" tabindex="-1">${this.renderFilteredEmpty("preview", "No matching live entities", "No live exposed entities", "Current room or search filters hide every live HomeKit entity.", "This bridge is not currently exposing any entities through HomeKit Preview.")}</div>`;
    const tableRows = rows.map((e) => `<tr><td class="entityCell"><code>${this.escape(e.entity_id)}</code></td><td>${this.escape(e.name || "")}</td><td>${this.escape(e.domain)}</td><td>${this.escape(e.area || "")}</td><td>${this.escape(e.device || "")}</td><td><code>${this.escape(e.state || "")}</code></td><td><span class="statusBadge ${e.available ? "good" : "bad"}">${e.available ? "available" : "unavailable"}</span></td><td><span class="statusBadge ${e.homekit_supported === false ? "bad" : "good"}">${this.escape(e.homekit_type || "HomeKit")}</span></td><td class="${String(e.inclusion_reason || "").startsWith("ALL") ? "reasonWarn" : ""}">${this.escape(e.inclusion_reason || "")}</td></tr>`).join("");
    const mobileRows = rows.map((e) => `<div class="mobileEntityRow">
      <div class="mobileEntityTop"><div class="mobileEntityMain"><code>${this.escape(e.entity_id)}</code><span class="mobileEntityName">${this.escape(e.name || "")}</span></div><span class="statusBadge ${e.available ? "good" : "bad"}">${e.available ? "available" : "unavailable"}</span></div>
      <div class="mobileEntityMeta"><span class="statusBadge ${e.homekit_supported === false ? "bad" : "good"}">${this.escape(e.homekit_type || "HomeKit")}</span>${this.renderMobileMeta([["State", e.state], ["Room", e.area], ["Device", e.device], ["Domain", e.domain]])}</div>
      <div class="mobileReason ${String(e.inclusion_reason || "").startsWith("ALL") ? "reasonWarn" : ""}">${this.escape(e.inclusion_reason || "")}</div>
    </div>`).join("");
    return `<div id="liveEntities" class="tableCard" tabindex="-1">${this.sectionHead("Live exposed entities", [`${rows.length} rows`])}<div class="tableWrap"><table class="previewTable">${this.colgroup(["21%", "13%", "7%", "9%", "12%", "7%", "9%", "10%", "12%"]) }<thead><tr><th>Entity</th><th>Name</th><th>Domain</th><th>Room</th><th>Device</th><th>State</th><th>Available</th><th>HomeKit type</th><th>Why exposed</th></tr></thead><tbody>${tableRows}</tbody></table></div><div class="mobileList">${mobileRows}</div></div>`;
  }


  compactFilterValues(values, limit = 3) {
    const list = (values || []).filter(Boolean);
    const shown = list.slice(0, limit);
    return {
      count: list.length,
      text: shown.join(", "),
      more: Math.max(0, list.length - shown.length),
      title: list.join(", "),
    };
  }

  filterChips(entry) {
    const pairs = [["include domains", entry.include_domains], ["include entities", entry.include_entities], ["exclude domains", entry.exclude_domains], ["exclude entities", entry.exclude_entities]];
    const chips = pairs.filter(([, values]) => values?.length).map(([label, values]) => {
      const compact = this.compactFilterValues(values, label.includes("entities") ? 1 : 4);
      const count = compact.count > 1 ? ` ${compact.count}` : "";
      const more = compact.more ? `<span class="filterChipMore">+${compact.more}</span>` : "";
      return `<span class="chip filterChip" title="${this.escape(compact.title)}"><b>${this.escape(label)}${count}:</b><span class="filterChipText">${this.escape(compact.text)}</span>${more}</span>`;
    });
    return chips.join("") || `<span class="chip">No explicit filter</span>`;
  }

  renderDomainHints(entry) {
    const hints = entry.domain_wide_includes || [];
    if (!hints.length) return "";
    return `<div class="notice warn compactNotice"><b>Domain include behavior</b>${hints.map((h) => `<div class="sectionNote"><b>${this.escape(h.domain)}</b>: ${this.escape(h.message)}</div>`).join("")}</div>`;
  }

  renderRaw(entry) {
    const exact = this.exactFilter(entry);
    const filterJson = JSON.stringify({ filter: exact }, null, 2);
    const entryJson = JSON.stringify(entry, null, 2);
    const candidates = this.candidates(entry).length;
    const drops = entry.explicit_include_not_exposed?.length || 0;
    const proxyReady = this.proxyReadyDropCount(entry);
    return `<div class="stack">
      <div class="debugSummary">
        <div class="debugTile"><div class="debugTileValue">${exact.include_entities.length}</div><div class="debugTileLabel">entities in exact draft</div></div>
        <div class="debugTile"><div class="debugTileValue">${candidates}</div><div class="debugTileLabel">candidate entities in raw payload</div></div>
        <div class="debugTile ${drops ? "bad" : ""}"><div class="debugTileValue">${drops}</div><div class="debugTileLabel">explicit includes HomeKit drops</div></div>
        <div class="debugTile ${proxyReady ? "warn" : ""}"><div class="debugTileValue">${proxyReady}</div><div class="debugTileLabel">same-unit proxy candidates</div></div>
      </div>
      <div class="debugGrid">
        <div class="panel debugPanel">
          ${this.sectionHead("Exact draft filter", [`${this.ensureDraft(entry).size} entities`], "Copy-ready filter payload for this bridge.")}
          <div class="debugActions"><button id="copyRawFilter">Copy filter JSON</button></div>
          <pre>${this.escape(filterJson)}</pre>
        </div>
        <div class="panel debugPanel">
          ${this.sectionHead("Live selected entry", [`${candidates} candidates`, `${entry.exposed_count ?? 0} live`], "Raw preview payload returned by HomeKit Preview.")}
          <div class="debugActions"><button class="secondary" id="copyRawEntry">Copy raw entry</button></div>
          <pre>${this.escape(entryJson)}</pre>
        </div>
      </div>
    </div>`;
  }

  escape(value) { return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
}
if (!customElements.get(PANEL_TAG)) {
  customElements.define(PANEL_TAG, HomeKitPreviewPanel);
}
if (!customElements.get("homekit-preview-panel")) {
  customElements.define(
    "homekit-preview-panel",
    class HomeKitPreviewPanelLegacy extends HomeKitPreviewPanel {},
  );
}
