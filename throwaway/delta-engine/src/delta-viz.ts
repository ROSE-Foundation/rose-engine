// THROWAWAY — self-contained HTML visualisation of a DELTA ENGINE run (paper §5).
//
// Renders one run into ONE self-contained HTML document (data inlined as JSON, charts drawn with
// vanilla <canvas>, no libraries / no network) so it opens straight from disk (file://). It shows:
//   • the price series with the fitted SUPPORT / RESISTANCE lines of a representative scale and the
//     directional-change (intrinsic-time) event markers, plus the executed contrarian trades;
//   • the ±u NET-EXPOSURE oscillation over time (the signature of the Delta Engine);
//   • the number of SILENCED agents per tick (the §5.5 volatility-feedback loop).
// The price source is the package's own emergent-price market (p_int) — so the market that GENERATES
// the price and the strategy that TRADES it are shown together.
//
// REGIME: lives under /throwaway, Node stdlib only. /prod must NEVER import this; the web app embeds
// only the PRE-GENERATED static asset.
import type { DeltaResult } from './delta-engine.js';

/** Builds a complete, self-contained HTML document visualising a Delta Engine run. */
export function toDeltaHtml(result: DeltaResult): string {
  const n = result.config.thresholds.length;
  // Representative scale for the support/resistance + DC overlay: a mid threshold (cleaner lines).
  const repr = Math.min(n - 1, Math.floor(n / 2));
  const reprDelta = result.config.thresholds[repr] ?? 0;

  const price = result.series.map((r) => r.price);
  const res = result.series.map((r) => r.scales[repr]?.resistance ?? null);
  const sup = result.series.map((r) => r.scales[repr]?.support ?? null);
  const exposure = result.series.map((r) => r.netExposure);
  const silenced = result.series.map((r) => r.silencedScales);
  const trades = result.trades.map((t) => ({
    i: t.index,
    p: t.price,
    side: t.side,
    size: t.size,
    reason: t.reason,
  }));
  const dc = result.dcEvents
    .filter((e) => e.scaleIndex === repr)
    .map((e) => ({ i: e.extremeIndex, p: e.extremePrice, d: e.direction }));

  const dataJson = JSON.stringify({
    config: result.config,
    summary: result.summary,
    reprDelta,
    price,
    res,
    sup,
    exposure,
    silenced,
    trades,
    dc,
  });

  // The client script below uses NO template literals / `${...}` so it can live inside this TS
  // template literal untouched. The only interpolation is the inlined DATA payload.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Delta Engine — Run Visualisation</title>
<style>
  :root {
    --bg:#0e1218; --panel:#161c26; --panel2:#1b2330; --grid:#232c3a; --line:#2c3645;
    --text:#c7d0db; --dim:#7e8a99; --accent:#7aa2ff;
    --price:#7aa2ff; --res:#f472b6; --sup:#4ade80; --long:#4ade80; --short:#f472b6;
    --dcUp:#4ade80; --dcDown:#f472b6; --silence:#fb923c; --exposure:#ffd166;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text);
    font:14px/1.5 ui-sans-serif,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif; }
  header { padding:24px 28px 8px; }
  h1 { margin:0 0 4px; font-size:22px; letter-spacing:.2px; }
  .sub { color:var(--dim); font-size:13px; max-width:78ch; }
  .wrap { padding:8px 28px 40px; }
  .grid { display:grid; gap:16px; }
  @media (min-width:1100px){ .charts { grid-template-columns:1fr 1fr; } .charts .full{ grid-column:1/-1; } }
  .card { background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card h2 { margin:0 0 2px; font-size:14px; font-weight:600; }
  .card .hint { color:var(--dim); font-size:12px; margin:0 0 10px; }
  .legend { display:flex; flex-wrap:wrap; gap:14px; font-size:12px; color:var(--dim); margin:0 0 8px; }
  .legend span { display:inline-flex; align-items:center; gap:6px; }
  .swatch { width:11px; height:3px; border-radius:2px; display:inline-block; }
  .dot { width:9px; height:9px; border-radius:50%; display:inline-block; }
  .canvas-box { position:relative; }
  canvas { width:100%; height:300px; display:block; }
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
  <h1>Delta Engine <span class="pill">THROWAWAY · R&amp;D</span></h1>
  <div class="sub">A contrarian, multi-scale directional-change (intrinsic-time) trading model
  (Glattfelder/Houweling/Olsen 2025, §5). It fades breakouts of fitted support/resistance lines; the
  net exposure oscillates between +u and −u and is decoupled from PnL (no take-profit / stop-loss).
  Price source: the package's own emergent-price market (p_int).</div>
</header>
<div class="wrap grid">
  <div class="card">
    <h2>Run configuration</h2>
    <div id="params" class="params"></div>
  </div>
  <div class="grid stats" id="stats"></div>
  <div class="grid charts">
    <div class="card full">
      <h2>Price, decision landscape &amp; trades</h2>
      <p class="hint">Price <code>p_int(t)</code> with the fitted support/resistance of the
      representative scale, directional-change events, and executed contrarian trades.</p>
      <div class="legend">
        <span><i class="swatch" style="background:var(--price)"></i>price</span>
        <span><i class="swatch" style="background:var(--res)"></i>resistance</span>
        <span><i class="swatch" style="background:var(--sup)"></i>support</span>
        <span><i class="dot" style="background:var(--dcUp)"></i>DC up (trough)</span>
        <span><i class="dot" style="background:var(--dcDown)"></i>DC down (peak)</span>
        <span><i class="dot" style="background:#fff"></i>trade</span>
      </div>
      <div class="canvas-box"><canvas id="c_price"></canvas><div class="tip" id="t_price"></div></div>
    </div>
    <div class="card full">
      <h2>Net exposure — the ±u oscillation</h2>
      <p class="hint">The signature of the Delta Engine: exposure flips between +u and −u, only on a
      contrarian reversal breakout (a 2u offsetting trade). Never exceeds |u|.</p>
      <div class="canvas-box"><canvas id="c_exp"></canvas><div class="tip" id="t_exp"></div></div>
    </div>
    <div class="card full">
      <h2>Silenced agents (volatility feedback, §5.5)</h2>
      <p class="hint">Agents whose DC-count is out of sync with the cross-scale scaling law are
      temporarily silenced — the volatility regime fine-tunes which scales act.</p>
      <div class="canvas-box"><canvas id="c_sil"></canvas><div class="tip" id="t_sil"></div></div>
    </div>
  </div>
</div>
<footer>Generated by <code>@throwaway/delta-engine</code> — open from disk, no server required.</footer>
<script>const DATA = ${dataJson};</script>
<script>
(function(){
  "use strict";
  var P = DATA.price, R = DATA.res, SU = DATA.sup, EXP = DATA.exposure, SIL = DATA.silenced;
  var TR = DATA.trades, DC = DATA.dc, CFG = DATA.config, SUM = DATA.summary, N = P.length;
  var css = getComputedStyle(document.documentElement);
  var COL = function(name){ return css.getPropertyValue(name).trim() || name; };

  function fmtInt(x){ return Math.round(x).toLocaleString("en-US"); }
  function fmtPrice(x){ return Number(x).toFixed(4); }

  // ---- params panel ----
  var pr = [["scales δ", CFG.thresholds.join(", ")],["look-backs", CFG.lookbacks.join(", ")],
    ["u", CFG.u],["vol window", CFG.volWindow],["silence tol", CFG.silenceTolerance],
    ["repr δ", DATA.reprDelta],["price source", CFG.priceSource]];
  document.getElementById("params").innerHTML = pr.map(function(kv){
    return "<span>" + kv[0] + " <b>" + kv[1] + "</b></span>"; }).join("");

  // ---- stats grid ----
  var stats = [
    ["Ticks", fmtInt(SUM.ticks)],
    ["DC events", fmtInt(SUM.dcEvents)],
    ["Trades", fmtInt(SUM.trades)],
    ["Reversals (2u)", fmtInt(SUM.reversals)],
    ["Final net exposure", (SUM.finalNetExposure>0?"+":"") + SUM.finalNetExposure],
    ["Max |exposure|", SUM.maxAbsExposure],
    ["Silenced ticks", fmtInt(SUM.silencedTickCount)],
    ["Mark-to-market PnL", SUM.markToMarketPnl.toFixed(4)]
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

  function axes(ctx,w,h,ymin,ymax,fmtY){
    var x0=PADL, x1=w-PADR, y0=PADT, y1=h-PADB;
    ctx.font="11px ui-sans-serif,sans-serif"; ctx.textBaseline="middle";
    var sy=function(v){ return y1 - ((v-ymin)/(ymax-ymin))*(y1-y0); };
    var sx=function(i){ return x0 + (N<=1?0:(i/(N-1))*(x1-x0)); };
    var yt=niceTicks(ymin,ymax,5);
    for (var k=0;k<yt.length;k++){ var yy=sy(yt[k]);
      ctx.strokeStyle=COL("--grid"); ctx.lineWidth=1; ctx.beginPath(); ctx.moveTo(x0,yy); ctx.lineTo(x1,yy); ctx.stroke();
      ctx.fillStyle=COL("--dim"); ctx.textAlign="right"; ctx.fillText(fmtY(yt[k]), x0-8, yy);
    }
    ctx.textAlign="center"; ctx.textBaseline="top";
    for (var f=0; f<=4; f++){ var ix=Math.round((f/4)*(N-1)); var xx=sx(ix);
      ctx.fillStyle=COL("--dim"); ctx.fillText(fmtInt(ix), xx, y1+6); }
    return {x0:x0,x1:x1,y0:y0,y1:y1,sx:sx,sy:sy};
  }

  function drawSeriesLine(ctx, arr, geo, color){
    ctx.strokeStyle=color; ctx.lineWidth=1.5; ctx.beginPath(); var started=false;
    for (var j=0;j<N;j++){ var v=arr[j]; if(v===null||v===undefined){ started=false; continue; }
      var px=geo.sx(j), py=geo.sy(v); if(!started){ctx.moveTo(px,py);started=true;} else ctx.lineTo(px,py); }
    ctx.stroke();
  }

  // ---- price chart with support/resistance + DC dots + trade markers ----
  function priceChart(){
    var cv=document.getElementById("c_price"), s=setup(cv), ctx=s.ctx, w=s.w, h=s.h;
    var ymin=Infinity, ymax=-Infinity;
    for (var i=0;i<N;i++){ var v=P[i]; if(v<ymin)ymin=v; if(v>ymax)ymax=v;
      if(R[i]!==null){ if(R[i]<ymin)ymin=R[i]; if(R[i]>ymax)ymax=R[i]; }
      if(SU[i]!==null){ if(SU[i]<ymin)ymin=SU[i]; if(SU[i]>ymax)ymax=SU[i]; } }
    if (ymin===ymax){ ymin-=1; ymax+=1; } else { var pad=(ymax-ymin)*0.06; ymin-=pad; ymax+=pad; }
    var geo=axes(ctx,w,h,ymin,ymax,fmtPrice);
    drawSeriesLine(ctx, SU, geo, COL("--sup"));
    drawSeriesLine(ctx, R, geo, COL("--res"));
    drawSeriesLine(ctx, P, geo, COL("--price"));
    // DC event dots
    for (var d=0; d<DC.length; d++){ var e=DC[d]; if(e.i<0||e.i>=N) continue;
      ctx.fillStyle = e.d==="up" ? COL("--dcUp") : COL("--dcDown");
      ctx.beginPath(); ctx.arc(geo.sx(e.i), geo.sy(e.p), 2.6, 0, 6.2832); ctx.fill(); }
    // trade markers (white ring, BUY ▲ / SELL ▼ via triangle)
    for (var t=0; t<TR.length; t++){ var tr=TR[t]; var x=geo.sx(tr.i), y=geo.sy(tr.p);
      ctx.fillStyle="#fff"; ctx.strokeStyle="#0e1218"; ctx.lineWidth=1; ctx.beginPath();
      if (tr.side==="BUY"){ ctx.moveTo(x,y-6); ctx.lineTo(x-5,y+4); ctx.lineTo(x+5,y+4); }
      else { ctx.moveTo(x,y+6); ctx.lineTo(x-5,y-4); ctx.lineTo(x+5,y-4); }
      ctx.closePath(); ctx.fill(); ctx.stroke(); }
    return geo;
  }

  // ---- net-exposure step chart ----
  function expChart(){
    var cv=document.getElementById("c_exp"), s=setup(cv), ctx=s.ctx, w=s.w, h=s.h;
    var u=CFG.u, ymin=-u*1.3, ymax=u*1.3;
    var geo=axes(ctx,w,h,ymin,ymax,function(v){return (v>0?"+":"")+Number(v).toFixed(0);});
    // zero line
    ctx.strokeStyle=COL("--line"); ctx.lineWidth=1; ctx.beginPath();
    ctx.moveTo(geo.x0,geo.sy(0)); ctx.lineTo(geo.x1,geo.sy(0)); ctx.stroke();
    // step line
    ctx.strokeStyle=COL("--exposure"); ctx.lineWidth=1.5; ctx.beginPath();
    for (var j=0;j<N;j++){ var px=geo.sx(j), py=geo.sy(EXP[j]);
      if(j===0){ctx.moveTo(px,py);} else { ctx.lineTo(px, geo.sy(EXP[j-1])); ctx.lineTo(px,py); } }
    ctx.stroke();
    return geo;
  }

  // ---- silenced-agents chart ----
  function silChart(){
    var cv=document.getElementById("c_sil"), s=setup(cv), ctx=s.ctx, w=s.w, h=s.h;
    var mx=1; for (var i=0;i<N;i++){ if(SIL[i]>mx) mx=SIL[i]; }
    var geo=axes(ctx,w,h,0,mx,function(v){return Number(v).toFixed(0);});
    ctx.strokeStyle=COL("--silence"); ctx.lineWidth=1.4; ctx.beginPath();
    for (var j=0;j<N;j++){ var px=geo.sx(j), py=geo.sy(SIL[j]); if(j===0)ctx.moveTo(px,py); else ctx.lineTo(px,py); }
    ctx.stroke();
    return geo;
  }

  function attachTip(cvId, tipId, geo, rows){
    var cv=document.getElementById(cvId), tipEl=document.getElementById(tipId);
    cv.onmousemove=function(ev){
      var rect=cv.getBoundingClientRect(); var mx=ev.clientX-rect.left;
      var frac=(mx-geo.x0)/(geo.x1-geo.x0); if(frac<0)frac=0; if(frac>1)frac=1;
      var idx=Math.round(frac*(N-1));
      var html="<div class='t'>tick "+fmtInt(idx)+"</div>";
      for (var i=0;i<rows.length;i++){ html+="<div class='row'><i class='swatch' style='background:"+rows[i].color+"'></i>"+rows[i].label+": <b>"+rows[i].fmt(idx)+"</b></div>"; }
      tipEl.innerHTML=html; tipEl.style.left=geo.sx(idx)+"px"; tipEl.style.top=(PADT+6)+"px"; tipEl.style.opacity="1";
    };
    cv.onmouseleave=function(){ tipEl.style.opacity="0"; };
  }

  function renderAll(){
    var gp=priceChart();
    attachTip("c_price","t_price",gp,[
      {label:"price",color:COL("--price"),fmt:function(i){return fmtPrice(P[i]);}},
      {label:"resistance",color:COL("--res"),fmt:function(i){return R[i]===null?"—":fmtPrice(R[i]);}},
      {label:"support",color:COL("--sup"),fmt:function(i){return SU[i]===null?"—":fmtPrice(SU[i]);}}]);
    var ge=expChart();
    attachTip("c_exp","t_exp",ge,[{label:"net exposure",color:COL("--exposure"),fmt:function(i){return (EXP[i]>0?"+":"")+EXP[i];}}]);
    var gs=silChart();
    attachTip("c_sil","t_sil",gs,[{label:"silenced",color:COL("--silence"),fmt:function(i){return fmtInt(SIL[i]);}}]);
  }

  renderAll();
  var rt; window.addEventListener("resize", function(){ clearTimeout(rt); rt=setTimeout(renderAll,120); });
})();
</script>
</body>
</html>
`;
}
