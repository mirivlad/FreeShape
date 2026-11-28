// Local cursor, preview and hit testing. Only committed edits go to the native Python solver.
const $=id=>document.getElementById(id);
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1];
const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
const add=(a,b,t=1)=>[a[0]+b[0]*t,a[1]+b[1]*t];
const tau=2*Math.PI;
const constraintHints={coincident:"Совпадение: две точки, точка и кривая или две окружности/дуги",point_on:"Точка на кривой: точка и кривая",horizontal:"Горизонтальность: отрезок или две точки",vertical:"Вертикальность: отрезок или две точки",parallel:"Параллельность: два отрезка",perpendicular:"Перпендикулярность: два отрезка или отрезок и кривая",normal:"Нормаль: отрезок и окружность, дуга или эллипс",tangent:"Касательность: отрезок и круговая кривая или две круговые кривые",equal:"Равенство: два отрезка или две круговые кривые",midpoint:"Середина: точка и отрезок или дуга",concentric:"Концентричность: две круговые кривые или кривая и точка",fix:"Фиксация: точка или объект",symmetric:"Симметрия: две точки, два отрезка или две круговые кривые, затем ось"};
const constraintGlyphs={coincident:"●",point_on:"●",horizontal:"H",vertical:"V",parallel:"∥",perpendicular:"⊥",tangent:"◡",normal:"⊾",symmetric:"⋈",equal:"=",midpoint:"M",concentric:"◎",fix:"⚓"};
const wrap=a=>(a%tau+tau)%tau;
function intersect(a,b){
 if(a.kind==="line"&&b.kind==="line"){
  const d=sub(a.b,a.a),e=sub(b.b,b.a),den=cross(d,e);if(Math.abs(den)<1e-10)return [];
  return [add(a.a,d,cross(sub(b.a,a.a),e)/den)];
 }
 if(a.kind==="circle"&&b.kind==="line")return intersect(b,a);
 if(a.kind==="line"&&b.kind==="circle"){
  const d=sub(a.b,a.a),v=sub(a.a,b.c),A=dot(d,d),B=2*dot(d,v),C=dot(v,v)-b.r*b.r,D=B*B-4*A*C;
  if(A<1e-12||D<-1e-9)return [];
  return [...new Set([(-B+Math.sqrt(Math.max(0,D)))/(2*A),(-B-Math.sqrt(Math.max(0,D)))/(2*A)])].map(t=>add(a.a,d,t));
 }
 const d=sub(b.c,a.c),L=Math.hypot(...d);if(L<1e-10||L>a.r+b.r+1e-8||L<Math.abs(a.r-b.r)-1e-8)return [];
 const u=d.map(x=>x/L),x=(a.r*a.r-b.r*b.r+L*L)/(2*L),h=Math.sqrt(Math.max(0,a.r*a.r-x*x)),p=add(a.c,u,x);
 return [add(p,[-u[1],u[0]],h),add(p,[-u[1],u[0]],-h)];
}
function contains(c,q){
 if(c.kind==="line"){const d=sub(c.b,c.a),t=dot(sub(q,c.a),d)/Math.max(dot(d,d),1e-20);return t>=-1e-7&&t<=1+1e-7;}
 if(c.arc){const t=wrap(Math.atan2(q[1]-c.c[1],q[0]-c.c[0])-c.arc[0]);return t<=c.arc[1]+1e-7||t>=tau-1e-7;}
 return true;
}
function project(c,q){
 if(c.kind==="line"){const d=sub(c.b,c.a);return add(c.a,d,Math.max(0,Math.min(1,dot(sub(q,c.a),d)/Math.max(dot(d,d),1e-20))));}
 const v=sub(q,c.c),L=Math.hypot(...v);return L>1e-12?add(c.c,v,c.r/L):add(c.c,[1,0],c.r);
}
export class SketchEditor {
 constructor(send,finish,status,preview){
  this.send=send;this.preview=preview;this.offers=[];this.splineVersion=0;this.splineTimer=0;this.splineInFlight=false;this.splinePath=null;this.finish=finish;this.status=status;this.canvas=$("sketch-canvas");this.ctx=this.canvas.getContext("2d");
  this.active=false;this.busy=false;this.tool="select";this.constraintTool=null;this.snapSources=[];this.wakeEntities=[];this.anchors=[];this.selection=new Set();this.scale=8;this.center=[0,0];this.mouse=null;this.pan=null;this.drag=null;this.state=null;this.dimEditing=null;
  this.canvas.addEventListener("contextmenu",e=>e.preventDefault());
  this.canvas.addEventListener("pointerdown",e=>this.down(e));
  this.canvas.addEventListener("pointermove",e=>this.move(e));
  this.canvas.addEventListener("pointerup",e=>this.up(e));
  this.canvas.addEventListener("pointercancel",()=>{this.pan=null;this.drag=null;this.draw();});
  this.canvas.addEventListener("wheel",e=>this.wheel(e),{passive:false});
  new ResizeObserver(()=>{if(this.active)this.resize();}).observe(this.canvas);
  for(const b of document.querySelectorAll("[data-tool]"))b.onclick=()=>this.setTool(b.dataset.tool);
  for(const b of document.querySelectorAll("[data-constraint]"))b.onclick=()=>this.constraint(b.dataset.constraint);
  $("sk-show-regions").onchange=()=>this.draw();
  $("sk-show-constraints").onchange=()=>{$("sk-constraints").hidden=!$("sk-show-constraints").checked;this.dimEditing=null;this.draw();};
  $("sk-spline-done").onclick=()=>this.finishSpline();$("sk-sides").oninput=()=>this.draw();$("sk-spline-closed").onchange=()=>this.draw();
  $("sk-offer-apply").onclick=()=>this.applyOffer();
  $("sk-offer-skip").onclick=()=>this.clearOffers();
  $("sk-offer-value").addEventListener("keydown",e=>{if(e.key==="Enter"||e.key==="Escape"){e.preventDefault();e.stopPropagation();if(e.key==="Enter")this.applyOffer();else {this.clearOffers();this.canvas.focus();}}});
  $("sk-delete").onclick=()=>this.remove();
  $("sk-undo").onclick=()=>this.change("sketch_undo");
  $("sk-redo").onclick=()=>this.change("sketch_redo");
  $("sk-fit").onclick=()=>this.fit();
  $("sk-finish").onclick=()=>this.end("sketch_finish");
  $("sk-cancel").onclick=()=>this.end("sketch_cancel");
  window.addEventListener("keydown",e=>{
   if(!this.active||e.target.matches("input,textarea,select"))return;
   const keys={KeyL:"line",KeyR:"rect",KeyC:"circle",KeyA:"arc",KeyP:"point",KeyE:"ellipse",KeyS:"spline",KeyM:"trim",KeyX:"extend",Escape:"select"};
   if(e.code==="Enter"&&this.tool==="spline"){e.preventDefault();this.finishSpline();}
   else if(e.ctrlKey&&e.code==="KeyZ"){e.preventDefault();this.change(e.shiftKey?"sketch_redo":"sketch_undo");}
   else if(e.ctrlKey&&e.code==="KeyY"){e.preventDefault();this.change("sketch_redo");}
   else if(e.code==="Delete"){e.preventDefault();this.remove();}
   else if(!e.ctrlKey&&!e.altKey&&!e.metaKey&&keys[e.code]){e.preventDefault();this.setTool(keys[e.code]);}
  });
 }
 show(s){this.active=true;this.state=s;this.anchors=[];this.selection.clear();this.mouse=null;this.center=[0,0];this.scale=8;
  $("dimension-overlay").hidden=false;$("sketch-canvas").hidden=false;$("sketch-tools").hidden=false;$("sketch-panel").hidden=false;$("model-panel").hidden=true;$("view-controls").hidden=true;
  $("sk-title").textContent=s.id?"Эскиз "+s.id:"Новый эскиз";$("sk-plane").textContent=s.plane.kind==="std"?s.plane.name:s.plane.kind==="face"?"Грань":"Плоскость";$("sk-show-regions").checked=true;$("sk-show-constraints").checked=true;$("sk-constraints").hidden=false;this.setTool("select");this.resize();this.fit();this.updateInfo();}
 hide(){this.active=false;this.clearOffers();this.clearSplinePreview();this.dimEditing=null;$("dimension-overlay").replaceChildren();$("dimension-overlay").hidden=true;this.state=null;this.anchors=[];this.selection.clear();$("sketch-canvas").hidden=true;$("sketch-tools").hidden=true;$("sketch-panel").hidden=true;$("model-panel").hidden=false;$("view-controls").hidden=false;}
 resize(){const r=this.canvas.getBoundingClientRect();this.w=Math.max(1,r.width);this.h=Math.max(1,r.height);const d=Math.min(devicePixelRatio,2);this.canvas.width=Math.round(this.w*d);this.canvas.height=Math.round(this.h*d);this.ctx.setTransform(d,0,0,d,0,0);this.draw();}
 screen(q){return [this.w/2+(q[0]-this.center[0])*this.scale,this.h/2-(q[1]-this.center[1])*this.scale];}
 uv(p){return [this.center[0]+(p[0]-this.w/2)/this.scale,this.center[1]-(p[1]-this.h/2)/this.scale];}
 eventPos(e){const r=this.canvas.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
 fit(){const pts=[...Object.values(this.state?.draft.points||{}),...Object.values(this.state?.curves||{}).flat(2),...(this.state?.model_edges||[]).flatMap(m=>m.path)];if(pts.length>1){const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]),a=Math.min(...xs),b=Math.max(...xs),c=Math.min(...ys),d=Math.max(...ys);this.center=[(a+b)/2,(c+d)/2];this.scale=Math.min(this.w/Math.max(b-a,10),this.h/Math.max(d-c,10))*.72;}else {this.center=[0,0];this.scale=Math.min(this.w,this.h)/100;}this.draw();}
 setTool(t){if(this.busy)return;this.snapSources=[];this.wakeEntities=[];this.setConstraintTool(null);this.clearOffers();this.clearSplinePreview();this.tool=t;this.anchors=[];this.mouse=null;this.toolOptions();for(const b of document.querySelectorAll("[data-tool]"))b.classList.toggle("active",b.dataset.tool===t);this.draw();}
 toolOptions(){
  const polygon=["polygon","polygon_out"].includes(this.tool),spline=this.tool==="spline",ellipse=this.tool==="ellipse";
  const modify=this.modifying();
  $("sk-tool-options").hidden=!(polygon||spline||ellipse||modify||["line","arc","rect","center_rect","circle"].includes(this.tool));$("sk-polygon-options").hidden=!polygon;$("sk-spline-options").hidden=!spline;
  $("sk-tool-help").textContent=ellipse?"Центр → конец оси → вторая полуось":spline?"Щёлкайте точки; Enter или двойной щелчок — завершить, первая точка — замкнуть, Esc — отменить":polygon?(this.tool==="polygon"?"Центр → вершина":"Центр → середина стороны"):({line:"Цепочка отрезков; Esc — закончить",arc:"Начало → конец → точка на дуге",rect:"Два противоположных угла",center_rect:"Центр → угол",circle:"Центр → радиус",trim:"Щёлкните удаляемый участок отрезка между пересечениями",split:"Щёлкните точку разделения отрезка или дуги",extend:"Щёлкните ближе к концу, который нужно удлинить до следующей кривой"}[this.tool]||"");
 }
 modifying(){return ["trim","split","extend"].includes(this.tool);}
 modTarget(q){return this.pick(q,e=>!e.helper&&(e.type==="line"||(this.tool!=="trim"&&e.type==="arc")));}
 polygonSides(){const n=Number($("sk-sides").value);return Number.isInteger(n)&&n>=3&&n<=64?n:null;}
 finishSpline(closed=$("sk-spline-closed").checked){if(this.busy||this.tool!=="spline")return;if(this.anchors.length<(closed?3:2)){this.status("Недостаточно точек сплайна");return;}const points=this.anchors;this.anchors=[];this.clearSplinePreview();this.change("sketch_draw",{tool:"spline",points,closed,construction:$("construction").checked});}
 clearOffers(){this.offers=[];$("sk-draw-dims").hidden=true;}
 showOffer(){const o=this.offers[0];$("sk-draw-dims").hidden=!o;if(!o)return;$("sk-offer-label").textContent=o.label+", мм";const input=$("sk-offer-value");input.value=Number(o.value.toFixed(6));input.focus();input.select();}
 async applyOffer(){if(this.busy||!this.offers.length)return;const o=this.offers[0],input=$("sk-offer-value"),value=Number(input.value);if(!input.checkValidity()||!(value>0)){input.reportValidity();return;}if(await this.change("sketch_offer_dimension",{kind:o.kind,refs:o.refs,value})){this.offers.shift();this.showOffer();if(!this.offers.length)this.canvas.focus();}}
 clearSplinePreview(){clearTimeout(this.splineTimer);this.splineVersion++;this.splinePath=null;}
 scheduleSplinePreview(){this.clearSplinePreview();if(!this.active||this.tool!=="spline"||!this.mouse||!this.anchors.length||this.busy)return;const version=this.splineVersion,pts=this.anchors.map(a=>a.uv);if(distance(pts.at(-1),this.mouse.uv)>1e-8&&pts.length<128)pts.push(this.mouse.uv);const closed=$("sk-spline-closed").checked&&pts.length>=3;this.splineTimer=setTimeout(async()=>{if(this.splineInFlight||version!==this.splineVersion||this.busy)return;this.splineInFlight=true;try{const r=await this.preview("sketch_spline_preview",{points:pts,closed});if(version===this.splineVersion&&this.active&&this.tool==="spline"){this.splinePath=r.points;this.draw();}}catch{}finally{this.splineInFlight=false;}},45);}
 curves(){const {points,entities}=this.state.draft,out=[];for(const [id,e] of Object.entries(entities)){
  if(e.type==="line"){out.push({id,kind:"line",a:points[e.p1],b:points[e.p2]});}
  else if(e.type==="circle"||e.type==="arc"){const c=points[e.c],r=e.type==="circle"?e.r:distance(c,points[e.p1]);const obj={id,kind:"circle",c,r};if(e.type==="arc"){const a=Math.atan2(points[e.p1][1]-c[1],points[e.p1][0]-c[0]),b=Math.atan2(points[e.p2][1]-c[1],points[e.p2][0]-c[0]);obj.arc=[a,wrap(b-a)];}out.push(obj);}
 }return out;}
 rememberSnap(hit,curves){
  if(!hit?.ref)return;
  const r=hit.ref;
  if(["point","mid","quadrant","intersection","rect_center"].includes(r.kind)){
   const k=JSON.stringify(r);this.snapSources=this.snapSources.filter(x=>JSON.stringify(x.ref)!==k);this.snapSources.push({uv:hit.uv,ref:r});this.snapSources=this.snapSources.slice(-8);
  }
  const {entities}=this.state.draft;
  const ids=r.kind==="point"?Object.keys(entities).filter(id=>[entities[id].p1,entities[id].p2,entities[id].c].includes(r.id)):r.ids||[r.id];
  for(const id of ids){if(curves.some(c=>c.id===id)){this.wakeEntities=this.wakeEntities.filter(x=>x!==id);this.wakeEntities.push(id);this.wakeEntities=this.wakeEntities.slice(-6);}}
 }
 sourcePosition(src,curves){
  const r=src.ref,{points}=this.state.draft;
  if(r.kind==="point")return points[r.id];
  if(r.kind==="rect_center"){const [a,b]=r.diagonal.map(id=>points[id]);return a&&b?add(a,sub(b,a),.5):null;}
  if(r.kind==="intersection"){const cs=r.ids.map(id=>curves.find(c=>c.id===id));if(cs.some(c=>!c))return null;return intersect(...cs).filter(p=>cs.every(c=>contains(c,p))).sort((a,b)=>distance(a,src.uv)-distance(b,src.uv))[0];}
  const c=curves.find(c=>c.id===r.id);if(!c)return null;
  if(r.kind==="mid")return c.kind==="line"?add(c.a,sub(c.b,c.a),.5):c.arc?add(c.c,[Math.cos(c.arc[0]+c.arc[1]/2),Math.sin(c.arc[0]+c.arc[1]/2)],c.r):null;
  if(r.kind==="quadrant"){const d=r.direction||[1,0];return add(c.c,d,c.r);}
  return null;
 }
 snap(q,shift=false,hover=false){
  if(shift||!$("sk-snap-enabled").checked)return {uv:q};
  const {points,entities}=this.state.draft,tol=9/this.scale,gt=7/this.scale,cands=[],curves=this.curves(),near=[],models=this.state.model_edges||[];
  const usePoints=$("sk-snap-points").checked,useGuides=$("sk-snap-guides").checked,useRelations=$("sk-snap-relations").checked;
  const offer=(p,ref,label,rank=1)=>{const d=distance(q,p);if(d<=tol)cands.push({uv:p,ref,label,rank,d});};
  const acquire=h=>{if(hover)this.rememberSnap(h,curves);return h;};
  for(const [id,p] of Object.entries(points))offer(p,{kind:"point",id},id==="origin"?"Начало координат":"Точка",0);
  const direct=cands.filter(c=>c.rank===0).sort((a,b)=>a.d-b.d)[0];if(direct)return acquire(direct);
  for(const c of curves){
   const p=project(c,q);if(contains(c,p)&&distance(q,p)<=tol){near.push(c);offer(p,{kind:"on",id:c.id},"Точка на кривой",6);}
   if(!usePoints)continue;
   if(c.kind==="line"){if(!entities[c.id].helper)offer(add(c.a,sub(c.b,c.a),.5),{kind:"mid",id:c.id},"Середина",2);}
   else {
    if(c.arc){const a=c.arc[0]+c.arc[1]/2;offer(add(c.c,[Math.cos(a),Math.sin(a)],c.r),{kind:"mid",id:c.id},"Середина дуги",2);}
    for(const [x,y] of [[1,0],[-1,0],[0,1],[0,-1]]){const p=add(c.c,[x,y],c.r);if(contains(c,p))offer(p,{kind:"quadrant",id:c.id,axis:y?"vertical":"horizontal",direction:[x,y]},"Квадрант",3);}
   }
  }
  for(const [id,paths] of Object.entries(this.state.curves)){
   if(!["ellipse","ellipse_arc"].includes(entities[id].type))continue;
   for(const path of paths)for(let i=1;i<path.length;i++){const a=path[i-1],d=sub(path[i],a),p=add(a,d,Math.max(0,Math.min(1,dot(sub(q,a),d)/Math.max(dot(d,d),1e-20))));offer(p,{kind:"on",id},"Точка на эллипсе",6);}
  }
  if(usePoints){
   for(let i=0;i<near.length;i++)for(let j=i+1;j<near.length;j++)for(const p of intersect(near[i],near[j]))if(contains(near[i],p)&&contains(near[j],p))offer(p,{kind:"intersection",ids:[near[i].id,near[j].id]},"Пересечение",1);
   for(const r of this.state.rectangle_centres||[])offer(r.uv,{kind:"rect_center",diagonal:r.diagonal,ids:r.ids},"Центр прямоугольника",2);
  }
  const exact=cands.filter(c=>c.rank<6).sort((a,b)=>Math.round(a.d*this.scale/2)-Math.round(b.d*this.scale/2)||a.rank-b.rank||a.d-b.d)[0];
  const anchor=this.anchors.at(-1),a=anchor?.uv;
  let tang=null;
  if(useRelations&&a&&this.tool==="line"){
   const v=sub(q,a);
   for(const c of curves.filter(c=>c.kind==="circle")){
    const d=distance(a,c.c);if(d<1e-9)continue;
    if(c.arc&&anchor.ref?.kind==="point"&&[entities[c.id].p1,entities[c.id].p2].includes(anchor.ref.id)&&distance(q,a)*this.scale>12){
     const rv=sub(a,c.c),u=[-rv[1]/d,rv[0]/d],p=add(a,u,dot(v,u)),dist=distance(q,p);
     if(dist<=gt&&Math.abs(cross(v,u))/Math.max(Math.hypot(...v),1e-12)<.05&&(!tang||dist<tang.d))tang={uv:p,relation:{kind:"tangent",id:c.id},label:"Касательная",d:dist,guide:a};
    }
    if(d<=c.r*1.001)continue;
    const base=Math.atan2(a[1]-c.c[1],a[0]-c.c[0]),ang=Math.acos(c.r/d);
    for(const sign of [-1,1]){const t=base+sign*ang,p=add(c.c,[Math.cos(t),Math.sin(t)],c.r),dist=distance(q,p);
     if(contains(c,p)&&dist<=18/this.scale&&(!tang||dist<tang.d))tang={uv:p,ref:{kind:"on",id:c.id},relation:{kind:"tangent",id:c.id},label:"Касание",d:dist,guide:a};}
   }
  }
  if(exact&&!(exact.ref.kind==="quadrant"&&tang&&tang.d<exact.d))return acquire(exact);
  if(usePoints){
   const mp=[];for(const m of models)m.points.forEach((p,i)=>{const d=distance(q,p.uv);if(d<=tol)mp.push({uv:p.uv,ref:{kind:"model_point",id:m.id,index:i},label:p.label,d});});
   if(mp.length)return mp.sort((a,b)=>a.d-b.d)[0];
  }
  if(tang)return tang;
  const on=cands.filter(c=>c.rank===6).sort((a,b)=>a.d-b.d)[0];
  if(hover&&on)this.rememberSnap(on,curves);
  const guides={};
  if(useGuides){
   const sources=this.snapSources.map(src=>({src,uv:this.sourcePosition(src,curves)})).filter(s=>s.uv);
   if(a&&this.tool==="line")sources.unshift({src:null,uv:a});
   for(const {src,uv} of sources){
    if(distance(q,uv)*this.scale<=12)continue;
    const delta=sub(q,uv),axis=Math.abs(delta[1])<=Math.abs(delta[0])?"horizontal":"vertical",k=axis==="horizontal"?1:0,d=Math.abs(delta[k]);
    if(d<=gt&&(!guides[axis]||d<guides[axis].d))guides[axis]={src,uv,k,d};
   }
  }
  const gs=Object.entries(guides),guided=[...q],alignments=[],guideLines=[];
  for(const [axis,g] of gs){guided[g.k]=g.uv[g.k];guideLines.push(g.uv);if(g.src&&(!a||distance(g.uv,a)>1e-9))alignments.push({axis,source:{...g.src,uv:g.uv}});}
  // A guide intersecting an actual finite edge must snap to both, not approximate the crossing.
  if(gs.length===1){
   const [axis,g]=gs[0],line={kind:"line",a:guided,b:add(guided,axis==="horizontal"?[1,0]:[0,1])},hits=[];
   for(const c of [...near,...models.filter(m=>m.kind)]){
    for(const p of intersect(line,c))if(contains(c,p)&&distance(q,p)<=12/this.scale)hits.push({uv:p,ref:{kind:models.includes(c)?"model_edge":"on",id:c.id},label:"Пересечение с направляющей",d:distance(q,p),alignments,guideLines});
   }
   if(hits.length)return hits.sort((a,b)=>a.d-b.d)[0];
  }
  if(gs.length)return {uv:guided,label:gs.map(([k])=>k==="horizontal"?"Горизонталь":"Вертикаль").join(" + "),alignments,guideLines};
  if(on)return acquire(on);
  if(useRelations&&a){
   const v=sub(q,a),L=Math.hypot(...v),opts=[];
   if(L>1e-9)for(const id of this.wakeEntities){
    const c=curves.find(x=>x.id===id);if(!c)continue;
    if(this.tool==="line"&&c.kind==="line"){
     const d=sub(c.b,c.a),len=Math.hypot(...d);if(len<1e-9)continue;
     const u=d.map(x=>x/len);
     for(const [kind,w,label] of [["parallel",u,"Параллельно"],["perpendicular",[-u[1],u[0]],"Перпендикулярно"]]){
      const p=add(a,w,dot(v,w)),dist=distance(q,p);if(dist<=gt&&distance(p,a)>1e-9)opts.push({uv:p,relation:{kind,id},label,d:dist,guide:a});}
     const p=add(a,v,len/L),dist=distance(q,p);if(dist<=gt)opts.push({uv:p,relation:{kind:"equal",id},label:"Равная длина",d:dist,guide:a});
    }
    if(this.tool==="circle"&&c.kind==="circle"){const p=add(a,v,c.r/L),dist=distance(q,p);if(dist<=gt)opts.push({uv:p,relation:{kind:"equal",id},label:"Равный радиус",d:dist,guide:a});}
   }
   if(opts.length)return opts.sort((a,b)=>a.d-b.d)[0];
  }
  const edges=[];
  for(const m of models){
   if(m.kind){const p=project(m,q);if(contains(m,p)&&distance(q,p)<=gt)edges.push({uv:p,ref:{kind:"model_edge",id:m.id},label:"Ребро модели",d:distance(q,p)});}
   else for(let i=1;i<m.path.length;i++){const a=m.path[i-1],d=sub(m.path[i],a),p=add(a,d,Math.max(0,Math.min(1,dot(sub(q,a),d)/Math.max(dot(d,d),1e-20))));if(distance(q,p)<=gt)edges.push({uv:p,ref:{kind:"model_edge",id:m.id},label:"Ребро модели",d:distance(q,p)});}
  }
  return edges.sort((a,b)=>a.d-b.d)[0]||{uv:q};
 }

 pickPoint(q){let best=null;for(const [id,p] of Object.entries(this.state.draft.points)){const d=distance(q,p);if(d<7/this.scale&&(!best||d<best.d))best={id,d};}return best?.id;}
 pick(q,filter=()=>true){let best=null;for(const [id,paths] of Object.entries(this.state.curves)){if(!filter(this.state.draft.entities[id]))continue;for(const path of paths)for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],d=sub(b,a),p=add(a,d,Math.max(0,Math.min(1,dot(sub(q,a),d)/Math.max(dot(d,d),1e-20)))),dist=distance(p,q);if(dist<7/this.scale&&(!best||dist<best.dist))best={id,dist};}}
  for(const [id,e] of Object.entries(this.state.draft.entities))if(e.type==="point"&&filter(e)){const dist=distance(q,this.state.draft.points[e.p]);if(dist<7/this.scale&&(!best||dist<best.dist))best={id,dist};}return best?.id;}
 down(e){if(!this.active)return;const p=this.eventPos(e);if(e.button===1||e.button===2){this.pan={p,center:[...this.center]};this.canvas.setPointerCapture(e.pointerId);e.preventDefault();return;}if(e.button!==0||this.busy)return;this.clearOffers();const q=this.uv(p);
  if(this.constraintTool){const id=this.pickPoint(q)||this.pick(q);if(id){if(this.selection.has(id))this.selection.delete(id);else this.selection.add(id);this.updateInfo();this.draw();if(this.constraintReady(this.constraintTool,[...this.selection]))this.applyConstraint(this.constraintTool);}return;}
  if(this.tool==="select"){const pid=this.pickPoint(q),id=pid||this.pick(q);if(!e.shiftKey)this.selection.clear();if(id){if(this.selection.has(id))this.selection.delete(id);else this.selection.add(id);}if(pid&&pid!=="origin"&&!e.shiftKey){this.drag={id:pid,start:p,uv:q,moved:false};this.canvas.setPointerCapture(e.pointerId);}this.updateInfo();this.draw();return;}
  if(this.modifying()){const id=this.modTarget(q);if(id)this.change("sketch_modify",{tool:this.tool,id,uv:q});return;}
  const sides=this.polygonSides();if(["polygon","polygon_out"].includes(this.tool)&&sides===null){this.status("Число сторон: от 3 до 64");return;}
   const hit=this.snap(q,e.shiftKey);if(this.tool==="spline"&&this.anchors.length){
    if(this.anchors.length>=3&&distance(q,this.anchors[0].uv)*this.scale<9){this.finishSpline(true);return;}
    if(this.anchors.length>=2&&distance(q,this.anchors.at(-1).uv)*this.scale<4){this.finishSpline();return;}
    if(this.anchors.some(a=>distance(a.uv,hit.uv)<1e-8)){this.status("Точки сплайна должны различаться");return;}
   }
   this.anchors.push({uv:hit.uv,ref:hit.ref,alignments:hit.alignments,relation:hit.relation,free:e.shiftKey||!$("sk-snap-enabled").checked});if(this.tool==="spline"){if(this.anchors.length>=128)this.finishSpline();else {this.scheduleSplinePreview();this.draw();}return;}
   const count=this.tool==="point"?1:["arc","ellipse"].includes(this.tool)?3:2;
   if(this.anchors.length===count){const tool=this.tool,points=this.anchors;this.anchors=[];this.change("sketch_draw",{tool,points,sides,construction:$("construction").checked});}else this.draw();
 }
 move(e){if(!this.active)return;const p=this.eventPos(e);if(this.pan){this.center=[this.pan.center[0]-(p[0]-this.pan.p[0])/this.scale,this.pan.center[1]+(p[1]-this.pan.p[1])/this.scale];this.draw();return;}if(this.drag){this.drag.moved ||= distance(p,this.drag.start)>4;this.drag.uv=this.uv(p);this.draw();return;}const q=this.uv(p);this.mouse=this.modifying()?{uv:q,ref:{id:this.modTarget(q)}}:this.snap(q,e.shiftKey,true);if(this.tool==="spline")this.scheduleSplinePreview();this.draw();}
 up(e){this.pan=null;if(!this.drag)return;const d=this.drag;this.drag=null;if(d.moved)this.change("sketch_drag",{id:d.id,uv:this.uv(this.eventPos(e))});else this.draw();}
 wheel(e){e.preventDefault();const p=this.eventPos(e),before=this.uv(p);this.scale=Math.max(.02,Math.min(10000,this.scale*Math.exp(-e.deltaY*.0015)));const after=this.uv(p);this.center=add(this.center,sub(before,after));this.draw();}
 async change(op,args={}){if(!this.active||this.busy)return false;if(op!=="sketch_offer_dimension")this.clearOffers();if(op==="sketch_undo"||op==="sketch_redo"){this.snapSources=[];this.wakeEntities=[];this.anchors=[];this.clearSplinePreview();}this.busy=true;this.updateInfo();let ok=false;try{this.state=await this.send(op,args);$("sk-info").dataset.revision=String(Number($("sk-info").dataset.revision||0)+1);this.dimEditing=null;this.selection.clear();this.mouse=null;
  if(op==="sketch_draw"&&args.tool==="line"&&this.state.chain_end){const id=this.state.chain_end;this.anchors=[{uv:this.state.draft.points[id],ref:{kind:"point",id}}];}
  if(op==="sketch_offer_dimension"&&this.anchors[0]?.ref?.kind==="point"){const p=this.state.draft.points[this.anchors[0].ref.id];if(p)this.anchors[0].uv=p;}
  if(op==="sketch_draw"&&this.state.offers?.length){this.offers=this.state.offers;this.showOffer();}
  ok=true;}catch(e){this.status(String(e));}finally{this.busy=false;this.updateInfo();this.draw();}return ok;}
 setConstraintTool(kind){this.constraintTool=kind;$("sk-constraint-help").hidden=!kind;$("sk-constraint-help").textContent=kind?constraintHints[kind]+" · Esc — выход":"";for(const b of document.querySelectorAll("[data-constraint]"))b.classList.toggle("active",b.dataset.constraint===kind);}
 constraintReady(kind,refs){const typ=id=>id in this.state.draft.points?"point":this.state.draft.entities[id]?.type,t=refs.map(typ),c=x=>["circle","arc"].includes(x),n=x=>["circle","arc","ellipse","ellipse_arc"].includes(x);
  if(kind==="fix")return refs.length>0;
  if(["horizontal","vertical"].includes(kind))return (t.length>0&&t.every(x=>x==="line"))||(t.length===2&&t.every(x=>x==="point"));
  if(kind==="symmetric")return t.length===3&&t.includes("line")&&(t.filter(x=>x==="point").length===2||t.filter(c).length===2||t.every(x=>x==="line"));
  if(t.length!==2)return false;const [a,b]=t,p=t.includes("point"),l=t.includes("line");
  return ({coincident:(p&&(t.every(x=>x==="point")||l||t.some(n)))||t.every(c),point_on:p&&(l||t.some(n)),midpoint:p&&(l||t.includes("arc")),parallel:t.every(x=>x==="line"),perpendicular:t.every(x=>x==="line")||(l&&t.some(n)),normal:l&&t.some(n),tangent:(l&&t.some(c))||t.every(c),equal:t.every(x=>x==="line")||t.every(c),concentric:t.every(x=>x==="point"||c(x))})[kind]||false;}
 async applyConstraint(kind){const refs=[...this.selection];await this.change("sketch_constraint",{kind,refs});}
 constraint(kind){if(this.busy)return;const refs=[...this.selection];if(kind in constraintHints){
  if(this.constraintReady(kind,refs)){this.setConstraintTool(null);this.applyConstraint(kind);return;}
  this.setTool("select");this.selection.clear();this.setConstraintTool(kind);this.canvas.focus();this.updateInfo();this.draw();return;}
  if(!refs.length){this.status("Выберите геометрию (Shift — несколько объектов)");return;}
  const args={kind,refs};if(["distance","hdistance","vdistance","radius","diameter","angle"].includes(kind)){const v=Number($("sk-value").value);if(!(v>0)){this.status("Укажите положительный размер");return;}args.value=v;}this.change("sketch_constraint",args);
 }

 remove(){if(this.selection.size)this.change("sketch_delete",{ids:[...this.selection]});}
 async end(op){if(this.busy)return;if(op==="sketch_finish"&&this.tool==="spline"&&this.anchors.length){this.status("Завершите сплайн или отмените построение (Esc)");return;}this.busy=true;try{const result=await this.send(op);this.hide();this.finish(result);}catch(e){this.status(String(e));}finally{this.busy=false;this.updateInfo();}}
 updateInfo(){if(!this.active)return;const s=this.state;$("sk-info").textContent=Object.keys(s.draft.entities).length+" объектов · степеней свободы: "+(s.dof??"—")+" · выбрано: "+this.selection.size;
  $("sk-constraints").replaceChildren(...s.draft.constraints.map(c=>{const div=document.createElement("div");div.className="constraint-row"+(s.bad.includes(c.id)?" bad":"");const label=document.createElement("span");label.textContent=(constraintGlyphs[c.type]?constraintGlyphs[c.type]+" ":"")+c.type+" · "+c.refs.join(", ");label.title=constraintHints[c.type]||c.type;div.dataset.constraintType=c.type;div.dataset.constraintId=c.id;div.onmouseenter=()=>{this.constraintHover=c.refs;this.draw();};div.onmouseleave=()=>{this.constraintHover=null;this.draw();};div.append(label);if(typeof c.value==="number"&&!c.expr&&["distance","hdistance","vdistance","radius","diameter","angle"].includes(c.type)){const input=document.createElement("input");input.type="number";input.step="any";input.min="0.000001";input.value=c.value;input.title="Изменить размер";input.disabled=this.busy;input.onchange=()=>{if(input.checkValidity())this.change("sketch_dimension",{id:c.id,value:Number(input.value)});};div.append(input);}const del=document.createElement("button");del.textContent="×";del.title="Удалить ограничение";del.disabled=this.busy;del.onclick=()=>this.change("sketch_delete",{ids:[c.id]});div.append(del);return div;}));$("sk-undo").disabled=this.busy||!s.undo;$("sk-redo").disabled=this.busy||!s.redo;$("sk-finish").disabled=this.busy;$("sk-cancel").disabled=this.busy;
 }
 dimensionGeometry(c){
  const {points,entities}=this.state.draft,refs=c.refs||[],e=entities[refs[0]],kind=c.type;
  if(["distance","hdistance","vdistance"].includes(kind)){
   let p,q;if(refs.length===2){p=points[refs[0]];q=points[refs[1]];}else if(e?.type==="line"){p=points[e.p1];q=points[e.p2];}
   if(!p||!q)return null;
   const a=this.screen(p),b=this.screen(q),d=sub(b,a),len=Math.hypot(...d);if(len<1)return null;
   let x,y;
   if(kind==="hdistance"){const v=Math.min(a[1],b[1])-23;x=[a[0],v];y=[b[0],v];}
   else if(kind==="vdistance"){const v=Math.max(a[0],b[0])+23;x=[v,a[1]];y=[v,b[1]];}
   else {const n=[-d[1]/len,d[0]/len];x=add(a,n,23);y=add(b,n,23);}
   return {lines:[[a,x],[b,y],[x,y]],arrows:[x,y],label:add(x,sub(y,x),.5)};
  }
  if(["radius","diameter"].includes(kind)&&e&&["ellipse","ellipse_arc"].includes(e.type)){
   const center=points[e.c],axis=sub(points[e.a],center),len=Math.hypot(...axis);if(len<1e-8)return null;
   const n=[-axis[1]/len,axis[0]/len],a=this.screen(kind==="diameter"?add(center,n,-e.r):center),b=this.screen(add(center,n,e.r)),end=this.screen(add(center,n,e.r+25/this.scale));
   return {lines:[[a,b],[b,end]],arrows:[a,b],label:end};
  }
  if(["radius","diameter"].includes(kind)&&e&&["circle","arc"].includes(e.type)){
   const center=points[e.c],r=e.type==="circle"?e.r:distance(center,points[e.p1]);if(!center||!(r>0))return null;
   const angle=e.type==="arc"?Math.atan2(points[e.p1][1]-center[1],points[e.p1][0]-center[0])+wrap(Math.atan2(points[e.p2][1]-center[1],points[e.p2][0]-center[0])-Math.atan2(points[e.p1][1]-center[1],points[e.p1][0]-center[0]))/2:Math.PI/4;
   const v=[Math.cos(angle),Math.sin(angle)],a=this.screen(kind==="diameter"?add(center,v,-r):center),b=this.screen(add(center,v,r)),end=this.screen(add(center,v,r+25/this.scale));
   return {lines:[[a,b],[b,end]],arrows:[a,b],label:end};
  }
  return null;
 }
 drawDimensions(){
  const overlay=$("dimension-overlay"),ctx=this.ctx;
  if(!this.active||!$("sk-show-constraints").checked){overlay.replaceChildren();return;}
  const wanted=new Set();
  for(const c of this.state.draft.constraints){
   if(typeof c.value!=="number")continue;
   const g=this.dimensionGeometry(c);if(!g)continue;
   const color=this.state.bad.includes(c.id)?"#ff7979":"#f6f8fb";
   ctx.strokeStyle=color;ctx.lineWidth=1;ctx.setLineDash([]);
   for(const [p,q] of g.lines){ctx.beginPath();ctx.moveTo(...p);ctx.lineTo(...q);ctx.stroke();}
   const [a,b]=g.arrows,v=sub(b,a),len=Math.hypot(...v);
   if(len>1){const u=v.map(x=>x/len),n=[-u[1],u[0]];for(const [p,sign] of [[a,1],[b,-1]]){ctx.beginPath();ctx.moveTo(...add(add(p,u,sign*7),n,3));ctx.lineTo(...p);ctx.lineTo(...add(add(p,u,sign*7),n,-3));ctx.stroke();}}
   wanted.add(c.id);
   let el=[...overlay.children].find(n=>n.dataset.constraintId===c.id);
   if(!el){el=document.createElement("button");el.type="button";el.className="dimension-label";el.dataset.constraintId=c.id;el.addEventListener("click",()=>this.editDimension(c.id));overlay.append(el);}
   el.style.left=g.label[0]+"px";el.style.top=g.label[1]+"px";el.style.color=color;
   if(el.tagName==="BUTTON"){const prefix=c.type==="radius"?"R":c.type==="diameter"?"⌀":"";el.textContent=prefix+Number(c.value.toFixed(4));el.title=c.expr?String(c.expr):"Изменить размер";el.disabled=!!c.expr||this.busy;el.style.pointerEvents=this.tool==="select"?"auto":"none";}
  }
  for(const el of [...overlay.children])if(!wanted.has(el.dataset.constraintId))el.remove();
 }
 editDimension(id){
  if(this.busy||this.dimEditing)return;
  const c=this.state.draft.constraints.find(x=>x.id===id),overlay=$("dimension-overlay");
  const el=[...overlay.children].find(n=>n.dataset.constraintId===id);if(!c||!el||c.expr)return;
  const input=document.createElement("input");input.type="number";input.min="0.000001";input.step="any";input.value=c.value;input.className="dimension-input";input.dataset.constraintId=id;input.style.left=el.style.left;input.style.top=el.style.top;input.setAttribute("aria-label","Размер");
  this.dimEditing=id;el.replaceWith(input);input.focus();input.select();
  let done=false;
  const close=commit=>{if(done)return;done=true;const value=Number(input.value);input.remove();this.dimEditing=null;this.draw();if(commit&&Number.isFinite(value)&&value>0&&value!==c.value)this.change("sketch_dimension",{id,value});};
  input.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key==="Escape"){e.preventDefault();e.stopPropagation();close(e.key==="Enter");}});
  input.addEventListener("blur",()=>close(false));
 }
 line(a,b,color,width=1,dash=[]){const c=this.ctx,p=this.screen(a),q=this.screen(b);c.beginPath();c.setLineDash(dash);c.strokeStyle=color;c.lineWidth=width;c.moveTo(...p);c.lineTo(...q);c.stroke();c.setLineDash([]);}
 draw(){if(!this.active||!this.state||!this.w)return;this.canvas.dataset.snap=this.mouse?.label||"";this.canvas.dataset.transform=JSON.stringify({center:this.center,scale:this.scale,width:this.w,height:this.h});const c=this.ctx;c.fillStyle="#6d7680";c.fillRect(0,0,this.w,this.h);
  const step=Math.pow(10,Math.floor(Math.log10(55/this.scale)));const spacing=step*this.scale<18?step*5:step;const lo=this.uv([0,this.h]),hi=this.uv([this.w,0]);
  for(let x=Math.ceil(lo[0]/spacing)*spacing;x<=hi[0];x+=spacing)this.line([x,lo[1]],[x,hi[1]],"#77818b");
  for(let y=Math.ceil(lo[1]/spacing)*spacing;y<=hi[1];y+=spacing)this.line([lo[0],y],[hi[0],y],"#77818b");
  this.line([lo[0],0],[hi[0],0],"#c78383");this.line([0,lo[1]],[0,hi[1]],"#79ad87");
  if($("sk-show-regions").checked){c.fillStyle="#9bc8ff35";for(const region of this.state.regions||[]){c.beginPath();for(const tri of region.triangles){c.moveTo(...this.screen(region.vertices[tri[0]]));c.lineTo(...this.screen(region.vertices[tri[1]]));c.lineTo(...this.screen(region.vertices[tri[2]]));c.closePath();}c.fill();}}
  for(const m of this.state.model_edges||[]){const color=this.mouse?.ref?.id===m.id?"#dca527":"#b0b6bd";for(let i=1;i<m.path.length;i++)this.line(m.path[i-1],m.path[i],color,1.4);}
  const {entities,points}=this.state.draft;
  const highlighted=new Set([...(this.mouse?.ref?.ids||[this.mouse?.ref?.id]),...(this.constraintHover||[]),this.mouse?.relation?.id]);
  for(const [id,paths] of Object.entries(this.state.curves)){const e=entities[id];c.strokeStyle=this.selection.has(id)?"#e89116":highlighted.has(id)?(this.tool==="trim"?"#f08b80":"#dca527"):"#9bc8ff";c.lineWidth=this.selection.has(id)||highlighted.has(id)?2.6:1.8;c.setLineDash(e.construction?[6,4]:[]);
   for(const path of paths){if(!path.length)continue;c.beginPath();c.moveTo(...this.screen(path[0]));for(const p of path.slice(1))c.lineTo(...this.screen(p));c.stroke();}c.setLineDash([]);
  }
  for(const [id,p] of Object.entries(points)){const q=this.screen(p);c.fillStyle=this.selection.has(id)||highlighted.has(id)?"#e89116":id==="origin"?"#b84545":"#a7d0ff";c.beginPath();c.arc(...q,id==="origin"?4:3,0,tau);c.fill();}
  if(this.modifying()&&this.mouse?.ref?.id){
   const e=entities[this.mouse.ref.id],q=this.mouse.uv;
   if(this.tool==="split"){const curve=this.curves().find(v=>v.id===this.mouse.ref.id);if(curve){const p=this.screen(project(curve,q));c.strokeStyle="#e89116";c.lineWidth=2;c.beginPath();c.arc(...p,5,0,tau);c.stroke();}}
   if(this.tool==="extend"){const p=points[e.p1],r=points[e.p2],end=distance(p,q)<distance(r,q)?p:r;c.strokeStyle="#e89116";c.lineWidth=2;c.beginPath();c.arc(...this.screen(end),6,0,tau);c.stroke();}
  }
  this.drawDimensions();
  if(this.drag?.moved){this.line(points[this.drag.id],this.drag.uv,"#e89116",1,[4,4]);const q=this.screen(this.drag.uv);c.beginPath();c.arc(...q,6,0,tau);c.strokeStyle="#e89116";c.lineWidth=2;c.stroke();}
  const a=this.anchors[0]?.uv,b=this.mouse?.uv;
  if(a&&b){const color="#c3dcff",dash=[5,4];if(this.tool==="ellipse"&&this.anchors.length===2){
    const d=sub(this.anchors[1].uv,a),A=Math.hypot(...d);if(A>1e-8){const n=[-d[1]/A,d[0]/A],B=Math.abs(dot(sub(b,a),n));c.strokeStyle=color;c.lineWidth=1.5;c.setLineDash(dash);c.beginPath();c.ellipse(...this.screen(a),A*this.scale,B*this.scale,-Math.atan2(d[1],d[0]),0,tau);c.stroke();c.setLineDash([]);this.line(a,this.anchors[1].uv,color,1,dash);}
   }else if(["polygon","polygon_out"].includes(this.tool)){
    const n=this.polygonSides(),r=distance(a,b);if(n&&r>1e-8){const step=tau/n,ins=this.tool==="polygon",R=ins?r:r/Math.cos(Math.PI/n);let ang=Math.atan2(b[1]-a[1],b[0]-a[0])-(ins?0:step/2);for(const target of [Math.PI/2-step/2,Math.PI/2]){const k=((ang-target)%step+step)%step;if(Math.min(k,step-k)<4*Math.PI/180){ang+=k<step/2?-k:step-k;break;}}const pts=Array.from({length:n},(_,i)=>add(a,[Math.cos(ang+i*step),Math.sin(ang+i*step)],R));for(let i=0;i<n;i++)this.line(pts[i],pts[(i+1)%n],color,1.5,dash);}
   }else if(this.tool==="spline"){
    const pts=[...this.anchors.map(p=>p.uv),b],path=this.splinePath||pts;for(let i=1;i<path.length;i++)this.line(path[i-1],path[i],color,1.5,dash);if(!this.splinePath&&$("sk-spline-closed").checked&&pts.length>2)this.line(pts.at(-1),pts[0],color,1,dash);
   }else if(this.tool==="arc"&&this.anchors.length===2){
    const end=this.anchors[1].uv,d=sub(end,a),v=sub(b,a),den=2*cross(d,v);
    if(Math.abs(den)>1e-9){const D=dot(d,d),V=dot(v,v),ctr=add(a,[(D*v[1]-V*d[1])/den,(V*d[0]-D*v[0])/den]),r=distance(ctr,a);
      const start=Math.atan2(a[1]-ctr[1],a[0]-ctr[0]),finish=Math.atan2(end[1]-ctr[1],end[0]-ctr[0]),mid=Math.atan2(b[1]-ctr[1],b[0]-ctr[0]);const ccw=wrap(mid-start)<=wrap(finish-start);c.strokeStyle=color;c.lineWidth=1.5;c.setLineDash(dash);c.beginPath();c.arc(...this.screen(ctr),r*this.scale,-start,-finish,ccw);c.stroke();c.setLineDash([]);}else this.line(a,end,color,1.5,dash);
   }else if(this.tool==="rect"||this.tool==="center_rect"){const first=this.tool==="center_rect"?add(a,sub(a,b)):a,p=[b[0],first[1]],q=[first[0],b[1]];for(const [x,y] of [[first,p],[p,b],[b,q],[q,first]])this.line(x,y,color,1.5,dash);if(this.tool==="center_rect")this.line(first,b,color,1,dash);}else if(this.tool==="circle"){c.strokeStyle=color;c.setLineDash(dash);c.beginPath();c.arc(...this.screen(a),distance(a,b)*this.scale,0,tau);c.stroke();c.setLineDash([]);}else {this.line(this.anchors.at(-1).uv,b,color,1.5,dash);if(this.anchors.length===2)this.line(a,this.anchors[1].uv,color,1.5,dash);}}
  if(this.mouse?.label&&this.tool!=="select"){const q=this.screen(b);if(this.mouse.guide)this.line(this.mouse.guide,b,"#dca527",1,[4,4]);for(const src of this.mouse.guideLines||[])this.line(src,b,"#dca527",1,[4,4]);c.strokeStyle="#dca527";c.lineWidth=2;c.beginPath();c.moveTo(q[0]-6,q[1]);c.lineTo(q[0],q[1]-6);c.lineTo(q[0]+6,q[1]);c.lineTo(q[0],q[1]+6);c.closePath();c.stroke();c.font="12px system-ui";const w=c.measureText(this.mouse.label).width+12,x=Math.min(q[0]+12,this.w-w-4),y=Math.min(q[1]+12,this.h-23);c.fillStyle="#fff5d9";c.fillRect(x,y,w,22);c.fillStyle="#76530b";c.fillText(this.mouse.label,x+6,y+15);}
 }
}
