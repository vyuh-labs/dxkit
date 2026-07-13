/**
 * Inlined assets for the holistic contract map. One module (no I/O in the
 * builder). A LIVE, graphify-style graph: physics-driven, draggable, explored
 * by DOUBLE-CLICKING one level deeper each time — a route reveals its handler,
 * a handler reveals its internal calls, a function reveals its callees. The
 * initial view is just the contract seam (calls ⋈ routes); depth is on demand.
 * Colors live in JS (canvas can't read CSS vars).
 */

export const MAP_CSS = `
:root{
  --bg:#ffffff; --panel:#f7f8fa; --border:#e2e5ea; --text:#1b1f27; --muted:#6b7280; --faint:#c8ccd4; --accent:#2f6feb;
  --observed:#2e9e5b; --derived:#2f6feb; --inferred:#d98a1f; --unknown:#d1443f; --fn:#7c5cff;
}
:root[data-theme="dark"]{
  --bg:#0d0f15; --panel:#161b25; --border:#242b38; --text:#e8ebf1; --muted:#8b94a4; --faint:#2b3340; --accent:#6aa1ff;
  --observed:#46c17b; --derived:#6aa1ff; --inferred:#e3a94a; --unknown:#ff6b64; --fn:#a98bff;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --bg:#0d0f15; --panel:#161b25; --border:#242b38; --text:#e8ebf1; --muted:#8b94a4; --faint:#2b3340; --accent:#6aa1ff;
  --observed:#46c17b; --derived:#6aa1ff; --inferred:#e3a94a; --unknown:#ff6b64; --fn:#a98bff;
}}
*{box-sizing:border-box}
body{margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
header{padding:15px 22px 10px;border-bottom:1px solid var(--border)}
h1{margin:0 0 2px;font-size:19px;letter-spacing:-.01em}
h1 .sub{color:var(--muted);font-weight:400;font-size:14px}
.prov{color:var(--muted);font-size:12px;margin-top:3px}
.hero{display:flex;flex-wrap:wrap;gap:8px;margin:9px 0 2px;align-items:center}
.stat{border:1px solid var(--border);border-radius:8px;padding:3px 11px;font-size:12px;background:var(--panel)}
.stat b{font-variant-numeric:tabular-nums}
.stat.big{border-color:var(--accent);color:var(--accent);font-weight:600}
.stat.seam{border-color:var(--unknown);color:var(--unknown)} .stat.dead{border-color:var(--inferred);color:var(--inferred)} .stat.cross{border-color:var(--derived);color:var(--derived)}
.disclose{margin-top:7px;color:var(--inferred);font-size:12px;line-height:1.5}
.disclose:empty{display:none}
#cap-note{color:var(--muted)}
.toolbar-in{margin-top:9px}
#search{width:280px;max-width:60%;font:inherit;font-size:13px;padding:6px 11px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text)}
#search:focus{outline:none;border-color:var(--accent)}
.wrap{display:flex;height:calc(100vh - 150px);min-height:430px;position:relative}
#net{flex:1 1 auto;min-width:0}
#net-msg{position:absolute;left:0;top:0;right:290px;bottom:0;display:none;align-items:center;justify-content:center;
  color:var(--muted);font-size:14px;text-align:center;pointer-events:none;padding:24px}
#net-msg.show{display:flex}
#net-msg .spin{display:inline-block;width:13px;height:13px;margin-right:9px;border:2px solid var(--faint);
  border-top-color:var(--accent);border-radius:50%;animation:sp 0.7s linear infinite;vertical-align:middle}
@keyframes sp{to{transform:rotate(360deg)}}
aside{width:290px;flex:0 0 290px;border-left:1px solid var(--border);overflow-y:auto;padding:14px;background:var(--panel);font-size:13px}
aside h2{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:16px 0 6px}
aside h2:first-child{margin-top:0}
.leg{display:flex;align-items:center;gap:8px;margin:5px 0}
.dot{width:11px;height:11px;border-radius:50%;flex:0 0 auto}
.bar{width:20px;height:3px;border-radius:2px;flex:0 0 auto}
.hint{color:var(--muted);font-size:12px;margin-top:8px;line-height:1.65}
.hint b{color:var(--text);font-weight:600}
.toolbar{position:absolute;top:12px;right:304px;display:flex;gap:8px;z-index:2;align-items:center}
.views{display:inline-flex;border:1px solid var(--border);border-radius:7px;overflow:hidden}
.views .view{border:none;border-radius:0;border-right:1px solid var(--border)}
.views .view:last-child{border-right:none}
.views .view.on{background:var(--accent);color:#fff}
button{font:inherit;font-size:12px;padding:5px 11px;border:1px solid var(--border);border-radius:7px;background:var(--panel);color:var(--text);cursor:pointer}
button:hover{border-color:var(--accent)}
.views .view:hover{border-color:transparent}
footer{padding:8px 22px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}
`;

export const MAP_APP_JS = `
(function(){
  var DATA = JSON.parse(document.getElementById('dxkit-contract-data').textContent);
  var V=function(n){return getComputedStyle(document.documentElement).getPropertyValue(n).trim()||'#888';};
  var byId={}; DATA.nodes.forEach(function(n){byId[n.id]=n;});
  var servesByRoute={}; DATA.edges.forEach(function(e){ if(e.kind==='serves') servesByRoute[e.from]=e.to; });
  var net=null, ds=null, es=null, P, focusSet=null, MODE='full';
  var msgEl=document.getElementById('net-msg');
  function showMsg(html){ if(msgEl){ msgEl.innerHTML=html; msgEl.className='show'; } }
  function hideMsg(){ if(msgEl) msgEl.className=''; }
  var EMPTY={ seam:'No HTTP endpoints found in this repo.',
    request:'No request paths found — no routes with resolvable handlers here.',
    full:'No functions resolved in this repo.' };

  function pal(){return{ observed:V('--observed'),derived:V('--derived'),inferred:V('--inferred'),unknown:V('--unknown'),
    accent:V('--accent'),fn:V('--fn'),panel:V('--panel'),text:V('--text'),muted:V('--muted'),faint:V('--faint')};}

  function colorFor(n){ return n.seam==='broken'?P.unknown : n.seam==='dead'?P.inferred
    : n.kind==='call'?P.accent : (n.kind==='handler'||n.kind==='fn')?P.fn : P.observed; }
  function styleNode(n){
    var faded = focusSet && !focusSet.has(n.id);
    var c = colorFor(n);
    var lbl = n.label + (n.kind==='handler'&&typeof n.fanout==='number'?'  ×'+n.fanout : (n.kind==='fn'&&n.fanout?'  ×'+n.fanout:''));
    return { id:n.id, label:lbl, title:n.title||n.label,
      shape:(n.kind==='call'||n.kind==='route')?'box':'ellipse',
      size:n.kind==='route'||n.kind==='call'?16:14,
      color:{background:P.panel,border:faded?P.faint:c,highlight:{background:P.panel,border:c},hover:{background:P.panel,border:c}},
      borderWidth:n.seam?3:1.6, shadow:(n.seam&&!faded)?{enabled:true,color:c,size:16,x:0,y:0}:false,
      font:{color:faded?P.faint:P.text,size:13}, margin:8 };
  }
  function styleEdge(e){
    var faded = focusSet && !(focusSet.has(e.from)&&focusSet.has(e.to));
    var c = (e.kind==='serves'||e.kind==='consumes')?P.observed : e.kind==='calls'?P.fn : e.crossRepo?P.derived : (P[e.label]||P.muted);
    return { id:e.eid, from:e.from, to:e.to, arrows:'to', _kind:e.kind, _label:e.label, _cross:e.crossRepo,
      color:{color:faded?P.faint:c,highlight:c,hover:c,opacity:faded?0.35:1},
      width:e.crossRepo?2.6:1.6, dashes:(e.kind==='cross-repo'||e.label==='inferred'||e.label==='unknown'||e.kind==='lib'),
      smooth:{type:'dynamic'} };
  }

  function addNode(n){ if(!ds.get(n.id)){ ds.add(styleNode(n)); } }
  function addEdge2(from,to,kind,label,cross){ if(!ds.get(from)||!ds.get(to)) return; var eid='e:'+from+'>'+to;
    if(!es.get(eid)) es.add(styleEdge({eid:eid,from:from,to:to,kind:kind,label:label,crossRepo:cross})); }

  // The node for a function drill id: its handler node if it is one, else a
  // synthetic code-graph node.
  function fnNode(did){ var h=byId['d:'+did]; if(h) return h; var f=DATA.fns[did]; if(!f) return null;
    return { id:'d:'+did, kind:'fn', repo:f.repo, drillId:did, label:f.name+'()', fanout:f.fanout,
      title:f.name+'()  ·  '+f.internal.length+' internal, '+f.external.length+' library call(s)' }; }
  function showFn(did){ var o=fnNode(did); if(o) addNode(o); }
  function nodeMeta(id){ if(byId[id]) return byId[id]; var did=id.indexOf('d:')===0?id.slice(2):null;
    var f=did&&DATA.fns[did]; return f?{id:id,kind:'fn',label:f.name+'()',fanout:f.fanout}:{id:id,kind:'fn',label:id}; }

  // Double-click = drill one level deeper: a route reveals its handler, a
  // function reveals its callees.
  function onDouble(id){
    if(id.indexOf('d:')===0){ var f=DATA.fns[id.slice(2)]; if(f){ f.internal.forEach(function(cid){ if(DATA.fns[cid]){ showFn(cid); addEdge2(id,'d:'+cid,'calls','observed'); } }); } return; }
    var n=byId[id]; if(!n) return;
    if(n.kind==='route'&&n.handlerId&&byId[n.handlerId]){ addNode(byId[n.handlerId]); addEdge2(n.id,n.handlerId,'serves','observed'); }
  }

  function neighborsOf(id){ var set=new Set([id]), q=[{id:id,d:0}], out={},inn={};
    es.get().forEach(function(e){ (out[e.from]=out[e.from]||[]).push(e.to); (inn[e.to]=inn[e.to]||[]).push(e.from); });
    while(q.length){ var c=q.shift(); if(c.d>=5)continue;
      (out[c.id]||[]).concat(inn[c.id]||[]).forEach(function(t){ if(!set.has(t)){set.add(t);q.push({id:t,d:c.d+1});} }); }
    return set; }
  function repaint(){ ds.update(ds.get().map(function(o){ return styleNode(nodeMeta(o.id)); }));
    es.update(es.get().map(function(o){ return styleEdge({eid:o.id,from:o.from,to:o.to,kind:o._kind,label:o._label,crossRepo:o._cross}); })); }

  // Build the dataset for a view mode: seam = contract only; request = + the
  // code on the request paths; full = the whole code graph + contract overlay.
  function render(){
    focusSet=null; ds.clear(); es.clear();
    // Physics force-layout is unusable past ~700 nodes, so the code-graph views
    // enforce a hard node BUDGET (priority: seams → request-path / top-fanout).
    // The Seam view is a physics-off grid, so it shows every endpoint regardless.
    var BUDGET=650;
    if(MODE==='seam'){
      DATA.nodes.forEach(function(n){ if(n.kind==='call'||n.kind==='route') addNode(n); });
    } else {
      DATA.nodes.forEach(function(n){ if(n.kind==='call' && ds.length<BUDGET) addNode(n); });
      if(MODE==='request'){
        var seed=[];
        DATA.nodes.forEach(function(n){ if(n.kind==='handler'&&n.drillId&&ds.length<BUDGET){ addNode(n); seed.push(n.drillId); }
          if(n.kind==='route'&&n.callerDrillIds) n.callerDrillIds.forEach(function(c){ seed.push(c); }); });
        DATA.nodes.forEach(function(n){ if(n.kind==='route'&&(n.seam||n.callerDrillIds)&&ds.length<BUDGET) addNode(n); });
        var seen={}; while(seed.length && ds.length<BUDGET){ var d=seed.shift(); if(seen[d])continue; seen[d]=1; showFn(d);
          var f=DATA.fns[d]; if(f) f.internal.forEach(function(c){ if(DATA.fns[c]&&!seen[c]) seed.push(c); }); }
      } else { // full: endpoints (routes + handlers) FIRST, then the code graph
        var RCAP=Math.floor(BUDGET*0.55); // reserve for the contract layer
        DATA.nodes.forEach(function(n){ if(n.kind==='route'&&ds.length<RCAP){ addNode(n);
          if(n.handlerId&&byId[n.handlerId]) addNode(byId[n.handlerId]); } });
        var fs=Object.keys(DATA.fns).sort(function(a,b){ return (DATA.fns[b].fanout||0)-(DATA.fns[a].fanout||0); });
        for(var i=0;i<fs.length&&ds.length<BUDGET;i++) showFn(fs[i]);
      }
    }
    DATA.edges.forEach(function(e){ if(e.kind==='cross-repo') addEdge2(e.from,e.to,e.kind,e.label,e.crossRepo);
      else if(e.kind==='serves') addEdge2(e.from,e.to,'serves','observed'); });
    if(MODE!=='seam'){
      for(var d2 in DATA.fns){ if(!ds.get('d:'+d2)) continue; DATA.fns[d2].internal.forEach(function(c){ addEdge2('d:'+d2,'d:'+c,'calls','observed'); }); }
      DATA.nodes.forEach(function(n){ if(n.kind==='route'&&n.callerDrillIds) n.callerDrillIds.forEach(function(c){ addEdge2('d:'+c,n.id,'consumes','observed'); }); });
      DATA.nodes.forEach(function(n){ if(n.kind==='call'&&n.drillId) addEdge2(n.id,'d:'+n.drillId,'calls','observed'); });
    }
    // Disclose when the view is capped for performance (why the graph is partial).
    var capEl=document.getElementById('cap-note');
    if(capEl){
      if(MODE==='seam'){ capEl.textContent=''; }
      else {
        var totalNodes=Object.keys(DATA.fns).length + DATA.nodes.filter(function(n){return n.kind==='route'||n.kind==='call';}).length;
        if(ds.length<totalNodes){ var disc=document.querySelector('.disclose');
          var hasNotes=disc&&disc.firstChild&&disc.firstChild.nodeType===3&&disc.firstChild.textContent.trim().length>0;
          capEl.textContent=(hasNotes?' · ':'')+'showing '+ds.length.toLocaleString()+' of '+totalNodes.toLocaleString()+' nodes (large graph — Seam shows every endpoint)';
        } else capEl.textContent='';
      }
    }
    if(!net) return;
    if(ds.length===0){ showMsg(EMPTY[MODE]||'Nothing to show.'); net.setOptions({physics:false}); net.fit({animation:false}); return; }
    if(MODE==='seam'){
      // Mostly edge-less endpoints — a physics sim flings them apart, so lay a
      // clean grid (seams grouped first), physics off but still draggable.
      net.setOptions({physics:false});
      var ids=ds.getIds().slice().sort(function(a,b){ var na=nodeMeta(a),nb=nodeMeta(b); var rank={broken:0,dead:1};
        return ((rank[na.seam]==null?2:rank[na.seam])-(rank[nb.seam]==null?2:rank[nb.seam])) || String(na.label).localeCompare(String(nb.label)); });
      var cols=Math.max(4,Math.ceil(Math.sqrt(ids.length)));
      ids.forEach(function(id,i){ ds.update({id:id, x:(i%cols)*230-(cols-1)*115, y:Math.floor(i/cols)*74, fixed:false}); });
      net.fit({animation:false}); hideMsg();
    } else {
      showMsg('<span class="spin"></span>laying out '+ds.length+' nodes…');
      net.setOptions({physics:{enabled:true, stabilization:{iterations:MODE==='full'?70:150}}});
      ds.getIds().forEach(function(id){ ds.update({id:id, x:undefined, y:undefined}); });
      net.once('stabilizationIterationsDone', function(){ net.fit({animation:false}); hideMsg(); });
      net.stabilize(); net.fit({animation:false});
    }
  }
  function setMode(m){ MODE=m; ['seam','request','full'].forEach(function(k){ var b=document.getElementById('v-'+k); if(b) b.className='view'+(k===m?' on':''); }); render(); }

  function draw(){
    if(typeof vis==='undefined'){ showMsg('Interactive graph unavailable.'); return; } P=pal();
    ds=new vis.DataSet(); es=new vis.DataSet();
    net=new vis.Network(document.getElementById('net'),{nodes:ds,edges:es},{
      layout:{randomSeed:12, improvedLayout:true},
      physics:{ enabled:true, solver:'barnesHut',
        barnesHut:{ gravitationalConstant:-7000, centralGravity:0.35, springLength:115, springConstant:0.05, damping:0.6, avoidOverlap:0.55 },
        stabilization:{ iterations:150, fit:true }, minVelocity:0.7 },
      interaction:{ hover:true, hoverConnectedEdges:true, dragNodes:true, dragView:true, zoomView:true, tooltipDelay:110, navigationButtons:true, keyboard:false },
      nodes:{ shapeProperties:{borderRadius:5} }
    });
    net.on('doubleClick', function(p){ if(p.nodes.length) onDouble(p.nodes[0]); });
    net.on('click', function(p){ if(!p.nodes.length){ focusSet=null; repaint(); return; } focusSet=neighborsOf(p.nodes[0]); repaint(); });
    ['seam','request','full'].forEach(function(k){ var b=document.getElementById('v-'+k); if(b) b.addEventListener('click',function(){ setMode(k); }); });
    render();
  }

  var search=document.getElementById('search');
  if(search) search.addEventListener('input',function(){ var q=this.value.trim().toLowerCase();
    if(!q){ focusSet=null; repaint(); return; }
    focusSet=new Set(ds.get().filter(function(o){ return (o.label||'').toLowerCase().indexOf(q)>=0; }).map(function(o){return o.id;})); repaint(); });
  var t=document.getElementById('theme-toggle');
  if(t)t.addEventListener('click',function(){ var r=document.documentElement,cur=r.getAttribute('data-theme');
    r.setAttribute('data-theme',cur==='dark'?'light':(cur==='light'?'dark':'light')); draw(); });
  draw();
})();
`;
