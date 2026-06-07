const ICON_URL = "/homekit_preview_static/icon.svg";
const EMPTY_FILTER = {
  include_domains: [], include_entities: [], include_entity_globs: [],
  exclude_domains: [], exclude_entities: [], exclude_entity_globs: [],
};

class HomeKitPreviewPanel extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });
    this._data = this._data || null;
    this._selected = this._selected || "";
    this._tab = this._tab || "device";
    this._room = this._room || "all";
    this._deviceKey = this._deviceKey || "";
    this._search = this._search || "";
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

  ensureDraft(entry) {
    if (!entry) return new Set();
    if (!this._drafts[entry.entry_id]) this._drafts[entry.entry_id] = Array.from(this.liveIds(entry)).sort();
    return new Set(this._drafts[entry.entry_id]);
  }

  saveDraft(entry, set) {
    this._drafts[entry.entry_id] = Array.from(set).sort();
  }

  exactFilter(entry) {
    const ids = Array.from(this.ensureDraft(entry)).sort();
    return { ...EMPTY_FILTER, include_entities: ids };
  }

  draftStats(entry) {
    const live = this.liveIds(entry);
    const draft = this.ensureDraft(entry);
    let added = 0, removed = 0;
    for (const id of draft) if (!live.has(id)) added += 1;
    for (const id of live) if (!draft.has(id)) removed += 1;
    return { live: live.size, draft: draft.size, added, removed, changed: added + removed };
  }

  toggleEntity(entry, entityId, on) {
    const draft = this.ensureDraft(entry);
    if (on === undefined) draft.has(entityId) ? draft.delete(entityId) : draft.add(entityId);
    else if (on) draft.add(entityId);
    else draft.delete(entityId);
    this.saveDraft(entry, draft);
    this.render();
  }

  setEntities(entry, entities, on) {
    const draft = this.ensureDraft(entry);
    for (const entity of entities) on ? draft.add(entity.entity_id) : draft.delete(entity.entity_id);
    this.saveDraft(entry, draft);
    this.render();
  }

  resetDraft(entry) { delete this._drafts[entry.entry_id]; this.ensureDraft(entry); this.render(); }
  clearDraft(entry) { this._drafts[entry.entry_id] = []; this.render(); }

  async applyDraft(entry) {
    if (!entry) return;
    const filter = this.exactFilter(entry);
    const msg = `Apply exact HomeKit entity list to ${entry.title}?\n\nThis will remove domain-wide includes and write ${filter.include_entities.length} explicit entities.`;
    if (!confirm(msg)) return;
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

  async copyText(text, label) {
    try { await navigator.clipboard.writeText(text); this._message = `${label} copied.`; }
    catch (err) { this._message = `Copy failed: ${err?.message || err}`; }
    this.render();
  }

  rooms(entry) {
    const names = new Set(this.candidates(entry).map((e) => e.area || "No room"));
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }

  deviceKey(entity) { return `${entity.area || "No room"}|||${entity.device || "No device"}|||${entity.device_id || ""}`; }

  devices(entry) {
    const q = this._search.trim().toLowerCase();
    const groups = new Map();
    for (const entity of this.candidates(entry)) {
      const room = entity.area || "No room";
      if (this._room !== "all" && room !== this._room) continue;
      const hay = [entity.entity_id, entity.name, entity.domain, entity.area, entity.device, entity.state].filter(Boolean).join(" ").toLowerCase();
      if (q && !hay.includes(q)) continue;
      const key = this.deviceKey(entity);
      if (!groups.has(key)) groups.set(key, { key, room, name: entity.device || "No device", entities: [] });
      groups.get(key).entities.push(entity);
    }
    const devices = Array.from(groups.values()).sort((a, b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
    if (devices.length && !devices.some((device) => device.key === this._deviceKey)) this._deviceKey = devices[0].key;
    return devices;
  }

  selectedDevice(entry) { return this.devices(entry).find((device) => device.key === this._deviceKey) || this.devices(entry)[0] || null; }

  rowMatches(entity) {
    const q = this._search.trim().toLowerCase();
    if (!q) return true;
    return [entity.entity_id, entity.name, entity.domain, entity.area, entity.device, entity.state, entity.inclusion_reason]
      .filter(Boolean).join(" ").toLowerCase().includes(q);
  }

  filteredPreviewRows(entry) {
    return (entry?.exposed_entities || []).filter((entity) => {
      if (this._room !== "all" && (entity.area || "No room") !== this._room) return false;
      return this.rowMatches(entity);
    });
  }

  scheduleSearch(value) {
    this._search = value;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => this.render(), 180);
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
      <style>
        :host{display:block;padding:24px;box-sizing:border-box;color:var(--primary-text-color);background:var(--primary-background-color);min-height:100vh}.wrap{max-width:1420px;margin:0 auto}.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:16px}.titleRow{display:flex;align-items:center;gap:12px}.appIcon{width:46px;height:46px;border-radius:14px;box-shadow:var(--ha-card-box-shadow,none)}h1{margin:0;font-size:28px;font-weight:800}.sub,.muted{color:var(--secondary-text-color)}.controls,.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap}select,input,button{font:inherit;padding:10px 12px;border-radius:10px;border:1px solid var(--divider-color);background:var(--card-background-color);color:var(--primary-text-color);box-sizing:border-box;min-height:42px}input{min-width:280px}button{cursor:pointer;background:var(--primary-color);color:var(--text-primary-color);border-color:var(--primary-color);font-weight:700}button.secondary{background:var(--card-background-color);color:var(--primary-text-color);border-color:var(--divider-color)}button.danger{background:var(--error-color,#db4437);border-color:var(--error-color,#db4437);color:white}button[disabled]{opacity:.55;cursor:not-allowed}.tabs,.pills{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.tab,.pill,.miniBtn{background:var(--card-background-color);color:var(--primary-text-color);border:1px solid var(--divider-color);border-radius:999px;min-height:unset;padding:7px 10px;font-size:13px}.tab.active,.pill.active{background:var(--primary-color);color:var(--text-primary-color);border-color:var(--primary-color)}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:16px 0}.card{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:16px;padding:16px;box-shadow:var(--ha-card-box-shadow,none)}.num{font-size:28px;font-weight:850;line-height:1.1;overflow-wrap:anywhere}.label{color:var(--secondary-text-color);font-size:13px;margin-top:4px}.warn{border-left:4px solid var(--warning-color,#ffa600)}.error{border-left:4px solid var(--error-color,#db4437)}.ok{border-left:4px solid var(--success-color,#0b8043)}.sectionTitle{font-size:18px;font-weight:800;margin:22px 0 8px}.layout{display:grid;grid-template-columns:320px 1fr;gap:14px}@media(max-width:900px){.layout{grid-template-columns:1fr}}.deviceList{display:flex;flex-direction:column;gap:8px;max-height:68vh;overflow:auto}.deviceCard{text-align:left;background:var(--card-background-color);color:var(--primary-text-color);border:1px solid var(--divider-color);border-radius:14px;padding:12px;cursor:pointer}.deviceCard.active{border-color:var(--primary-color);box-shadow:0 0 0 1px var(--primary-color)}.chips{display:flex;gap:7px;flex-wrap:wrap;margin-top:8px}.chip{font-size:12px;padding:5px 8px;border-radius:999px;background:var(--secondary-background-color);border:1px solid var(--divider-color)}.warnChip{border-color:var(--warning-color,#ffa600);background:color-mix(in srgb,var(--warning-color,#ffa600) 18%,var(--card-background-color))}.tableWrap{overflow:auto;border-radius:16px;border:1px solid var(--divider-color);background:var(--card-background-color)}table{width:100%;border-collapse:collapse;min-width:980px}th,td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--divider-color);vertical-align:top}th{font-size:12px;text-transform:uppercase;color:var(--secondary-text-color);background:var(--secondary-background-color);letter-spacing:.04em;position:sticky;top:0;z-index:1}tr:last-child td{border-bottom:0}.selectedRow td{background:color-mix(in srgb,var(--success-color,#0b8043) 12%,transparent)}code,pre{background:var(--secondary-background-color);padding:2px 5px;border-radius:6px}pre{padding:16px;overflow:auto;white-space:pre-wrap}.good{color:var(--success-color,#0b8043);font-weight:800}.bad{color:var(--error-color,#db4437);font-weight:800}.reasonWarn{color:var(--warning-color,#ffa600);font-weight:800}.empty{text-align:center;padding:24px}.hint{line-height:1.45}.hint p{margin:6px 0}.footer{margin-top:14px;color:var(--secondary-text-color);font-size:13px}
      </style>
      <div class="wrap">
        <div class="top">
          <div class="titleRow"><img class="appIcon" src="${ICON_URL}" alt=""><div><h1>HomeKit Preview</h1><div class="sub">Room → device → choose entities. No more domain trap.</div></div></div>
          <div class="controls">
            <select id="bridgeSelect" aria-label="HomeKit bridge">${entries.map((item) => `<option value="${this.escape(item.entry_id)}" ${item.entry_id === this._selected ? "selected" : ""}>${this.escape(item.title || "HomeKit entry")} · ${this.escape(item.port || "unknown port")}</option>`).join("")}</select>
            <button id="refresh" ${this._loading ? "disabled" : ""}>${this._loading ? "Scanning..." : "Scan / Refresh"}</button>
          </div>
        </div>
        <div class="tabs"><button class="tab ${this._tab === "device" ? "active" : ""}" data-tab="device">Device Picker</button><button class="tab ${this._tab === "preview" ? "active" : ""}" data-tab="preview">Live Preview</button><button class="tab ${this._tab === "raw" ? "active" : ""}" data-tab="raw">Raw</button></div>
        ${this._message ? `<div class="card ${this._message.includes("failed") || this._message.includes("failed") ? "error" : "ok"}"><b>${this.escape(this._message)}</b></div>` : ""}
        ${(data.warnings || []).length ? `<div class="card warn"><b>Warnings</b><ul>${data.warnings.map((w) => `<li>${this.escape(w)}</li>`).join("")}</ul></div>` : ""}
        <div class="cards"><div class="card"><div class="num">${data.entry_count ?? 0}</div><div class="label">HomeKit entries</div></div><div class="card"><div class="num">${data.total_exposed ?? 0}</div><div class="label">Total live exposed</div></div><div class="card"><div class="num">${entry?.exposed_count ?? 0}</div><div class="label">Selected live</div></div><div class="card"><div class="num">${stats.draft}</div><div class="label">Draft exact list</div></div><div class="card"><div class="num good">${stats.added}</div><div class="label">Would add</div></div><div class="card"><div class="num bad">${stats.removed}</div><div class="label">Would remove</div></div><div class="card ${entry?.domain_wide_include_count ? "warn" : ""}"><div class="num">${entry?.domain_wide_include_count ?? 0}</div><div class="label">ALL-domain traps</div></div></div>
        ${entry ? (this._tab === "device" ? this.renderDevicePicker(entry, rooms, devices, selectedDevice, stats) : this._tab === "raw" ? this.renderRaw(entry) : this.renderPreview(entry, previewRows, rooms)) : `<div class="card empty">No HomeKit entries found.</div>`}
      </div>`;
    this.bind(entry);
  }

  bind(entry) {
    this.shadowRoot.getElementById("refresh")?.addEventListener("click", () => this.loadData(true));
    this.shadowRoot.getElementById("bridgeSelect")?.addEventListener("change", (ev) => { this._selected = ev.target.value; this._room = "all"; this._deviceKey = ""; this.render(); });
    this.shadowRoot.querySelectorAll("[data-tab]").forEach((el) => el.addEventListener("click", () => { this._tab = el.dataset.tab; this.render(); }));
    this.shadowRoot.getElementById("roomFilter")?.addEventListener("change", (ev) => { this._room = ev.target.value; this._deviceKey = ""; this.render(); });
    this.shadowRoot.getElementById("entitySearch")?.addEventListener("input", (ev) => this.scheduleSearch(ev.target.value));
    this.shadowRoot.querySelectorAll("[data-device]").forEach((el) => el.addEventListener("click", () => { this._deviceKey = el.dataset.device; this.render(); }));
    this.shadowRoot.querySelectorAll("[data-toggle-entity]").forEach((el) => el.addEventListener("change", () => this.toggleEntity(entry, el.dataset.toggleEntity, el.checked)));
    this.shadowRoot.getElementById("addDevice")?.addEventListener("click", () => this.setEntities(entry, this.selectedDevice(entry)?.entities || [], true));
    this.shadowRoot.getElementById("removeDevice")?.addEventListener("click", () => this.setEntities(entry, this.selectedDevice(entry)?.entities || [], false));
    this.shadowRoot.getElementById("resetDraft")?.addEventListener("click", () => this.resetDraft(entry));
    this.shadowRoot.getElementById("clearDraft")?.addEventListener("click", () => this.clearDraft(entry));
    this.shadowRoot.getElementById("applyDraft")?.addEventListener("click", () => this.applyDraft(entry));
    this.shadowRoot.getElementById("copyDraft")?.addEventListener("click", () => this.copyText(JSON.stringify({ filter: this.exactFilter(entry) }, null, 2), "Exact filter"));
  }

  renderControls(rooms) {
    return `<div class="toolbar"><div class="controls"><select id="roomFilter"><option value="all">All rooms</option>${rooms.map((room) => `<option value="${this.escape(room)}" ${room === this._room ? "selected" : ""}>${this.escape(room)}</option>`).join("")}</select><input id="entitySearch" placeholder="Search room, device, entity..." value="${this.escape(this._search)}"></div></div>`;
  }

  renderDevicePicker(entry, rooms, devices, selectedDevice, stats) {
    const draft = this.ensureDraft(entry);
    return `<div class="card warn hint"><b>This writes an exact entity list.</b><p>Pick a room, pick a device, check the entities you want. Applying removes domain-wide includes and writes only the selected entity IDs, so HomeKit Bridge cannot accidentally include every switch/camera/sensor.</p></div>${this.renderDomainHints(entry)}${this.renderControls(rooms)}<div class="layout"><div><div class="sectionTitle">Devices</div><div class="deviceList">${devices.map((device) => { const selected = device.entities.filter((e) => draft.has(e.entity_id)).length; const live = device.entities.filter((e) => e.currently_exposed).length; return `<button class="deviceCard ${device.key === selectedDevice?.key ? "active" : ""}" data-device="${this.escape(device.key)}"><b>${this.escape(device.name)}</b><div class="muted">${this.escape(device.room)} · ${device.entities.length} entities</div><div class="chips"><span class="chip">${selected} selected</span><span class="chip">${live} live</span></div></button>`; }).join("") || `<div class="card empty">No devices match.</div>`}</div></div><div>${selectedDevice ? this.renderDeviceEntities(entry, selectedDevice) : `<div class="card empty">Pick a device.</div>`}</div></div><div class="cards"><div class="card"><div class="num">${stats.live}</div><div class="label">Live now</div></div><div class="card"><div class="num">${stats.draft}</div><div class="label">Exact draft</div></div><div class="card"><div class="num good">${stats.added}</div><div class="label">Would add</div></div><div class="card"><div class="num bad">${stats.removed}</div><div class="label">Would remove</div></div></div><div class="controls"><button id="applyDraft" ${this._loading ? "disabled" : ""}>Apply exact list to HomeKit Bridge</button><button class="secondary" id="resetDraft">Reset from live</button><button class="secondary" id="clearDraft">Clear draft</button><button class="secondary" id="copyDraft">Copy exact filter JSON</button></div>`;
  }

  renderDeviceEntities(entry, device) {
    const draft = this.ensureDraft(entry);
    return `<div class="card"><div class="sectionTitle" style="margin-top:0;">${this.escape(device.name)}</div><div class="muted">${this.escape(device.room)} · ${device.entities.length} entities</div><div class="controls" style="margin-top:12px;"><button id="addDevice">Add all entities on this device</button><button class="secondary" id="removeDevice">Remove all entities on this device</button></div></div><div class="tableWrap"><table><thead><tr><th>In HomeKit?</th><th>Entity</th><th>Name</th><th>Domain</th><th>Live</th><th>State</th><th>Why live?</th></tr></thead><tbody>${device.entities.map((entity) => { const checked = draft.has(entity.entity_id); return `<tr class="${checked ? "selectedRow" : ""}"><td><input type="checkbox" data-toggle-entity="${this.escape(entity.entity_id)}" ${checked ? "checked" : ""}></td><td><code>${this.escape(entity.entity_id)}</code></td><td>${this.escape(entity.name || "")}</td><td>${this.escape(entity.domain)}</td><td>${entity.currently_exposed ? "yes" : "no"}</td><td><code>${this.escape(entity.state || "")}</code></td><td class="${String(entity.inclusion_reason || "").startsWith("ALL") ? "reasonWarn" : ""}">${this.escape(entity.inclusion_reason || "")}</td></tr>`; }).join("")}</tbody></table></div>`;
  }

  renderPreview(entry, rows, rooms) {
    return `${this.renderDomainHints(entry)}${this.renderControls(rooms)}<div class="card"><div class="sectionTitle" style="margin-top:0;">${this.escape(entry.title)}</div><div class="muted">Port <code>${this.escape(entry.port || "unknown")}</code> · Mode <code>${this.escape(entry.mode || "unknown")}</code></div><div class="chips">${this.filterChips(entry)}</div></div>${this.renderPreviewTable(rows)}`;
  }

  renderPreviewTable(rows) {
    if (!rows.length) return `<div class="card empty">No live exposed entities match.</div>`;
    return `<div class="tableWrap"><table><thead><tr><th>Entity</th><th>Name</th><th>Domain</th><th>Room</th><th>Device</th><th>State</th><th>Available</th><th>Why included</th></tr></thead><tbody>${rows.map((e) => `<tr><td><code>${this.escape(e.entity_id)}</code></td><td>${this.escape(e.name || "")}</td><td>${this.escape(e.domain)}</td><td>${this.escape(e.area || "")}</td><td>${this.escape(e.device || "")}</td><td><code>${this.escape(e.state || "")}</code></td><td class="${e.available ? "good" : "bad"}">${e.available ? "yes" : "no"}</td><td class="${String(e.inclusion_reason || "").startsWith("ALL") ? "reasonWarn" : ""}">${this.escape(e.inclusion_reason || "")}</td></tr>`).join("")}</tbody></table></div>`;
  }

  filterChips(entry) {
    const pairs = [["include domains", entry.include_domains], ["include entities", entry.include_entities], ["exclude domains", entry.exclude_domains], ["exclude entities", entry.exclude_entities]];
    return pairs.filter(([, values]) => values?.length).map(([label, values]) => `<span class="chip"><b>${label}</b>: ${values.map((v) => this.escape(v)).join(", ")}</span>`).join("") || `<span class="chip">No explicit filter</span>`;
  }

  renderDomainHints(entry) {
    const hints = entry.domain_wide_includes || [];
    if (!hints.length) return "";
    return `<div class="card warn hint"><b>Domain include behavior</b>${hints.map((h) => `<p><b>${this.escape(h.domain)}</b>: ${this.escape(h.message)}</p>`).join("")}</div>`;
  }

  renderRaw(entry) { return `<div class="card"><div class="sectionTitle" style="margin-top:0;">Exact draft filter</div><pre>${this.escape(JSON.stringify({ filter: this.exactFilter(entry) }, null, 2))}</pre></div><div class="card"><div class="sectionTitle" style="margin-top:0;">Live selected entry</div><pre>${this.escape(JSON.stringify(entry, null, 2))}</pre></div>`; }

  escape(value) { return String(value ?? "").replace(/[&<>'"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c])); }
}
customElements.define("homekit-preview-panel", HomeKitPreviewPanel);
