// THROWAWAY — Delta Engine PoC (docs/alpha_engine_poc_v1.pdf) — self-contained HTML visualisation.
//
// Renders a full simulation run (the §18 series + params + derived stats) into ONE self-contained
// HTML document: the data is inlined as JSON, charts are drawn with vanilla <canvas> (no libraries,
// no build, no network), so the file opens straight from disk (file://). Dark ROSE-style theme.
//
// REGIME: lives under /throwaway, Node stdlib only. /prod must NEVER import this; this is a
// disposable visualisation for the R&D PoC, NOT a /prod web surface (the regime boundary forbids
// /prod — including the web app — from importing /throwaway).
import type { SimResult } from './simulation.js';

/** Builds a complete, self-contained HTML document visualising the run. */
export function toHtml(result: SimResult): string {
  const dataJson = JSON.stringify({
    params: result.params,
    finalTick: result.finalTick,
    reason: result.reason,
    series: result.series,
  });

  // NOTE: the client script below uses NO template literals and NO `${...}` so it can live inside
  // this TS template literal untouched. The only interpolation is the inlined DATA payload.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Delta Engine PoC — Run Visualisation</title>
<style>
  :root {
    --bg:#0e1218; --panel:#161c26; --panel2:#1b2330; --grid:#232c3a; --line:#2c3645;
    --text:#c7d0db; --dim:#7e8a99; --accent:#7aa2ff;
    --price:#7aa2ff; --capital:#ffd166; --aliveL:#4ade80; --aliveS:#f472b6;
    --queueL:#38bdf8; --queueS:#fb923c; --matched:#a78bfa;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  header { padding:24px 28px 8px; }
  h1 { margin:0 0 4px; font-size:22px; letter-spacing:.2px; }
  .sub { color:var(--dim); font-size:13px; }
  .wrap { padding:8px 28px 40px; }
  .grid { display:grid; gap:16px; }
  @media (min-width:1100px){ .charts { grid-template-columns:1fr 1fr; } .charts .full{ grid-column:1/-1; } }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card h2 { margin:0 0 2px; font-size:14px; font-weight:600; }
  .card .hint { color:var(--dim); font-size:12px; margin:0 0 10px; }
  .legend { display:flex; flex-wrap:wrap; gap:14px; font-size:12px; color:var(--dim); margin:0 0 8px; }
  .legend span { display:inline-flex; align-items:center; gap:6px; }
  .swatch { width:11px; height:3px; border-radius:2px; display:inline-block; }
  .canvas-box { position:relative; }
  canvas { width:100%; height:260px; display:block; }
  .stats { grid-template-columns:repeat(2,1fr); }
  @media (min-width:680px){ .stats { grid-template-columns:repeat(4,1fr); } }
  @media (min-width:1100px){ .stats { grid-template-columns:repeat(6,1fr); } }
  .stat { background:var(--panel2); border:1px solid var(--line); border-radius:10px; padding:10px 12px; }
  .stat .k { color:var(--dim); font-size:11px; text-transform:uppercase; letter-spacing:.4px; }
  .stat .v { font-size:18px; font-weight:600; margin-top:2px; font-variant-numeric:tabular-nums; }
  .params { display:flex; flex-wrap:wrap; gap:8px 18px; color:var(--dim); font-size:12px;
    font-variant-numeric:tabular-nums; }
  .params b { color:var(--text); font-weight:600; }
  .pill { display:inline-block; padding:2px 9px; border-radius:999px; font-size:11px; font-weight:600;
    background:#22304a; color:#9fc0ff; border:1px solid #2c3f63; }
  .tip { position:absolute; pointer-events:none; background:#0b0f15ee; border:1px solid var(--line);
    border-radius:8px; padding:7px 9px; font-size:12px; color:var(--text); white-space:nowrap;
    transform:translate(-50%,-115%); opacity:0; transition:opacity .08s; font-variant-numeric:tabular-nums; }
  .tip .t { color:var(--dim); margin-bottom:3px; }
  .tip .row { display:flex; align-items:center; gap:6px; }
  footer { padding:0 28px 30px; color:var(--dim); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>Delta Engine PoC <span class="pill">THROWAWAY · R&amp;D</span></h1>
  <div class="sub">Closed agent-based market — endogenous price via Dutch auction. Internal market only · disjoint from ROSE P0.</div>
</header>
<div class="wrap grid">
  <div class="card">
    <h2>Run parameters</h2>
    <div id="params" class="params"></div>
  </div>
  <div class="grid stats" id="stats"></div>
  <div class="grid charts">
    <div class="card full">
      <h2>Endogenous price <code>p_int(t)</code></h2>
      <p class="hint">Two-sided Dutch-auction clearing price. Free to rise and fall (no ratchet).</p>
      <div class="canvas-box"><canvas id="c_price"></canvas><div class="tip" id="t_price"></div></div>
    </div>
    <div class="card">
      <h2>Pool capital <code>total_capital(t)</code></h2>
      <p class="hint">Σ K_i over alive agents (EUR). Drained monotonically by carry to "the house".</p>
      <div class="canvas-box"><canvas id="c_cap"></canvas><div class="tip" id="t_cap"></div></div>
    </div>
    <div class="card">
      <h2>Surviving agents</h2>
      <p class="hint">Long vs short populations over time (mortality).</p>
      <div class="legend"><span><i class="swatch" style="background:var(--aliveL)"></i>long</span><span><i class="swatch" style="background:var(--aliveS)"></i>short</span></div>
      <div class="canvas-box"><canvas id="c_alive"></canvas><div class="tip" id="t_alive"></div></div>
    </div>
    <div class="card">
      <h2>Queue depth</h2>
      <p class="hint">Unmatched orders remaining (long vs short) — imbalance &amp; liquidity.</p>
      <div class="legend"><span><i class="swatch" style="background:var(--queueL)"></i>long</span><span><i class="swatch" style="background:var(--queueS)"></i>short</span></div>
      <div class="canvas-box"><canvas id="c_queue"></canvas><div class="tip" id="t_queue"></div></div>
    </div>
    <div class="card">
      <h2>Matched volume <code>matched_volume(t)</code></h2>
      <p class="hint">EUR cleared each tick by the auction.</p>
      <div class="canvas-box"><canvas id="c_matched"></canvas><div class="tip" id="t_matched"></div></div>
    </div>
    <div class="card full">
      <h2>Price distribution</h2>
      <p class="hint">Histogram of p_int over the run — shape of the emergent price.</p>
      <div class="canvas-box"><canvas id="c_hist"></canvas><div class="tip" id="t_hist"></div></div>
    </div>
  </div>
</div>
<footer>Generated by <code>@throwaway/delta-engine</code> — open from disk, no server required.</footer>
<script>const DATA = ${dataJson};</script>
<script>
(function(){
  "use strict";
  var S = DATA.series, P = DATA.params, N = S.length;
  var css = getComputedStyle(document.documentElement);
  var COL = function(name){ return css.getPropertyValue(name).trim() || name; };

  function fmtInt(x){ return Math.round(x).toLocaleString("en-US"); }
  function fmtCap(x){ return Math.round(x).toLocaleString("en-US"); }
  function fmtPrice(x){ return Number(x).toFixed(4); }
  function fmtPct(x){ return (x*100).toFixed(1) + "%"; }

  // ---- derived stats ----
  var prices = S.map(function(r){ return r.pInt; });
  var minP = Math.min.apply(null, prices), maxP = Math.max.apply(null, prices);
  var distinct = (function(){ var s={}; prices.forEach(function(p){ s[p.toFixed(6)]=1; }); return Object.keys(s).length; })();
  var rises=0, falls=0, matchedTotal=0, tradeTicks=0, peakQ=0;
  for (var i=0;i<N;i++){
    if (i>0){ if (S[i].pInt > S[i-1].pInt+1e-12) rises++; else if (S[i].pInt < S[i-1].pInt-1e-12) falls++; }
    matchedTotal += S[i].matchedVolume;
    if (S[i].matchedVolume > 1e-9) tradeTicks++;
    var q = S[i].queueDepthLong + S[i].queueDepthShort; if (q>peakQ) peakQ=q;
  }
  var aliveStart = (S[0]?S[0].aliveLong+S[0].aliveShort:0);
  var last = S[N-1] || {aliveLong:0,aliveShort:0,totalCapital:0,pInt:0};
  var aliveEnd = last.aliveLong + last.aliveShort;
  var capStart = S[0] ? S[0].totalCapital : 0;
  var drained = capStart>0 ? (capStart - last.totalCapital)/capStart : 0;

  // ---- params panel ----
  var pr = [["n",P.n],["K",fmtCap(P.K)],["x0",P.x0],["alpha",P.alpha],["xMin",fmtCap(P.xMin)],
    ["f",P.f],["c",P.c],["dBase",P.dBase],["q",P.q],["W",P.W],["epsilon",P.epsilon],["T",fmtInt(P.T)]];
  document.getElementById("params").innerHTML = pr.map(function(kv){
    return "<span>" + kv[0] + " <b>" + kv[1] + "</b></span>"; }).join("");

  // ---- stats grid ----
  var stats = [
    ["Ticks run", fmtInt(DATA.finalTick) + " / " + fmtInt(P.T)],
    ["Stop reason", DATA.reason],
    ["Distinct prices", fmtInt(distinct)],
    ["Price range", fmtPrice(minP) + " – " + fmtPrice(maxP)],
    ["Final price", fmtPrice(last.pInt)],
    ["Price ↑ / ↓ ticks", fmtInt(rises) + " / " + fmtInt(falls)],
    ["Agents alive", fmtInt(aliveEnd) + " / " + fmtInt(aliveStart)],
    ["Bankruptcies", fmtInt(aliveStart - aliveEnd)],
    ["Pool drained", fmtPct(drained)],
    ["Final pool (EUR)", fmtCap(last.totalCapital)],
    ["Trading ticks", fmtInt(tradeTicks)],
    ["Total matched (EUR)", fmtCap(matchedTotal)]
  ];
  document.getElementById("stats").innerHTML = stats.map(function(s){
    return "<div class='stat'><div class='k'>" + s[0] + "</div><div class='v'>" + s[1] + "</div></div>"; }).join("");

  // ---- canvas helpers ----
  function setup(cv){
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = cv.clientHeight;
    cv.width = Math.round(w*dpr); cv.height = Math.round(h*dpr);
    var ctx = cv.getContext("2d"); ctx.setTransform(dpr,0,0,dpr,0,0);
    return {ctx:ctx, w:w, h:h};
  }
  function niceTicks(min,max,count){
    if (min===max){ return [min]; }
    var span=max-min, step=Math.pow(10,Math.floor(Math.log(span/count)/Math.LN10));
    var err=(span/count)/step;
    if (err>=7.5) step*=10; else if (err>=3.5) step*=5; else if (err>=1.5) step*=2;
    var out=[], t=Math.ceil(min/step)*step;
    for (; t<=max+1e-9; t+=step) out.push(t);
    return out;
  }

  var PADL=58, PADR=12, PADT=12, PADB=24;

  // generic time-series line chart over ticks; lines:[{get,color}], fmtY
  function lineChart(cv, lines, fmtY){
    var s = setup(cv), ctx=s.ctx, w=s.w, h=s.h;
    var x0=PADL, x1=w-PADR, y0=PADT, y1=h-PADB;
    var ymin=Infinity, ymax=-Infinity;
    for (var li=0; li<lines.length; li++) for (var i=0;i<N;i++){ var v=lines[li].get(S[i]); if(v<ymin)ymin=v; if(v>ymax)ymax=v; }
    if (ymin===ymax){ ymin-=1; ymax+=1; } else { var pad=(ymax-ymin)*0.06; ymin-=pad; ymax+=pad; }
    var sx=function(i){ return x0 + (N<=1?0:(i/(N-1))*(x1-x0)); };
    var sy=function(v){ return y1 - ((v-ymin)/(ymax-ymin))*(y1-y0); };
    // y gridlines + labels
    ctx.font="11px ui-sans-serif,sans-serif"; ctx.textBaseline="middle";
    var yt=niceTicks(ymin,ymax,5);
    for (var k=0;k<yt.length;k++){ var yy=sy(yt[k]);
      ctx.strokeStyle=COL("--grid"); ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x0,yy); ctx.lineTo(x1,yy); ctx.stroke();
      ctx.fillStyle=COL("--dim"); ctx.textAlign="right"; ctx.fillText(fmtY(yt[k]), x0-8, yy);
    }
    // x labels
    ctx.textAlign="center"; ctx.textBaseline="top";
    for (var f=0; f<=4; f++){ var ix=Math.round((f/4)*(N-1)); var xx=sx(ix);
      ctx.fillStyle=COL("--dim"); ctx.fillText(fmtInt(S[ix]?S[ix].t:0), xx, y1+6); }
    // lines
    for (var li2=0; li2<lines.length; li2++){
      ctx.strokeStyle=lines[li2].color; ctx.lineWidth=1.5; ctx.beginPath();
      for (var j=0;j<N;j++){ var px=sx(j), py=sy(lines[li2].get(S[j])); if(j===0)ctx.moveTo(px,py); else ctx.lineTo(px,py); }
      ctx.stroke();
    }
    return {x0:x0,x1:x1,sx:sx,sy:sy};
  }

  function areaChart(cv, get, color, fmtY){
    var geo = lineChart(cv, [{get:get,color:color}], fmtY);
    return geo;
  }

  function histChart(cv, values, color){
    var s=setup(cv), ctx=s.ctx, w=s.w, h=s.h;
    var x0=PADL, x1=w-PADR, y0=PADT, y1=h-PADB;
    var mn=Math.min.apply(null,values), mx=Math.max.apply(null,values);
    if (mn===mx){ mx=mn+1; }
    var bins=Math.min(40, Math.max(8, Math.round(Math.sqrt(values.length))));
    var counts=new Array(bins).fill(0);
    for (var i=0;i<values.length;i++){ var b=Math.min(bins-1, Math.floor((values[i]-mn)/(mx-mn)*bins)); counts[b]++; }
    var cmax=Math.max.apply(null,counts);
    ctx.font="11px ui-sans-serif,sans-serif"; ctx.textBaseline="middle"; ctx.textAlign="right";
    var yt=niceTicks(0,cmax,4);
    for (var k=0;k<yt.length;k++){ var yy=y1-(yt[k]/cmax)*(y1-y0);
      ctx.strokeStyle=COL("--grid"); ctx.beginPath(); ctx.moveTo(x0,yy); ctx.lineTo(x1,yy); ctx.stroke();
      ctx.fillStyle=COL("--dim"); ctx.fillText(fmtInt(yt[k]), x0-8, yy); }
    var bw=(x1-x0)/bins;
    ctx.fillStyle=color;
    for (var bi=0; bi<bins; bi++){ var bh=(counts[bi]/cmax)*(y1-y0); ctx.fillRect(x0+bi*bw+1, y1-bh, bw-2, bh); }
    ctx.textAlign="center"; ctx.textBaseline="top"; ctx.fillStyle=COL("--dim");
    for (var f=0; f<=4; f++){ var v=mn+(f/4)*(mx-mn); ctx.fillText(fmtPrice(v), x0+(f/4)*(x1-x0), y1+6); }
  }

  // ---- hover wiring for time-series charts ----
  function attachTip(cv, tipEl, geo, rows){
    cv.onmousemove=function(ev){
      var rect=cv.getBoundingClientRect(); var mx=ev.clientX-rect.left;
      var frac=(mx-geo.x0)/(geo.x1-geo.x0); if(frac<0)frac=0; if(frac>1)frac=1;
      var idx=Math.round(frac*(N-1)); var r=S[idx];
      var html="<div class='t'>tick "+fmtInt(r.t)+"</div>";
      for (var i=0;i<rows.length;i++){ html+="<div class='row'><i class='swatch' style='background:"+rows[i].color+"'></i>"+rows[i].label+": <b>"+rows[i].fmt(r)+"</b></div>"; }
      tipEl.innerHTML=html; tipEl.style.left=geo.sx(idx)+"px"; tipEl.style.top=(PADT+6)+"px"; tipEl.style.opacity="1";
    };
    cv.onmouseleave=function(){ tipEl.style.opacity="0"; };
  }

  function renderAll(){
    var g;
    g = lineChart(document.getElementById("c_price"), [{get:function(r){return r.pInt;},color:COL("--price")}], fmtPrice);
    attachTip(document.getElementById("c_price"), document.getElementById("t_price"), g, [{label:"p_int",color:COL("--price"),fmt:function(r){return fmtPrice(r.pInt);}}]);

    g = areaChart(document.getElementById("c_cap"), function(r){return r.totalCapital;}, COL("--capital"), fmtCap);
    attachTip(document.getElementById("c_cap"), document.getElementById("t_cap"), g, [{label:"pool",color:COL("--capital"),fmt:function(r){return fmtCap(r.totalCapital);}}]);

    g = lineChart(document.getElementById("c_alive"), [
      {get:function(r){return r.aliveLong;},color:COL("--aliveL")},
      {get:function(r){return r.aliveShort;},color:COL("--aliveS")}], fmtInt);
    attachTip(document.getElementById("c_alive"), document.getElementById("t_alive"), g, [
      {label:"long",color:COL("--aliveL"),fmt:function(r){return fmtInt(r.aliveLong);}},
      {label:"short",color:COL("--aliveS"),fmt:function(r){return fmtInt(r.aliveShort);}}]);

    g = lineChart(document.getElementById("c_queue"), [
      {get:function(r){return r.queueDepthLong;},color:COL("--queueL")},
      {get:function(r){return r.queueDepthShort;},color:COL("--queueS")}], fmtInt);
    attachTip(document.getElementById("c_queue"), document.getElementById("t_queue"), g, [
      {label:"long",color:COL("--queueL"),fmt:function(r){return fmtInt(r.queueDepthLong);}},
      {label:"short",color:COL("--queueS"),fmt:function(r){return fmtInt(r.queueDepthShort);}}]);

    g = areaChart(document.getElementById("c_matched"), function(r){return r.matchedVolume;}, COL("--matched"), fmtCap);
    attachTip(document.getElementById("c_matched"), document.getElementById("t_matched"), g, [{label:"matched",color:COL("--matched"),fmt:function(r){return fmtCap(r.matchedVolume);}}]);

    histChart(document.getElementById("c_hist"), prices, COL("--price"));
  }

  renderAll();
  var rt; window.addEventListener("resize", function(){ clearTimeout(rt); rt=setTimeout(renderAll,120); });
})();
</script>
</body>
</html>
`;
}
