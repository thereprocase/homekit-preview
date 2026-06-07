const ICON_URL = "/homekit_preview_static/icon.svg";
const EMPTY_FILTER = {
  include_domains: [], include_entities: [], include_entity_globs: [],
  exclude_domains: [], exclude_entities: [], exclude_entity_globs: []
};

class HomeKitPreviewPanel extends HTMLElement {
  connectedCallback() {
    if (!this.shadowRoot) this.attachShadow({mode:"open"});
    this._data ||= null;
    this._selected ||= "";
    this._tab ||= "preview";
    this._room ||= "all";
    this._device ||= "";
    this._search ||= "";
    this._mode ||= "all";
    this._drafts ||= {};
    this._loading = false;
    this._loaded ||= false;
    this._message = "";
    this.render();
    this.maybeLoad();
  }

  set hass(hass) { this._hass = hass; this.maybeLoad(); }
  maybeLoad() { if (this._hass && !this._loaded && !this._loading) this.load(false); }

  async load(scan) {
    if (!this._hass) return;
    this._loading = true; this._message = ""; this.render();
    try {
      this._data = scan ? await this._hass.callApi("POST", "homekit_preview/scan") : await this._hass.callApi("GET", "homekit_preview/preview");
      this._loaded = true;
      const entries = this._data?.entries || [];
      if (!this._selected && entries.length) this._selected = entries[0].entry_id;
      if (entries.length && !entries.some(e => e.entry_id === this._selected)) this._selected = entries[0].entry_id;
      this.ensureDraft(this.entry());
    } catch (err) { this._message = `Load failed: ${err?.message || err}`; this._loaded = true; }
    finally { this._loading = false; this.render(); }
  }

  entry() { const e = this._data?.entries || []; return e.find(x => x.entry_id === this._selected) || e[0] || null; }
  allCandidates(e) { return e?.candidate_entities || e?.exposed_entities || []; }
  liveSet(e) { return new Set(this.allCandidates(e).filter(x => x.currently_exposed).map(x => x.entity_id)); }
  ensureDraft(e) { if (!e) return new Set(); if (!this._drafts[e.entry_id]) this._drafts[e.entry_id] = [...this.liveSet(e)].sort(); return new Set(this._drafts[e.entry_id]); }
  saveDraft(e, set) { this._drafts[e.entry_id] = [...set].sort(); }
  exactFilter(e) { return {...EMPTY_FILTER, include_entities:[...this.ensureDraft(e)].sort()}; }

  stats(e) {
    const live = this.liveSet(e), draft = this.ensureDraft(e);
    let add = 0, remove = 0;
    for (const id of draft) if (!live.has(id)) add++;
    for (const id of live) if (!draft.has(id)) remove++;
    return {live: live.size, draft: draft.size, add, remove};
  }

  rows(e) {
    return (e?.exposed_entities || []).filter(x => {
      if (this._room !== "all" && (x.area || "No room") !== this._room) return false;
      if (this._mode === "available" && !x.available) return false;
      if (this._mode === "unavailable" && x.available) return false;
      if (this._mode === "domain" && !String(x.inclusion_reason || "").startsWith("ALL")) return false;
      return this.match(x);
    });
  }

  match(x) {
    const q = this._search.trim().toLowerCase();
    if (!q) return true;
    return [x.entity_id,x.name,x.domain,x.area,x.device,x.state,x.inclusion_reason].filter(Boolean).join(" ").toLowerCase().includes(q);
  }

  rooms(e) { return [...new Set(this.allCandidates(e).map(x => x.area || "No room"))].sort(); }
  devKey(x) { return `${x.area || "No room"}|||${x.device || "No device"}|||${x.device_id || ""}`; }
  devices(e) {
    const map = new Map();
    for (const x of this.allCandidates(e)) {
      if (this._room !== "all" && (x.area || "No room") !== this._room) continue;
      if (!this.match(x)) continue;
      const key = this.devKey(x);
      if (!map.has(key)) map.set(key, {key, room:x.area || "No room", name:x.device || "No device", entities:[]});
      map.get(key).entities.push(x);
    }
    const out = [...map.values()].sort((a,b) => a.room.localeCompare(b.room) || a.name.localeCompare(b.name));
    if (out.length && !out.some(d => d.key === this._device)) this._device = out[0].key;
    return out;
  }
  device(e) { const d = this.devices(e); return d.find(x => x.key === this._device) || d[0] || null; }

  toggle(e, id, checked) { const d = this.ensureDraft(e); checked ? d.add(id) : d.delete(id); this.saveDraft(e,d); this.render(); }
  setDevice(e, dev, checked) { const d = this.ensureDraft(e); for (const x of dev?.entities || []) checked ? d.add(x.entity_id) : d.delete(x.entity_id); this.saveDraft(e,d); this.render(); }
  reset(e) { delete this._drafts[e.entry_id]; this.ensureDraft(e); this.render(); }
  clear(e) { this._drafts[e.entry_id] = []; this.render(); }

  async apply(e) {
    const filter = this.exactFilter(e);
    if (!confirm(`Apply exact list to ${e.title}?\n\nThis writes ${filter.include_entities.length} explicit entities and reloads the HomeKit entry.`)) return;
    this._loading = true; this._message = "Applying..."; this.render();
    try {
      this._data = await this._hass.callApi("POST", "homekit_preview/update_filter", {entry_id:e.entry_id, filter, reload:true});
      delete this._drafts[e.entry_id];
      this.ensureDraft(this.entry());
      this._message = "Applied. HomeKit entry reloaded.";
    } catch (err) { this._message = `Apply failed: ${err?.message || err}`; }
    finally { this._loading = false; this.render(); }
  }

  async showPairing(e) {
    this._loading = true; this._message = "Requesting pairing notification..."; this.render();
    try {
      const r = await this._hass.callApi("POST", "homekit_preview/show_pairing", {entry_id:e.entry_id});
      this._message = r?.message || "Pairing notification shown.";
      await this.load(true);
    } catch (err) { this._message = `Pairing request failed: ${err?.message || err}`; }
    finally { this._loading = false; this.render(); }
  }

  searchChanged(value) {
    this._search = value;
    clearTimeout(this._searchTimer);
    this._searchTimer = setTimeout(() => {
      const old = this.shadowRoot?.getElementById("search");
      const pos = old?.selectionStart ?? this._search.length;
      this.render();
      const next = this.shadowRoot?.getElementById("search");
      if (next) { next.focus(); next.setSelectionRange?.(pos,pos); }
    }, 180);
  }

  render() {
    const e = this.entry(), entries = this._data?.entries || [];
    const stats = e ? this.stats(e) : {live:0,draft:0,add:0,remove:0};
    const rows = e ? this.rows(e) : [];
    const rooms = e ? this.rooms(e) : [];
    const devs = e ? this.devices(e) : [];
    const dev = e ? this.device(e) : null;
    this.shadowRoot.innerHTML = `
<style>
:host{display:block;padding:18px;color:var(--primary-text-color);background:var(--primary-background-color);min-height:100vh}.wrap{max-width:1200px;margin:auto}.top{display:flex;gap:14px;justify-content:space-between;align-items:flex-start;flex-wrap:wrap}.brand{display:flex;gap:12px;align-items:center}.brand img{width:44px;height:44px;border-radius:14px}h1{margin:0;font-size:26px}.sub,.muted{color:var(--secondary-text-color)}select,input,button{font:inherit;box-sizing:border-box;border:1px solid var(--divider-color);border-radius:12px;padding:10px 12px;background:var(--card-background-color);color:var(--primary-text-color)}button{background:var(--primary-color);color:var(--text-primary-color);font-weight:700;cursor:pointer}button.secondary{background:var(--card-background-color);color:var(--primary-text-color)}.controls,.tabs,.chips{display:flex;gap:8px;flex-wrap:wrap}.tabs{margin:14px 0}.tab,.pill{border-radius:999px;padding:7px 10px;background:var(--card-background-color);color:var(--primary-text-color)}.active{background:var(--primary-color)!important;color:var(--text-primary-color)!important}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:14px 0}.card,.summary{background:var(--card-background-color);border:1px solid var(--divider-color);border-radius:18px;padding:15px}.summary{text-align:left;color:var(--primary-text-color)}.summary:hover{border-color:var(--primary-color)}.num{font-size:28px;font-weight:900}.label{font-size:13px;color:var(--secondary-text-color)}.ok{border-left:4px solid var(--success-color,#0b8043)}.warn{border-left:4px solid var(--warning-color,#ffa600)}.error{border-left:4px solid var(--error-color,#db4437)}.good{color:var(--success-color,#0b8043);font-weight:800}.bad{color:var(--error-color,#db4437);font-weight:800}.chip{font-size:12px;padding:5px 8px;border-radius:999px;background:var(--secondary-background-color);border:1px solid var(--divider-color)}.layout{display:grid;grid-template-columns:300px 1fr;gap:12px}.deviceList{display:flex;flex-direction:column;gap:8px}.device{width:100%;text-align:left;background:var(--card-background-color);color:var(--primary-text-color);border:1px solid var(--divider-color);border-radius:14px;padding:12px}.device.sel{border-color:var(--primary-color)}.table{overflow:auto;border:1px solid var(--divider-color);border-radius:16px}table{width:100%;border-collapse:collapse;min-width:860px}th,td{text-align:left;padding:9px;border-bottom:1px solid var(--divider-color)}th{background:var(--secondary-background-color);font-size:12px;text-transform:uppercase}.entityCards{display:none}.entityCard{margin-bottom:10px}.selected td{background:color-mix(in srgb,var(--success-color,#0b8043) 12%,transparent)}code,pre{background:var(--secondary-background-color);border-radius:6px;padding:2px 5px}pre{padding:12px;overflow:auto;white-space:pre-wrap}@media(max-width:760px){:host{padding:12px}.top{display:block}.controls select,.controls button,input{width:100%;margin-top:8px}.grid{grid-template-columns:1fr 1fr}.layout{grid-template-columns:1fr}.table{display:none}.entityCards{display:block}.brand{margin-bottom:10px}}
</style>
<div class="wrap">
  <div class="top"><div class="brand"><img src="${ICON_URL}"><div><h1>HomeKit Preview</h1><div class="sub">Preview first. Device Picker edits a delta from live.</div></div></div><div class="controls"><select id="bridge">${entries.map(x=>`<option value="${this.esc(x.entry_id)}" ${x.entry_id===this._selected?"selected":""}>${this.esc(x.title)} · ${this.esc(x.port||"?")}</option>`).join("")}</select><button id="refresh">${this._loading?"Scanning...":"Scan / Refresh"}</button></div></div>
  <div class="tabs"><button class="tab ${this._tab==="preview"?"active":""}" data-tab="preview">Preview</button><button class="tab ${this._tab==="device"?"active":""}" data-tab="device">Device Picker</button><button class="tab ${this._tab==="raw"?"active":""}" data-tab="raw">Raw</button></div>
  ${this._message?`<div class="card ${this._message.toLowerCase().includes("failed")?"error":"ok"}">${this.esc(this._message)}</div>`:""}
  <div class="grid">${this.summary("all",e?.exposed_count||0,"Live exposed")}${this.summary("available",e?.available_count||0,"Available","good")}${this.summary("unavailable",e?.unavailable_count||0,"Unavailable","bad")}${this.summary("domain",e?.domain_wide_include_count||0,"Domain traps")}${this.tabSummary("device",`${stats.add}/${stats.remove}`,"Draft + / −")}</div>
  ${e?this.pairing(e):""}
  ${e?(this._tab==="device"?this.deviceTab(e,rooms,devs,dev,stats):this._tab==="raw"?this.rawTab(e):this.previewTab(e,rows,rooms)):"<div class='card'>No HomeKit entries found.</div>"}
</div>`;
    this.bind(e);
  }

  summary(mode,val,label,cls="") { return `<button class="summary ${this._mode===mode?"active":""}" data-mode="${mode}"><div class="num ${cls}">${val}</div><div class="label">${label}</div></button>`; }
  tabSummary(tab,val,label) { return `<button class="summary" data-tab="${tab}"><div class="num">${val}</div><div class="label">${label}</div></button>`; }

  bind(e) {
    this.shadowRoot.getElementById("refresh")?.addEventListener("click",()=>this.load(true));
    this.shadowRoot.getElementById("bridge")?.addEventListener("change",ev=>{this._selected=ev.target.value;this._room="all";this._device="";this.render();});
    this.shadowRoot.querySelectorAll("[data-tab]").forEach(b=>b.addEventListener("click",()=>{this._tab=b.dataset.tab;this.render();}));
    this.shadowRoot.querySelectorAll("[data-mode]").forEach(b=>b.addEventListener("click",()=>{this._mode=b.dataset.mode;this._tab="preview";this.render();}));
    this.shadowRoot.getElementById("room")?.addEventListener("change",ev=>{this._room=ev.target.value;this._device="";this.render();});
    this.shadowRoot.getElementById("search")?.addEventListener("input",ev=>this.searchChanged(ev.target.value));
    this.shadowRoot.querySelectorAll("[data-dev]").forEach(b=>b.addEventListener("click",()=>{this._device=b.dataset.dev;this.render();}));
    this.shadowRoot.querySelectorAll("[data-ent]").forEach(c=>c.addEventListener("change",()=>this.toggle(e,c.dataset.ent,c.checked)));
    this.shadowRoot.getElementById("addDev")?.addEventListener("click",()=>this.setDevice(e,this.device(e),true));
    this.shadowRoot.getElementById("remDev")?.addEventListener("click",()=>this.setDevice(e,this.device(e),false));
    this.shadowRoot.getElementById("reset")?.addEventListener("click",()=>this.reset(e));
    this.shadowRoot.getElementById("clear")?.addEventListener("click",()=>this.clear(e));
    this.shadowRoot.getElementById("apply")?.addEventListener("click",()=>this.apply(e));
    this.shadowRoot.getElementById("showPair")?.addEventListener("click",()=>this.showPairing(e));
  }

  controls(rooms) { return `<div class="controls"><select id="room"><option value="all">All rooms</option>${rooms.map(r=>`<option value="${this.esc(r)}" ${r===this._room?"selected":""}>${this.esc(r)}</option>`).join("")}</select><input id="search" value="${this.esc(this._search)}" placeholder="Search room, device, entity..." autocomplete="off"></div>`; }

  pairing(e) {
    const p = e.pairing || {}, paired = p.paired === true, unpaired = p.paired === false;
    return `<div class="card ${paired?"ok":unpaired?"warn":""}"><b>${paired?"Paired to Apple Home":unpaired?"Not paired yet":"Pairing unknown"}</b><p class="muted">${this.esc(p.summary||"Status unavailable")}</p><div class="chips"><span class="chip">status: ${this.esc(p.status||"unknown")}</span><span class="chip">clients: ${this.esc(p.client_count??"?")}</span>${unpaired&&p.pincode?`<span class="chip">PIN: ${this.esc(p.pincode)}</span>`:""}</div>${unpaired&&p.can_show_pairing?`<div class="controls" style="margin-top:10px"><button id="showPair">Show QR / PIN notification</button></div>`:""}</div>`;
  }

  previewTab(e, rows, rooms) { return `${this.hints(e)}${this.controls(rooms)}${this.table(rows)}${this.mobileRows(rows)}`; }
  table(rows) { if(!rows.length)return`<div class="card">No exposed entities match.</div>`; return `<div class="table"><table><thead><tr><th>Entity</th><th>Name</th><th>Domain</th><th>Room</th><th>Device</th><th>State</th><th>Why</th></tr></thead><tbody>${rows.map(x=>`<tr><td><code>${this.esc(x.entity_id)}</code></td><td>${this.esc(x.name||"")}</td><td>${this.esc(x.domain)}</td><td>${this.esc(x.area||"")}</td><td>${this.esc(x.device||"")}</td><td>${this.esc(x.state||"")}</td><td>${this.esc(x.inclusion_reason||"")}</td></tr>`).join("")}</tbody></table></div>`; }
  mobileRows(rows) { return `<div class="entityCards">${rows.map(x=>`<div class="card entityCard"><b>${this.esc(x.name||x.entity_id)}</b><div><code>${this.esc(x.entity_id)}</code></div><div class="chips"><span class="chip">${this.esc(x.domain)}</span><span class="chip">${this.esc(x.area||"")}</span><span class="chip ${x.available?"good":"bad"}">${x.available?"available":"unavailable"}</span></div><p class="muted">${this.esc(x.inclusion_reason||"")}</p></div>`).join("")}</div>`; }

  deviceTab(e, rooms, devices, dev, stats) {
    const draft = this.ensureDraft(e);
    return `<div class="card"><b>Delta builder.</b><p class="muted">Starts from live. Add or remove device entities, then apply the exact final list.</p></div>${this.controls(rooms)}<div class="layout"><div class="deviceList">${devices.map(d=>{const sel=d.entities.filter(x=>draft.has(x.entity_id)).length;const live=d.entities.filter(x=>x.currently_exposed).length;return`<button class="device ${d.key===dev?.key?"sel":""}" data-dev="${this.esc(d.key)}"><b>${this.esc(d.name)}</b><div class="muted">${this.esc(d.room)} · ${d.entities.length} entities</div><div class="chips"><span class="chip">${sel} selected</span><span class="chip">${live} live</span></div></button>`}).join("")}</div><div>${dev?this.devEntities(e,dev):"<div class='card'>Pick a device.</div>"}</div></div><div class="grid"><div class="card"><div class="num">${stats.live}</div><div class="label">Live</div></div><div class="card"><div class="num">${stats.draft}</div><div class="label">Draft</div></div><div class="card"><div class="num good">${stats.add}</div><div class="label">Would add</div></div><div class="card"><div class="num bad">${stats.remove}</div><div class="label">Would remove</div></div></div><div class="controls"><button id="apply">Apply exact list</button><button class="secondary" id="reset">Reset from live</button><button class="secondary" id="clear">Clear draft</button></div>`;
  }
  devEntities(e,dev){const draft=this.ensureDraft(e);return`<div class="card"><b>${this.esc(dev.name)}</b><div class="muted">${this.esc(dev.room)}</div><div class="controls" style="margin-top:10px"><button id="addDev">Add all on device</button><button class="secondary" id="remDev">Remove all on device</button></div></div><div class="table"><table><thead><tr><th>In HomeKit</th><th>Entity</th><th>Name</th><th>Live</th><th>State</th></tr></thead><tbody>${dev.entities.map(x=>`<tr class="${draft.has(x.entity_id)?"selected":""}"><td><input type="checkbox" data-ent="${this.esc(x.entity_id)}" ${draft.has(x.entity_id)?"checked":""}></td><td><code>${this.esc(x.entity_id)}</code></td><td>${this.esc(x.name||"")}</td><td>${x.currently_exposed?"yes":"no"}</td><td>${this.esc(x.state||"")}</td></tr>`).join("")}</tbody></table></div>${this.mobileRows(dev.entities)}`}

  rawTab(e){return`<div class="card"><b>Exact draft filter</b><pre>${this.esc(JSON.stringify({filter:this.exactFilter(e)},null,2))}</pre></div><div class="card"><b>Selected entry</b><pre>${this.esc(JSON.stringify(e,null,2))}</pre></div>`}
  hints(e){const h=e.domain_wide_includes||[];return h.length?`<div class="card warn"><b>Domain include behavior</b>${h.map(x=>`<p>${this.esc(x.domain)}: ${this.esc(x.message)}</p>`).join("")}</div>`:""}
  esc(v){return String(v??"").replace(/[&<>'"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[c]));}
}
customElements.define("homekit-preview-panel", HomeKitPreviewPanel);
