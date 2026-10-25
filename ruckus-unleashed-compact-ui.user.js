// ==UserScript==
// @name         Ruckus Unleashed Compact UI
// @namespace    https://github.com/henno/ruckus-unleashed-compact-ui
// @version      1.12.0
// @description  Dense single-screen table UI for Ruckus Unleashed: APs, clients, WLANs and events at once.
// @author       Henno Täht
// @license      MIT
// @homepageURL  https://github.com/henno/ruckus-unleashed-compact-ui
// @supportURL   https://github.com/henno/ruckus-unleashed-compact-ui/issues
// @updateURL    https://raw.githubusercontent.com/henno/ruckus-unleashed-compact-ui/main/ruckus-unleashed-compact-ui.user.js
// @downloadURL  https://raw.githubusercontent.com/henno/ruckus-unleashed-compact-ui/main/ruckus-unleashed-compact-ui.user.js
// @match        https://*/admin/dashboard.jsp*
// @match        http://*/admin/dashboard.jsp*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  if (window.__tgUnleashed) return;
  // @match is broad, so run only on a real Unleashed page
  if (!/unleashed/i.test(document.title) || typeof window.csfrToken !== 'string') return;
  window.__tgUnleashed = true;

  // ---------- configuration ----------
  const LS = 'tgUnleashed.';
  const store = {
    get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };
  const state = {
    interval: store.get('interval', 15),
    filter: '',
    apFilter: null, // AP MAC whose clients are shown
    expanded: new Set(store.get('expanded', [])), // expanded AP rows
    sort: store.get('sort', { ap: ['state', 1], cl: ['ap', 1], ev: ['time', -1] }),
    blocked: [], acl: {}, upBase: store.get('upBase', { at: 0, aps: {} }), aps: [], apsConf: new Map(), clients: [], wlans: [], wlanConf: [], events: [], sys: {},
    prev: { aps: new Map(), clients: new Map() },
    lastOk: 0, loading: false, error: null,
  };

  // ---------- API ----------
  let seq = 0;
  async function ajax(file, action, comp, inner = '', extra = '') {
    const body = `<ajax-request action='${action}' comp='${comp}' updater='tg.${Date.now()}.${++seq}' ${extra}>${inner}</ajax-request>`;
    const r = await fetch(`/admin/_${file}.jsp`, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'text/xml', 'X-CSRF-Token': window.csfrToken || '' },
      body,
    });
    const text = await r.text();
    if (!r.ok || !text.includes('<ajax-response')) throw new Error(r.status === 200 ? 'Session expired' : `HTTP ${r.status}`);
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const err = doc.querySelector('response[type="error"], error, xmsg[type="-1"]');
    if (err && action !== 'getstat' && action !== 'getconf') throw new Error(err.getAttribute('lmsg') || err.getAttribute('msg') || err.textContent || 'Error');
    return doc;
  }
  const stat = (comp, inner) => ajax('cmdstat', 'getstat', comp, inner, "caller='unleashed_web'");
  const conf = (comp) => ajax('conf', 'getconf', comp);
  const attrs = (el) => { const o = {}; for (const a of el.attributes) o[a.name] = a.value; return o; };

  const cmd = {
    reboot: (mac) => ajax('cmdstat', 'docmd', 'stamgr', `<xcmd cmd='reset' ap='${mac}' tag='ap' checkAbility='2'/>`, "xcmd='reset' checkAbility='2'"),
    kick: (mac) => ajax('cmdstat', 'docmd', 'stamgr', `<xcmd cmd='delete' tag='client' client='${mac}'/>`, "xcmd='delete' checkAbility='2'"),
    block: (mac) => ajax('cmdstat', 'docmd', 'stamgr', `<xcmd check-ability='10' tag='client' acl-id='1' client='${mac}' cmd='block'><client client='${mac}' acl-id='1' hostname=''></client></xcmd>`, "xcmd='block' checkAbility='10'"),
    // IS_PARTIAL changes only the given field, the rest of the AP config is untouched
    apSet: (mac, field, value) => {
      const c = state.apsConf.get(mac);
      if (!c) return Promise.reject(new Error('AP configuration not found'));
      return ajax('conf', 'updobj', 'ap-list', `<ap id='${esc(c.id)}' mac='${esc(mac)}' ${field}='${esc(value)}' IS_PARTIAL='true'/>`)
        .then(() => { c[field] = value; });
    },
    // unblocking saves the System ACL without this device
    unblock: (mac) => {
      const keep = state.blocked.filter((b) => b.mac !== mac).map((b) => `<deny mac='${esc(b.mac)}' type='single' hostname='${esc(b.host)}'/>`).join('');
      return ajax('conf', 'updobj', 'acl-list', `<acl id='${esc(state.acl.id)}' name='System' description='${esc(state.acl.description)}' default-mode='${esc(state.acl['default-mode'])}' EDITABLE='false'>${keep}</acl>`);
    },
    wlan: (w, enable) => ajax('conf', 'updobj', 'wlansvc-list', `<wlansvc id='${esc(w.id)}' name='${esc(w.name)}' enable-type='${enable ? 0 : 1}' IS_PARTIAL='true'/>`),
  };

  async function load() {
    if (state.loading) return;
    state.loading = true; renderStatus();
    try {
      const [st, sys, ev, apc, wlc, acl] = await Promise.all([
        stat('stamgr', "<ap LEVEL='2'/><client LEVEL='1'/><wlan LEVEL='1'/>"),
        stat('system', '<sysinfo/><identity/><mgmt-ip/>'),
        stat('eventd', "<xevent sortBy='time' sortDirection='-1'/>"),
        state.apsConf.size ? null : conf('ap-list'),
        conf('wlansvc-list'),
        conf('acl-list'),
      ]);
      const sysAcl = acl.querySelector("acl-list > acl[name='System']");
      state.acl = sysAcl ? attrs(sysAcl) : {};
      state.blocked = sysAcl ? [...sysAcl.querySelectorAll('deny')].map((d) => ({ mac: d.getAttribute('mac'), host: d.getAttribute('hostname') || '' })) : [];
      if (apc) for (const a of apc.querySelectorAll('ap-list > ap')) state.apsConf.set(a.getAttribute('mac'), attrs(a));
      const root = st.querySelector('apstamgr-stat');
      const aps = [...root.querySelectorAll(':scope > ap')].map(parseAp);
      const apByMac = new Map(aps.map((a) => [a.mac, a]));
      const clients = [...root.querySelectorAll(':scope > client')].map((el) => {
        const c = attrs(el);
        return {
          mac: c.mac, ip: c.ip, host: c.hostname && c.hostname !== c.mac ? c.hostname : '',
          os: c.dvcinfo, type: c.dvctype, model: c.model, ssid: c.ssid, user: c.user,
          apMac: c.ap, ap: apByMac.get(c.ap)?.name || c['ap-name'], band: c['radio-band'], ch: +c.channel,
          rssi: +c.rssi, health: c['display-health-level'], since: +c['first-assoc'], vlan: c.vlan,
          enc: c.encryption, blocked: c.blocked === '1',
        };
      });
      for (const a of aps) a.clients = clients.filter((c) => c.apMac === a.mac).length;
      const wlConf = [...wlc.querySelectorAll('wlansvc-list > wlansvc')].map(attrs);
      const wlans = [...root.querySelectorAll(':scope > wlan')].map((el) => {
        const w = attrs(el);
        const c = wlConf.find((x) => x.ssid === w.ssid || x.name === w.ssid) || {};
        return { id: c.id || w.id, name: c.name || w.ssid, ssid: w.ssid, clients: +w['assoc-stas'] || 0, enabled: c['enable-type'] ? c['enable-type'] === '0' : w.state === 'enabled', enc: c.encryption, auth: c.authentication, vlan: c['vlan-id'], guest: c['is-guest'] === 'true', hidden: c['close-system'] === 'true' };
      });
      // WLANs present in config but missing from stats (e.g. disabled)
      for (const c of wlConf) if (!wlans.some((w) => w.id === c.id)) wlans.push({ id: c.id, name: c.name, ssid: c.ssid, clients: 0, enabled: c['enable-type'] === '0', enc: c.encryption, auth: c.authentication, vlan: c['vlan-id'], guest: c['is-guest'] === 'true', hidden: c['close-system'] === 'true' });

      const sy = sys.querySelector('sysinfo'); const id = sys.querySelector('identity'); const mg = sys.querySelector('mgmt-ip');
      state.sys = { name: id?.getAttribute('name'), ver: sy?.getAttribute('version'), uptime: +sy?.getAttribute('uptime'), cpu: +sy?.getAttribute('cpu_busy'), memTotal: +sy?.getAttribute('mem_total'), memFree: +sy?.getAttribute('mem_free'), model: sy?.getAttribute('display-model'), ip: mg?.getAttribute('ip') };
      state.events = [...ev.querySelectorAll('xevent')].map((e) => ({ time: +e.getAttribute('time'), sev: +e.getAttribute('severity'), msg: e.getAttribute('lmsg') || e.getAttribute('msg'), code: e.getAttribute('msg'), ap: e.getAttribute('ap'), client: e.getAttribute('sta') || e.getAttribute('client') }));

      notifyChanges(aps, clients);
      state.aps = aps; state.clients = clients; state.wlans = wlans;
      state.lastOk = Date.now(); state.error = null;
    } catch (e) {
      state.error = e.message;
    } finally {
      state.loading = false;
      render();
    }
  }

  function parseAp(el) {
    const a = attrs(el);
    const c = state.apsConf.get(a.mac) || {};
    const radios = [...el.querySelectorAll(':scope > radio')].map(attrs);
    const r24 = radios.find((r) => r['radio-band'] === '2.4g') || {};
    const r5 = radios.find((r) => r['radio-band'] === '5g') || {};
    const ap = {
      mac: a.mac, name: a.devname || a['ap-name'] || a.mac, desc: a.description || c.description || '', model: a['display-model'] || a.model,
      ip: a.ip, state: a.state === '1' ? 1 : 0, role: a.role, uptime: +a.uptime || 0, lastSeen: +a['last-seen'] || 0,
      ch24: r24.channel || a['channel-11ng'] || '', ch5: r5.channel || a['channel-11na'] || '', w5: r5.channelization || a['channelization-11na'] || '',
      cpu: +a.cpu_util || 0, mem: a.mem_total ? Math.round((1 - a.mem_avail / a.mem_total) * 100) : 0,
      tx: +a.sta_tx_byte || 0, rx: +a.sta_rx_byte || 0, mesh: a['mesh-enabled'] === 'true' ? (a['mesh-depth'] > 0 ? `mesh ${a['mesh-depth']}` : 'root') : '',
      fw: a['firmware-version'], serial: a['serial-number'], reboot: a['last-reboot-reason'] || '', temp: a['current-temperature'] !== 'unavailable' ? a['current-temperature'] : '',
      rogue: +a['num-rogue'] || 0, clients: 0,
      raw: a, conf: c,
      vaps: [...el.querySelectorAll(':scope > vap')].map(attrs),
      lan: [...el.querySelectorAll(':scope > lan-port')].map(attrs),
      ports: [...el.querySelectorAll(':scope > port')].map(attrs),
      ifs: [...el.querySelectorAll(':scope > if')].map(attrs).filter((i) => /^(eth|br)\d/.test(i['if-name'])),
      neighbors: [...el.querySelectorAll(':scope > neighbor-ap')].map(attrs),
    };
    // uplink = first working ethX interface; speed and duplex from LAN port status
    const up = ap.ifs.find((i) => i['if-operStatus'] === '1' && /^eth/.test(i['if-name']));
    const lanUp = ap.lan.find((l) => (l.Physical || '').trim().startsWith('Up'));
    const dup = /(full|half)/i.exec(lanUp?.Physical || '')?.[1]?.toLowerCase() || '';
    ap.upSpeed = up ? +up['if-speed'] || 0 : 0;
    ap.upDuplex = dup;
    ap.upErrRaw = up ? (+up['if-inErrors'] || 0) + (+up['if-outErrors'] || 0) : 0;
    ap.upDropRaw = up ? (+up['if-inDiscards'] || 0) + (+up['if-outDiscards'] || 0) : 0;
    // after a reset only the increase is shown; if the AP has rebooted since, the device already zeroed its counters
    const b = state.upBase.at && state.upBase.aps[ap.mac];
    const rebooted = b && ap.uptime < (Date.now() / 1000 - state.upBase.at);
    ap.upErr = b && !rebooted ? Math.max(0, ap.upErrRaw - b.err) : ap.upErrRaw;
    ap.upDrop = b && !rebooted ? Math.max(0, ap.upDropRaw - b.drop) : ap.upDropRaw;
    ap.upIf = up ? up['if-name'] : '';
    // an offline AP's uptime is negative: how long it has been down (also sorts correctly)
    if (!ap.state) ap.uptime = ap.lastSeen ? -Math.round(Date.now() / 1000 - ap.lastSeen) : 0;
    return ap;
  }

  // ---------- change notifications ----------
  let first = true;
  function notifyChanges(aps, clients) {
    if (!first) {
      for (const a of aps) {
        const p = state.prev.aps.get(a.mac);
        if (p != null && p !== a.state) toast(a.state ? `▲ ${a.name} is back online` : `▼ ${a.name} went offline`, a.state ? 'ok' : 'bad');
      }
      const now = new Set(clients.map((c) => c.mac));
      const joined = clients.filter((c) => !state.prev.clients.has(c.mac));
      const left = [...state.prev.clients.keys()].filter((m) => !now.has(m));
      if (joined.length) toast(`+${joined.length} client${joined.length > 1 ? 's' : ''}: ${joined.slice(0, 3).map((c) => c.host || c.ip || c.mac).join(', ')}`, 'info');
      if (left.length) toast(`−${left.length} client${left.length > 1 ? 's' : ''} left`, 'muted');
    }
    first = false;
    state.prev.aps = new Map(aps.map((a) => [a.mac, a.state]));
    state.prev.clients = new Map(clients.map((c) => [c.mac, 1]));
  }

  // ---------- helpers ----------
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function dur(s) {
    if (!s || s < 0) return '–';
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  }
  function ago(t) { return t ? dur(Date.now() / 1000 - t) : '–'; }
  function bytes(n) { if (!n) return '–'; const u = ['B', 'K', 'M', 'G', 'T']; let i = 0; while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(n < 10 && i ? 1 : 0) + u[i]; }
  function clock(t) { const d = new Date(t * 1000); const p = (x) => String(x).padStart(2, '0'); const today = new Date().toDateString() === d.toDateString(); return (today ? '' : `${p(d.getDate())}.${p(d.getMonth() + 1)} `) + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; }
  function rssiBar(r) { const lvl = r >= 40 ? 4 : r >= 30 ? 3 : r >= 20 ? 2 : r >= 10 ? 1 : 0; return `<span class="sig s${lvl}" title="RSSI ${r} dB"><i></i><i></i><i></i><i></i></span><span class="num">${r}</span>`; }
  function matches(o) {
    const f = state.filter.trim().toLowerCase();
    if (!f) return true;
    return f.split(/\s+/).every((t) => Object.values(o).some((v) => v != null && typeof v !== 'object' && String(v).toLowerCase().includes(t)));
  }
  function sortBy(list, key) {
    const [k, dir] = state.sort[key];
    return [...list].sort((a, b) => {
      let x = a[k], y = b[k];
      if (k === 'ip') { x = ipNum(x); y = ipNum(y); }
      if (typeof x === 'string' || typeof y === 'string') return dir * String(x ?? '').localeCompare(String(y ?? ''), undefined, { numeric: true });
      return dir * ((x ?? 0) - (y ?? 0));
    });
  }
  function ipNum(ip) { return (ip || '').split('.').reduce((n, p) => n * 256 + (+p || 0), 0); }

  // ---------- user interface ----------
  const font = document.createElement('link');
  font.rel = 'stylesheet';
  font.href = 'https://fonts.googleapis.com/css2?family=Pathway+Extreme:opsz,wdth,wght@8..12,75..100,100..900&family=Pathway+Gothic+One&display=swap';
  document.head.appendChild(font);

  const css = document.createElement('style');
  css.textContent = `
  :root{--bg:#f4f5f7;--panel:#fff;--line:#e2e4e8;--txt:#1d2228;--mut:#7a8290;--acc:#e8711c;--ok:#1f9d55;--bad:#d64545;--warn:#d99a00;--info:#2f6fd6;--hov:#fff5ec;--sel:#ffe6cf}
  @media (prefers-color-scheme:dark){:root:not([data-tg-theme=light]){--bg:#111418;--panel:#181c21;--line:#2a2f37;--txt:#e3e6ea;--mut:#8a93a1;--hov:#24221f;--sel:#3a2a1c}}
  :root[data-tg-theme=dark]{--bg:#111418;--panel:#181c21;--line:#2a2f37;--txt:#e3e6ea;--mut:#8a93a1;--hov:#24221f;--sel:#3a2a1c}
  #tgU,#tgU *{box-sizing:border-box}
  #tgU{position:fixed;inset:0;z-index:2147483000;background:var(--bg);color:var(--txt);font-size:var(--fz);line-height:1.1;font-family:var(--ff);font-weight:var(--fw);font-stretch:var(--fst);letter-spacing:.02em;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-synthesis:none;display:grid;grid-template-rows:auto 1fr;overflow:hidden}
  #tgU header{display:flex;align-items:center;gap:10px;padding:2px 6px;background:var(--panel);border-bottom:2px solid var(--acc);white-space:nowrap}
  :root{--ff:'Pathway Extreme',sans-serif;--fw:300;--fst:75%;--fz:11px}
  :root[data-tg-font=ext400]{--fw:400} :root[data-tg-font=ext200]{--fw:200}
  :root[data-tg-font=gothic]{--ff:'Pathway Gothic One',sans-serif;--fw:400;--fst:100%}
  #tgU b,#tgU strong,#tgU h2,#tgU h3,#tgU th{font-weight:inherit}
  #tgU header b.logo,#tgU section>h2 b{font-weight:500}
  #tgU input,#tgU select,#tgU button{font-weight:inherit;font-stretch:inherit}
  #tgToasts{-webkit-font-smoothing:antialiased;font-synthesis:none}
  #tgU header b.logo{color:var(--acc);font-size:1.15em;letter-spacing:.06em}
  #tgU .kpi{display:flex;gap:9px}
  #tgU .kpi span{color:var(--mut)} #tgU .kpi em{font-style:normal;color:var(--txt);font-size:1.08em}
  #tgU .kpi em.bad{color:var(--bad)}
  #tgU input,#tgU select,#tgU button{font:inherit;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:2px;padding:0 4px}
  #tgU input[type=search]{width:220px}
  #tgU button{cursor:pointer} #tgU button:hover{border-color:var(--acc);color:var(--acc)}
  #tgU .grow{flex:1}
  #tgU .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--mut);vertical-align:middle}
  #tgU .dot.ok{background:var(--ok)} #tgU .dot.bad{background:var(--bad);box-shadow:0 0 0 3px color-mix(in srgb,var(--bad) 25%,transparent);animation:pulse 1.4s infinite}
  #tgU .dot.load{background:var(--acc);animation:pulse .7s infinite}
  @keyframes pulse{50%{opacity:.35}}
  #tgU main{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);grid-template-rows:minmax(0,1.15fr) minmax(0,1fr);gap:4px;padding:4px;min-height:0}
  #tgU section{background:var(--panel);border:1px solid var(--line);display:flex;flex-direction:column;min-height:0;min-width:0}
  #tgU section>h2{margin:0;padding:1px 5px;font-size:.92em;font-weight:normal;color:var(--mut);display:flex;gap:8px;align-items:center;border-bottom:1px solid var(--line);text-transform:uppercase;letter-spacing:.08em}
  #tgU section>h2 b{color:var(--txt)} #tgU section>h2 .grow{flex:1}
  #tgU section>h2 a{color:var(--acc);cursor:pointer;text-transform:none;letter-spacing:.02em}
  #tgU .scroll{overflow:auto;min-height:0;flex:1}
  #tgU #secAp{grid-row:1/3}
  #tgU #secRight{display:grid;grid-template-rows:auto minmax(0,1fr);gap:4px;background:none;border:0}
  #tgU table{border-collapse:collapse;width:100%}
  #tgU th{position:sticky;top:0;background:var(--panel);text-align:left;font-weight:normal;color:var(--mut);padding:1px 4px;border-bottom:1px solid var(--line);cursor:pointer;user-select:none;white-space:nowrap;z-index:1}
  #tgU th.sorted{color:var(--acc)} #tgU th.sorted:after{content:attr(data-dir);font-size:10px;margin-left:2px}
  #tgU td{padding:0 4px;border-bottom:1px solid var(--line);white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis}
  #tgU tr:hover td{background:var(--hov)} #tgU tr.sel td{background:var(--sel)}
  #tgU tr.off td{color:var(--bad)} #tgU tr.off td.name{font-size:1.08em}
  #tgU td.desc{max-width:150px}
  #tgU td.num,#tgU th.num{text-align:right;font-variant-numeric:tabular-nums}
  #tgU .mut{color:var(--mut)}
  #tgU .cp{cursor:copy} #tgU .cp:hover{color:var(--info);text-decoration:underline dotted}
  #tgU .act{opacity:.35;transition:opacity .1s;white-space:nowrap} #tgU tr:hover .act{opacity:1}
  #tgU .act button{padding:0 4px;margin-left:2px;font-size:.85em;line-height:1.2}
  #tgU .act button.danger:hover{border-color:var(--bad);color:var(--bad)}
  #tgU .bar{display:inline-block;width:34px;height:6px;background:var(--line);vertical-align:middle;margin-right:3px;border-radius:2px;overflow:hidden}
  #tgU .bar i{display:block;height:100%;background:var(--ok)} #tgU .bar i.w{background:var(--warn)} #tgU .bar i.b{background:var(--bad)}
  #tgU .sig{display:inline-flex;align-items:flex-end;gap:1px;height:10px;margin-right:3px;vertical-align:middle}
  #tgU .sig i{width:3px;background:var(--line)} #tgU .sig i:nth-child(1){height:3px}#tgU .sig i:nth-child(2){height:5px}#tgU .sig i:nth-child(3){height:7px}#tgU .sig i:nth-child(4){height:10px}
  #tgU .sig.s1 i:nth-child(-n+1){background:var(--bad)} #tgU .sig.s2 i:nth-child(-n+2){background:var(--warn)} #tgU .sig.s3 i:nth-child(-n+3),#tgU .sig.s4 i{background:var(--ok)}
  #tgU .tag{display:inline-block;padding:0 4px;border-radius:2px;background:var(--bg);border:1px solid var(--line);font-size:.85em;line-height:1.15;color:var(--mut)}
  #tgU .tag.b5{color:var(--info)} #tgU .tag.b24{color:var(--warn)}
  #tgU .sw{position:relative;display:inline-block;width:28px;height:14px;border-radius:7px;background:var(--line);cursor:pointer;vertical-align:middle}
  #tgU .sw:after{content:'';position:absolute;top:2px;left:2px;width:10px;height:10px;border-radius:50%;background:#fff;transition:left .15s}
  #tgU .sw.on{background:var(--ok)} #tgU .sw.on:after{left:16px}
  #tgU .sev1{color:var(--mut)} #tgU .sev2,#tgU .sev3{color:var(--warn)} #tgU .sev4,#tgU .sev5{color:var(--bad)}
  #tgU .flash td{animation:flash 1.6s}
  @keyframes flash{from{background:color-mix(in srgb,var(--acc) 35%,transparent)}}
  #tgU tr[data-ap]{cursor:pointer} #tgU tr.open td{background:var(--sel)}
  #tgU tr[data-ap] td.name:before{content:'▸';display:inline-block;width:10px;color:var(--mut);font-size:11px} #tgU tr.open td.name:before{content:'▾';color:var(--acc)}
  #tgU tr.det>td{padding:0;background:var(--bg);white-space:normal;max-width:none;border-bottom:1px solid var(--line)}
  #tgU tr.det:hover>td{background:var(--bg)}
  #tgU .ins{margin-left:14px;padding:6px 10px 8px;border-left:2px solid var(--acc);display:grid;grid-template-columns:repeat(3,max-content) 1fr;gap:8px 28px;align-items:start}
  #tgU .ins>.full{grid-column:1/-1;display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}
  #tgU .ins h4{margin:0;padding:1px 6px;font-size:1em;font-weight:normal;color:var(--mut);text-transform:uppercase;letter-spacing:.08em;background:var(--bg);border-bottom:1px solid var(--line)}
  #tgU .ins>div:not(.full):not(:empty),#tgU .ins>.full>div{background:var(--panel);border:1px solid var(--line);border-radius:3px;padding:0;overflow:hidden}
  #tgU .ins table{width:100%;border-collapse:collapse;border-style:hidden}
  #tgU .ins td,#tgU .ins th{position:static;padding:0 6px;border:1px solid var(--line);background:none;max-width:none;cursor:auto;font-variant-numeric:tabular-nums;line-height:1.3}
  #tgU .ins th{color:var(--mut);text-align:left}
  #tgU .ins .kv td:first-child{color:var(--mut);min-width:64px}
  #tgU .ins .c{text-align:right}
  #tgU tr.det .ins td,#tgU tr.det .ins th,#tgU tr.det .ins tr:hover td{background:var(--panel)}
  #tgU .ins .z{color:var(--mut)} #tgU .ins .bad{color:var(--bad)}
  #tgU .ins .ev{grid-column:1/-1} #tgU .ins .ev td{white-space:normal} #tgU .ins .ev td:first-child{white-space:nowrap;color:var(--mut);vertical-align:top}
  #tgU header select,#tgU header input,#tgU header button{width:auto;max-width:none;height:auto;margin:0}
  #tgU input.ed{width:100%;min-width:180px;padding:0 3px;margin:1px 0;border:1px solid transparent;border-radius:2px;background:var(--bg);font:inherit;line-height:1.2}
  #tgU input.ed:hover{border-color:var(--line)} #tgU input.ed:focus{outline:0;border-color:var(--acc);background:var(--panel)}
  #tgU .evt td:nth-child(1),#tgU .evt td:nth-child(2),#tgU .evt td:nth-child(3){width:1%}
  #tgU .evt td:nth-child(3){max-width:180px} #tgU .evt td:nth-child(4){max-width:none;white-space:normal}
  #tgU .evt tr.day td{background:var(--bg);color:var(--mut);text-transform:uppercase;letter-spacing:.08em;font-size:.85em;padding:1px 4px}
  #tgU .evt tr.day:hover td{background:var(--bg)}
  #tgU .dot.sv1{background:var(--line)} #tgU .dot.sv2,#tgU .dot.sv3{background:var(--warn)} #tgU .dot.sv4,#tgU .dot.sv5{background:var(--bad)}
  #tgU .warnc{color:var(--warn)} #tgU .badc{color:var(--bad)}
  #tgU .err{background:var(--bad);color:#fff;padding:2px 8px} #tgU .err a{color:#fff}
  #tgToasts{position:fixed;right:10px;bottom:10px;z-index:2147483001;display:flex;flex-direction:column;gap:3px;font-size:var(--fz);font-family:var(--ff);font-weight:var(--fw);font-stretch:var(--fst)}
  #tgToasts div{background:#222;color:#fff;padding:3px 8px;border-left:4px solid var(--info);border-radius:2px;box-shadow:0 2px 8px #0004;animation:tin .2s}
  #tgToasts .ok{border-color:var(--ok)} #tgToasts .bad{border-color:var(--bad)} #tgToasts .muted{border-color:#666}
  @keyframes tin{from{transform:translateX(30px);opacity:0}}
  #tgU kbd{font:inherit;font-size:.77em;border:1px solid var(--line);border-bottom-width:2px;border-radius:3px;padding:0 3px;color:var(--mut)}
  #tgClassic{position:fixed;right:8px;bottom:8px;z-index:2147483002;font:14px sans-serif;padding:3px 8px;background:#e8711c;color:#fff;border:0;border-radius:3px;cursor:pointer;display:none}
  @media (max-width:1100px){#tgU main{grid-template-columns:1fr;grid-template-rows:auto;overflow:auto}#tgU #secAp{grid-row:auto}#tgU section{min-height:300px}}
  `;
  document.head.appendChild(css);

  const FONTS = { ext200: 'Extreme thin', ext300: 'Extreme light', ext400: 'Extreme regular', gothic: 'Gothic One' };
  const root = document.createElement('div');
  root.id = 'tgU';
  root.innerHTML = `
    <header>
      <b class="logo">UNLEASHED</b>
      <span id="tgSys" class="mut"></span>
      <div class="kpi" id="tgKpi"></div>
      <span class="grow"></span>
      <input type="search" id="tgQ" placeholder="Filter everything…  ( / )" autocomplete="off">
      <span class="mut">refresh</span>
      <select id="tgInt">${[5, 10, 15, 30, 60, 0].map((s) => `<option value="${s}">${s ? s + ' s' : 'manual'}</option>`).join('')}</select>
      <button id="tgRef" title="Refresh (r)">↻</button>
      <button id="tgTheme" title="Theme (t)"></button>
      <select id="tgSize" title="Text size">${[9, 10, 11, 12, 13, 15].map((z) => `<option value="${z}">${z} px</option>`).join('')}</select>
      <select id="tgFont" title="Font">${Object.entries(FONTS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
      <span id="tgStat"></span>
      <span class="mut" title="/ search · r refresh · t theme · Esc clear filters and close details">⌨</span>
      <button id="tgOld" title="Open the original Ruckus view">Original UI</button>
    </header>
    <main>
      <section id="secAp"><h2><b>Access points</b><span id="apCnt"></span><span class="grow"></span><span id="upBase"></span><a data-csv="ap">CSV</a></h2><div class="scroll" id="apT"></div></section>
      <section id="secCl"><h2><b>Clients</b><span id="clCnt"></span><span id="clApF"></span><span class="grow"></span><a data-csv="cl">CSV</a></h2><div class="scroll" id="clT"></div></section>
      <div id="secRight">
        <section><h2><b>WLANs</b></h2><div id="wlT"></div></section>
        <section><h2><b>Events</b><span id="evCnt"></span></h2><div class="scroll" id="evT"></div></section>
      </div>
    </main>`;
  document.body.appendChild(root);
  const toasts = document.createElement('div'); toasts.id = 'tgToasts'; document.body.appendChild(toasts);
  const back = document.createElement('button'); back.id = 'tgClassic'; back.textContent = '← Compact view'; document.body.appendChild(back);
  // the original UI stays in the background so Ruckus keeps its own session alive
  document.documentElement.style.overflow = 'hidden';

  const $ = (s) => root.querySelector(s);

  const THEMES = { auto: '◐ auto', light: '☀ light', dark: '☾ dark' };
  function applyTheme(t) {
    if (t === 'auto') delete document.documentElement.dataset.tgTheme; else document.documentElement.dataset.tgTheme = t;
    $('#tgTheme').textContent = THEMES[t];
    store.set('theme', t);
  }
  function cycleTheme() { const k = Object.keys(THEMES); applyTheme(k[(k.indexOf(store.get('theme', 'auto')) + 1) % k.length]); }
  applyTheme(store.get('theme', 'auto'));
  function applyFont(f) { document.documentElement.dataset.tgFont = f; $('#tgFont').value = f; store.set('font', f); }
  applyFont(store.get('font', 'ext300'));
  function applySize(z) { document.documentElement.style.setProperty('--fz', z + 'px'); $('#tgSize').value = String(z); store.set('size', z); }
  applySize(store.get('size', 11));
  $('#tgSize').addEventListener('change', (e) => applySize(+e.target.value));
  $('#tgFont').addEventListener('change', (e) => applyFont(e.target.value));
  $('#tgInt').value = String(state.interval);

  function toast(msg, cls = 'info') {
    const d = document.createElement('div'); d.className = cls; d.textContent = msg;
    toasts.appendChild(d); setTimeout(() => d.remove(), 6000);
    while (toasts.children.length > 6) toasts.firstChild.remove();
  }

  function th(key, k, label, cls = '') {
    const [sk, dir] = state.sort[key];
    return `<th class="${cls}${sk === k ? ' sorted' : ''}" data-sort="${key}:${k}" data-dir="${dir > 0 ? '▲' : '▼'}">${label}</th>`;
  }
  function pct(v) { return `<span class="bar"><i class="${v > 85 ? 'b' : v > 60 ? 'w' : ''}" style="width:${Math.min(v, 100)}%"></i></span>${v}%`; }

  const flashKeys = new Map();
  function rowFlash(id, sig) { const old = flashKeys.get(id); flashKeys.set(id, sig); return old != null && old !== sig ? ' flash' : ''; }

  function renderAps() {
    const list = sortBy(state.aps.filter(matches), 'ap');
    const off = state.aps.filter((a) => !a.state).length;
    $('#apCnt').innerHTML = `${state.aps.length - off}/${state.aps.length}${off ? ` <span style="color:var(--bad)">· ${off} offline</span>` : ''}`;
    $('#apT').innerHTML = `<table><thead><tr>
      ${th('ap', 'state', '')}${th('ap', 'name', 'Name')}${th('ap', 'desc', 'Description')}${th('ap', 'model', 'Model')}${th('ap', 'ip', 'IP')}${th('ap', 'mac', 'MAC')}
      ${th('ap', 'clients', 'Cl', 'num')}${th('ap', 'upSpeed', 'Uplink', 'num')}${th('ap', 'upErr', 'Errors', 'num')}${th('ap', 'upDrop', 'Drop', 'num')}
      ${th('ap', 'tx', 'TX', 'num')}${th('ap', 'rx', 'RX', 'num')}${th('ap', 'uptime', 'Uptime', 'num')}${th('ap', 'reboot', 'Last reboot')}<th></th>
      </tr></thead><tbody>${list.map((a) => `
      <tr data-ap="${a.mac}" class="${a.state ? '' : 'off'}${state.expanded.has(a.mac) ? ' open' : ''}${state.apFilter === a.mac ? ' sel' : ''}${rowFlash('ap' + a.mac, a.state + '|' + a.clients + '|' + a.ch24 + '|' + a.ch5)}">
        <td><span class="dot ${a.state ? 'ok' : 'bad'}"></span></td>
        <td class="name" title="${esc(a.fw)} · SN ${esc(a.serial)}${a.role === 'master' ? ' · MASTER' : ''}">${esc(a.name)}${a.role === 'master' ? ' <span class="tag">master</span>' : ''}${a.mesh && a.state ? ` <span class="tag">${a.mesh}</span>` : ''}</td>
        <td class="mut desc" title="${esc(a.desc)}">${esc(a.desc)}</td>
        <td>${esc(a.model)}</td>
        <td class="cp" data-copy="${esc(a.ip)}">${esc(a.ip)}</td>
        <td class="cp mut" data-copy="${esc(a.mac)}">${esc(a.mac)}</td>
        <td class="num">${a.state ? `<a class="cp" data-apf="${a.mac}" title="Show this AP's clients">${a.clients}</a>` : '–'}</td>
        <td class="num" title="${esc(a.upIf)}">${a.state && a.upSpeed ? `<span class="${a.upSpeed < 1000 || a.upDuplex === 'half' ? 'warnc' : ''}">${a.upSpeed >= 1000 ? a.upSpeed / 1000 + ' G' : a.upSpeed + ' M'}${a.upDuplex === 'half' ? ' half' : ''}</span>` : ''}</td>
        <td class="num">${a.state ? (a.upErr ? `<span class="badc">${a.upErr}</span>` : '<span class="mut">0</span>') : ''}</td>
        <td class="num">${a.state ? (a.upDrop ? `<span class="warnc">${a.upDrop}</span>` : '<span class="mut">0</span>') : ''}</td>
        <td class="num">${a.state ? bytes(a.tx) : ''}</td>
        <td class="num">${a.state ? bytes(a.rx) : ''}</td>
        <td class="num">${a.state ? dur(a.uptime) : `<span title="Offline since ${a.lastSeen ? new Date(a.lastSeen * 1000).toLocaleString() : '?'}">−${dur(-a.uptime)}</span>`}</td>
        <td class="mut desc" title="${esc(a.reboot)}">${esc(a.reboot)}</td>
        <td class="act">${a.state ? `<button class="danger" data-do="reboot" data-mac="${a.mac}" title="Restart">⟲</button>` : ''}</td>
      </tr>${state.expanded.has(a.mac) ? apDetail(a) : ''}`).join('')}</tbody></table>`;
  }

  function apDetail(a) {
    const r = a.raw, c = a.conf;
    const g = (k) => { const v = String(r[k] ?? c[k] ?? '').trim(); return /^-[A-Z0-9_]+-$/.test(v) ? '' : esc(v); };
    const n = (v) => (+v ? `${+v}` : '<span class="z">0</span>');
    const kv = (title, rows) => `<div><h4>${title}</h4><table class="kv">${rows.filter((x) => x[1]).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</table></div>`;
    const sn = g('serial-number') || g('serial');
    const boot = (k, bad) => { const v = +r[`${k}-reboot-counter`] || 0; return v ? (bad ? `<span class="bad">${v}</span>` : `${v}`) : '<span class="z">0</span>'; };

    const net = kv('Network', [['IP', `<span class="cp" data-copy="${g('ip')}">${g('ip')}</span>`], ['Mask', g('netmask')], ['Gateway', g('gateway')], ['DNS', [g('dns1'), g('dns2')].filter(Boolean).join(', ')],
      ['Mode', r['by-dhcp'] === 'true' || c['by-dhcp'] === 'true' ? 'DHCP' : 'static'], ['VLAN', g('mgmt-vlan-id')], ['PoE', g('poe-mode-str')]]);
    const ed = (field, v, ph) => `<input class="ed" data-mac="${a.mac}" data-field="${field}" value="${esc(v)}" placeholder="${ph}" maxlength="${field === 'devname' ? 64 : 128}">`;
    const dev = kv('Device', [['Name', ed('devname', a.name, 'name')], ['Description', ed('description', a.desc, 'add description')], ['Serial', sn ? `<span class="cp" data-copy="${sn}">${sn}</span>` : ''], ['Hardware', g('hardware-version')], ['Firmware', g('firmware-version') || g('version')],
      ['Memory', r.mem_total ? `${bytes((r.mem_total - r.mem_avail) * 1024)} / ${bytes(r.mem_total * 1024)}` : ''], ['Temp.', a.temp ? esc(a.temp) + '°' : ''], ['Neighbors', g('num-neighbors') || '0'],
      ['Rogue', a.rogue ? `<span class="bad">${a.rogue}</span>` : ''], ['Mesh', a.mesh]]);
    const boots = kv('Reboots', [['Total', g('total-boot-counter') || '0'], ['Application', boot('application')], ['User', boot('user')], ['Power', boot('powercycle')],
      ['Watchdog', boot('watchdog', 1)], ['Panic', boot('kernel-panic', 1)], ['Last', `<span title="${g('last-reboot-details')}">${g('last-reboot-reason')}</span>`], ['Rejoin', g('last-rejoin-reason')]]);

    const vaps = [...a.vaps].sort((x, y) => x.ssid.localeCompare(y.ssid) || x['radio-band'].localeCompare(y['radio-band']));
    const radios = vaps.length ? `<div><h4>Radios</h4><table><tr><th>SSID</th><th>Band</th><th class="c">Channel</th><th class="c">Cl</th><th class="c">TX</th><th class="c">RX</th><th class="c">Errors</th><th>BSSID</th></tr>
      ${vaps.map((v) => `<tr><td>${esc(v.ssid)}</td><td><span class="tag ${v['radio-band'] === '5g' ? 'b5' : 'b24'}">${v['radio-band'] === '5g' ? '5 GHz' : '2.4 GHz'}</span></td><td class="c">${esc(v.channel)}</td>
        <td class="c">${v['vap-up'] === 'Up' ? n(v['assoc-stas'] || v['num-sta']) : '<span class="bad">down</span>'}</td><td class="c">${bytes(+v['tx-bytes'])}</td><td class="c">${bytes(+v['rx-bytes'])}</td>
        <td class="c">${n((+v['tx-errors'] || 0) + (+v['rx-errors'] || 0))}</td><td class="mut cp" data-copy="${esc(v.bssid)}">${esc(v.bssid)}</td></tr>`).join('')}</table></div>` : '';

    const portCfg = new Map(a.ports.map((p) => [p.name, p]));
    const ports = a.lan.length ? `<div><h4>Ports</h4><table><tr><th></th><th>Port</th><th>Link</th><th>Type</th><th class="c">VLAN</th></tr>${a.lan.map((l) => {
      const pc = portCfg.get('LAN' + (+l.Port + 1)) || {}; const phys = (l.Physical || '').trim(); const up = phys.startsWith('Up');
      return `<tr><td><span class="dot ${up ? 'ok' : ''}"></span></td><td>${esc((l.Label || l.name).replace('10/100/1000 ', ''))}</td><td class="${up ? '' : 'z'}">${up ? esc(phys.replace(/^Up\s*/, '')) : 'down'}</td><td>${esc(pc.type || '')}</td><td class="c">${esc(pc.vlan || '')}</td></tr>`;
    }).join('')}</table></div>` : '';

    const upIfs = a.ifs.filter((i) => i['if-operStatus'] === '1');
    const ifs = upIfs.length ? `<div><h4>Uplink</h4><table><tr><th>Interface</th><th class="c">Speed</th><th class="c">Errors</th><th class="c">Drop</th></tr>${upIfs.map((i) => `<tr><td>${esc(i['if-name'])}</td><td class="c">${esc(i['if-speed'])} Mb/s</td><td class="c">${n((+i['if-inErrors'] || 0) + (+i['if-outErrors'] || 0))}</td><td class="c">${n((+i['if-inDiscards'] || 0) + (+i['if-outDiscards'] || 0))}</td></tr>`).join('')}</table></div>` : '';

    const ev = state.events.filter((e) => e.ap === a.mac).slice(0, 6);
    const events = ev.length ? `<div class="ev"><h4>Events</h4><table>${ev.map((e) => `<tr><td>${clock(e.time)}</td><td class="sev${e.sev}">${esc(e.msg)}</td></tr>`).join('')}</table></div>` : '';

    return `<tr class="det"><td colspan="16"><div class="ins">${net}${dev}${boots}<div></div><div class="full">${radios}${ports}${ifs}</div>${events}</div></td></tr>`;
  }

  function renderUpBase() {
    const at = state.upBase.at;
    $('#upBase').innerHTML = at
      ? `<span class="mut" style="text-transform:none">errors/drops since ${clock(at)}</span> <a data-upbase="reset" title="Reset again">⟲</a> <a data-upbase="clear" title="Show full counters since AP boot">✕</a>`
      : `<a data-upbase="reset" title="Errors and drops will show the increase from this moment on">reset counters</a>`;
  }
  function setUpBase(reset) {
    state.upBase = reset ? { at: Math.floor(Date.now() / 1000), aps: Object.fromEntries(state.aps.map((a) => [a.mac, { err: a.upErrRaw, drop: a.upDropRaw }])) } : { at: 0, aps: {} };
    store.set('upBase', state.upBase);
    for (const a of state.aps) { a.upErr = reset ? 0 : a.upErrRaw; a.upDrop = reset ? 0 : a.upDropRaw; }
    render();
  }

  function renderClients() {
    let list = state.clients.filter(matches);
    if (state.apFilter) list = list.filter((c) => c.apMac === state.apFilter);
    list = sortBy(list, 'cl');
    const apf = state.aps.find((a) => a.mac === state.apFilter);
    $('#clCnt').textContent = list.length === state.clients.length ? state.clients.length : `${list.length}/${state.clients.length}`;
    $('#clApF').innerHTML = apf ? `<a data-apf="">✕ AP: ${esc(apf.name)}</a>` : '';
    $('#clT').innerHTML = `<table><thead><tr>
      ${th('cl', 'host', 'Name')}${th('cl', 'ip', 'IP')}${th('cl', 'mac', 'MAC')}${th('cl', 'os', 'Device')}${th('cl', 'ssid', 'SSID')}${th('cl', 'ap', 'AP')}
      ${th('cl', 'band', 'Band')}${th('cl', 'rssi', 'Signal')}${th('cl', 'since', 'Connected', 'num')}<th></th>
      </tr></thead><tbody>${list.map((c) => `
      <tr class="${rowFlash('cl' + c.mac, c.apMac + c.ch)}">
        <td title="${esc(c.user)}">${c.host ? esc(c.host) : '<span class="mut">—</span>'}</td>
        <td class="cp" data-copy="${esc(c.ip)}">${esc(c.ip)}</td>
        <td class="cp mut" data-copy="${esc(c.mac)}">${esc(c.mac)}</td>
        <td title="${esc(c.model)}">${esc(c.os)}<span class="mut"> ${esc(c.type)}</span></td>
        <td>${esc(c.ssid)}${c.vlan && c.vlan !== '1' ? `<span class="mut"> v${esc(c.vlan)}</span>` : ''}</td>
        <td><a class="cp" data-apf="${c.apMac}">${esc(c.ap)}</a></td>
        <td><span class="tag ${c.band === '5g' ? 'b5' : 'b24'}">${c.band === '5g' ? '5G' : '2.4'}</span> <span class="mut">ch${c.ch}</span></td>
        <td>${rssiBar(c.rssi)}</td>
        <td class="num">${ago(c.since)}</td>
        <td class="act"><button data-do="kick" data-mac="${c.mac}" title="Disconnect">⏏</button><button class="danger" data-do="block" data-mac="${c.mac}" title="Block">⛔</button></td>
      </tr>`).join('')}</tbody></table>`;
  }

  function renderWlans() {
    $('#wlT').innerHTML = `<table><thead><tr><th></th><th>SSID</th><th class="num">Cl</th><th>Security</th><th class="num">VLAN</th><th></th></tr></thead><tbody>${state.wlans.map((w) => `
      <tr><td><span class="sw ${w.enabled ? 'on' : ''}" data-wlan="${esc(w.id)}" title="${w.enabled ? 'Disable' : 'Enable'}"></span></td>
      <td><a class="cp" data-q="${esc(w.ssid)}">${esc(w.ssid)}</a>${w.guest ? ' <span class="tag">guest</span>' : ''}${w.hidden ? ' <span class="tag">hidden</span>' : ''}</td>
      <td class="num">${w.clients}</td><td class="mut">${esc(w.auth)} · ${esc(w.enc)}</td><td class="num">${esc(w.vlan)}</td><td></td></tr>`).join('')}</tbody></table>${state.blocked.length ? `
      <table><thead><tr><th>⛔ Blocked</th><th></th><th></th></tr></thead><tbody>${state.blocked.map((b) => `
      <tr><td class="cp" data-copy="${esc(b.mac)}">${esc(b.mac)}</td><td class="mut">${esc(b.host)}</td><td class="act"><button data-do="unblock" data-mac="${esc(b.mac)}" title="Remove block">Unblock</button></td></tr>`).join('')}</tbody></table>` : ''}`;
  }

  // strip AP[name@mac] parts – the AP has its own column
  function evText(m) {
    return (m || '')
      .replace(/\s+of\s+AP\[[^\]]*\]/g, '')
      .replace(/^AP\[[^\]]*\]\s*/, '')
      .replace(/AP\[[^\]]*\]/g, 'AP')
      .replace(/,(?=\S)/g, ', ')
      .replace(/\.$/, '')
      .replace(/^./, (c) => c.toUpperCase());
  }
  function evAp(e) {
    const ap = e.ap && state.aps.find((a) => a.mac === e.ap);
    if (ap) return ap.name;
    const m = /AP\[([^\]@]*)(?:@[^\]]*)?\]/.exec(e.msg || '');
    if (!m) return '';
    return state.aps.find((a) => a.mac === m[1])?.name || m[1];
  }
  function renderEvents() {
    const list = sortBy(state.events.map((e) => ({ ...e, apName: evAp(e), text: evText(e.msg) })).filter(matches), 'ev');
    $('#evCnt').textContent = list.length;
    let day = '';
    $('#evT').innerHTML = `<table class="evt"><thead><tr>${th('ev', 'time', 'Time')}<th></th>${th('ev', 'apName', 'AP')}${th('ev', 'text', 'Event')}</tr></thead><tbody>${list.slice(0, 300).map((e) => {
      const d = new Date(e.time * 1000).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' });
      const sep = state.sort.ev[0] === 'time' && d !== day ? `<tr class="day"><td colspan="4">${(day = d)}</td></tr>` : '';
      return `${sep}<tr><td class="mut num">${clock(e.time).slice(-8)}</td><td><span class="dot sv${e.sev}" title="Severity ${e.sev}"></span></td>
        <td>${e.apName ? `<a class="cp" data-q="${esc(e.apName)}">${esc(e.apName)}</a>` : ''}</td><td class="sev${e.sev}" title="${esc(e.code)} · ${esc(e.msg)}">${esc(e.text)}</td></tr>`;
    }).join('')}</tbody></table>`;
  }


  function renderHeader() {
    const s = state.sys;
    const off = state.aps.filter((a) => !a.state).length;
    const mem = s.memTotal ? Math.round((1 - s.memFree / s.memTotal) * 100) : 0;
    $('#tgSys').innerHTML = s.name ? `${esc(s.name)} · ${esc(s.model)} ${esc(s.ip)} · v${esc(s.ver)} · up ${dur(s.uptime)}` : '';
    $('#tgKpi').innerHTML = s.name ? `
      <span>AP <em class="${off ? 'bad' : ''}">${state.aps.length - off}/${state.aps.length}</em></span>
      <span>clients <em>${state.clients.length}</em></span>
      <span>5G <em>${state.clients.filter((c) => c.band === '5g').length}</em></span>
      <span>CPU <em>${s.cpu}%</em></span><span>memory <em>${mem}%</em></span>` : '';
    document.title = (off ? `⚠ ${off} AP offline · ` : '') + `${state.clients.length} cl · Unleashed`;
  }

  function renderStatus() {
    const el = $('#tgStat');
    if (state.error) {
      el.innerHTML = `<span class="err">${esc(state.error)} — <a href="/admin/login.jsp">log in again</a></span>`;
    } else {
      el.innerHTML = `<span class="dot ${state.loading ? 'load' : 'ok'}"></span> <span class="mut">${state.lastOk ? clock(state.lastOk / 1000) : '…'}</span>`;
    }
  }

  function render() {
    // keep scroll positions
    const sc = [...root.querySelectorAll('.scroll')].map((e) => e.scrollTop);
    renderHeader(); renderUpBase(); if (!editing) renderAps(); renderClients(); renderWlans(); renderEvents(); renderStatus();
    root.querySelectorAll('.scroll').forEach((e, i) => { e.scrollTop = sc[i]; });
  }

  // ---------- CSV ----------
  function csv(kind) {
    const rows = kind === 'ap'
      ? [['Name', 'Description', 'Model', 'IP', 'MAC', 'State', 'Clients', '2.4 channel', '5G channel', 'Uptime (s)', 'Firmware', 'Serial'],
        ...sortBy(state.aps.filter(matches), 'ap').map((a) => [a.name, a.desc, a.model, a.ip, a.mac, a.state ? 'up' : 'down', a.clients, a.ch24, a.ch5, a.uptime, a.fw, a.serial])]
      : [['Name', 'IP', 'MAC', 'OS', 'Type', 'SSID', 'AP', 'Band', 'Channel', 'RSSI', 'Connected since'],
        ...sortBy(state.clients.filter(matches), 'cl').map((c) => [c.host, c.ip, c.mac, c.os, c.type, c.ssid, c.ap, c.band, c.ch, c.rssi, new Date(c.since * 1000).toISOString()])];
    const text = rows.map((r) => r.map((v) => `"${String(v ?? '').replace(/"/g, '""')}"`).join(';')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' }));
    a.download = `unleashed-${kind === 'ap' ? 'aps' : 'clients'}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.csv`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  // ---------- editing AP name/description in the detail view ----------
  let editing = null;
  async function saveField(inp) {
    const { mac, field } = inp.dataset;
    const ap = state.aps.find((x) => x.mac === mac); if (!ap) return;
    const old = field === 'devname' ? ap.name : ap.desc;
    const val = inp.value.trim();
    if (val === old || (!val && field === 'devname')) { inp.value = old; return; }
    inp.disabled = true;
    try {
      await cmd.apSet(mac, field, val);
      if (field === 'devname') ap.name = val; else ap.desc = val;
      toast(`✎ ${old || ap.name} → ${val || '(empty)'}`, 'ok');
    } catch (err) { inp.value = old; toast(`Failed: ${err.message}`, 'bad'); }
    inp.disabled = false;
  }
  root.addEventListener('focusin', (e) => { if (e.target.matches('input.ed')) editing = e.target.dataset.mac; });
  root.addEventListener('focusout', async (e) => {
    if (!e.target.matches('input.ed')) return;
    await saveField(e.target);
    if (!root.querySelector('input.ed:focus')) { editing = null; renderAps(); }
  });
  root.addEventListener('keydown', (e) => {
    if (!e.target.matches('input.ed')) return;
    e.stopPropagation();
    if (e.key === 'Enter') e.target.blur();
    else if (e.key === 'Escape') {
      const ap = state.aps.find((x) => x.mac === e.target.dataset.mac);
      e.target.value = e.target.dataset.field === 'devname' ? ap.name : ap.desc; e.target.blur();
    }
  });

  // ---------- events ----------
  root.addEventListener('click', async (e) => {
    if (e.target.closest('input.ed')) return;
    const ub = e.target.closest('[data-upbase]');
    if (ub) { setUpBase(ub.dataset.upbase === 'reset'); return; }
    const t = e.target.closest('[data-sort],[data-copy],[data-apf],[data-do],[data-wlan],[data-csv],[data-q]');
    if (!t) {
      const row = e.target.closest('tr[data-ap]');
      if (row && !e.target.closest('.ins') && !getSelection().toString()) {
        const m = row.dataset.ap;
        if (!state.expanded.delete(m)) state.expanded.add(m);
        store.set('expanded', [...state.expanded]); render();
      }
      return;
    }
    if (t.dataset.sort) {
      const [key, k] = t.dataset.sort.split(':');
      const [ok, od] = state.sort[key];
      state.sort[key] = [k, ok === k ? -od : 1];
      store.set('sort', state.sort); render();
    } else if (t.dataset.apf != null) {
      state.apFilter = t.dataset.apf && state.apFilter !== t.dataset.apf ? t.dataset.apf : null; render();
    } else if (t.dataset.q) {
      $('#tgQ').value = state.filter = state.filter === t.dataset.q ? '' : t.dataset.q; render();
    } else if (t.dataset.copy) {
      await navigator.clipboard.writeText(t.dataset.copy).catch(() => {}); toast(`Copied: ${t.dataset.copy}`, 'muted');
    } else if (t.dataset.csv) {
      csv(t.dataset.csv);
    } else if (t.dataset.do) {
      const mac = t.dataset.mac, act = t.dataset.do;
      const ap = state.aps.find((a) => a.mac === mac), cl = state.clients.find((c) => c.mac === mac);
      const who = ap ? ap.name : (cl?.host || cl?.ip || state.blocked.find((b) => b.mac === mac)?.host || mac);
      const ask = { reboot: `Restart AP "${who}"?\nIts ${ap?.clients || 0} clients will be disconnected.`, block: `Block device "${who}" (${mac})?\nYou can unblock it from the list under WLANs.` }[act];
      if (ask && !confirm(ask)) return;
      try {
        t.disabled = true;
        await cmd[act](mac);
        toast({ reboot: `⟲ ${who} is restarting`, kick: `⏏ ${who} disconnected`, block: `⛔ ${who} blocked`, unblock: `✓ ${who} unblocked` }[act], 'ok');
        setTimeout(load, 1500);
      } catch (err) { toast(`Failed: ${err.message}`, 'bad'); } finally { t.disabled = false; }
    } else if (t.dataset.wlan) {
      const w = state.wlans.find((x) => x.id === t.dataset.wlan);
      if (!w) return;
      if (!confirm(`${w.enabled ? 'DISABLE' : 'ENABLE'} WLAN "${w.ssid}"?${w.enabled && w.clients ? `\n${w.clients} clients will lose connection.` : ''}`)) return;
      try { await cmd.wlan(w, !w.enabled); toast(`${w.ssid} ${w.enabled ? 'disabled' : 'enabled'}`, 'ok'); setTimeout(load, 1000); } catch (err) { toast(`Failed: ${err.message}`, 'bad'); }
    }
  });

  let qTimer;
  $('#tgQ').addEventListener('input', (e) => { clearTimeout(qTimer); qTimer = setTimeout(() => { state.filter = e.target.value; render(); }, 80); });
  $('#tgInt').addEventListener('change', (e) => { state.interval = +e.target.value; store.set('interval', state.interval); schedule(); });
  $('#tgRef').addEventListener('click', load);
  $('#tgTheme').addEventListener('click', cycleTheme);
  $('#tgOld').addEventListener('click', () => { root.style.display = 'none'; back.style.display = 'block'; document.documentElement.style.overflow = ''; });
  back.addEventListener('click', () => { root.style.display = ''; back.style.display = 'none'; document.documentElement.style.overflow = 'hidden'; load(); });

  document.addEventListener('keydown', (e) => {
    if (root.style.display === 'none') return;
    const typing = /INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName);
    if (e.key === '/' && !typing) { e.preventDefault(); $('#tgQ').focus(); $('#tgQ').select(); }
    else if (e.key === 'Escape') { $('#tgQ').value = state.filter = ''; state.apFilter = null; state.expanded.clear(); store.set('expanded', []); $('#tgQ').blur(); render(); }
    else if (e.key === 'r' && !typing && !e.metaKey && !e.ctrlKey) load();
    else if (e.key === 't' && !typing && !e.metaKey && !e.ctrlKey) cycleTheme();
  });

  let timer;
  function schedule() { clearInterval(timer); if (state.interval) timer = setInterval(() => { if (!document.hidden && root.style.display !== 'none') load(); }, state.interval * 1000); }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && root.style.display !== 'none') load(); });
  // keep relative times fresh in manual mode too
  setInterval(() => { if (!state.loading && root.style.display !== 'none') renderStatus(); }, 1000);

  schedule();
  load();
})();
