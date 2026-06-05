"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildQueryTemplate = buildQueryTemplate;
exports.buildDetailTemplate = buildDetailTemplate;

// SAPUI5 is loaded from the official SAP CDN as a progressive enhancement: the
// query view renders a real sap.m.Table once UI5 is ready, else the
// self-contained CSS table. This origin is declared in the resource's
// `_meta.ui.csp` (see apps.js) so the sandboxed iframe may fetch it.
const UI5_CDN_ORIGIN = "https://ui5.sap.com";
const SAPUI5_BOOTSTRAP_SRC = UI5_CDN_ORIGIN + "/resources/sap-ui-core.js";
exports.UI5_CDN_ORIGIN = UI5_CDN_ORIGIN;

/**
 * Generates self-contained MCP App HTML templates from parsed UiMetadata.
 *
 * Templates implement the MCP Apps postMessage protocol (spec 2026-01-26):
 *   - Connect:   ui/initialize request + ui/notifications/initialized notification
 *   - Data:      ui/notifications/tool-result delivers the JSON result
 *
 * Vanilla HTML/CSS/JS — no external CDN, no build step. Uses SAP Horizon design
 * tokens via CSS custom properties; degrades gracefully in non-Horizon hosts.
 *
 * Features driven by UiMetadata:
 *   buildQueryTemplate:
 *     - Column list from lineItems (DataField, DataFieldWithUrl, DataFieldForAction)
 *     - Row-level criticality coloring from lineItemCriticality
 *     - Per-cell criticality badges from column.criticalityPath
 *     - @UI.Importance ordering (High first)
 *     - Clickable links for DataFieldWithUrl
 *     - Action button placeholders for DataFieldForAction columns
 *     - Count / empty state messages
 *
 *   buildDetailTemplate:
 *     - DataPoint status cards in the header strip (from dataPoints + headerFacets)
 *     - Full facet-driven section structure when @UI.Facets present
 *     - Fallback to @UI.FieldGroup sections when no Facets
 *     - Identification action list
 *     - @Common.Text label resolution for FK fields
 *     - @UI.MultiLineText fields rendered as <pre>
 */

const MCP_APPS_PROTOCOL_VERSION = "2026-01-26";

// ---------------------------------------------------------------------------
// SAP Horizon CSS variables + shared styles
// ---------------------------------------------------------------------------

const SHARED_STYLES = `
<style>
  /* ---- SAP Fiori — Morning Horizon (light) design tokens ---- */
  :root {
    --sapBackgroundColor: #f5f6f7;
    --sapBaseColor: #ffffff;
    --sapTile_Background: #ffffff;
    --sapTextColor: #1d2d3e;
    --sapTitleColor: #1d2d3e;
    --sapContent_LabelColor: #556b82;
    --sapContent_ForegroundColor: #5b738b;
    --sapList_HeaderTextColor: #1d2d3e;
    --sapList_BorderColor: #e5e5e5;
    --sapList_Hover: #f2f5f8;
    --sapLinkColor: #0064d9;
    --sapBrandColor: #0070f2;
    --sapPositiveColor: #188918;
    --sapCriticalColor: #e76500;
    --sapNegativeColor: #bb0000;
    --sapInformativeColor: #0070f2;
    --sapNeutralColor: #788fa6;
    --sapErrorBackground: #ffeaf0;
    --sapFontFamily: "72","72full","72override",Arial,Helvetica,sans-serif;
    --sapFontSize: 0.875rem;
    --sapFontSmallSize: 0.75rem;
    --sapElement_BorderCornerRadius: 0.75rem;
    --sapField_BorderCornerRadius: 0.5rem;
    --sapShadowLevel0: 0 0 0 0.0625rem rgba(34,54,80,.10);
    --sapShadowLevel1: 0 0.125rem 0.5rem 0 rgba(34,54,80,.12), 0 0 0 0.0625rem rgba(34,54,80,.06);
    color-scheme: light;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { font-size: 16px; }
  body { background: transparent; font-family: var(--sapFontFamily); font-size: var(--sapFontSize); line-height: 1.35; color: var(--sapTextColor); -webkit-font-smoothing: antialiased; }
  /* The whole app reads as a rounded card floating in the chat, not a full-bleed box. */
  .app-card { background: var(--sapBackgroundColor); border-radius: 1.25rem; overflow: hidden; box-shadow: var(--sapShadowLevel1); }
  .page { padding: 0.5rem 0.75rem 0.75rem; }

  /* Fiori shell bar — SAP logo + app title */
  .shellbar { display: flex; align-items: center; gap: 0.625rem; height: 2.25rem; padding: 0 0.75rem; background: var(--sapTile_Background); border-bottom: 0.0625rem solid var(--sapList_BorderColor); }
  .shellbar .sap-logo { height: 1rem; width: auto; display: block; flex-shrink: 0; }
  .shellbar .sap-logo-fb { display: none; }
  .shellbar .sap-logo-fb svg { height: 1rem; width: auto; display: block; }
  .shellbar .shell-title { font-size: 0.875rem; font-weight: 600; color: var(--sapTitleColor); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .shellbar .shell-sep { width: 0.0625rem; height: 1.125rem; background: var(--sapList_BorderColor); flex-shrink: 0; }

  .loading { color: var(--sapContent_ForegroundColor); font-size: var(--sapFontSmallSize); padding: 2rem; text-align: center; }
  .error-msg { color: var(--sapNegativeColor); padding: 0.75rem 1rem; border-radius: var(--sapField_BorderCornerRadius); background: var(--sapErrorBackground); font-size: var(--sapFontSmallSize); }

  /* ---- Fiori ObjectStatus — semantic colored text + leading icon (no fill) ---- */
  .objstatus { display: inline-flex; align-items: baseline; gap: 0.25rem; font-weight: 600; white-space: nowrap; }
  .objstatus .ois-ic { font-size: 0.8em; font-weight: 700; line-height: 1; }
  .crit-1 { color: var(--sapNegativeColor); }
  .crit-2 { color: var(--sapCriticalColor); }
  .crit-3 { color: var(--sapPositiveColor); }
  .crit-5 { color: var(--sapInformativeColor); }
  .crit-0 { color: var(--sapTextColor); }

  /* ---- Fiori-style buttons + write form modal ---- */
  .fbtn { display: inline-flex; align-items: center; gap: 0.25rem; height: 1.75rem; padding: 0 0.625rem; border-radius: var(--sapField_BorderCornerRadius); font-size: var(--sapFontSmallSize); font-weight: 600; font-family: inherit; cursor: pointer; border: 0.0625rem solid var(--sapLinkColor); background: transparent; color: var(--sapLinkColor); }
  .fbtn:hover { background: rgba(0,112,242,.08); }
  .fbtn-emph { background: var(--sapBrandColor); border-color: var(--sapBrandColor); color: #fff; }
  .fbtn-emph:hover { background: #0064d9; }
  .fbtn-neg { border-color: var(--sapNegativeColor); color: var(--sapNegativeColor); }
  .fbtn-neg:hover { background: rgba(187,0,0,.08); }
  .modal-ov { position: fixed; inset: 0; background: rgba(0,0,0,.45); display: flex; align-items: flex-start; justify-content: center; padding: 2rem 1rem; z-index: 1000; overflow-y: auto; }
  .modal { background: var(--sapBaseColor); border-radius: var(--sapElement_BorderCornerRadius); box-shadow: var(--sapShadowLevel1); width: 100%; max-width: 30rem; }
  .modal-hdr { padding: 0.875rem 1.25rem; font-size: 1rem; font-weight: 700; color: var(--sapTitleColor); border-bottom: 0.0625rem solid var(--sapList_BorderColor); }
  .modal-body { padding: 0.5rem 1.25rem 1rem; max-height: 60vh; overflow-y: auto; }
  .form-row { padding: 0.3125rem 0; }
  .form-row label { display: block; font-size: var(--sapFontSmallSize); color: var(--sapContent_LabelColor); margin-bottom: 0.1875rem; }
  .form-row .req { color: var(--sapNegativeColor); }
  .form-row input[type=text], .form-row input[type=number], .form-row input[type=date], .form-row input[type=datetime-local] {
    width: 100%; height: 1.875rem; padding: 0 0.5rem; font-size: var(--sapFontSize); font-family: inherit;
    color: var(--sapTextColor); background: var(--sapBaseColor);
    border: 0.0625rem solid var(--sapBorderColor, #89919a); border-radius: var(--sapField_BorderCornerRadius); }
  .form-row input:focus { outline: none; border-color: var(--sapBrandColor); box-shadow: 0 0 0 0.0625rem var(--sapBrandColor); }
  .form-row input:disabled { background: var(--sapBackgroundColor); color: var(--sapContent_ForegroundColor); }
  .modal-ftr { display: flex; justify-content: flex-end; gap: 0.5rem; padding: 0.75rem 1.25rem; border-top: 0.0625rem solid var(--sapList_BorderColor); }
  .modal-msg { font-size: var(--sapFontSmallSize); padding: 0 1.25rem 0.5rem; }
  .modal-msg.err { color: var(--sapNegativeColor); }

  /* ---- SAP Fiori — Evening Horizon (dark) ---- */
  html[data-theme="dark"] {
    --sapBackgroundColor: #12171c;
    --sapBaseColor: #1c232b;
    --sapTile_Background: #1c232b;
    --sapTextColor: #eaecee;
    --sapTitleColor: #ffffff;
    --sapContent_LabelColor: #a9b4be;
    --sapContent_ForegroundColor: #9aa7b3;
    --sapList_HeaderTextColor: #eaecee;
    --sapList_BorderColor: #2b343d;
    --sapList_Hover: #252e37;
    --sapLinkColor: #5dafff;
    --sapBrandColor: #1b90ff;
    --sapPositiveColor: #36a41d;
    --sapCriticalColor: #f58b00;
    --sapNegativeColor: #ff8888;
    --sapInformativeColor: #5dafff;
    --sapNeutralColor: #99a8b5;
    --sapErrorBackground: #341a22;
    --sapShadowLevel0: 0 0 0 0.0625rem rgba(255,255,255,.10);
    --sapShadowLevel1: 0 0.125rem 0.5rem 0 rgba(0,0,0,.40), 0 0 0 0.0625rem rgba(255,255,255,.08);
    color-scheme: dark;
  }
  @media (prefers-color-scheme: dark) {
    html:not([data-theme="light"]) {
      --sapBackgroundColor: #12171c; --sapBaseColor: #1c232b; --sapTile_Background: #1c232b;
      --sapTextColor: #eaecee; --sapTitleColor: #fff; --sapContent_LabelColor: #a9b4be;
      --sapContent_ForegroundColor: #9aa7b3; --sapList_HeaderTextColor: #eaecee;
      --sapList_BorderColor: #2b343d; --sapList_Hover: #252e37; --sapLinkColor: #5dafff;
      --sapBrandColor: #1b90ff; --sapPositiveColor: #36a41d; --sapCriticalColor: #f58b00;
      --sapNegativeColor: #ff8888; --sapInformativeColor: #5dafff; --sapNeutralColor: #99a8b5;
      --sapErrorBackground: #341a22; color-scheme: dark;
    }
  }
</style>`;

// ---------------------------------------------------------------------------
// Fiori shell bar (SAP logo + app title)
// ---------------------------------------------------------------------------

/**
 * Inline SAP logo — the blue gradient parallelogram wordmark, rendered as a
 * self-contained SVG so it needs no external asset (CSP-safe). Used in the
 * Fiori shell bar of every generated app, the same way an SAP Fiori launchpad
 * shows the SAP logo top-left.
 */
// The official SAP logo, served from the SAPUI5 resource CDN. Loaded as an
// <img>; if the host CSP blocks ui5.sap.com the inline fallback below is shown
// instead (wired up in SHARED_JS — no inline event handlers, CSP-safe).
const SAP_LOGO_URL = "https://ui5.sap.com/resources/sap/ushell/themes/base/img/SAPLogo.svg";

// Inline fallback rendition of the SAP wordmark (used only if the official
// asset can't be fetched).
const SAP_LOGO_FALLBACK_SVG = `<svg viewBox="0 0 66 33" role="img" aria-label="SAP" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="capmcp-sap" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#1870c5"/><stop offset="1" stop-color="#0070f2"/></linearGradient></defs><polygon points="0,33 55,33 66,0 11,0" fill="url(#capmcp-sap)"/><text x="33" y="24.5" text-anchor="middle" font-family="Arial,Helvetica,sans-serif" font-size="19" font-weight="700" letter-spacing="0.5" fill="#ffffff">SAP</text></svg>`;

/**
 * Builds the Fiori shell-bar markup: official SAP logo, a separator, and the
 * app title. The logo is an <img> from ui5.sap.com with an inline-SVG fallback.
 * @param {string} title - App / entity-collection title
 * @returns {string}
 */
function shellBar(title) {
    return `<header class="shellbar"><img id="sap-logo-img" class="sap-logo" src="${SAP_LOGO_URL}" alt="SAP"><span id="sap-logo-fb" class="sap-logo sap-logo-fb" style="display:none">${SAP_LOGO_FALLBACK_SVG}</span><span class="shell-sep"></span><span class="shell-title">${escHtml(title)}</span></header>`;
}

/**
 * Loads SAPUI5 (sap.m) from the official SAP CDN and, once the core is ready,
 * requires the controls needed for the table, stashes them on `window.__UI5LIBS`,
 * applies the dark theme when the host is dark, and calls `window.__ui5ready()`.
 * Any failure leaves the page on its CSS fallback (never throws into the page).
 *
 * Bootstrap is async + CSP-friendly (no eval, no document.write). The origin is
 * allow-listed via the resource `_meta.ui.csp`.
 */
function sapui5Loader() {
    return `<script id="sap-ui-bootstrap"
  src="${SAPUI5_BOOTSTRAP_SRC}"
  data-sap-ui-theme="sap_horizon"
  data-sap-ui-libs="sap.m"
  data-sap-ui-async="true"
  data-sap-ui-compat-version="edge"
  data-sap-ui-excludejquerycompat="true"></script>
<script>
(function(){
  var booted=false;
  function build(){
    if(booted)return; booted=true;
    try{
      var attr=document.documentElement.getAttribute("data-theme");
      var dark=attr==="dark"||(attr!=="light"&&window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches);
      if(dark){ try{ sap.ui.getCore().applyTheme("sap_horizon_dark"); }catch(e){} }
      sap.ui.require(["sap/m/Table","sap/m/Column","sap/m/ColumnListItem","sap/m/Text","sap/m/ObjectStatus","sap/m/Link","sap/m/Button","sap/m/Label","sap/m/OverflowToolbar","sap/m/ToolbarSpacer","sap/m/Title","sap/m/Dialog","sap/m/CheckBox","sap/ui/core/library"],
        function(Table,Column,ColumnListItem,Text,ObjectStatus,Link,Button,Label,OverflowToolbar,ToolbarSpacer,Title,Dialog,CheckBox,coreLib){
          window.__UI5LIBS={Table:Table,Column:Column,ColumnListItem:ColumnListItem,Text:Text,ObjectStatus:ObjectStatus,Link:Link,Button:Button,Label:Label,OverflowToolbar:OverflowToolbar,ToolbarSpacer:ToolbarSpacer,Title:Title,Dialog:Dialog,CheckBox:CheckBox,ValueState:coreLib.ValueState,TextAlign:coreLib.TextAlign};
          console.info("[cap-mcp-app] SAPUI5 loaded");
          try{ document.documentElement.setAttribute("data-ui5","ready"); }catch(e){}
          if(window.__ui5ready) window.__ui5ready();
        });
    }catch(e){ console.warn("[cap-mcp-app] SAPUI5 init failed, using CSS fallback:", e && (e.stack||e.message||e)); }
  }
  function wait(n){
    if(window.sap && sap.ui && sap.ui.require){
      sap.ui.require(["sap/ui/core/Core"], function(Core){
        try{
          if(Core && Core.ready){ var r=Core.ready(build); if(r&&r.then)r.then(build); }
          else if(sap.ui.getCore){ sap.ui.getCore().attachInit(build); }
          else build();
        }catch(e){ build(); }
      }, function(){ if(sap.ui.getCore) sap.ui.getCore().attachInit(build); else build(); });
    } else if(n>0){ setTimeout(function(){wait(n-1);}, 100); }
    else { console.warn("[cap-mcp-app] SAPUI5 bootstrap did not load (CDN blocked?) — using CSS fallback"); }
  }
  wait(120); /* up to ~12s for the CDN bootstrap */
})();
</script>`;
}

// ---------------------------------------------------------------------------
// MCP Apps postMessage bootstrap
// ---------------------------------------------------------------------------

/**
 * Returns the MCP Apps protocol bootstrap script (spec 2026-01-26).
 *
 * Wire-format details that MUST match the host's PostMessageTransport:
 *   - Messages are posted as STRUCTURED OBJECTS (not JSON strings). The host
 *     ignores any payload whose `.jsonrpc !== "2.0"`, so a stringified message
 *     is silently dropped and the handshake never completes.
 *   - The tool-result notification carries the CallToolResult directly on
 *     `params` (i.e. `params.content[0].text` / `params.structuredContent`),
 *     NOT under `params.result`.
 *   - The app MUST emit `ui/notifications/size-changed` with the content height,
 *     otherwise the host renders the iframe collapsed (blank).
 *
 * Handshake: send `ui/initialize` (request) → on response send
 * `ui/notifications/initialized` → then deliver any buffered tool-result.
 * The host may push tool-result before the handshake finishes, so it is
 * buffered and replayed once ready.
 *
 * @param {string} handlerFnName - JS function called with the parsed tool data
 */
function mcpAppsBootstrap(handlerFnName) {
    return `<script>
(function(){
  var _p={},_id=0,_ready=false,_have=false,_buf=undefined;
  function _send(m){ try{ window.parent.postMessage(m,"*"); }catch(e){} } // object, not string
  function _req(method,params){
    return new Promise(function(res,rej){
      var id=++_id; _p[id]={res:res,rej:rej};
      _send({jsonrpc:"2.0",id:id,method:method,params:params||{}});
    });
  }
  // Call another MCP tool back through the host (Create/Edit/Delete). The host
  // applies its own consent/audit to this tools/call, then returns the result.
  window.__callTool=function(name,args){ return _req("tools/call",{name:name,arguments:args||{}}); };
  // Extract the JSON payload from a CallToolResult.
  window.__extract=function(result){
    try{
      if(result){
        if(result.structuredContent!==undefined && result.structuredContent!==null) return result.structuredContent;
        if(result.content && result.content[0] && typeof result.content[0].text==="string") return JSON.parse(result.content[0].text);
      }
    }catch(e){}
    return null;
  };
  function _sendSize(){
    try{
      var h=Math.ceil(document.documentElement.getBoundingClientRect().height);
      var w=Math.ceil(window.innerWidth);
      _send({jsonrpc:"2.0",method:"ui/notifications/size-changed",params:{width:w,height:h}});
    }catch(e){}
  }
  function _deliver(result){
    try{
      var data=null;
      if(result){
        if(result.structuredContent!==undefined && result.structuredContent!==null) data=result.structuredContent;
        else if(result.content && result.content[0] && typeof result.content[0].text==="string") data=JSON.parse(result.content[0].text);
      }
      ${handlerFnName}(data);
    }catch(e){ console.error("[cap-mcp-app] deliver",e); try{${handlerFnName}(null);}catch(_){} }
    _sendSize();
  }
  function _theme(ctx){ if(ctx && ctx.theme){ try{ document.documentElement.setAttribute("data-theme",ctx.theme); document.documentElement.style.colorScheme=ctx.theme; }catch(e){} } }
  window.addEventListener("message",function(ev){
    var m=ev.data;
    if(typeof m==="string"){ try{m=JSON.parse(m);}catch(e){return;} }
    if(!m || typeof m!=="object" || m.jsonrpc!=="2.0") return;
    if(m.id!==undefined && _p[m.id]){ var p=_p[m.id]; delete _p[m.id]; if(m.error)p.rej(m.error); else p.res(m.result); return; }
    if(m.method==="ui/notifications/tool-result"){ _have=true; _buf=m.params; if(_ready)_deliver(m.params); }
    else if(m.method==="ui/notifications/host-context-changed"){ _theme(m.params); }
  });
  _req("ui/initialize",{appInfo:{name:"cap-mcp-app",version:"1.0.0"},appCapabilities:{},protocolVersion:"${MCP_APPS_PROTOCOL_VERSION}"})
    .then(function(res){
      _send({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}});
      if(res && res.hostContext) _theme(res.hostContext);
      _ready=true;
      if(_have)_deliver(_buf); else _sendSize();
    })
    .catch(function(){ _ready=true; if(_have)_deliver(_buf); });
  if(window.ResizeObserver){ try{ new ResizeObserver(_sendSize).observe(document.documentElement); }catch(e){} }
  window.addEventListener("load",_sendSize);
})();
</script>`;
}

// ---------------------------------------------------------------------------
// Shared JS utilities (inlined in templates)
// ---------------------------------------------------------------------------

const SHARED_JS = `
function _getv(obj,path){
  if(!path)return undefined;
  var segs=path.split(/[\\/\\.]/);
  var v=obj;
  for(var i=0;i<segs.length;i++){
    if(v==null)return undefined;
    // Flattened projection: the annotation says e.g. "genre.name" but the
    // entity denormalised it to a plain "genre" string — use that value
    // instead of trying to index into a primitive (which yields blank).
    if(typeof v!=="object")return v;
    v=v[segs[i]];
  }
  return v;
}
function _esc(v){
  if(v===null||v===undefined)return null;
  return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function _empty(v){ return v===null||v===undefined||v===""; }
function _critN(n){ if(n===null||n===undefined||n==="")return null; var i=typeof n==="number"?n:parseInt(n,10); return isNaN(i)?null:i; }
function _critClass(n){
  var i=_critN(n); if(i===null)return "";
  if(i===1)return "crit-1";if(i===2)return "crit-2";if(i===3)return "crit-3";
  if(i===5)return "crit-5";return "crit-0";
}
/* Monochrome ObjectStatus icon (inherits the semantic text colour). The
   U+FE0E variation selector forces text (not emoji) presentation. */
function _critIcon(n){
  var i=_critN(n);
  if(i===3)return "✓";        /* ✓ success */
  if(i===2)return "⚠︎";  /* ⚠ warning */
  if(i===1)return "✕";        /* ✕ error   */
  if(i===5)return "ⓘ";        /* ⓘ info    */
  return "";
}
/* Fiori list-row highlight bar colour (left edge), driven by row criticality. */
function _critBar(n){
  var i=_critN(n);
  if(i===1)return "var(--sapNegativeColor)";
  if(i===2)return "var(--sapCriticalColor)";
  if(i===3)return "var(--sapPositiveColor)";
  if(i===5)return "var(--sapInformativeColor)";
  return "";
}
/* Show the inline SAP-logo fallback if the official asset fails to load.
   Wired here (not via an inline onerror attribute) to stay CSP-safe. */
(function(){
  try{
    var img=document.getElementById("sap-logo-img");
    if(!img)return;
    var swap=function(){ img.style.display="none"; var fb=document.getElementById("sap-logo-fb"); if(fb)fb.style.display="inline-flex"; };
    img.addEventListener("error",swap);
    if(img.complete&&img.naturalWidth===0)swap();
  }catch(e){}
})();
/* Renders a value as a Fiori ObjectStatus (icon optional) or plain text. */
function _objStatus(text, critVal, withIcon){
  var cls=_critClass(critVal);
  if(!cls) return text!==null?text:'<span class="null-val">—</span>';
  var ic=withIcon?_critIcon(critVal):"";
  return '<span class="objstatus '+cls+'">'+(ic?'<span class="ois-ic">'+ic+'</span>':'')+(text!==null?text:'—')+'</span>';
}
/* Applies @Common.Text + @Common.TextArrangement: a key/FK column shows its
   descriptive text (e.g. ID → author name) the way Fiori does. COMMON_TEXT is
   the per-template map { path: { textPath, textArrangement } }. */
function _applyText(val, row, path){
  var ct=(typeof COMMON_TEXT!=="undefined")?COMMON_TEXT[path]:null;
  // Association-traversal column (e.g. "author.ID"): fall back to the
  // association element's @Common.Text (author → author.name) so the column
  // shows the descriptive text like Fiori, not the raw key.
  if(!ct && typeof COMMON_TEXT!=="undefined" && path && path.indexOf(".")>0){
    ct=COMMON_TEXT[path.split(".")[0]];
  }
  if(!ct||!ct.textPath) return val;
  var t=_getv(row,ct.textPath);
  if(t===null||t===undefined||t==="") return val;
  var a=ct.textArrangement;
  if(a==="TextFirst") return (val!==null&&val!==undefined&&val!=="")? t+" ("+val+")" : t;
  if(a==="TextLast")  return (val!==null&&val!==undefined&&val!=="")? val+" ("+t+")" : t;
  return t; /* TextOnly / TextSeparate / unset → descriptive text */
}
/* Locale-style date formatting to match Fiori: "1818-07-30" → "Jul 30, 1818".
   Pure-deterministic (no Date()/timezone drift); only touches ISO date strings. */
function _fmtVal(v){
  if(typeof v!=="string") return v;
  var m=v.match(/^(\\d{4})-(\\d{2})-(\\d{2})(?:[T ](\\d{2}):(\\d{2}))?/);
  if(!m) return v;
  var MON=["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  var s=MON[parseInt(m[2],10)-1]+" "+parseInt(m[3],10)+", "+m[1];
  if(m[4]) s+=" "+m[4]+":"+m[5];
  return s;
}
/* Coerce a form input string to the field's wire type. */
function _coerce(field, raw){
  if(field.type==="number"){ if(raw===""||raw==null)return undefined; var n=Number(raw); return isNaN(n)?raw:n; }
  if(raw===""||raw==null) return undefined;
  return raw;
}
/* Pull a human-readable message out of a CallToolResult error. */
function _errText(res){ try{ if(res&&res.content&&res.content[0]&&res.content[0].text)return String(res.content[0].text).slice(0,400); }catch(e){} return ""; }
/* Generic Fiori-styled modal form. opts:{title,fields,submitLabel,onSubmit}.
   onSubmit(values) returns a Promise of a CallToolResult; the dialog shows the
   error and stays open on failure, closes on success. */
function _openForm(opts){
  var ov=document.createElement("div"); ov.className="modal-ov";
  var modal=document.createElement("div"); modal.className="modal";
  var hdr=document.createElement("div"); hdr.className="modal-hdr"; hdr.textContent=opts.title||"Form"; modal.appendChild(hdr);
  var body=document.createElement("div"); body.className="modal-body";
  var inputs={};
  (opts.fields||[]).forEach(function(f){
    var row=document.createElement("div"); row.className="form-row";
    var lab=document.createElement("label"); lab.textContent=f.label||f.name;
    if(f.required){ var s=document.createElement("span"); s.className="req"; s.textContent=" *"; lab.appendChild(s); }
    var inp=document.createElement("input");
    inp.type=(f.type==="number"?"number":(f.type==="date"?"date":(f.type==="datetime"?"datetime-local":"text")));
    if(f.value!==undefined&&f.value!==null) inp.value=String(f.value);
    if(f.readonly) inp.disabled=true;
    inputs[f.name]=inp;
    row.appendChild(lab); row.appendChild(inp); body.appendChild(row);
  });
  modal.appendChild(body);
  var msg=document.createElement("div"); msg.className="modal-msg"; msg.style.display="none"; modal.appendChild(msg);
  var ftr=document.createElement("div"); ftr.className="modal-ftr";
  var cancel=document.createElement("button"); cancel.className="fbtn"; cancel.textContent="Cancel";
  var save=document.createElement("button"); save.className="fbtn fbtn-emph"; save.textContent=opts.submitLabel||"Save";
  function close(){ if(ov.parentNode) ov.parentNode.removeChild(ov); }
  cancel.onclick=close;
  save.onclick=function(){
    var values={};
    (opts.fields||[]).forEach(function(f){ var v=_coerce(f, inputs[f.name]?inputs[f.name].value:undefined); if(v!==undefined) values[f.name]=v; });
    save.disabled=true; cancel.disabled=true;
    msg.style.display="block"; msg.className="modal-msg"; msg.textContent="Saving…";
    Promise.resolve(opts.onSubmit(values)).then(function(res){
      if(res&&res.isError){ msg.className="modal-msg err"; msg.textContent=_errText(res)||"Operation failed"; save.disabled=false; cancel.disabled=false; }
      else { close(); }
    }).catch(function(e){ msg.className="modal-msg err"; msg.textContent=(e&&(e.message||e.code))||"Request failed"; save.disabled=false; cancel.disabled=false; });
  };
  ftr.appendChild(cancel); ftr.appendChild(save); modal.appendChild(ftr);
  ov.appendChild(modal); document.body.appendChild(ov);
}`;

// ---------------------------------------------------------------------------
// Query table template
// ---------------------------------------------------------------------------

/**
 * Builds the MCP App HTML for a list/query view.
 *
 * - Columns sorted by importance (High first)
 * - Row criticality coloring when lineItemCriticality is set
 * - Per-cell criticality badges (with optional WithIcon indicator)
 * - DataFieldWithUrl columns rendered as links
 * - Action column placeholders for DataFieldForAction
 * - DataFieldForAnnotation columns show the target label
 *
 * @param {string} entityName
 * @param {import('../../annotations/ui-parser').UiMetadata} uiMeta
 * @returns {string}
 */
function buildQueryTemplate(entityName, uiMeta, appTitle, writeSpec, opts) {
    // When `apps.ui5` is disabled, omit the SAPUI5 bootstrap so the view always
    // uses the self-contained CSS table (no external CDN load).
    const useUi5 = !opts || opts.ui5 !== false;
    // Entity collection name (table toolbar / document title); the shell bar
    // shows the server/app name instead.
    const title = uiMeta.headerInfo?.typeNamePlural ?? uiMeta.headerInfo?.typeName ?? entityName;
    const shellTitle = appTitle || title;

    // Sort columns: High importance first, then Medium, then Low/null
    const columns = sortByImportance(uiMeta.lineItems);

    // Build column spec passed to template JS — includes @UI.LineItem columns
    // plus @UI.Hidden / @UI.SelectionFields entries as off-by-default optional
    // columns so the Fiori-style settings dialog can reveal them.
    const colSpec = augmentColumnSpec(
        columns.map((c) => ({
            path: c.path,
            label: c.label ?? (c.path ? labelFromPath(c.path) : c.annotationTarget ?? "?"),
            critPath: c.criticalityPath,
            withIcon: c.criticalityRepresentation !== "WithoutIcon",
            type: c.dataFieldType,
            url: c.url,
            action: c.action,
        })),
        uiMeta,
        opts?.exposableFields ?? [],
    );

    // Row criticality: we need the path or a simple expression
    const rowCritPath = uiMeta.lineItemCriticality;

    // @Common.Text map so key/FK columns can show their descriptive text
    // (e.g. ID → author name), matching the Fiori List Report.
    const commonTextMap = Object.fromEntries(
        Array.from((uiMeta.commonText ?? new Map()).entries()).map(([k, v]) => [k, v])
    );

    // Index of the identifier column to render bold (Fiori emphasises it):
    // prefer the HeaderInfo.Title column, else the first data column.
    const idColIndex = (() => {
        const tp = uiMeta.headerInfo?.titlePath;
        const byTitle = tp ? colSpec.findIndex((c) => c.path === tp) : -1;
        if (byTitle >= 0) return byTitle;
        return colSpec.findIndex((c) => c.path);
    })();

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
${SHARED_STYLES}
<style>
  .hdr { display: flex; align-items: baseline; gap: 0.5rem; margin-bottom: 0.75rem; }
  .hdr-title { font-size: 1.125rem; font-weight: 700; color: var(--sapTitleColor); letter-spacing: -0.01em; }
  .row-info { font-size: var(--sapFontSmallSize); color: var(--sapContent_ForegroundColor); }
  .list-toolbar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; min-height: 2.25rem; margin-bottom: 0.5rem; }
  .list-toolbar .row-info-title { font-size: 1rem; font-weight: 700; color: var(--sapTitleColor); }
  /* Fiori ResponsiveTable inside a Horizon card */
  .table-card { background: var(--sapTile_Background); border-radius: var(--sapElement_BorderCornerRadius); box-shadow: var(--sapShadowLevel0); overflow: hidden; }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: var(--sapTile_Background); font-weight: 600; font-size: var(--sapFontSmallSize); text-align: left; padding: 0.4375rem 0.75rem; border-bottom: 0.0625rem solid var(--sapList_BorderColor); color: var(--sapList_HeaderTextColor); white-space: nowrap; }
  tbody td { padding: 0.4375rem 0.75rem; border-bottom: 0.0625rem solid var(--sapList_BorderColor); vertical-align: middle; color: var(--sapTextColor); }
  tbody tr:last-child td { border-bottom: none; }
  tbody tr:hover td { background: var(--sapList_Hover); }
  td.has-bar { border-left: 0.1875rem solid transparent; padding-left: calc(1rem - 0.1875rem); }
  td.cell-id { font-weight: 700; color: var(--sapTitleColor); }
  .null-val { color: var(--sapContent_ForegroundColor); }
  .url-link { color: var(--sapLinkColor); text-decoration: none; }
  .url-link:hover { text-decoration: underline; }
  .act-hint { display: inline-flex; align-items: center; height: 1.5rem; padding: 0 0.625rem; border: 0.0625rem solid var(--sapLinkColor); border-radius: var(--sapField_BorderCornerRadius); color: var(--sapLinkColor); font-size: var(--sapFontSmallSize); font-weight: 600; }
</style>
</head>
<body>
<div class="app-card">
${shellBar(shellTitle)}
<div class="page">
<div id="row-info" class="list-toolbar"></div>
<div id="content"><div class="loading">Waiting for data…</div></div>
</div>
</div>
${useUi5 ? sapui5Loader() : ""}
${mcpAppsBootstrap("render")}
<script>
${SHARED_JS}
var COLS=${JSON.stringify(colSpec)};
var ROW_CRIT_PATH=${JSON.stringify(rowCritPath ?? null)};
var COMMON_TEXT=${JSON.stringify(commonTextMap)};
var ID_COL=${JSON.stringify(idColIndex)};
var TYPE_PLURAL=${JSON.stringify(title)};
var WRITE=${JSON.stringify(writeSpec || null)};
var UI5=false, LAST=null;

/* Create form fields: writable fields + any non-computed keys (editable). */
function _createFields(){
  var fs=(WRITE&&WRITE.fields?WRITE.fields:[]).map(function(f){return {name:f.name,label:f.label,type:f.type};});
  (WRITE&&WRITE.keyFields?WRITE.keyFields:[]).forEach(function(k){ if(!k.computed) fs.unshift({name:k.name,label:k.name,type:k.type}); });
  return fs;
}
function _create(){
  if(!WRITE||!WRITE.create)return;
  _openForm({ title:"Create "+(TYPE_PLURAL||"").replace(/s$/,""), submitLabel:"Create", fields:_createFields(),
    onSubmit:function(values){ return window.__callTool(WRITE.create.tool, values).then(function(res){ if(!(res&&res.isError)) _refreshQuery(); return res; }); }
  });
}
function _refreshQuery(){ if(!WRITE)return; window.__callTool(WRITE.queryTool,{}).then(function(res){ if(res&&!res.isError){ var d=window.__extract(res); if(d!=null) render(d); } }); }

/* Dispatcher: prefer authentic UI5 Web Components; fall back to the
   self-contained CSS table if UI5 isn't loaded (or a render error occurs). */
function render(data){
  LAST=data;
  if(UI5){ try{ renderUi5(data); return; }catch(e){ console.warn("[cap-mcp-app] ui5 render error, css fallback:", e&&e.message); } }
  renderCss(data);
}
window.__ui5ready=function(){
  UI5=true;
  if(LAST!==null){ try{ renderUi5(LAST); }catch(e){ renderCss(LAST); } }
};

/* Map criticality (0/1/2/3/5) to a UI5 ObjectStatus value-state. */
function _ui5State(crit){ var i=_critN(crit); return i===3?"Positive":i===2?"Critical":i===1?"Negative":i===5?"Information":"None"; }

/* Per-column alignment: right-align numeric columns the Fiori way. Only plain
   value columns (not status / actions) are considered; sampled from the data. */
function _colAligns(rows){
  return COLS.map(function(c){
    if(!c.path||c.critPath||c.type!=="DataField") return false;
    var num=false, seen=false;
    for(var i=0;i<rows.length&&i<25;i++){
      var v=_getv(rows[i],c.path);
      if(v==null||v==="")continue;
      seen=true;
      if(typeof v==="number"||(typeof v==="string"&&/^-?\\d+(\\.\\d+)?$/.test(v))){ num=true; } else { num=false; break; }
    }
    return seen&&num;
  });
}

/* Populates the CSS-mode page toolbar: "<TypeNamePlural> (<count>)" + Create. */
function _cssToolbar(info, count){
  info.innerHTML=""; info.style.display="flex";
  var t=document.createElement("span"); t.className="row-info-title";
  t.textContent=((typeof TYPE_PLURAL!=="undefined"&&TYPE_PLURAL)?TYPE_PLURAL+" ":"")+"("+count+")";
  info.appendChild(t);
  if(WRITE&&WRITE.create){ var b=document.createElement("button"); b.className="fbtn fbtn-emph"; b.textContent="Create"; b.onclick=_create; info.appendChild(b); }
}

/* ---- CSS fallback table (always available) ---- */
function renderCss(data){
  var el=document.getElementById("content"), info=document.getElementById("row-info");
  if(!data){el.innerHTML='<div class="error-msg">No data received</div>';return}
  var rows=Array.isArray(data)?data:[data];
  _cssToolbar(info, rows.length);
  if(!rows.length){el.innerHTML='<div class="loading">No results</div>';return}
  var AL=_colAligns(rows);
  var h='<div class="table-card"><table><thead><tr>';
  COLS.forEach(function(c,ci){ if(c.visible===false)return; h+='<th'+(AL[ci]?' style="text-align:right"':'')+'>'+(_esc(c.label)||'')+'</th>';});
  h+='</tr></thead><tbody>';
  rows.forEach(function(row){
    var bar=ROW_CRIT_PATH?_critBar(_getv(row,ROW_CRIT_PATH)):"";
    h+='<tr>';
    COLS.forEach(function(c,ci){
      if(c.visible===false)return;
      var cls=[], style="";
      if(ci===0&&bar){ cls.push("has-bar"); style+='border-left-color:'+bar+';'; }
      if(ci===ID_COL) cls.push("cell-id");
      if(AL[ci]) style+='text-align:right;';
      h+='<td'+(cls.length?' class="'+cls.join(" ")+'"':'')+(style?' style="'+style+'"':'')+'>';
      if(c.type==="DataFieldForAction"||c.type==="DataFieldForActionGroup"){
        h+='<span class="act-hint">'+_esc(c.label)+'</span>';
      } else if(c.type==="DataFieldForAnnotation"){
        h+='<span class="null-val">'+_esc(c.label)+'</span>';
      } else if(c.path){
        var raw=_fmtVal(_applyText(_getv(row,c.path),row,c.path));
        var ve=_esc(raw);
        if(c.critPath){
          h+=_objStatus(ve, _getv(row,c.critPath), c.withIcon);
        } else if(c.type==="DataFieldWithUrl"&&c.url){
          var urlVal=_getv(row,c.url)||"#";
          h+=ve!==null?'<a class="url-link" href="'+_esc(urlVal)+'" target="_blank" rel="noopener">'+ve+'</a>':'<span class="null-val">—</span>';
        } else {
          h+=ve!==null?ve:'<span class="null-val">—</span>';
        }
      } else {
        h+='<span class="null-val">—</span>';
      }
      h+='</td>';
    });
    h+='</tr>';
  });
  h+='</tbody></table></div>';
  el.innerHTML=h;
}

/* ---- Authentic SAPUI5 sap.m.Table ---- */
var _SEMICON={Positive:"sap-icon://sys-enter-2",Critical:"sap-icon://alert",Negative:"sap-icon://error",Information:"sap-icon://information"};
function renderUi5(data){
  var L=window.__UI5LIBS;
  if(!L){ renderCss(data); return; }
  var el=document.getElementById("content"), info=document.getElementById("row-info");
  if(!data){ renderCss(data); return; }
  var rows=Array.isArray(data)?data:[data];
  if(!rows.length){ if(info){info.innerHTML="";info.style.display="none";} el.innerHTML='<div class="loading">No results</div>'; return; }
  var AL=_colAligns(rows);
  if(window.__tbl){ try{ window.__tbl.destroy(); }catch(e){} window.__tbl=null; }
  // Count + Create live in the UI5 header toolbar; collapse the page toolbar
  // entirely (its min-height would otherwise leave a gap above the table).
  if(info){ info.innerHTML=""; info.style.display="none"; }

  var columns=COLS.map(function(c,ci){
    return new L.Column({ visible:c.visible!==false, hAlign: AL[ci]?L.TextAlign.End:L.TextAlign.Begin, header: new L.Label({text:c.label||"", wrapping:false}) });
  });

  // Fiori table header toolbar: "<TypeNamePlural> (<count>)" + Create + settings.
  var tbContent=[
    new L.Title({ text:(TYPE_PLURAL||"")+" ("+rows.length+")", level:"H2" }),
    new L.ToolbarSpacer()
  ];
  if(WRITE&&WRITE.create){ tbContent.push(new L.Button({ text:"Create", icon:"sap-icon://add", type:"Transparent", press:_create })); }
  tbContent.push(new L.Button({ icon:"sap-icon://action-settings", tooltip:"Table settings", press:_openColumnsDialog }));
  var headerToolbar=new L.OverflowToolbar({ content:tbContent });

  var tbl=new L.Table({ headerToolbar:headerToolbar, columns:columns, growing:true, growingThreshold:100, alternateRowColors:false });

  rows.forEach(function(row){
    var cells=COLS.map(function(c){
      if(c.type==="DataFieldForAction"||c.type==="DataFieldForActionGroup"){
        return new L.Button({text:c.label||"", type:"Transparent"});
      }
      if(c.path){
        var raw=_fmtVal(_applyText(_getv(row,c.path),row,c.path));
        var txt=(raw==null||raw==="")?"—":String(raw);
        if(c.critPath){
          var st=_ui5State(_getv(row,c.critPath));
          var cfg={text:txt, state:st};
          if(c.withIcon && _SEMICON[st]) cfg.icon=_SEMICON[st];
          return new L.ObjectStatus(cfg);
        }
        if(c.type==="DataFieldWithUrl"&&c.url){
          return new L.Link({text:txt, href:String(_getv(row,c.url)||"#"), target:"_blank"});
        }
        return new L.Text({text:txt});
      }
      return new L.Text({text:"—"});
    });
    tbl.addItem(new L.ColumnListItem({cells:cells}));
  });

  el.innerHTML="";
  // Compact density — shorter rows/controls, the space-efficient UI5 look.
  var mount=document.createElement("div"); mount.id="ui5-tbl-mount"; mount.className="sapUiSizeCompact"; el.appendChild(mount);
  tbl.placeAt(mount);
  window.__tbl=tbl;
}

/* Column-visibility dialog (the "settings" affordance). Lists every column
   with a checkbox bound to sap.m.Column#setVisible — like the Fiori columns
   personalisation, kept lean and self-contained. */
function _openColumnsDialog(){
  var L=window.__UI5LIBS, tbl=window.__tbl;
  if(!L||!tbl)return;
  var cols=tbl.getColumns();
  var boxes=cols.map(function(col,ci){
    return new L.CheckBox({
      text:(COLS[ci]&&COLS[ci].label)||("Column "+(ci+1)),
      selected:col.getVisible(),
      select:(function(c){return function(e){ c.setVisible(e.getParameter("selected")); };})(col)
    });
  });
  var dlg=new L.Dialog({
    title:"Columns",
    contentWidth:"18rem",
    content:boxes,
    beginButton:new L.Button({ text:"Close", type:"Emphasized", press:function(){ dlg.close(); } }),
    afterClose:function(){ dlg.destroy(); }
  });
  dlg.addStyleClass("sapUiContentPadding");
  dlg.addStyleClass("sapUiSizeCompact");
  dlg.open();
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Detail card template
// ---------------------------------------------------------------------------

/**
 * Builds the MCP App HTML for a detail / single-record view.
 *
 * Structure:
 *   1. Header: title + subtitle (from HeaderInfo paths), optional image
 *   2. DataPoint status strip (from dataPoints matching headerFacets)
 *   3. Page sections driven by @UI.Facets when present, otherwise @UI.FieldGroup
 *   4. Identification action list at the bottom
 *
 * FieldGroup items with @Common.Text associations show label text.
 * @UI.MultiLineText fields render as <pre>.
 *
 * @param {string} entityName
 * @param {import('../../annotations/ui-parser').UiMetadata} uiMeta
 * @returns {string}
 */
function buildDetailTemplate(entityName, uiMeta, appTitle, writeSpec) {
    const title = uiMeta.headerInfo?.typeName ?? entityName;
    const shellTitle = appTitle || title;

    // Determine which DataPoints to show in the header strip
    // Use HeaderFacets references when available; otherwise show all DataPoints
    const dpKeys = buildHeaderDataPointKeys(uiMeta);
    const dpSpec = dpKeys.map((q) => ({ qualifier: q, ...uiMeta.dataPoints[q] }));

    // Build section structure from Facets (preferred) or FieldGroups (fallback)
    const sections = buildDetailSections(uiMeta);

    // Actions from Identification
    const actions = uiMeta.identification.flatMap((id) => {
        if (id.type === "DataFieldForAction") return id.action ? [id.label ?? id.action] : [];
        if (id.type === "DataFieldForActionGroup" && id.actions) return id.actions.map((a) => a.label ?? a.action).filter(Boolean);
        return [];
    });

    // Element metadata
    const multiLineFields = Array.from(uiMeta.multiLineFields ?? new Set());
    const commonTextMap = Object.fromEntries(
        Array.from((uiMeta.commonText ?? new Map()).entries()).map(([k, v]) => [k, v])
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
${SHARED_STYLES}
<style>
  /* Fiori Object Page header (Horizon) */
  .obj-hdr { display: flex; align-items: center; gap: 0.75rem; background: var(--sapTile_Background); border-radius: var(--sapElement_BorderCornerRadius); box-shadow: var(--sapShadowLevel0); padding: 0.625rem 0.875rem; margin-bottom: 0.625rem; }
  .obj-avatar { width: 2.5rem; height: 2.5rem; border-radius: 0.5rem; object-fit: cover; background: var(--sapList_Hover); flex-shrink: 0; }
  .obj-titles { min-width: 0; }
  .obj-titles .title { font-size: 1.1875rem; font-weight: 700; color: var(--sapTitleColor); letter-spacing: -0.01em; line-height: 1.2; }
  .obj-titles .subtitle { font-size: 0.8125rem; color: var(--sapContent_LabelColor); margin-top: 0.0625rem; }
  .obj-actions { margin-left: auto; display: flex; gap: 0.375rem; align-self: flex-start; }
  /* DataPoint strip — Fiori ObjectStatus header items */
  .dp-strip { display: flex; flex-wrap: wrap; gap: 0.375rem 1.5rem; margin-bottom: 0.625rem; padding: 0 0.25rem; }
  .dp-item { display: flex; flex-direction: column; gap: 0.0625rem; }
  .dp-label { font-size: var(--sapFontSmallSize); color: var(--sapContent_LabelColor); }
  .dp-value { font-size: 1rem; font-weight: 700; }
  /* Sections — Horizon form cards */
  .section { background: var(--sapTile_Background); border-radius: var(--sapElement_BorderCornerRadius); box-shadow: var(--sapShadowLevel0); margin-bottom: 0.625rem; overflow: hidden; }
  .section-hdr { padding: 0.625rem 0.875rem 0.375rem; font-weight: 700; font-size: 0.9375rem; color: var(--sapTitleColor); }
  .section > .section-hdr + .fields { padding-top: 0.25rem; }
  .fields { display: grid; grid-template-columns: repeat(auto-fill,minmax(12rem,1fr)); gap: 0.625rem 1.25rem; padding: 0.625rem 0.875rem 0.75rem; }
  .field { min-width: 0; }
  .f-label { font-size: var(--sapFontSmallSize); color: var(--sapContent_LabelColor); margin-bottom: 0.125rem; }
  .f-value { font-size: 0.875rem; color: var(--sapTextColor); word-break: break-word; }
  .f-empty { color: var(--sapContent_ForegroundColor); }
  .f-multi { font-family: "72Mono","Consolas",monospace; font-size: var(--sapFontSmallSize); white-space: pre-wrap; max-height: 7rem; overflow-y: auto; background: var(--sapBackgroundColor); border-radius: var(--sapField_BorderCornerRadius); padding: 0.4375rem 0.5rem; }
  .f-link { color: var(--sapLinkColor); text-decoration: none; } .f-link:hover { text-decoration: underline; }
  /* Actions — Fiori toolbar buttons */
  .actions { margin-top: 0.125rem; }
  .actions-title { font-size: var(--sapFontSmallSize); color: var(--sapContent_LabelColor); margin-bottom: 0.375rem; }
  .act-list { display: flex; flex-wrap: wrap; gap: 0.375rem; }
  .act-chip { display: inline-flex; align-items: center; height: 1.75rem; padding: 0 0.625rem; background: transparent; color: var(--sapLinkColor); border: 0.0625rem solid var(--sapLinkColor); border-radius: var(--sapField_BorderCornerRadius); font-size: var(--sapFontSmallSize); font-weight: 600; }
</style>
</head>
<body>
<div class="app-card">
${shellBar(shellTitle)}
<div class="page">
<div id="obj-hdr" class="obj-hdr" style="display:none">
  <img id="obj-img" class="obj-avatar" style="display:none" alt="">
  <div class="obj-titles">
    <div class="title" id="obj-title">${escHtml(title)}</div>
    <div class="subtitle" id="obj-subtitle"></div>
  </div>
  <div id="obj-actions" class="obj-actions"></div>
</div>
<div id="dp-strip" class="dp-strip" style="display:none"></div>
<div id="content"><div class="loading">Waiting for data…</div></div>
${actions.length ? `<div class="actions"><div class="actions-title">Available Actions</div><div class="act-list">${actions.map((a) => `<span class="act-chip">${escHtml(a)}</span>`).join("")}</div></div>` : ""}
</div>
</div>
${mcpAppsBootstrap("render")}
<script>
${SHARED_JS}
var SECTIONS=${JSON.stringify(sections)};
var DP_SPEC=${JSON.stringify(dpSpec)};
var TITLE_PATH=${JSON.stringify(uiMeta.headerInfo?.titlePath ?? null)};
var DESC_PATH=${JSON.stringify(uiMeta.headerInfo?.descriptionPath ?? null)};
var IMG_PATH=${JSON.stringify(uiMeta.headerInfo?.imagePath ?? null)};
var MULTI_FIELDS=${JSON.stringify(multiLineFields)};
var COMMON_TEXT=${JSON.stringify(commonTextMap)};
var WRITE=${JSON.stringify(writeSpec || null)};
var LAST_ROW=null;

/* Addressing keys for the current record (update/delete/refresh). */
function _keyArgs(row){ var a={}; (WRITE&&WRITE.keyFields?WRITE.keyFields:[]).forEach(function(k){ var v=_getv(row,k.name); if(v!==undefined&&v!==null)a[k.name]=v; }); return a; }
/* Edit: form pre-filled from the record; keys are read-only addressing. */
function _edit(){
  if(!WRITE||!LAST_ROW)return;
  if(!WRITE.update&&!WRITE.draftUpdate)return;
  var row=LAST_ROW;
  var keyF=(WRITE.keyFields||[]).map(function(k){return {name:k.name,label:k.name,type:k.type,readonly:true,value:_getv(row,k.name)};});
  var valF=(WRITE.fields||[]).map(function(f){return {name:f.name,label:f.label,type:f.type,value:_getv(row,f.name)};});
  _openForm({ title:"Edit", submitLabel:"Save", fields:keyF.concat(valF),
    onSubmit:function(values){
      if(WRITE.draftUpdate){
        var keys={}; (WRITE.keyFields||[]).forEach(function(k){ if(values[k.name]!==undefined) keys[k.name]=values[k.name]; });
        return window.__callTool(WRITE.draftUpdate.edit, keys)
          .then(function(res){ if(res&&res.isError) return res; return window.__callTool(WRITE.draftUpdate.patch, values); })
          .then(function(res){ if(res&&res.isError) return res; return window.__callTool(WRITE.draftUpdate.activate, keys); })
          .then(function(res){ if(!(res&&res.isError)) _refreshGet(); return res; });
      }
      return window.__callTool(WRITE.update.tool, values).then(function(res){ if(!(res&&res.isError)) _refreshGet(); return res; });
    }
  });
}
/* Delete: host applies its own consent prompt for the tools/call. */
function _del(){
  if(!WRITE||!WRITE.del||!LAST_ROW)return;
  window.__callTool(WRITE.del.tool, _keyArgs(LAST_ROW)).then(function(res){
    var el=document.getElementById("content");
    if(res&&res.isError){ el.insertAdjacentHTML("afterbegin",'<div class="error-msg">'+_esc(_errText(res)||"Delete failed")+'</div>'); }
    else { el.innerHTML='<div class="loading">Deleted.</div>'; var a=document.getElementById("obj-actions"); if(a)a.innerHTML=""; var dp=document.getElementById("dp-strip"); if(dp)dp.style.display="none"; }
  });
}
function _refreshGet(){ if(!WRITE||!LAST_ROW)return; window.__callTool(WRITE.getTool, _keyArgs(LAST_ROW)).then(function(res){ if(res&&!res.isError){ var d=window.__extract(res); if(d!=null) render(d); } }); }
function _renderActions(){
  var a=document.getElementById("obj-actions"); if(!a)return; a.innerHTML="";
  if((WRITE&&WRITE.update)||(WRITE&&WRITE.draftUpdate)){ var e=document.createElement("button"); e.className="fbtn fbtn-emph"; e.textContent="Edit"; e.onclick=_edit; a.appendChild(e); }
  if(WRITE&&WRITE.del){ var d=document.createElement("button"); d.className="fbtn fbtn-neg"; d.textContent="Delete"; d.onclick=_del; a.appendChild(d); }
}

function render(data){
  var el=document.getElementById("content");
  if(!data){el.innerHTML='<div class="error-msg">No data received</div>';return}
  var row=Array.isArray(data)?data[0]:data;
  if(!row){el.innerHTML='<div class="loading">No result</div>';return}
  LAST_ROW=row;

  // Update header
  var hdr=document.getElementById("obj-hdr");
  hdr.style.display="flex";
  _renderActions();
  if(TITLE_PATH){var tv=_getv(row,TITLE_PATH);if(tv!=null)document.getElementById("obj-title").textContent=String(tv);}
  if(DESC_PATH){var dv=_getv(row,DESC_PATH);if(dv!=null)document.getElementById("obj-subtitle").textContent=String(dv);}
  if(IMG_PATH){var iv=_getv(row,IMG_PATH);if(iv){var img=document.getElementById("obj-img");img.src=String(iv);img.style.display="block";}}

  // DataPoint strip
  if(DP_SPEC.length){
    var strip=document.getElementById("dp-strip");
    var dh="";
    DP_SPEC.forEach(function(dp){
      var v=dp.valuePath?_fmtVal(_applyText(_getv(row,dp.valuePath),row,dp.valuePath)):null;
      var cv=dp.criticalityPath?_getv(row,dp.criticalityPath):null;
      var cc=_critClass(cv);
      var ic=cc?_critIcon(cv):"";
      dh+='<div class="dp-item"><span class="dp-label">'+(_esc(dp.title)||'')+'</span>';
      dh+='<span class="dp-value'+(cc?' '+cc:'')+'">'+(ic?'<span class="ois-ic">'+ic+'</span> ':'')+(v!=null?_esc(v):'—')+'</span></div>';
    });
    strip.innerHTML=dh; strip.style.display="flex";
  }

  // Sections
  if(!SECTIONS.length){
    // Fallback: render all scalar fields
    el.innerHTML=renderFallback(row);
    return;
  }
  var html="";
  SECTIONS.forEach(function(sec){
    html+=renderSection(sec,row);
  });
  el.innerHTML=html||renderFallback(row);
}

function renderSection(sec,row){
  if(sec.type==="CollectionFacet"&&sec.sections){
    var inner="";
    sec.sections.forEach(function(s){inner+=renderSection(s,row);});
    if(!inner)return"";
    var lbl=sec.label?'<div class="section-hdr">'+_esc(sec.label)+'</div>':"";
    return'<div class="section">'+lbl+'<div style="padding:0">'+inner+'</div></div>';
  }
  if(sec.type==="FieldGroup"&&sec.fields){
    return renderFieldGroup(sec.label,sec.fields,row);
  }
  return"";
}

function renderFieldGroup(label,fields,row){
  var rows="";
  var hasContent=false;
  fields.forEach(function(f){
    if(!f.path)return;
    // @Common.Text (text arrangement) then locale value formatting
    var v=_fmtVal(_applyText(_getv(row,f.path),row,f.path));
    var isMulti=MULTI_FIELDS.indexOf(f.path)>=0;
    var ve=_esc(v);
    var valHtml;
    if(ve===null){
      valHtml='<span class="f-empty">—</span>';
    } else if(isMulti){
      valHtml='<pre class="f-multi">'+ve+'</pre>';
    } else if(f.critPath){
      valHtml=_objStatus(ve, _getv(row,f.critPath), true);
    } else if(f.url){
      var urlV=_getv(row,f.url)||"#";
      valHtml='<a class="f-link" href="'+_esc(urlV)+'" target="_blank" rel="noopener">'+ve+'</a>';
    } else {
      valHtml=ve;
    }
    rows+='<div class="field"><div class="f-label">'+_esc(f.label||f.path)+'</div><div class="f-value">'+valHtml+'</div></div>';
    hasContent=true;
  });
  if(!hasContent)return"";
  var lbl=label?'<div class="section-hdr">'+_esc(label)+'</div>':"";
  return'<div class="section">'+lbl+'<div class="fields">'+rows+'</div></div>';
}

function renderFallback(row){
  var h='<div class="section"><div class="fields">';
  Object.entries(row).forEach(function(kv){
    var k=kv[0],v=kv[1];
    if(v!==null&&typeof v==="object")return;
    h+='<div class="field"><div class="f-label">'+_esc(k)+'</div><div class="f-value">'+(v!=null?_esc(v):'<span class="f-empty">—</span>')+'</div></div>';
  });
  return h+'</div></div>';
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Section builder helpers
// ---------------------------------------------------------------------------

/**
 * Builds the flat list of sections to render in the detail view.
 * Priority: @UI.Facets (full structure) → @UI.FieldGroup (flat list).
 * @param {import('../../annotations/ui-parser').UiMetadata} uiMeta
 * @returns {Array<SectionSpec>}
 */
function buildDetailSections(uiMeta) {
    if (uiMeta.facets?.length) {
        return uiMeta.facets.flatMap((facet) => resolveFacetToSection(facet, uiMeta));
    }
    // Fallback: use FieldGroups directly
    return Object.entries(uiMeta.fieldGroups).map(([q, g]) => ({
        type: "FieldGroup",
        label: g.label ?? q,
        fields: g.fields.map(fieldToSpec),
    }));
}

/**
 * Resolves a FacetDef to a SectionSpec using uiMeta to look up FieldGroups.
 * @param {object} facet
 * @param {object} uiMeta
 * @returns {SectionSpec[]}
 */
function resolveFacetToSection(facet, uiMeta) {
    if (facet.type === "CollectionFacet" && facet.facets?.length) {
        const inner = facet.facets.flatMap((f) => resolveFacetToSection(f, uiMeta));
        if (!inner.length) return [];
        return [{ type: "CollectionFacet", label: facet.label, sections: inner }];
    }
    if (facet.type === "ReferenceFacet" && facet.target) {
        return resolveTargetToSection(facet.target, facet.label, uiMeta);
    }
    return [];
}

/**
 * Resolves an annotation target reference (e.g. '@UI.FieldGroup#General') to a section.
 * @param {string} target
 * @param {string|null} fallbackLabel
 * @param {object} uiMeta
 * @returns {SectionSpec[]}
 */
function resolveTargetToSection(target, fallbackLabel, uiMeta) {
    if (!target) return [];
    // @UI.FieldGroup#qualifier
    const fgMatch = target.match(/@UI\.FieldGroup(?:#(.+))?$/);
    if (fgMatch) {
        const qualifier = fgMatch[1] ?? "_default";
        const fg = uiMeta.fieldGroups[qualifier];
        if (!fg) return [];
        return [{ type: "FieldGroup", label: fallbackLabel ?? fg.label ?? qualifier, fields: fg.fields.map(fieldToSpec) }];
    }
    // @UI.DataPoint — skip (rendered in the header strip)
    if (target.includes("@UI.DataPoint")) return [];
    // Sub-entity navigation references like 'items/@UI.LineItem' — skip
    return [];
}

/**
 * Converts a UiMetadata field definition to a template SectionField spec.
 */
function fieldToSpec(f) {
    return {
        path: f.path,
        label: f.label ?? (f.path ? labelFromPath(f.path) : null),
        critPath: f.criticalityPath ?? null,
        url: f.url ?? null,
        type: f.dataFieldType ?? "DataField",
    };
}

/**
 * Determines which DataPoint qualifiers to show in the header strip.
 * Uses HeaderFacets references when available, falls back to all DataPoints.
 * @param {object} uiMeta
 * @returns {string[]}
 */
function buildHeaderDataPointKeys(uiMeta) {
    if (!uiMeta.dataPoints || !Object.keys(uiMeta.dataPoints).length) return [];

    if (uiMeta.headerFacets?.length) {
        const keys = [];
        for (const hf of uiMeta.headerFacets) {
            const dpMatch = hf.target?.match(/@UI\.DataPoint#(.+)/);
            if (dpMatch && uiMeta.dataPoints[dpMatch[1]]) keys.push(dpMatch[1]);
        }
        if (keys.length) return keys;
    }
    // No HeaderFacets or none pointing to DataPoints → show all (max 4 for space)
    return Object.keys(uiMeta.dataPoints).slice(0, 4);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/** Sorts a column list: High importance first, then unset/Medium, Low last. */
function sortByImportance(cols) {
    const rank = { High: 0, Medium: 1, Low: 3, null: 2, undefined: 2 };
    return [...cols].sort((a, b) => (rank[a.importance] ?? 2) - (rank[b.importance] ?? 2));
}

/**
 * Builds the full table column spec:
 *   - @UI.LineItem → visible by default (@UI.Hidden entries dropped entirely)
 *   - service-exposed fields not in LineItem → off by default, toggleable in settings
 *   - @UI.Hidden → never rendered, never listed in settings
 * @param {Array<object>} colSpec - columns derived from LineItem
 * @param {import('../annotations/ui-parser').UiMetadata} uiMeta
 * @param {Array<{path:string,label?:string}>} exposableFields - MCP resource fields
 * @returns {Array<object>}
 */
function _pathHidden(path, hidden) {
    if (!path) return false;
    if (hidden.has(path)) return true;
    const root = path.split(/[/.]/)[0];
    return hidden.has(root);
}

function augmentColumnSpec(colSpec, uiMeta, exposableFields) {
    const hidden = uiMeta.hiddenFields ?? new Set();

    const result = colSpec
        .filter((c) => !c.path || !_pathHidden(c.path, hidden))
        .map((c) => ({ ...c, visible: true }));

    const seen = new Set(result.map((c) => c.path).filter(Boolean));

    for (const f of exposableFields ?? []) {
        if (!f.path || seen.has(f.path) || _pathHidden(f.path, hidden)) continue;
        result.push({
            path: f.path,
            label: f.label ?? labelFromPath(f.path),
            critPath: null,
            withIcon: false,
            type: "DataField",
            url: null,
            action: null,
            visible: false,
        });
        seen.add(f.path);
    }

    return result;
}

/** Converts an association-traversal path to a human-readable column label. */
function labelFromPath(path) {
    if (!path) return "";
    const name = path.split(/[/.]/).shift() ?? path;
    const stripped = name.replace(/_(ID|code|id|Code)$/, "");
    return stripped
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .replace(/_/g, " ")
        .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** HTML-escapes a server-side string (for use in template literal, not in runtime JS). */
function escHtml(str) {
    if (!str) return "";
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
