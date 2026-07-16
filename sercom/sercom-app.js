/* SAMD21/SAMD51 SERCOM configurator — logic.
   Combination rules (verified against datasheets + Adafruit ArduinoCore-samd SERCOM.h):
     I2C : SDA=PAD0, SCL=PAD1 (fixed); pins must be I2C-capable (Table 7-4 / 6-8).
     SPI : MOSI(DO)/SCK pads per DOPO; MISO(DI) any remaining pad (DIPO).
     UART: TX pad per TXPO (D21: PAD0/PAD2, D51: PAD0 only); RX any other pad (RXPO).
   SAMD51: pins for one SERCOM must all come from a single IOSET (DS60001507F §6.2.8). */

var D = SERCOM_DATA;
var state = { mcuId:null, variantId:'', cfg:{} }; // cfg[sercom] = {proto, sel:{signalName:pin}}
var PROTO_SIG = { spi:['mosi','sck','miso'], uart:['tx','rx'], i2c:['sda','scl'] };
var SIG_LABEL = { mosi:'MOSI', sck:'SCK', miso:'MISO', tx:'TX', rx:'RX', sda:'SDA', scl:'SCL' };

function mcu(){ return D.mcus[state.mcuId]; }
function esc(s){ return String(s).replace(/[&<>]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;'}[c];}); }

// mux helpers -------------------------------------------------------------
function muxEntry(m, pin, s){ var a=m.mux[pin]||[]; for(var i=0;i<a.length;i++) if(a[i].s===s) return a[i]; return null; }
function pinFunc(m, pin, s){ var e=muxEntry(m,pin,s); return e?e.f:null; }        // 'C' | 'D'
function pioName(f){ return f==='C'?'PIO_SERCOM':'PIO_SERCOM_ALT'; }
function avail(m, pin){ return !m.availPins || m.availPins.indexOf(pin)>=0; }
function isI2C(m, pin){ return m.i2cPins.indexOf(pin)>=0; }

// Arduino pin number from selected variant, or null
function ardPin(pin){
  if(!state.variantId) return null;
  var v=D.variants[state.variantId]; if(!v) return null;
  return (pin in v.pins)? v.pins[pin] : (v.mcu===state.mcuId ? 'CUSTOM' : null);
}

// candidate pins for (sercom,pad), restricted to available pins
function padCandidates(m, s, pad){
  var out=[];
  for(var pin in m.mux){ var e=muxEntry(m,pin,s); if(e && e.pad===pad && avail(m,pin)) out.push(pin); }
  return out;
}

// "cand sets": each is {0:[pins],1:[..],2:[..],3:[..]}.
// SAMD51 -> one set per IOSET (single pin per pad) to enforce the no-mix rule.
// SAMD21 -> one global set (free combination across function C/D).
function candSets(m, s){
  if(m.iosets){
    var iosets = m.iosets[String(s)]||[];
    return iosets.map(function(io){
      var c={}; for(var p=0;p<4;p++){ c[p]= (io[p]&&avail(m,io[p]))?[io[p]]:[]; } return c;
    });
  }
  var g={}; for(var p=0;p<4;p++) g[p]=padCandidates(m,s,p);
  return [g];
}

// Enumerate every valid complete combination for a sercom+protocol.
// combo = { sig:{name:{pin,pad,func}}, dopo:{mosi,sck}|null }
function enumCombos(m, s, proto){
  var combos=[], seen={};
  function add(sig, dopo){
    var pins = Object.keys(sig).map(function(k){return sig[k].pin;});
    // no pin reused
    if(new Set(pins).size !== pins.length) return;
    var key = Object.keys(sig).sort().map(function(k){return k+':'+sig[k].pin;}).join('|');
    if(seen[key]) return; seen[key]=1;
    combos.push({sig:sig, dopo:dopo||null});
  }
  function mk(pin, s){ var e=muxEntry(m,pin,s); return {pin:pin, pad:e.pad, func:e.f}; }

  candSets(m,s).forEach(function(c){
    if(proto==='i2c'){
      c[0].forEach(function(sda){ if(!isI2C(m,sda)) return;
        c[1].forEach(function(scl){ if(!isI2C(m,scl)) return;
          add({sda:mk(sda,s), scl:mk(scl,s)}); }); });
    } else if(proto==='spi'){
      m.spiDopo.forEach(function(dp){
        c[dp.mosi].forEach(function(mosi){
          c[dp.sck].forEach(function(sck){
            for(var mp=0;mp<4;mp++){ if(mp===dp.mosi||mp===dp.sck) continue;
              c[mp].forEach(function(miso){
                add({mosi:mk(mosi,s), sck:mk(sck,s), miso:mk(miso,s)}, {mosi:dp.mosi,sck:dp.sck}); });
            } }); }); });
    } else if(proto==='uart'){
      m.uartTx.forEach(function(txPad){
        c[txPad].forEach(function(tx){
          for(var rp=0;rp<4;rp++){ if(rp===txPad) continue;
            c[rp].forEach(function(rx){ add({tx:mk(tx,s), rx:mk(rx,s)}); });
          } }); });
    }
  });
  return combos;
}

// combos filtered by current partial selection
function matchCombos(combos, sel){
  return combos.filter(function(cb){
    for(var k in sel){ if(sel[k] && (!cb.sig[k] || cb.sig[k].pin!==sel[k])) return false; }
    return true;
  });
}

// ---- rendering ----------------------------------------------------------
function fill(el, html){ el.innerHTML=html; }

function pinLabel(pin, func){
  var s='<span class="mono">'+pin+'</span>';
  if(func) s+=' <span class="'+(func==='C'?'pio-C':'pio-D')+'">'+pioName(func)+'</span>';
  var ap=ardPin(pin);
  if(ap==='CUSTOM') s+='<span class="tag cust">needs custom variant</span>';
  else if(ap!==null) s+='<span class="tag ard">Arduino pin '+ap+'</span>';
  if(mcu().special && mcu().special[pin]) s+='<span class="tag warn">'+esc(mcu().special[pin])+'</span>';
  return s;
}
// short label for <option>
function optLabel(m, pin, s){
  var f=pinFunc(m,pin,s), ap=ardPin(pin);
  var t=pin+' ('+pioName(f)+')';
  if(ap==='CUSTOM') t+=' — custom variant';
  else if(ap!==null) t+=' — pin '+ap;
  if(m.special&&m.special[pin]) t+=' ⚠';
  return t;
}

function renderConfigure(){
  var m=mcu(), grid=document.getElementById('grid'), html='';
  m.sercoms.forEach(function(s){
    var cf=state.cfg[s]||{proto:'none',sel:{}};
    var on = cf.proto && cf.proto!=='none';
    html+='<div class="card'+(on?' on':'')+'">';
    html+='<h3>SERCOM'+s+' <span class="badge'+(on?' act':'')+'">'+(on?cf.proto.toUpperCase():'unused')+'</span></h3>';
    html+='<div class="protorow">';
    [['none','None'],['i2c','I²C'],['spi','SPI'],['uart','Serial']].forEach(function(p){
      html+='<button data-s="'+s+'" data-proto="'+p[0]+'" class="'+(cf.proto===p[0]?'sel':'')+'">'+p[1]+'</button>';
    });
    html+='</div>';
    if(on){ html+=renderSelector(m,s,cf); }
    html+='</div>';
  });
  fill(grid, html);
  // wire proto buttons
  grid.querySelectorAll('.protorow button').forEach(function(b){
    b.onclick=function(){ setProto(+b.dataset.s, b.dataset.proto); };
  });
  // wire selects
  grid.querySelectorAll('select.sigsel').forEach(function(sel){
    sel.onchange=function(){ setSignal(+sel.dataset.s, sel.dataset.sig, sel.value); };
  });
}

function renderSelector(m,s,cf){
  var proto=cf.proto, sigs=PROTO_SIG[proto];
  var combos=enumCombos(m,s,proto);
  var html='<div class="selarea">';
  if(combos.length===0){
    html+='<div class="empty">No valid '+proto.toUpperCase()+' pin set is available for SERCOM'+s+' on this MCU'+
      (proto==='i2c'?' (no I²C-capable PAD0/PAD1 pair).':'.')+'</div></div>';
    return html;
  }
  // cascading selects
  var sel=cf.sel||{};
  sigs.forEach(function(sig,idx){
    // options consistent with previously chosen signals
    var prior={}; for(var j=0;j<idx;j++){ prior[sigs[j]]=sel[sigs[j]]; }
    var pool=matchCombos(combos,prior);
    var opts={};
    pool.forEach(function(cb){ if(cb.sig[sig]) opts[cb.sig[sig].pin]=1; });
    var pins=Object.keys(opts).sort();
    html+='<div class="sigrow"><div class="sn">'+SIG_LABEL[sig]+'</div><select class="sigsel" data-s="'+s+'" data-sig="'+sig+'">';
    html+='<option value="">— choose —</option>';
    pins.forEach(function(pin){
      html+='<option value="'+pin+'"'+(sel[sig]===pin?' selected':'')+'>'+esc(optLabel(m,pin,s))+'</option>';
    });
    html+='</select></div>';
  });
  // completion status
  var full=matchCombos(combos,sel);
  var complete = sigs.every(function(sg){return sel[sg];}) && full.length>=1;
  if(complete){
    var cb=full[0], parts=sigs.map(function(sg){return SIG_LABEL[sg]+'='+cb.sig[sg].pin;});
    html+='<div class="done">✓ '+parts.join(', ')+'</div>';
  } else {
    html+='<div class="hint">Pick a pin for each signal to complete this SERCOM.</div>';
  }
  // reference: all possible pins per pad
  html+='<details class="refwrap"><summary>All possible pins for SERCOM'+s+
        (m.iosets?' (grouped by IOSET)':'')+'</summary>'+renderRef(m,s,proto)+'</details>';
  html+='</div>';
  return html;
}

function renderRef(m,s,proto){
  if(m.iosets){
    var iosets=m.iosets[String(s)]||[], h='<table class="ref"><tr><th>IOSET</th><th>PAD0</th><th>PAD1</th><th>PAD2</th><th>PAD3</th></tr>';
    iosets.forEach(function(io,i){
      var unavail = io.some(function(p){return !avail(m,p);});
      h+='<tr><td>'+(i+1)+(unavail?' <span class="tag cust">not all on pkg</span>':'')+'</td>';
      for(var p=0;p<4;p++){ h+='<td>'+refCell(m,io[p],s)+'</td>'; }
      h+='</tr>';
    });
    return h+'</table><div class="legend">Within one SERCOM, all pins must come from a single IOSET (they cannot be mixed).</div>';
  }
  var h='<table class="ref"><tr><th>PAD</th><th>Candidate pins</th></tr>';
  for(var p=0;p<4;p++){
    var c=padCandidates(m,s,p);
    h+='<tr><td>PAD'+p+'</td><td>'+(c.length?c.map(function(pin){return refCell(m,pin,s);}).join('<br>'):'—')+'</td></tr>';
  }
  return h+'</table>';
}
function refCell(m,pin,s){
  if(!pin) return '—';
  if(!avail(m,pin)) return '<span class="mono" style="opacity:.4">'+pin+'</span>';
  var f=pinFunc(m,pin,s), out='<span class="mono">'+pin+'</span> <span class="'+(f==='C'?'pio-C':'pio-D')+'">'+(f==='C'?'SERCOM':'ALT')+'</span>';
  if(isI2C(m,pin)) out+='<span class="tag i2c">I²C-ok</span>';
  var ap=ardPin(pin);
  if(ap==='CUSTOM') out+='<span class="tag cust">custom</span>';
  else if(ap!==null) out+='<span class="tag ard">#'+ap+'</span>';
  return out;
}

// ---- state mutations ----------------------------------------------------
function setProto(s, proto){
  if(!state.cfg[s]) state.cfg[s]={};
  if(state.cfg[s].proto===proto){ proto='none'; }
  state.cfg[s]={proto:proto, sel:{}};
  renderConfigure();
}
function setSignal(s, sig, pin){
  var cf=state.cfg[s]; if(!cf) return;
  var sigs=PROTO_SIG[cf.proto];
  cf.sel[sig]=pin;
  // clear any downstream selections that are now inconsistent
  var combos=enumCombos(mcu(),s,cf.proto);
  var idx=sigs.indexOf(sig);
  for(var j=idx+1;j<sigs.length;j++){
    var prior={}; for(var k=0;k<=idx;k++) prior[sigs[k]]=cf.sel[sigs[k]];
    var pool=matchCombos(combos,prior);
    var ok=pool.some(function(cb){return cb.sig[sigs[j]] && cb.sig[sigs[j]].pin===cf.sel[sigs[j]];});
    if(!ok) cf.sel[sigs[j]]='';
  }
  renderConfigure();
}

// ---- summary ------------------------------------------------------------
function completeConfigs(){
  var m=mcu(), res=[];
  m.sercoms.forEach(function(s){
    var cf=state.cfg[s]; if(!cf||cf.proto==='none'||!cf.proto) return;
    var sigs=PROTO_SIG[cf.proto];
    if(!sigs.every(function(sg){return cf.sel[sg];})) return;
    var combos=matchCombos(enumCombos(m,s,cf.proto), cf.sel);
    if(!combos.length) return;
    res.push({s:s, proto:cf.proto, combo:combos[0]});
  });
  return res;
}

function renderSummary(){
  var m=mcu(), cfgs=completeConfigs(), el=document.getElementById('summary'), html='';
  // pin usage map for conflicts
  var used={};
  cfgs.forEach(function(c){ var sigs=PROTO_SIG[c.proto];
    sigs.forEach(function(sg){ var pin=c.combo.sig[sg].pin; (used[pin]=used[pin]||[]).push('SERCOM'+c.s+' '+SIG_LABEL[sg]); }); });
  var conflicts=Object.keys(used).filter(function(p){return used[p].length>1;});

  // partial (chosen but incomplete) configs
  var partial=[];
  m.sercoms.forEach(function(s){ var cf=state.cfg[s]; if(cf&&cf.proto&&cf.proto!=='none'){
    var sigs=PROTO_SIG[cf.proto]; if(!sigs.every(function(sg){return cf.sel[sg];})) partial.push(s); }});

  if(cfgs.length===0){
    html+='<div class="empty">No fully-configured SERCOMs yet. Choose a protocol and pins on the Configure tab.</div>';
  }

  if(conflicts.length){
    html+='<div class="note err"><b>Pin conflict:</b> the following pins are assigned to more than one SERCOM signal — '+
      conflicts.map(function(p){return '<span class="mono">'+p+'</span> ('+used[p].join(', ')+')';}).join('; ')+'.</div>';
  }
  if(partial.length){
    html+='<div class="note warn">SERCOM'+partial.join(', SERCOM')+' '+(partial.length>1?'have':'has')+
      ' a protocol selected but incomplete pins — not shown below.</div>';
  }

  if(cfgs.length){
    html+='<h2>Pin map</h2><table class="sum"><tr><th>SERCOM</th><th>Protocol</th><th>Signal</th>'+
      '<th>Port pin</th><th>PAD</th><th>Peripheral (Arduino)</th>'+(state.variantId?'<th>Arduino pin</th>':'')+'<th>Notes</th></tr>';
    cfgs.forEach(function(c){ var sigs=PROTO_SIG[c.proto];
      sigs.forEach(function(sg,i){
        var e=c.combo.sig[sg], conf=conflicts.indexOf(e.pin)>=0;
        html+='<tr'+(conf?' class="conflict"':'')+'>';
        if(i===0){ html+='<td rowspan="'+sigs.length+'">SERCOM'+c.s+'</td><td rowspan="'+sigs.length+'">'+c.proto.toUpperCase()+'</td>'; }
        html+='<td>'+SIG_LABEL[sg]+'</td><td class="mono">'+e.pin+'</td><td>PAD'+e.pad+'</td>'+
          '<td class="'+(e.func==='C'?'pio-C':'pio-D')+'">'+pioName(e.func)+'</td>';
        if(state.variantId){ var ap=ardPin(e.pin);
          html+='<td>'+(ap==='CUSTOM'?'<span class="tag cust">custom variant</span>':(ap!==null?ap:'—'))+'</td>'; }
        var notes=[]; if(isI2C(m,e.pin)&&c.proto==='i2c') notes.push('I²C-capable');
        if(m.special&&m.special[e.pin]) notes.push(m.special[e.pin]);
        if(conf) notes.push('CONFLICT');
        html+='<td>'+esc(notes.join('; '))+'</td></tr>';
      });
    });
    html+='</table>';

    // reserved-pin warnings
    var resv=[]; cfgs.forEach(function(c){ PROTO_SIG[c.proto].forEach(function(sg){ var pin=c.combo.sig[sg].pin;
      if(m.special&&m.special[pin]) resv.push(pin+' — '+m.special[pin]); }); });
    resv=resv.filter(function(v,i,a){return a.indexOf(v)===i;});
    if(resv.length) html+='<div class="note warn"><b>Heads up:</b> you are using pins with a default alternate function: '+
      resv.map(esc).join('; ')+'. Make sure your board does not also need them for that purpose.</div>';

    // custom variant summary
    if(state.variantId){
      var customs=[]; cfgs.forEach(function(c){ PROTO_SIG[c.proto].forEach(function(sg){ var pin=c.combo.sig[sg].pin;
        if(ardPin(pin)==='CUSTOM') customs.push(pin); }); });
      customs=customs.filter(function(v,i,a){return a.indexOf(v)===i;});
      if(customs.length) html+='<div class="note warn"><b>Custom variant required:</b> '+customs.map(function(p){return '<span class="mono">'+p+'</span>';}).join(', ')+
        ' '+(customs.length>1?'are':'is')+' not broken out / mapped by the <b>'+esc(D.variants[state.variantId].name)+
        '</b> stock variant. To use '+(customs.length>1?'these pins':'this pin')+' you must create a custom variant (add '+
        (customs.length>1?'them':'it')+' to <span class="mono">g_APinDescription[]</span>).</div>';
    } else {
      html+='<div class="note">No board variant selected — pin numbers below are shown as port pins (e.g. <span class="mono">PA08</span>). '+
        'When you build your board you must map each pin to an Arduino pin number in your variant\'s '+
        '<span class="mono">g_APinDescription[]</span>. Select a board above to check against a stock variant.</div>';
    }

    html+='<h2>Arduino code</h2>';
    html+='<div class="note">Add <code>#include "wiring_private.h"</code> for <code>pinPeripheral()</code>. '+
      'Instantiate the objects globally, then call the setup lines inside <code>setup()</code>.</div>';
    cfgs.forEach(function(c){ html+=genCode(m,c); });
  }

  fill(el, html);
}

// pin token for code: Arduino number if known, else a clear placeholder
function pinTok(pin){
  var ap=ardPin(pin);
  if(ap!==null && ap!=='CUSTOM') return String(ap);
  return '/*'+pin+'*/';
}
function spiPadEnum(dopo){
  var k=dopo.mosi+'_'+dopo.sck;
  return {'0_1':'SPI_PAD_0_SCK_1','2_3':'SPI_PAD_2_SCK_3','3_1':'SPI_PAD_3_SCK_1','0_3':'SPI_PAD_0_SCK_3'}[k];
}
function K(s){return '<span class="kw">'+s+'</span>';}
function C(s){return '<span class="cm">'+esc(s)+'</span>';}
function F(s){return '<span class="fn">'+s+'</span>';}

function genCode(m,c){
  var s=c.s, sig=c.combo.sig, lines=[], setup=[], name;
  var d51=(m.family==='samd51');
  function ppline(sg){ return '  '+F('pinPeripheral')+'('+pinTok(sig[sg].pin)+', '+pioName(sig[sg].func)+');  '+C('// '+sig[sg].pin); }

  if(c.proto==='spi'){
    name='mySPI'+s;
    var rxpad='SERCOM_RX_PAD_'+sig.miso.pad, txpad=spiPadEnum(c.combo.dopo);
    lines.push(C('// SERCOM'+s+' SPI  —  MOSI='+sig.mosi.pin+' SCK='+sig.sck.pin+' MISO='+sig.miso.pin));
    lines.push(K('SPIClass')+' '+name+'(&sercom'+s+', '+pinTok(sig.miso.pin)+', '+pinTok(sig.sck.pin)+', '+pinTok(sig.mosi.pin)+
      ', '+txpad+', '+rxpad+');');
    setup.push('  '+name+'.'+F('begin')+'();');
    setup.push(ppline('miso')); setup.push(ppline('sck')); setup.push(ppline('mosi'));
  } else if(c.proto==='uart'){
    name='mySerial'+s;
    var rxp='SERCOM_RX_PAD_'+sig.rx.pad, txp='UART_TX_PAD_'+sig.tx.pad;
    lines.push(C('// SERCOM'+s+' Serial  —  TX='+sig.tx.pin+' RX='+sig.rx.pin));
    lines.push(K('Uart')+' '+name+'(&sercom'+s+', '+pinTok(sig.rx.pin)+', '+pinTok(sig.tx.pin)+', '+rxp+', '+txp+');');
    if(d51){ [0,1,2,3].forEach(function(v){ lines.push(K('void')+' '+F('SERCOM'+s+'_'+v+'_Handler')+'() { '+name+'.'+F('IrqHandler')+'(); }'); }); }
    else { lines.push(K('void')+' '+F('SERCOM'+s+'_Handler')+'() { '+name+'.'+F('IrqHandler')+'(); }'); }
    setup.push('  '+name+'.'+F('begin')+'(115200);');
    setup.push(ppline('rx')); setup.push(ppline('tx'));
  } else { // i2c
    name='myWire'+s;
    lines.push(C('// SERCOM'+s+' I²C  —  SDA='+sig.sda.pin+' SCL='+sig.scl.pin));
    lines.push(K('TwoWire')+' '+name+'(&sercom'+s+', '+pinTok(sig.sda.pin)+', '+pinTok(sig.scl.pin)+');');
    setup.push('  '+name+'.'+F('begin')+'();');
    setup.push(ppline('sda')); setup.push(ppline('scl'));
  }
  var body=lines.join('\n')+'\n\n'+C('// inside setup():')+'\n'+setup.join('\n');
  var warnCustom = PROTO_SIG[c.proto].some(function(sg){ var ap=ardPin(sig[sg].pin); return ap==null||ap==='CUSTOM'; });
  var h='<div class="codeblock"><h4>SERCOM'+s+' — '+c.proto.toUpperCase()+'</h4><pre>'+body+'</pre>';
  if(warnCustom) h+='<div class="hint">Tokens like <span class="mono">/*PA08*/</span> are placeholders — replace with the '+
    'Arduino pin number for that port pin in your variant (or select a board above to fill them in automatically).</div>';
  h+='</div>';
  return h;
}

// ---- setup / wiring -----------------------------------------------------
function populateMcu(){
  var sel=document.getElementById('mcu');
  sel.innerHTML=Object.keys(D.mcus).map(function(id){ return '<option value="'+id+'">'+esc(D.mcus[id].pretty)+'</option>'; }).join('');
  sel.value=state.mcuId;
}
function populateVariant(){
  var sel=document.getElementById('variant');
  var opts='<option value="">None / my own custom board</option>';
  Object.keys(D.variants).forEach(function(id){ var v=D.variants[id];
    if(v.mcu===state.mcuId) opts+='<option value="'+id+'">'+esc(v.name)+'</option>';
  });
  sel.innerHTML=opts;
  if(state.variantId && D.variants[state.variantId] && D.variants[state.variantId].mcu!==state.mcuId) state.variantId='';
  sel.value=state.variantId;
}
function updateMcuInfo(){
  var m=mcu();
  var np = m.availPins? m.availPins.length : Object.keys(m.mux).length;
  var txt='SERCOM0–'+m.sercoms[m.sercoms.length-1]+' · '+(m.family==='samd51'?'Cortex-M4 (samd51)':'Cortex-M0+ (samd21)');
  if(m.family==='samd51') txt+=' · SPI: SCK fixed to PAD1, MOSI PAD0/3 · UART: TX fixed to PAD0';
  else txt+=' · SPI: 4 DOPO layouts · UART: TX on PAD0 or PAD2';
  document.getElementById('mcuinfo').textContent=txt;
}
function renderAll(){ updateMcuInfo(); renderConfigure(); renderSummary(); }

function switchTab(t){
  document.querySelectorAll('.tab').forEach(function(x){ x.classList.toggle('active', x.dataset.tab===t); });
  document.getElementById('tab-cfg').style.display = t==='cfg'?'':'none';
  document.getElementById('tab-sum').style.display = t==='sum'?'':'none';
  if(t==='sum') renderSummary();
}

function init(){
  state.mcuId=Object.keys(D.mcus)[0];
  populateMcu(); populateVariant();
  document.getElementById('mcu').onchange=function(){ state.mcuId=this.value; state.cfg={}; populateVariant(); renderAll(); };
  document.getElementById('variant').onchange=function(){ state.variantId=this.value; renderAll(); };
  document.getElementById('reset').onclick=function(){ state.cfg={}; renderAll(); };
  document.querySelectorAll('.tab').forEach(function(t){ t.onclick=function(){ switchTab(t.dataset.tab); }; });
  document.getElementById('footer').innerHTML=
    'Sources: SAM D21 Family datasheet (Atmel-42181N) Tables 7-1, 7-4; SAM D5x/E5x Family datasheet (DS60001507F) '+
    'Tables 6-1, 6-8, 6-10…6-17; Adafruit <span class="mono">ArduinoCore-samd</span> (SERCOM.h + board variants); '+
    'Adafruit "Using ATSAMD21 SERCOM" guide. Always double-check against the datasheet for your exact part.';
  renderAll();
}
document.addEventListener('DOMContentLoaded', init);
