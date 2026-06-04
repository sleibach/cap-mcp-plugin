"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildQueryTemplate = buildQueryTemplate;
exports.buildDetailTemplate = buildDetailTemplate;

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
  :root {
    --sapBackgroundColor: #f5f6f7;
    --sapBaseColor: #fff;
    --sapTextColor: #1d2d3e;
    --sapTitleColor: #1d2d3e;
    --sapSubtitleColor: #556b82;
    --sapBorderColor: #c2cad3;
    --sapHighlightColor: #0070f2;
    --sapPositiveColor: #188918;
    --sapCriticalColor: #e9730c;
    --sapNegativeColor: #bb0000;
    --sapNeutralColor: #788fa6;
    --sapInformativeColor: #0070f2;
    --sapContent_ForegroundColor: #8696a9;
    --sapFontFamily: "72","72full",Arial,Helvetica,sans-serif;
    --sapFontSize: 14px;
    --sapFontSmallSize: 12px;
    --sapBorderRadius: 6px;
    --sapShadow: 0 1px 3px rgba(0,0,0,.08);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--sapBackgroundColor); padding: 12px; font-family: var(--sapFontFamily); font-size: var(--sapFontSize); color: var(--sapTextColor); min-height: 100vh; }
  .loading { color: var(--sapContent_ForegroundColor); font-size: var(--sapFontSmallSize); padding: 32px; text-align: center; }
  .error-msg { color: var(--sapNegativeColor); padding: 10px 14px; border: 1px solid var(--sapNegativeColor); border-radius: var(--sapBorderRadius); background: #ffebee; font-size: var(--sapFontSmallSize); }

  /* Criticality badges */
  .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .crit-1,.crit-neg  { background: #ffebee; color: var(--sapNegativeColor);  }
  .crit-2,.crit-warn { background: #fff3e0; color: var(--sapCriticalColor);  }
  .crit-3,.crit-pos  { background: #e8f5e9; color: var(--sapPositiveColor); }
  .crit-5,.crit-info { background: #e3f2fd; color: var(--sapInformativeColor); }
  .crit-0,.crit-neu  { background: #eceff1; color: var(--sapNeutralColor);   }
</style>`;

// ---------------------------------------------------------------------------
// MCP Apps postMessage bootstrap
// ---------------------------------------------------------------------------

/**
 * Returns the minimal MCP Apps protocol bootstrap script.
 * Sets up ui/initialize handshake and ui/notifications/tool-result listener.
 * @param {string} handlerFnName - Name of the JS function to call with parsed data
 */
function mcpAppsBootstrap(handlerFnName) {
    return `<script>
(function(){
  var _p={},_id=0;
  function _send(m){ try{window.parent.postMessage(JSON.stringify(m),"*")}catch(e){} }
  function _req(method,params){
    return new Promise(function(res,rej){
      var id=++_id; _p[id]={res:res,rej:rej};
      _send({jsonrpc:"2.0",id:id,method:method,params:params||{}});
    });
  }
  window.addEventListener("message",function(ev){
    var m; try{m=typeof ev.data==="string"?JSON.parse(ev.data):ev.data}catch(e){return}
    if(!m||typeof m!=="object")return;
    if(m.id!==undefined&&_p[m.id]){var p=_p[m.id];delete _p[m.id];if(m.error)p.rej(m.error);else p.res(m.result);return}
    if(m.method==="ui/notifications/tool-result"){
      try{
        var txt=m.params&&m.params.result&&m.params.result.content&&
                m.params.result.content[0]&&m.params.result.content[0].text;
        ${handlerFnName}(txt?JSON.parse(txt):null);
      }catch(e){console.error("[cap-mcp-app]",e)}
    }
  });
  _req("ui/initialize",{appInfo:{name:"cap-mcp-app",version:"1.0.0"},appCapabilities:{},protocolVersion:"${MCP_APPS_PROTOCOL_VERSION}"})
    .then(function(){_send({jsonrpc:"2.0",method:"ui/notifications/initialized",params:{}})})
    .catch(function(){/* host does not support MCP Apps */});
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
  for(var i=0;i<segs.length;i++){if(v==null)return undefined;v=v[segs[i]];}
  return v;
}
function _esc(v){
  if(v===null||v===undefined)return null;
  return String(v).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}
function _empty(v){ return v===null||v===undefined||v===""; }
function _critClass(n){
  if(n===null||n===undefined)return "";
  var i=typeof n==="number"?n:parseInt(n,10);
  if(i===1)return "crit-1";if(i===2)return "crit-2";if(i===3)return "crit-3";
  if(i===5)return "crit-5";return "crit-0";
}
function _critRowStyle(n){
  if(n===null||n===undefined)return "";
  var i=typeof n==="number"?n:parseInt(n,10);
  if(i===1)return "background:#fff5f5";
  if(i===2)return "background:#fff9f0";
  if(i===3)return "background:#f5fff5";
  return "";
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
function buildQueryTemplate(entityName, uiMeta) {
    const title = uiMeta.headerInfo?.typeNamePlural ?? uiMeta.headerInfo?.typeName ?? entityName;

    // Sort columns: High importance first, then Medium, then Low/null
    const columns = sortByImportance(uiMeta.lineItems);

    // Build column spec passed to template JS
    const colSpec = columns.map((c) => ({
        path: c.path,
        label: c.label ?? (c.path ? labelFromPath(c.path) : c.annotationTarget ?? "?"),
        critPath: c.criticalityPath,
        withIcon: c.criticalityRepresentation !== "WithoutIcon",
        type: c.dataFieldType,
        url: c.url,
        action: c.action,
    }));

    // Row criticality: we need the path or a simple expression
    const rowCritPath = uiMeta.lineItemCriticality;

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escHtml(title)}</title>
${SHARED_STYLES}
<style>
  .hdr { margin-bottom: 10px; }
  .hdr-title { font-size: 16px; font-weight: 700; color: var(--sapTitleColor); }
  .row-info { font-size: 11px; color: var(--sapContent_ForegroundColor); margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; background: var(--sapBaseColor); border-radius: var(--sapBorderRadius); overflow: hidden; box-shadow: var(--sapShadow); }
  th { background: #f0f2f4; font-weight: 600; font-size: 11px; text-align: left; padding: 8px 10px; border-bottom: 2px solid var(--sapBorderColor); color: var(--sapTitleColor); white-space: nowrap; text-transform: uppercase; letter-spacing: .3px; }
  td { padding: 8px 10px; border-bottom: 1px solid #eef0f2; font-size: var(--sapFontSmallSize); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: #f7f9fb !important; }
  .null-val { color: var(--sapContent_ForegroundColor); }
  .url-link { color: var(--sapHighlightColor); text-decoration: none; }
  .url-link:hover { text-decoration: underline; }
  .act-hint { font-size: 11px; color: var(--sapContent_ForegroundColor); font-style: italic; }
  .icon-pos::before { content:"✓ "; } .icon-neg::before { content:"✗ "; } .icon-warn::before { content:"⚠ "; }
</style>
</head>
<body>
<div class="hdr"><div class="hdr-title">${escHtml(title)}</div></div>
<div id="row-info" class="row-info"></div>
<div id="content"><div class="loading">Waiting for data…</div></div>
${mcpAppsBootstrap("render")}
<script>
${SHARED_JS}
var COLS=${JSON.stringify(colSpec)};
var ROW_CRIT_PATH=${JSON.stringify(rowCritPath ?? null)};

function render(data){
  var el=document.getElementById("content");
  var info=document.getElementById("row-info");
  if(!data){el.innerHTML='<div class="error-msg">No data received</div>';return}
  var rows=Array.isArray(data)?data:[data];
  info.textContent=rows.length+" row"+(rows.length!==1?"s":"");
  if(!rows.length){el.innerHTML='<div class="loading">No results</div>';return}

  var h='<table><thead><tr>';
  COLS.forEach(function(c){h+='<th>'+(_esc(c.label)||'')+'</th>';});
  h+='</tr></thead><tbody>';

  rows.forEach(function(row){
    var rs="";
    if(ROW_CRIT_PATH){var rv=_getv(row,ROW_CRIT_PATH);if(rv!==undefined&&rv!==null)rs=_critRowStyle(rv);}
    h+='<tr'+(rs?' style="'+rs+'"':'')+'>';
    COLS.forEach(function(c){
      h+='<td>';
      if(c.type==="DataFieldForAction"||c.type==="DataFieldForActionGroup"){
        h+='<span class="act-hint">['+_esc(c.label)+']</span>';
      } else if(c.type==="DataFieldForAnnotation"){
        h+='<span class="act-hint">'+_esc(c.label)+'</span>';
      } else if(c.path){
        var v=_getv(row,c.path);
        var ve=_esc(v);
        if(c.critPath){
          var cv=_getv(row,c.critPath);
          var cc=_critClass(cv);
          var icon=c.withIcon&&cc?(' icon-'+({1:'neg',2:'warn',3:'pos',5:'info',0:''}[typeof cv==='number'?cv:parseInt(cv,10)]||'')):'';
          if(cc)h+='<span class="badge '+cc+icon+'">'+(ve!==null?ve:'—')+'</span>';
          else h+=ve!==null?ve:'<span class="null-val">—</span>';
        } else if(c.type==="DataFieldWithUrl"&&c.url){
          var urlVal=_getv(row,c.url)||"#";
          h+=ve!==null?'<a class="url-link" href="'+_esc(urlVal)+'" target="_blank">'+ve+'</a>':'<span class="null-val">—</span>';
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
  h+='</tbody></table>';
  el.innerHTML=h;
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
function buildDetailTemplate(entityName, uiMeta) {
    const title = uiMeta.headerInfo?.typeName ?? entityName;

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
  .obj-hdr { display: flex; align-items: flex-start; gap: 12px; margin-bottom: 14px; }
  .obj-avatar { width: 48px; height: 48px; border-radius: 8px; object-fit: cover; background: #e0e7ef; flex-shrink: 0; }
  .obj-titles .title { font-size: 18px; font-weight: 700; color: var(--sapTitleColor); }
  .obj-titles .subtitle { font-size: 13px; color: var(--sapSubtitleColor); margin-top: 2px; }
  /* DataPoint status strip */
  .dp-strip { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 14px; }
  .dp-card { background: var(--sapBaseColor); border: 1px solid var(--sapBorderColor); border-radius: var(--sapBorderRadius); padding: 8px 14px; min-width: 120px; box-shadow: var(--sapShadow); }
  .dp-label { font-size: 11px; color: var(--sapContent_ForegroundColor); text-transform: uppercase; letter-spacing: .3px; margin-bottom: 3px; }
  .dp-value { font-size: 15px; font-weight: 600; }
  /* Sections */
  .section { background: var(--sapBaseColor); border: 1px solid var(--sapBorderColor); border-radius: var(--sapBorderRadius); margin-bottom: 12px; overflow: hidden; box-shadow: var(--sapShadow); }
  .section-hdr { background: #f0f2f4; padding: 8px 14px; font-weight: 600; font-size: var(--sapFontSmallSize); color: var(--sapTitleColor); border-bottom: 1px solid var(--sapBorderColor); }
  .fields { display: grid; grid-template-columns: repeat(auto-fill,minmax(200px,1fr)); }
  .field { padding: 10px 14px; border-bottom: 1px solid #f0f2f4; }
  .field:last-child { border-bottom: none; }
  .f-label { font-size: 11px; color: var(--sapContent_ForegroundColor); margin-bottom: 2px; text-transform: uppercase; letter-spacing: .4px; }
  .f-value { font-size: var(--sapFontSmallSize); word-break: break-word; }
  .f-empty { color: var(--sapContent_ForegroundColor); }
  .f-multi { font-family: monospace; font-size: 11px; white-space: pre-wrap; max-height: 120px; overflow-y: auto; }
  .f-link { color: var(--sapHighlightColor); text-decoration: none; } .f-link:hover { text-decoration: underline; }
  /* Actions */
  .actions { margin-top: 14px; border-top: 1px solid var(--sapBorderColor); padding-top: 10px; }
  .actions-title { font-size: 11px; color: var(--sapContent_ForegroundColor); text-transform: uppercase; letter-spacing: .3px; margin-bottom: 6px; }
  .act-list { display: flex; flex-wrap: wrap; gap: 6px; }
  .act-chip { background: #e8f0fe; color: var(--sapHighlightColor); padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
</style>
</head>
<body>
<div id="obj-hdr" class="obj-hdr" style="display:none">
  <img id="obj-img" class="obj-avatar" style="display:none" alt="">
  <div class="obj-titles">
    <div class="title" id="obj-title">${escHtml(title)}</div>
    <div class="subtitle" id="obj-subtitle"></div>
  </div>
</div>
<div id="dp-strip" class="dp-strip" style="display:none"></div>
<div id="content"><div class="loading">Waiting for data…</div></div>
${actions.length ? `<div class="actions"><div class="actions-title">Available Actions</div><div class="act-list">${actions.map((a) => `<span class="act-chip">${escHtml(a)}</span>`).join("")}</div></div>` : ""}
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

function render(data){
  var el=document.getElementById("content");
  if(!data){el.innerHTML='<div class="error-msg">No data received</div>';return}
  var row=Array.isArray(data)?data[0]:data;
  if(!row){el.innerHTML='<div class="loading">No result</div>';return}

  // Update header
  var hdr=document.getElementById("obj-hdr");
  hdr.style.display="flex";
  if(TITLE_PATH){var tv=_getv(row,TITLE_PATH);if(tv!=null)document.getElementById("obj-title").textContent=String(tv);}
  if(DESC_PATH){var dv=_getv(row,DESC_PATH);if(dv!=null)document.getElementById("obj-subtitle").textContent=String(dv);}
  if(IMG_PATH){var iv=_getv(row,IMG_PATH);if(iv){var img=document.getElementById("obj-img");img.src=String(iv);img.style.display="block";}}

  // DataPoint strip
  if(DP_SPEC.length){
    var strip=document.getElementById("dp-strip");
    var dh="";
    DP_SPEC.forEach(function(dp){
      var v=dp.valuePath?_getv(row,dp.valuePath):null;
      var cv=dp.criticalityPath?_getv(row,dp.criticalityPath):null;
      var cc=_critClass(cv);
      dh+='<div class="dp-card"><div class="dp-label">'+(_esc(dp.title)||'')+'</div>';
      dh+='<div class="dp-value'+(cc?' '+cc:'')+'">'+(v!=null?_esc(v):'—')+'</div></div>';
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
    var v=_getv(row,f.path);
    // Try @Common.Text label field first
    var ct=COMMON_TEXT[f.path];
    if(ct&&ct.textPath){var tv2=_getv(row,ct.textPath);if(tv2!=null)v=tv2;}
    var isMulti=MULTI_FIELDS.indexOf(f.path)>=0;
    var ve=_esc(v);
    var valHtml;
    if(ve===null){
      valHtml='<span class="f-empty">—</span>';
    } else if(isMulti){
      valHtml='<pre class="f-multi">'+ve+'</pre>';
    } else if(f.critPath){
      var cv=_getv(row,f.critPath);
      var cc=_critClass(cv);
      valHtml=cc?'<span class="badge '+cc+'">'+ve+'</span>':ve;
    } else if(f.url){
      var urlV=_getv(row,f.url)||"#";
      valHtml='<a class="f-link" href="'+_esc(urlV)+'" target="_blank">'+ve+'</a>';
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
