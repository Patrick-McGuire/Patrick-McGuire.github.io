"use strict";
/* ---------------------------------------------------------------------------------------------
   STFT settings are field_tool/app.py's, so the picture matches the live monitor:
   512-sample Hann, 75% overlap, 4x zero pad, dB = 20log10(|S| + 1e-6), inferno.
--------------------------------------------------------------------------------------------- */
const FS=50000, NWIN=512, ZPAD=4, NFFT=NWIN*ZPAD, DF=FS/NFFT;
const NYQ=FS/2, CACHE_BINS=Math.floor(NYQ/DF);        // whole spectrum, 0..25 kHz
const CACHE_HOP=1024;                                 // 20.5 ms columns; see buildIndex()
const DB_LO=-40, DB_HI=120, DB_SPAN=DB_HI-DB_LO;      // Uint8 quantisation, 0.63 dB a step

const rev=new Uint16Array(NFFT), cosT=new Float32Array(NFFT/2), sinT=new Float32Array(NFFT/2);
(function(){
  const bits=Math.log2(NFFT);
  for(let i=0;i<NFFT;i++){ let r=0; for(let b=0;b<bits;b++) if(i>>b&1) r|=1<<(bits-1-b); rev[i]=r; }
  for(let i=0;i<NFFT/2;i++){ cosT[i]=Math.cos(-2*Math.PI*i/NFFT); sinT[i]=Math.sin(-2*Math.PI*i/NFFT); }
})();
const win=new Float32Array(NWIN);
for(let i=0;i<NWIN;i++) win[i]=0.5-0.5*Math.cos(2*Math.PI*i/(NWIN-1));
const re=new Float32Array(NFFT), im=new Float32Array(NFFT);

// Writes bins k0..k0+out.length-1 as dB. Zero padding is implicit: re/im start cleared and only
// the first NWIN bit-reversed slots are written.
function spectrumDb(src,off,k0,out){
  re.fill(0); im.fill(0);
  for(let i=0;i<NWIN;i++) re[rev[i]]=src[off+i]*win[i];
  for(let size=2;size<=NFFT;size<<=1){
    const half=size>>1, step=NFFT/size;
    for(let i=0;i<NFFT;i+=size){
      for(let j=0;j<half;j++){
        const k=j*step,c=cosT[k],s=sinT[k],a=i+j,b=a+half;
        const tr=re[b]*c-im[b]*s, ti=re[b]*s+im[b]*c;
        re[b]=re[a]-tr; im[b]=im[a]-ti; re[a]+=tr; im[a]+=ti;
      }
    }
  }
  // 10log10(re^2+im^2) rather than 20log10(hypot(...)): identical result, and measured 23 us
  // per column faster because V8's hypot pays for overflow correctness this does not need.
  for(let i=0;i<out.length;i++){
    const k=k0+i, p=re[k]*re[k]+im[k]*im[k];
    out[i]=10*Math.log10(p+1e-12);
  }
}

const INFERNO=[[0,0,4],[22,11,57],[66,10,104],[106,23,110],[147,38,103],[188,55,84],
  [221,81,58],[243,120,25],[252,165,10],[246,215,70],[252,255,164]];
const LUT=new Uint8ClampedArray(256*3);
for(let i=0;i<256;i++){
  const x=i/255*(INFERNO.length-1), k=Math.min(INFERNO.length-2,Math.floor(x)), f=x-k;
  for(let c=0;c<3;c++) LUT[i*3+c]=INFERNO[k][c]+(INFERNO[k+1][c]-INFERNO[k][c])*f;
}

/* ---- log parsing ---- */
const EV=[
  // The firmware prints %X, so 0x0F3C logs as "F3C". Rebuild the label from the decimal field,
  // which is never ambiguous, and pad it back to four digits.
  {re:/Decoded message:\s*(\d+)/, kind:"ok",
   label:m=>parseInt(m[1],10).toString(16).toUpperCase().padStart(4,"0")},
  {re:/FALSE_DECODE\D*([0-9a-fx]+)/i, kind:"ok", label:m=>m[1].toUpperCase()},
  {re:/Message decode failed/, kind:"bad", label:()=>"fail"},
  {re:/Detected message duration:\s*(\d+)/, kind:"det", label:m=>m[1]+"ms"},
];
function parseLog(text){
  const out=[]; let t0=null, drops=0, build="", rate="";
  for(const raw of text.split(/\r?\n/)){
    const tm=raw.match(/^(\d\d):(\d\d):(\d\d)/);
    if(!tm) continue;
    const secs=(+tm[1])*3600+(+tm[2])*60+(+tm[3]);
    if(t0===null) t0=secs;
    let t=secs-t0; if(t<-43200) t+=86400;
    const b=raw.match(/#BUILD\s+(\S+)/); if(b) build=b[1];
    const r=raw.match(/#RATE\s+([\d.]+)/); if(r) rate=r[1];
    const d=raw.match(/#DROPS\s+usb=(\d+)\s+pdm=(\d+)/);
    if(d){ const p=+d[2]; if(p>drops){ out.push({t,kind:"warn",label:"pdm "+p}); drops=p; } continue; }
    for(const e of EV){ const m=raw.match(e.re); if(m){ out.push({t,kind:e.kind,label:e.label(m)}); break; } }
  }
  return {events:out, build, rate};
}

/* ---------------------------------------------------------------------------------------------
   Device event log (the Console tab's dump, or its "Download CSV") -> marks on an SD NNNNN.BIN.
   BOOT (6) and RECORD_START (7) entries carry the number of the file they opened, so every entry
   after one, up to the next, happened during that recording. Entry times are whole RTC seconds:
   the marks are good to about +-1 s.
--------------------------------------------------------------------------------------------- */
let deviceLog=null, deviceLogName="";
function parseEventCsv(text){
  const lines=text.split(/\r?\n/).filter(Boolean);
  if(!lines.length) return null;
  const head=lines.shift().split(",");
  const col=n=>head.indexOf(n);
  const iIdx=col("idx"), iType=col("type_id"), iUnix=col("unix"), iVal=col("value");
  if(iType<0||iUnix<0||iVal<0) return null;
  return lines.map((l,n)=>{ const f=l.split(",");
    return {idx:iIdx>=0?+f[iIdx]:n, type:+f[iType], time:+f[iUnix], value:+f[iVal]}; });
}
function eventsForFile(entries,fileNo){
  const sorted=[...entries].sort((a,b)=>a.idx-b.idx);
  let start=-1;   // the LAST opening of this number: numbers restart on a reformatted card
  for(let i=0;i<sorted.length;i++){ const e=sorted[i]; if((e.type===6||e.type===7)&&e.value===fileNo) start=i; }
  if(start<0) return null;
  const t0=sorted[start].time, out=[];
  for(let i=start+1;i<sorted.length;i++){
    const e=sorted[i];
    if(e.type===6||e.type===7) break;
    const t=e.time-t0;
    if(e.type===1) out.push({t,kind:"ok",label:(e.value&0xFFFF).toString(16).toUpperCase().padStart(4,"0")});
    else if(e.type===2) out.push({t,kind:"bad",label:"fail"});
    else if(e.type===5) out.push({t,kind:"warn",label:"overflow"});
    else if(e.type===3) out.push({t,kind:"warn",label:"sleep fail"});
  }
  return {events:out, build:"", rate:"", fromDevice:true};
}
// Puts the device log's marks on every pane holding an SD file that has no field-tool log.
function applyDeviceLog(){
  if(!deviceLog) return;
  const notes=[];
  for(const p of panes){
    const m=p.fileName.match(/^(\d{1,5})\.BIN$/i);
    if(!m || (p.log && !p.log.fromDevice)) continue;
    const ev=eventsForFile(deviceLog,parseInt(m[1],10));
    p.log=ev; p.logName=ev?deviceLogName:"";
    p.nameEl.textContent=p.fileName+(ev?"  +  "+deviceLogName:"  (not in the event log)");
    notes.push(p.fileName+": "+(ev?ev.events.length+" events":"no BOOT/RECORD_START entry"));
    setStat(p);
  }
  $("evInfo").textContent=deviceLogName+" ("+deviceLog.length+" entries)"+(notes.length?" · "+notes.join(" · "):"");
  drawAll();
}

/* ---- state ---- */
const PRESETS={proto:[7500,9500], full:[0,20000]};
const st={t0:0, span:20, fLo:7500, fHi:9500, gain:0, events:true, link:true};
const panes=[...document.querySelectorAll(".pane")].map(el=>({
  el, canvas:el.querySelector("canvas"), ctx:el.querySelector("canvas").getContext("2d",{alpha:false}),
  over:el.querySelector('[data-role=over]'), bar:el.querySelector('[data-role=bar]'),
  nameEl:el.querySelector('[data-role=name]'), statEl:el.querySelector('[data-role=stat]'),
  samples:null, dur:0, log:null, fileName:"", logName:"",
  index:null, nCols:0, indexing:false, buildMs:0,
}));

/* ---------------------------------------------------------------------------------------------
   Pre-generated index. One pass over the file at load time transforms the WHOLE capture into a
   Uint8 dB matrix covering the entire spectrum, so afterwards any band, any zoom and any pan is
   a memory read instead of thousands of transforms. At CACHE_HOP=1024 a 520 s capture is about
   25k columns x 1024 bins = 26 MB, which is the trade: one up-front second to make every later
   redraw free. Zooming in past the index's own 20.5 ms resolution falls through to computing
   just the visible window, which is only ever about one transform per pixel column.
--------------------------------------------------------------------------------------------- */
function buildIndex(p, done){
  const n=p.samples.length;
  p.nCols=Math.max(0,Math.floor((n-NWIN)/CACHE_HOP)+1);
  p.index=new Uint8Array(p.nCols*CACHE_BINS);
  p.indexing=true;
  const col=new Float32Array(CACHE_BINS);
  const t0=performance.now();
  let c=0;
  const CHUNK=900;
  (function step(){
    const end=Math.min(p.nCols,c+CHUNK);
    for(;c<end;c++){
      spectrumDb(p.samples,c*CACHE_HOP,0,col);
      const base=c*CACHE_BINS;
      for(let b=0;b<CACHE_BINS;b++){
        let q=(col[b]-DB_LO)*255/DB_SPAN;
        p.index[base+b]= q<0?0 : q>255?255 : q|0;
      }
    }
    setProgress(p,c/p.nCols);
    if(c<p.nCols){ setTimeout(step,0); return; }
    p.indexing=false; p.buildMs=performance.now()-t0;
    setProgress(p,1); setStat(p); done&&done();
  })();
}
function setProgress(p,f){
  const i=p.bar.firstElementChild;
  p.bar.hidden = f>=1;
  i.style.width=Math.round(f*100)+"%";
  if(f<1) p.statEl.textContent="indexing "+Math.round(f*100)+"%";
}

function fmtT(s){
  if(s<0) return "-"+fmtT(-s);
  const m=Math.floor(s/60);
  return m? m+"m"+String(Math.floor(s%60)).padStart(2,"0")+"s" : s.toFixed(s<10?2:1)+"s";
}

/* ---- draw ---- */
const AX=46;
// Zoomed in past the index's resolution every column is a fresh transform, about 98 us each, so
// a full-width redraw is ~120 ms -- visible as lag while dragging. During interaction the plot is
// computed at a third of the width and stretched; a full-resolution pass follows once the pointer
// has been still for a moment. Panning stays responsive and the picture at rest is unchanged.
let interacting=0, idleTimer=0;
function touchInteract(){
  interacting=1;
  clearTimeout(idleTimer);
  idleTimer=setTimeout(()=>{ interacting=0; drawAll(); }, 130);
}

function draw(p){
  const c=p.canvas, dpr=Math.min(devicePixelRatio||1,2);
  const W=Math.max(32,Math.round(c.clientWidth*dpr)), H=Math.max(32,Math.round(c.clientHeight*dpr));
  if(c.width!==W||c.height!==H){ c.width=W; c.height=H; }
  const ctx=p.ctx, axisW=Math.round(AX*dpr), plotW=Math.max(1,W-axisW);
  ctx.fillStyle="#0b1113"; ctx.fillRect(0,0,W,H);
  p.over.hidden = !!p.samples && !p.indexing;
  if(!p.samples || p.indexing) return;

  const fLo=Math.max(0,Math.min(st.fLo,st.fHi-1)), fHi=Math.min(NYQ,Math.max(st.fHi,fLo+1));
  const k0=Math.max(0,Math.floor(fLo/DF)), k1=Math.min(CACHE_BINS,Math.ceil(fHi/DF));
  const nb=Math.max(1,k1-k0);

  const i0=st.t0*FS;
  const hopFull=st.span*FS/plotW;
  const useIndex = p.index && hopFull>=CACHE_HOP;
  // only the live path is expensive enough to need the coarse pass
  const nCol = (!useIndex && interacting) ? Math.max(64,Math.round(plotW/3)) : plotW;
  const hopNeeded = st.span*FS/nCol;

  // gather one dB column per sample column
  const colDb=new Float32Array(nCol*nb);
  const tmp=new Float32Array(nb);
  let lo=1e9, hi=-1e9;
  for(let x=0;x<nCol;x++){
    const off=i0+x*hopNeeded;
    let ok=false;
    if(useIndex){
      const ci=Math.round(off/CACHE_HOP);
      if(ci>=0&&ci<p.nCols){
        const base=ci*CACHE_BINS;
        for(let b=0;b<nb;b++){
          const v=DB_LO+p.index[base+k0+b]*DB_SPAN/255;
          colDb[x*nb+b]=v; if(v<lo)lo=v; if(v>hi)hi=v;
        }
        ok=true;
      }
    } else {
      const s=Math.round(off);
      if(s>=0&&s+NWIN<p.samples.length){
        spectrumDb(p.samples,s,k0,tmp);
        for(let b=0;b<nb;b++){ const v=tmp[b]; colDb[x*nb+b]=v; if(v<lo)lo=v; if(v>hi)hi=v; }
        ok=true;
      }
    }
    if(!ok) for(let b=0;b<nb;b++) colDb[x*nb+b]=NaN;
  }
  if(!(hi>lo)){ lo=0; hi=1; }
  const vLo=lo+(hi-lo)*0.45-st.gain, vHi=hi-st.gain*0.3, sc=255/Math.max(1e-6,vHi-vLo);

  const img=ctx.createImageData(plotW,H);
  const d=img.data;
  for(let x=0;x<plotW;x++){
    const cb=(nCol===plotW ? x : Math.min(nCol-1,(x*nCol/plotW)|0))*nb;
    for(let y=0;y<H;y++){
      const b0=Math.floor((1-(y+1)/H)*nb);
      const b1=Math.max(b0+1,Math.ceil((1-y/H)*nb));
      let m=-1e9;
      for(let b=b0;b<b1&&b<nb;b++){ const v=colDb[cb+b]; if(v>m) m=v; }
      const o=(y*plotW+x)*4;
      if(!isFinite(m)){ d[o]=18; d[o+1]=26; d[o+2]=29; }
      else{ let q=(m-vLo)*sc; q=q<0?0:q>255?255:q|0;
            d[o]=LUT[q*3]; d[o+1]=LUT[q*3+1]; d[o+2]=LUT[q*3+2]; }
      d[o+3]=255;
    }
  }
  ctx.putImageData(img,axisW,0);

  // frequency axis, ticks chosen for the span actually shown
  ctx.fillStyle="#121a1d"; ctx.fillRect(0,0,axisW,H);
  ctx.strokeStyle="#24343a"; ctx.lineWidth=1;
  ctx.beginPath(); ctx.moveTo(axisW-.5,0); ctx.lineTo(axisW-.5,H); ctx.stroke();
  ctx.font=(10*dpr)+"px ui-monospace,monospace"; ctx.fillStyle="#8ba3a9";
  ctx.textAlign="right"; ctx.textBaseline="middle";
  const sp=fHi-fLo;
  const stepHz=[25,50,100,250,500,1000,2000,2500,5000].find(s=>sp/s<=8)||10000;
  for(let f=Math.ceil(fLo/stepHz)*stepHz; f<=fHi; f+=stepHz){
    const y=H*(1-(f-fLo)/sp);
    ctx.fillText(f>=1000?(f/1000).toFixed(f%1000?2:0)+"k":String(f), axisW-6*dpr,
                 Math.max(7*dpr,Math.min(H-7*dpr,y)));
    ctx.strokeStyle="rgba(255,255,255,.07)";
    ctx.beginPath(); ctx.moveTo(axisW,y); ctx.lineTo(W,y); ctx.stroke();
  }
  // where the chirp band sits, whenever the view is wider than it
  if(fLo<8000 && fHi>9000){
    ctx.strokeStyle="rgba(78,205,196,.5)"; ctx.setLineDash([4*dpr,3*dpr]);
    for(const f of [8000,9000]){
      const y=H*(1-(f-fLo)/sp);
      ctx.beginPath(); ctx.moveTo(axisW,y); ctx.lineTo(W,y); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.textAlign="left"; ctx.fillStyle="rgba(78,205,196,.8)";
    ctx.fillText("chirp", axisW+6*dpr, H*(1-(9000-fLo)/sp)-8*dpr);
  }

  if(st.events && p.log){
    const COL={ok:"#5ddc8a",bad:"#ff7a6b",det:"#6aa9ff",warn:"#f2b544"};
    ctx.textAlign="left"; ctx.font=(9.5*dpr)+"px ui-monospace,monospace";
    let lastX=-1e9;
    for(const e of p.log.events){
      const x=axisW+((e.t-st.t0)/st.span)*plotW;
      if(x<axisW||x>W) continue;
      ctx.strokeStyle=COL[e.kind]||"#fff"; ctx.globalAlpha=e.kind==="det"?.45:.85;
      ctx.lineWidth=(e.kind==="det"?1:1.5)*dpr;
      ctx.beginPath(); ctx.moveTo(x,0); ctx.lineTo(x,H); ctx.stroke();
      ctx.globalAlpha=1;
      if(e.kind!=="det" && x-lastX>34*dpr){ ctx.fillStyle=COL[e.kind]; ctx.fillText(e.label,x+3*dpr,10*dpr); lastX=x; }
    }
  }

  ctx.fillStyle="rgba(11,17,19,.72)"; ctx.fillRect(axisW,H-16*dpr,plotW,16*dpr);
  ctx.fillStyle="#8ba3a9"; ctx.textAlign="left"; ctx.font=(10*dpr)+"px ui-monospace,monospace";
  const nT=Math.max(2,Math.min(8,Math.floor(plotW/(90*dpr))));
  for(let i=0;i<=nT;i++)
    ctx.fillText(fmtT(st.t0+st.span*i/nT), Math.min(W-40*dpr,axisW+plotW*i/nT+3*dpr), H-6*dpr);

  if(!useIndex && p.index){
    ctx.textAlign="right"; ctx.fillStyle="rgba(223,234,236,.35)";
    ctx.fillText("live", W-6*dpr, H-6*dpr);
  }
}
let raf=0;
function drawAll(){ if(raf) return; raf=requestAnimationFrame(()=>{ raf=0; panes.forEach(draw); }); }

/* ---- files ---- */
function setStat(p){
  if(p.indexing) return;
  const bits=[];
  if(p.samples) bits.push(p.dur.toFixed(1)+"s");
  if(p.buildMs) bits.push("indexed "+(p.buildMs/1000).toFixed(1)+"s");
  if(p.log){
    const n=p.log.events.filter(e=>e.kind==="ok").length;
    const f=p.log.events.filter(e=>e.kind==="bad").length;
    bits.push(n+" decoded", f+" failed");
    if(p.log.build) bits.push(p.log.build);
    if(p.log.rate && Math.abs(+p.log.rate-FS)>1) bits.push("rate "+p.log.rate+"!");
  }
  p.statEl.textContent=bits.join("  ·  ");
}
async function loadBin(p,file){
  const buf=await file.arrayBuffer();
  p.samples=new Int16Array(buf); p.dur=p.samples.length/FS; p.fileName=file.name;
  p.index=null; p.buildMs=0;
  p.nameEl.textContent=file.name+(p.logName?"  +  "+p.logName:"");
  if(st.span>p.dur) st.span=Math.min(20,p.dur);
  syncInputs(); drawAll();
  applyDeviceLog();
  buildIndex(p,drawAll);
}
async function loadLog(p,file){
  p.log=parseLog(await file.text()); p.logName=file.name;
  p.nameEl.textContent=(p.fileName||"(no .bin)")+"  +  "+file.name;
  setStat(p); drawAll();
}

/* ---- interaction: wheel/drag semantics copied from field_tool/app.py's ZoomBox, so the two
   tools feel the same -- 1.1x per notch anchored under the cursor, shift = time only,
   ctrl = frequency only, no modifier = both. ---- */
/* ---------------------------------------------------------------------------------------------
   One selection, all four field-tool files. They are named <stamp>_<PORT>.bin / .log, as in
   20261004_172223_COM30.bin, so the port in the name says which receiver a file belongs to and
   the extension says whether it is audio or log. Ports are ordered numerically, so COM5 is
   always pane A and COM30 pane B however the file dialog happened to list them -- with two
   receivers you want the assignment stable between sessions, not dependent on click order.
--------------------------------------------------------------------------------------------- */
// CSVs first: a device event log overlays SD files; a UI (motor) log belongs to the Motor log tab.
async function takeCsvs(csvs){
  const info=[];
  for(const f of csvs){
    const text=await f.text();
    const head=text.slice(0,200).split(/\r?\n/)[0];
    if(/(^|,)type_id(,|$)/.test(head)){
      const entries=parseEventCsv(text);
      if(entries){ deviceLog=entries; deviceLogName=f.name; info.push("event log: "+f.name); }
    } else if(/^up_ms,/.test(head) && window.ITD){
      window.ITD.openUiLogFiles([f]); info.push(f.name+" -> Motor log tab");
    } else info.push("unrecognised CSV: "+f.name);
  }
  applyDeviceLog();
  return info;
}

async function assign(fileList){
  const csvs=[...fileList].filter(f=>/\.csv$/i.test(f.name));
  const csvInfo=csvs.length?await takeCsvs(csvs):[];
  fileList=[...fileList].filter(f=>!/\.csv$/i.test(f.name));
  if(!fileList.length){ $("pickInfo").textContent=csvInfo.join("  ·  ")||"nothing recognised"; return; }
  const groups=new Map();
  const odd=[];
  for(const f of fileList){
    const m=f.name.match(/^(.*?)[_-]?(COM\d+)\.(bin|log|txt)$/i);
    if(!m){ odd.push(f.name); continue; }
    const port=m[2].toUpperCase(), kind=m[3].toLowerCase()==="bin"?"bin":"log";
    if(!groups.has(port)) groups.set(port,{port,bin:null,log:null});
    groups.get(port)[kind]=f;
  }
  // a selection with no port in the names still works: fall back to extension order
  if(!groups.size){
    const bins=[...fileList].filter(f=>/\.bin$/i.test(f.name));
    const logs=[...fileList].filter(f=>/\.(log|txt)$/i.test(f.name));
    bins.forEach((b,i)=>groups.set("file"+i,{port:b.name,bin:b,log:logs[i]||null}));
    odd.length=0;   // SD NNNNN.BIN files land here by design: not "unrecognised"
  }
  const keys=[...groups.keys()].sort((a,b)=>{
    const na=+(a.match(/\d+/)||[1e9])[0], nb=+(b.match(/\d+/)||[1e9])[0];
    return na-nb || a.localeCompare(b);
  });
  const info=[];
  keys.slice(0,panes.length).forEach((k,i)=>{
    const g=groups.get(k), p=panes[i];
    if(!g.log){ p.log=null; p.logName=""; }   // an SD file: the device log (if any) fills this in
    if(g.log) loadLog(p,g.log);
    if(g.bin) loadBin(p,g.bin);
    info.push(("AB"[i])+" = "+g.port+(g.bin?"":" (no .bin)"));
  });
  if(keys.length>panes.length) info.push("ignored "+keys.slice(panes.length).join(", "));
  if(odd.length) info.push("unrecognised: "+odd.length);
  info.push(...csvInfo);
  $("pickInfo").textContent=info.join("  ·  ") || "nothing recognised";
}

panes.forEach(p=>{
  p.canvas.addEventListener("wheel",e=>{
    if(!p.samples) return; e.preventDefault();
    const r=p.canvas.getBoundingClientRect(), plot=Math.max(1,r.width-AX);
    const fx=Math.max(0,Math.min(1,(e.clientX-r.left-AX)/plot));
    const fy=1-Math.max(0,Math.min(1,(e.clientY-r.top)/r.height));
    const s=e.deltaY<0 ? 1/1.1 : 1.1;
    const xOnly=e.shiftKey, yOnly=e.ctrlKey||e.metaKey;
    if(!yOnly){
      const at=st.t0+fx*st.span;
      st.span=Math.max(0.02,st.span*s);
      st.t0=at-fx*st.span;
    }
    if(!xOnly){
      const at=st.fLo+fy*(st.fHi-st.fLo);
      let h=Math.max(50,(st.fHi-st.fLo)*s);
      st.fLo=at-fy*h; st.fHi=st.fLo+h;
      if(st.fLo<0){ st.fHi-=st.fLo; st.fLo=0; }
      if(st.fHi>NYQ){ st.fLo-=st.fHi-NYQ; st.fHi=NYQ; if(st.fLo<0) st.fLo=0; }
    }
    touchInteract(); clearPreset(); syncInputs(); drawAll();
  },{passive:false});
  let drag=null;
  p.canvas.addEventListener("pointerdown",e=>{
    if(!p.samples) return;
    drag={x:e.clientX,y:e.clientY,t0:st.t0,fLo:st.fLo,fHi:st.fHi};
    p.canvas.setPointerCapture(e.pointerId); p.canvas.style.cursor="grabbing";
  });
  const endDrag=()=>{ drag=null; p.canvas.style.cursor="crosshair"; };
  p.canvas.addEventListener("pointerup",endDrag);
  p.canvas.addEventListener("pointercancel",endDrag);
  p.canvas.addEventListener("pointermove",e=>{
    const r=p.canvas.getBoundingClientRect(), plot=Math.max(1,r.width-AX);
    if(drag){
      st.t0=drag.t0-((e.clientX-drag.x)/plot)*st.span;
      const h=drag.fHi-drag.fLo, dy=((e.clientY-drag.y)/r.height)*h;
      let lo=drag.fLo+dy, hi=lo+h;
      if(lo<0){ hi-=lo; lo=0; } if(hi>NYQ){ lo-=hi-NYQ; hi=NYQ; if(lo<0) lo=0; }
      st.fLo=lo; st.fHi=hi;
      touchInteract(); clearPreset(); syncInputs(); drawAll(); return;
    }
    if(!p.samples) return;
    const fx=(e.clientX-r.left-AX)/plot, fy=1-(e.clientY-r.top)/r.height;
    if(fx>=0&&fx<=1) document.getElementById("hover").textContent=
      fmtT(st.t0+fx*st.span)+"   "+Math.round(st.fLo+fy*(st.fHi-st.fLo))+" Hz";
  });
});

/* ---- controls ---- */
const $=id=>document.getElementById(id);
$("pick").addEventListener("change",e=>{ if(e.target.files.length) assign(e.target.files); });
function syncInputs(){
  $("tstart").value=st.t0.toFixed(2); $("hist").value=st.span.toFixed(2);
  $("fLo").value=Math.round(st.fLo); $("fHi").value=Math.round(st.fHi);
}
function clearPreset(){ $("bProto").ariaPressed="false"; $("bFull").ariaPressed="false"; }
function setBand(lo,hi,which){
  st.fLo=lo; st.fHi=hi; clearPreset();
  if(which) $(which).ariaPressed="true";
  syncInputs(); drawAll();
}
$("bProto").onclick=()=>setBand(PRESETS.proto[0],PRESETS.proto[1],"bProto");
$("bFull").onclick =()=>setBand(PRESETS.full[0],PRESETS.full[1],"bFull");
$("fLo").oninput=e=>{ const v=+e.target.value; if(isFinite(v)&&v<st.fHi){ st.fLo=Math.max(0,v); clearPreset(); drawAll(); } };
$("fHi").oninput=e=>{ const v=+e.target.value; if(isFinite(v)&&v>st.fLo){ st.fHi=Math.min(NYQ,v); clearPreset(); drawAll(); } };
$("hist").oninput=e=>{ const v=+e.target.value; if(v>0){ st.span=v; drawAll(); } };
$("tstart").oninput=e=>{ const v=+e.target.value; if(isFinite(v)){ st.t0=v; drawAll(); } };
$("reset").onclick=()=>{ st.t0=0; st.span=20; setBand(PRESETS.proto[0],PRESETS.proto[1],"bProto"); };
$("fit").onclick=()=>{ st.t0=0; st.span=Math.max(...panes.map(p=>p.dur),1); syncInputs(); drawAll(); };
$("gain").oninput=e=>{ st.gain=+e.target.value;
  $("gainTxt").textContent=st.gain?(st.gain>0?"+":"")+st.gain+" dB":"auto"; drawAll(); };
$("showEv").onchange=e=>{ st.events=e.target.checked; drawAll(); };
$("link").onchange=e=>{ st.link=e.target.checked; drawAll(); };
addEventListener("resize",drawAll);
// The Console tab's event log, once dumped there.
if(window.ITD){
  window.ITD.on("eventlog",()=>{ $("useConsoleLog").disabled=false; });
  $("useConsoleLog").onclick=()=>{
    if(!window.ITD.eventLog) return;
    deviceLog=window.ITD.eventLog; deviceLogName="console dump"; applyDeviceLog();
  };
}
addEventListener("keydown",e=>{
  if(window.ITD && !window.ITD.isActive("audio")) return;
  if(e.target.tagName==="INPUT") return;
  const k=e.key;
  if(k==="ArrowLeft") st.t0-=st.span*0.25;
  else if(k==="ArrowRight") st.t0+=st.span*0.25;
  else if(k==="ArrowUp") st.span=Math.max(0.02,st.span/1.3);
  else if(k==="ArrowDown") st.span*=1.3;
  else return;
  touchInteract(); syncInputs(); drawAll();
  e.preventDefault();
});
drawAll();
