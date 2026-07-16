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
  // wire dropdown options
  grid.querySelectorAll('.ddopt').forEach(function(o){
    o.onclick=function(ev){ ev.preventDefault(); setSignal(+o.dataset.s, o.dataset.sig, o.dataset.pin); };
  });
}

// pin ->[{s,sig}] : every pin currently assigned to some SERCOM signal
function usageMap(){
  var um={};
  for(var s in state.cfg){ var cf=state.cfg[s]; if(!cf||!cf.proto||cf.proto==='none') continue;
    PROTO_SIG[cf.proto].forEach(function(sig){ var pin=cf.sel[sig];
      if(pin){ (um[pin]=um[pin]||[]).push({s:+s,sig:sig}); } });
  }
  return um;
}
// is `pin` for `sig` compatible with the OTHER signals currently chosen?
function pinValidFor(combos, sig, pin, sel){
  var c={}; for(var k in sel){ if(sel[k] && k!==sig) c[k]=sel[k]; }
  c[sig]=pin;
  return matchCombos(combos,c).length>0;
}
// short inner HTML for a pin (pad/func + badges)
function chipInner(m, pin, s){
  var e=muxEntry(m,pin,s), f=e?e.f:null;
  var h='<span class="mono">'+pin+'</span> <span class="'+(f==='C'?'pio-C':'pio-D')+'">'+
        (f==='C'?'SERCOM':'ALT')+'·PAD'+(e?e.pad:'?')+'</span>';
  if(isI2C(m,pin)) h+='<span class="tag i2c">I²C</span>';
  var ap=ardPin(pin);
  if(ap==='CUSTOM') h+='<span class="tag cust">custom</span>';
  else if(ap!==null) h+='<span class="tag ard">#'+ap+'</span>';
  if(m.special&&m.special[pin]) h+='<span class="tag warn" title="'+esc(m.special[pin])+'">⚠</span>';
  return h;
}
function invalidReason(m,s,proto,sel){
  if(m.iosets){
    var iosets=m.iosets[String(s)]||[], pins=PROTO_SIG[proto].map(function(sg){return sel[sg];});
    var oneSet=iosets.some(function(io){ return pins.every(function(p){ return io.indexOf(p)>=0; }); });
    if(!oneSet) return 'these pins are not all in the same IOSET — a SERCOM cannot mix IOSETs on SAMD51.';
  }
  if(proto==='spi') return 'MOSI/SCK are not a supported pad layout (DOPO), or two signals land on the same PAD.';
  if(proto==='uart') return 'TX must be on '+(m.uartTx.length>1?'PAD0 or PAD2':'PAD0')+', and RX on a different PAD.';
  return 'this pin combination is not hardware-valid for '+proto.toUpperCase()+'.';
}

function renderSelector(m,s,cf){
  var proto=cf.proto, sigs=PROTO_SIG[proto];
  var combos=enumCombos(m,s,proto);
  var html='<div class="selarea">';
  if(combos.length===0){
    html+='<div class="empty">No valid '+proto.toUpperCase()+' pin set exists for SERCOM'+s+' on this MCU'+
      (proto==='i2c'?' — no I²C-capable PAD0/PAD1 pair is available.':'.')+'</div></div>';
    return html;
  }
  var sel=cf.sel||{};
  var usage=usageMap();
  if(combos.length===1) html+='<div class="onlyopt">Only one valid pin set for this SERCOM — pre-selected.</div>';

  sigs.forEach(function(sig){
    var uni={}; combos.forEach(function(cb){ if(cb.sig[sig]) uni[cb.sig[sig].pin]=1; });
    var pins=Object.keys(uni).sort();
    var chosen=sel[sig];
    var curConf = chosen && (usage[chosen]||[]).some(function(u){return !(u.s===s&&u.sig===sig);});
    var curBad  = chosen && !pinValidFor(combos,sig,chosen,sel);
    var curCls  = chosen ? ('has'+(curConf?' cur-conflict':'')+(curBad?' cur-invalid':'')) : 'empty';
    html+='<div class="picker"><div class="sn">'+SIG_LABEL[sig]+'</div>';
    html+='<details class="dd"><summary class="ddcur '+curCls+'">'+
          (chosen? chipInner(m,chosen,s) : '<span class="ph">— choose —</span>')+'</summary>';
    html+='<div class="ddlist">';
    pins.forEach(function(pin){
      var isSel=chosen===pin;
      var usedElse=(usage[pin]||[]).some(function(u){return !(u.s===s&&u.sig===sig);});
      var compat=pinValidFor(combos,sig,pin,sel);
      html+='<div class="ddopt'+(isSel?' sel':'')+(usedElse?' used':'')+(compat?'':' incompat')+
            '" data-s="'+s+'" data-sig="'+sig+'" data-pin="'+pin+'">'+chipInner(m,pin,s)+
            (usedElse?'<span class="tag warn">in use</span>':'')+
            (compat?'':'<span class="tag amb">≠ current pads</span>')+'</div>';
    });
    html+='</div></details></div>';
  });

  var allSel=sigs.every(function(sg){return sel[sg];});
  var match=allSel?matchCombos(combos,sel):[];
  if(match.length){
    var cb=match[0], parts=sigs.map(function(sg){return SIG_LABEL[sg]+'='+cb.sig[sg].pin;});
    html+='<div class="done">✓ valid — '+parts.join(', ')+'</div>';
  } else if(allSel){
    html+='<div class="err-line">⚠ Not a valid set: '+esc(invalidReason(m,s,proto,sel))+'</div>';
  } else {
    html+='<div class="hint">Pick a pin for each signal.</div>';
  }
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
function reRender(){ renderConfigure(); renderSummary(); }
function setProto(s, proto){
  if(!state.cfg[s]) state.cfg[s]={};
  if(state.cfg[s].proto===proto){ proto='none'; }
  state.cfg[s]={proto:proto, sel:{}};
  if(proto!=='none'){
    var combos=enumCombos(mcu(),s,proto);
    if(combos.length===1){ PROTO_SIG[proto].forEach(function(sg){ state.cfg[s].sel[sg]=combos[0].sig[sg].pin; }); }
  }
  reRender();
}
// select a pin for one signal; clicking the current pin clears it. No cascade — other picks are kept
// (invalid/conflicting results are shown, not prevented) so the user can freely experiment.
function setSignal(s, sig, pin){
  var cf=state.cfg[s]; if(!cf) return;
  cf.sel[sig] = (cf.sel[sig]===pin) ? '' : pin;
  reRender();
}

// ---- summary ------------------------------------------------------------
// every SERCOM with a protocol chosen, with completeness / validity resolved
function allStatuses(){
  var m=mcu(), res=[];
  m.sercoms.forEach(function(s){
    var cf=state.cfg[s]; if(!cf||cf.proto==='none'||!cf.proto) return;
    var sigs=PROTO_SIG[cf.proto];
    var complete=sigs.every(function(sg){return cf.sel[sg];});
    var match=complete?matchCombos(enumCombos(m,s,cf.proto), cf.sel):[];
    res.push({s:s, proto:cf.proto, sel:cf.sel, sigs:sigs, complete:complete,
              valid:match.length>0, combo:match[0]||null});
  });
  return res;
}

function renderSummary(){
  var m=mcu(), st=allStatuses(), el=document.getElementById('summary'), html='';
  var usage=usageMap();
  var conflicts=Object.keys(usage).filter(function(p){return usage[p].length>1;});
  var complete=st.filter(function(x){return x.complete;});
  var validCfgs=complete.filter(function(x){return x.valid;});
  var invalidCfgs=complete.filter(function(x){return !x.valid;});
  var incomplete=st.filter(function(x){return !x.complete;}).map(function(x){return x.s;});

  if(st.length===0){
    fill(el,'<div class="empty">No SERCOMs configured yet. Choose a protocol and pins on the Configure tab.</div>');
    return;
  }
  if(conflicts.length){
    html+='<div class="note err"><b>Pin conflict:</b> '+conflicts.map(function(p){
      return '<span class="mono">'+p+'</span> ('+usage[p].map(function(u){return 'SERCOM'+u.s+' '+SIG_LABEL[u.sig];}).join(', ')+')';
    }).join('; ')+' — the same physical pin is assigned to more than one signal.</div>';
  }
  if(invalidCfgs.length){
    html+='<div class="note err"><b>Invalid pin set:</b> '+invalidCfgs.map(function(x){
      return 'SERCOM'+x.s+' — '+esc(invalidReason(m,x.s,x.proto,x.sel));
    }).join('  ')+' No code is generated for these until fixed.</div>';
  }
  if(incomplete.length){
    html+='<div class="note warn">SERCOM'+incomplete.join(', SERCOM')+' '+(incomplete.length>1?'have':'has')+
      ' a protocol selected but not all pins chosen.</div>';
  }

  if(complete.length){
    html+='<h2>Pin map</h2><table class="sum"><tr><th>SERCOM</th><th>Protocol</th><th>Signal</th>'+
      '<th>Port pin</th><th>PAD</th><th>Peripheral (Arduino)</th>'+(state.variantId?'<th>Arduino pin</th>':'')+'<th>Notes</th></tr>';
    complete.forEach(function(x){
      x.sigs.forEach(function(sg,i){
        var pin=x.sel[sg], e=(x.combo&&x.combo.sig[sg])||muxEntry(m,pin,x.s)||{pad:'?',func:'?'};
        var conf=conflicts.indexOf(pin)>=0;
        html+='<tr'+(conf||!x.valid?' class="conflict"':'')+'>';
        if(i===0){ html+='<td rowspan="'+x.sigs.length+'">SERCOM'+x.s+(x.valid?'':' <span class="tag amb">invalid</span>')+
          '</td><td rowspan="'+x.sigs.length+'">'+x.proto.toUpperCase()+'</td>'; }
        html+='<td>'+SIG_LABEL[sg]+'</td><td class="mono">'+pin+'</td><td>'+(e.pad==='?'?'?':'PAD'+e.pad)+'</td>'+
          '<td class="'+(e.func==='C'?'pio-C':(e.func==='D'?'pio-D':''))+'">'+(e.func==='?'?'—':pioName(e.func))+'</td>';
        if(state.variantId){ var ap=ardPin(pin);
          html+='<td>'+(ap==='CUSTOM'?'<span class="tag cust">custom variant</span>':(ap!==null?ap:'—'))+'</td>'; }
        var notes=[]; if(isI2C(m,pin)&&x.proto==='i2c') notes.push('I²C-capable');
        if(m.special&&m.special[pin]) notes.push(m.special[pin]);
        if(conf) notes.push('CONFLICT');
        html+='<td>'+esc(notes.join('; '))+'</td></tr>';
      });
    });
    html+='</table>';
  }

  var pinsInUse=[]; complete.forEach(function(x){ x.sigs.forEach(function(sg){ pinsInUse.push(x.sel[sg]); }); });
  var resv=pinsInUse.filter(function(p,i,a){return a.indexOf(p)===i && m.special && m.special[p];})
                    .map(function(p){return p+' — '+m.special[p];});
  if(resv.length) html+='<div class="note warn"><b>Heads up:</b> pins with a default alternate function are in use: '+
    resv.map(esc).join('; ')+'. Make sure your board does not also need them for that purpose.</div>';

  if(state.variantId){
    var customs=pinsInUse.filter(function(p,i,a){return a.indexOf(p)===i && ardPin(p)==='CUSTOM';});
    if(customs.length) html+='<div class="note warn"><b>Custom variant required:</b> '+
      customs.map(function(p){return '<span class="mono">'+p+'</span>';}).join(', ')+' '+(customs.length>1?'are':'is')+
      ' not broken out / mapped by the <b>'+esc(D.variants[state.variantId].name)+'</b> stock variant. Add '+
      (customs.length>1?'them':'it')+' to <span class="mono">g_APinDescription[]</span> in a custom variant to use '+
      (customs.length>1?'them':'it')+'.</div>';
  } else if(complete.length){
    html+='<div class="note">No board variant selected — pins are shown as port pins (e.g. <span class="mono">PA08</span>). '+
      'Map each to an Arduino pin number in your variant\'s <span class="mono">g_APinDescription[]</span>, or select a board above.</div>';
  }

  if(validCfgs.length){
    html+='<h2>Arduino code</h2>';
    html+='<div class="note">Add <code>#include "wiring_private.h"</code> for <code>pinPeripheral()</code>. '+
      'Instantiate the objects globally, then call the setup lines inside <code>setup()</code>.</div>';
    validCfgs.forEach(function(x){ html+=genCode(m,{s:x.s,proto:x.proto,combo:x.combo}); });
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
