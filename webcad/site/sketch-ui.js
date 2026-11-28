// Local cursor, preview and hit testing. Only committed edits go to the native Python solver.
const $=id=>document.getElementById(id);
const distance=(a,b)=>Math.hypot(a[0]-b[0],a[1]-b[1]);
const sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
const dot=(a,b)=>a[0]*b[0]+a[1]*b[1];
const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
const add=(a,b,t=1)=>[a[0]+b[0]*t,a[1]+b[1]*t];
const tau=2*Math.PI;
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
 constructor(send,finish,status){
  this.send=send;this.finish=finish;this.status=status;this.canvas=$("sketch-canvas");this.ctx=this.canvas.getContext("2d");
  this.active=false;this.busy=false;this.tool="select";this.anchors=[];this.selection=new Set();this.scale=8;this.center=[0,0];this.mouse=null;this.pan=null;this.drag=null;this.state=null;this.dimEditing=null;
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
 hide(){this.active=false;this.dimEditing=null;$("dimension-overlay").replaceChildren();$("dimension-overlay").hidden=true;this.state=null;this.anchors=[];this.selection.clear();$("sketch-canvas").hidden=true;$("sketch-tools").hidden=true;$("sketch-panel").hidden=true;$("model-panel").hidden=false;$("view-controls").hidden=false;}
 resize(){const r=this.canvas.getBoundingClientRect();this.w=Math.max(1,r.width);this.h=Math.max(1,r.height);const d=Math.min(devicePixelRatio,2);this.canvas.width=Math.round(this.w*d);this.canvas.height=Math.round(this.h*d);this.ctx.setTransform(d,0,0,d,0,0);this.draw();}
 screen(q){return [this.w/2+(q[0]-this.center[0])*this.scale,this.h/2-(q[1]-this.center[1])*this.scale];}
 uv(p){return [this.center[0]+(p[0]-this.w/2)/this.scale,this.center[1]-(p[1]-this.h/2)/this.scale];}
 eventPos(e){const r=this.canvas.getBoundingClientRect();return [e.clientX-r.left,e.clientY-r.top];}
 fit(){const pts=[...Object.values(this.state?.draft.points||{}),...Object.values(this.state?.curves||{}).flat(2)];if(pts.length>1){const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]),a=Math.min(...xs),b=Math.max(...xs),c=Math.min(...ys),d=Math.max(...ys);this.center=[(a+b)/2,(c+d)/2];this.scale=Math.min(this.w/Math.max(b-a,10),this.h/Math.max(d-c,10))*.72;}else {this.center=[0,0];this.scale=Math.min(this.w,this.h)/100;}this.draw();}
 setTool(t){if(this.busy)return;this.tool=t;this.anchors=[];this.mouse=null;this.toolOptions();for(const b of document.querySelectorAll("[data-tool]"))b.classList.toggle("active",b.dataset.tool===t);this.draw();}
 toolOptions(){
  const polygon=["polygon","polygon_out"].includes(this.tool),spline=this.tool==="spline",ellipse=this.tool==="ellipse";
  const modify=this.modifying();
  $("sk-tool-options").hidden=!(polygon||spline||ellipse||modify);$("sk-polygon-options").hidden=!polygon;$("sk-spline-options").hidden=!spline;
  $("sk-tool-help").textContent=ellipse?"Центр → конец оси → вторая полуось":spline?"Щёлкайте точки; Enter — завершить, Esc — отменить построение":polygon?(this.tool==="polygon"?"Центр → вершина":"Центр → середина стороны"):({trim:"Щёлкните удаляемый участок отрезка между пересечениями",split:"Щёлкните точку разделения отрезка или дуги",extend:"Щёлкните ближе к концу, который нужно удлинить до следующей кривой"}[this.tool]||"");
 }
 modifying(){return ["trim","split","extend"].includes(this.tool);}
 modTarget(q){return this.pick(q,e=>!e.helper&&(e.type==="line"||(this.tool!=="trim"&&e.type==="arc")));}
 polygonSides(){const n=Number($("sk-sides").value);return Number.isInteger(n)&&n>=3&&n<=64?n:null;}
 finishSpline(){if(this.busy||this.tool!=="spline")return;const closed=$("sk-spline-closed").checked;if(this.anchors.length<(closed?3:2)){this.status("Недостаточно точек сплайна");return;}const points=this.anchors;this.anchors=[];this.change("sketch_draw",{tool:"spline",points,closed,construction:$("construction").checked});}
 curves(){const {points,entities}=this.state.draft,out=[];for(const [id,e] of Object.entries(entities)){
  if(e.type==="line"){out.push({id,kind:"line",a:points[e.p1],b:points[e.p2]});}
  else if(e.type==="circle"||e.type==="arc"){const c=points[e.c],r=e.type==="circle"?e.r:distance(c,points[e.p1]);const obj={id,kind:"circle",c,r};if(e.type==="arc"){const a=Math.atan2(points[e.p1][1]-c[1],points[e.p1][0]-c[0]),b=Math.atan2(points[e.p2][1]-c[1],points[e.p2][0]-c[0]);obj.arc=[a,wrap(b-a)];}out.push(obj);}
 }return out;}
 snap(q,shift=false){
  if(shift)return {uv:q};
  const {points}=this.state.draft,tol=9/this.scale,cands=[],curves=this.curves(),near=[];
  const offer=(p,ref,label,rank=1)=>{const d=distance(q,p);if(d<=tol)cands.push({uv:p,ref,label,rank,d});};
  for(const [id,p] of Object.entries(points))offer(p,{kind:"point",id},id==="origin"?"Начало координат":"Точка",0);
  for(const c of curves){
   const p=project(c,q);if(contains(c,p)&&distance(q,p)<=tol){near.push(c);offer(p,{kind:"on",id:c.id},"Точка на кривой",6);}
   if(c.kind==="line")offer(add(c.a,sub(c.b,c.a),.5),{kind:"mid",id:c.id},"Середина",2);
   else {
    if(c.arc){const a=c.arc[0]+c.arc[1]/2;offer(add(c.c,[Math.cos(a),Math.sin(a)],c.r),{kind:"mid",id:c.id},"Середина дуги",2);}
    for(const [x,y] of [[1,0],[-1,0],[0,1],[0,-1]]){const p=add(c.c,[x,y],c.r);if(contains(c,p))offer(p,{kind:"quadrant",id:c.id,axis:y?"vertical":"horizontal"},"Квадрант",3);}
   }
  }
  // Native ellipse point-on constraint; sampled curves are only used for the cursor candidate.
  for(const [id,paths] of Object.entries(this.state.curves)){
   if(!["ellipse","ellipse_arc"].includes(this.state.draft.entities[id].type))continue;
   for(const path of paths)for(let i=1;i<path.length;i++){const a=path[i-1],d=sub(path[i],a),p=add(a,d,Math.max(0,Math.min(1,dot(sub(q,a),d)/Math.max(dot(d,d),1e-20))));offer(p,{kind:"on",id},"Точка на эллипсе",6);}
  }
  for(let i=0;i<near.length;i++)for(let j=i+1;j<near.length;j++)for(const p of intersect(near[i],near[j]))if(contains(near[i],p)&&contains(near[j],p))offer(p,{kind:"intersection",ids:[near[i].id,near[j].id]},"Пересечение",1);
  // Specific points win over a generic point-on-curve within the capture radius.
  const exact=cands.filter(c=>c.rank<6).sort((a,b)=>a.rank-b.rank||a.d-b.d)[0];
  if(exact)return exact;
  const a=this.anchors.at(-1);if(a&&this.tool==="line"){
   if(Math.abs(q[1]-a.uv[1])<=tol) return {uv:[q[0],a.uv[1]],label:"Горизонталь",guide:a.uv};
   if(Math.abs(q[0]-a.uv[0])<=tol) return {uv:[a.uv[0],q[1]],label:"Вертикаль",guide:a.uv};
  }
  return cands.sort((a,b)=>a.d-b.d)[0]||{uv:q};
 }
 pickPoint(q){let best=null;for(const [id,p] of Object.entries(this.state.draft.points)){const d=distance(q,p);if(d<7/this.scale&&(!best||d<best.d))best={id,d};}return best?.id;}
 pick(q,filter=()=>true){let best=null;for(const [id,paths] of Object.entries(this.state.curves)){if(!filter(this.state.draft.entities[id]))continue;for(const path of paths)for(let i=1;i<path.length;i++){const a=path[i-1],b=path[i],d=sub(b,a),p=add(a,d,Math.max(0,Math.min(1,dot(sub(q,a),d)/Math.max(dot(d,d),1e-20)))),dist=distance(p,q);if(dist<7/this.scale&&(!best||dist<best.dist))best={id,dist};}}
  for(const [id,e] of Object.entries(this.state.draft.entities))if(e.type==="point"&&filter(e)){const dist=distance(q,this.state.draft.points[e.p]);if(dist<7/this.scale&&(!best||dist<best.dist))best={id,dist};}return best?.id;}
 down(e){if(!this.active)return;const p=this.eventPos(e);if(e.button===1||e.button===2){this.pan={p,center:[...this.center]};this.canvas.setPointerCapture(e.pointerId);e.preventDefault();return;}if(e.button!==0||this.busy)return;const q=this.uv(p);
  if(this.tool==="select"){const pid=this.pickPoint(q),id=pid||this.pick(q);if(!e.shiftKey)this.selection.clear();if(id){if(this.selection.has(id))this.selection.delete(id);else this.selection.add(id);}if(pid&&pid!=="origin"&&!e.shiftKey){this.drag={id:pid,start:p,uv:q,moved:false};this.canvas.setPointerCapture(e.pointerId);}this.updateInfo();this.draw();return;}
  if(this.modifying()){const id=this.modTarget(q);if(id)this.change("sketch_modify",{tool:this.tool,id,uv:q});return;}
  const sides=this.polygonSides();if(["polygon","polygon_out"].includes(this.tool)&&sides===null){this.status("Число сторон: от 3 до 64");return;}
   const hit=this.snap(q,e.shiftKey);if(this.tool==="spline"&&this.anchors.some(a=>distance(a.uv,hit.uv)<1e-8)){this.status("Точки сплайна должны различаться");return;}
   this.anchors.push({uv:hit.uv,ref:hit.ref,free:e.shiftKey});if(this.tool==="spline"){if(this.anchors.length>=128)this.finishSpline();else this.draw();return;}
   const count=this.tool==="point"?1:["arc","ellipse"].includes(this.tool)?3:2;
   if(this.anchors.length===count){const tool=this.tool,points=this.anchors;this.anchors=[];this.change("sketch_draw",{tool,points,sides,construction:$("construction").checked});}else this.draw();
 }
 move(e){if(!this.active)return;const p=this.eventPos(e);if(this.pan){this.center=[this.pan.center[0]-(p[0]-this.pan.p[0])/this.scale,this.pan.center[1]+(p[1]-this.pan.p[1])/this.scale];this.draw();return;}if(this.drag){this.drag.moved ||= distance(p,this.drag.start)>4;this.drag.uv=this.uv(p);this.draw();return;}const q=this.uv(p);this.mouse=this.modifying()?{uv:q,ref:{id:this.modTarget(q)}}:this.snap(q,e.shiftKey);this.draw();}
 up(e){this.pan=null;if(!this.drag)return;const d=this.drag;this.drag=null;if(d.moved)this.change("sketch_drag",{id:d.id,uv:this.uv(this.eventPos(e))});else this.draw();}
 wheel(e){e.preventDefault();const p=this.eventPos(e),before=this.uv(p);this.scale=Math.max(.02,Math.min(10000,this.scale*Math.exp(-e.deltaY*.0015)));const after=this.uv(p);this.center=add(this.center,sub(before,after));this.draw();}
 async change(op,args={}){if(!this.active||this.busy)return;this.busy=true;this.updateInfo();try{this.state=await this.send(op,args);$("sk-info").dataset.revision=String(Number($("sk-info").dataset.revision||0)+1);this.dimEditing=null;this.selection.clear();this.mouse=null;this.draw();}catch(e){this.status(String(e));}finally{this.busy=false;this.updateInfo();this.draw();}}
 constraint(kind){const refs=[...this.selection];if(!refs.length){this.status("Выберите геометрию (Shift — несколько объектов)");return;}const args={kind,refs};if(["distance","hdistance","vdistance","radius","diameter"].includes(kind)){const v=Number($("sk-value").value);if(!(v>0)){this.status("Укажите положительный размер");return;}args.value=v;}this.change("sketch_constraint",args);}
 remove(){if(this.selection.size)this.change("sketch_delete",{ids:[...this.selection]});}
 async end(op){if(this.busy)return;if(op==="sketch_finish"&&this.tool==="spline"&&this.anchors.length){this.status("Завершите сплайн или отмените построение (Esc)");return;}this.busy=true;try{const result=await this.send(op);this.hide();this.finish(result);}catch(e){this.status(String(e));}finally{this.busy=false;this.updateInfo();}}
 updateInfo(){if(!this.active)return;const s=this.state;$("sk-info").textContent=Object.keys(s.draft.entities).length+" объектов · степеней свободы: "+(s.dof??"—")+" · выбрано: "+this.selection.size;
  $("sk-constraints").replaceChildren(...s.draft.constraints.map(c=>{const div=document.createElement("div");div.className="constraint-row"+(s.bad.includes(c.id)?" bad":"");const label=document.createElement("span");label.textContent=c.type+" · "+c.refs.join(", ");div.append(label);if(typeof c.value==="number"&&!c.expr&&["distance","hdistance","vdistance","radius","diameter","angle"].includes(c.type)){const input=document.createElement("input");input.type="number";input.step="any";input.min="0.000001";input.value=c.value;input.title="Изменить размер";input.disabled=this.busy;input.onchange=()=>{if(input.checkValidity())this.change("sketch_dimension",{id:c.id,value:Number(input.value)});};div.append(input);}const del=document.createElement("button");del.textContent="×";del.title="Удалить ограничение";del.disabled=this.busy;del.onclick=()=>this.change("sketch_delete",{ids:[c.id]});div.append(del);return div;}));$("sk-undo").disabled=this.busy||!s.undo;$("sk-redo").disabled=this.busy||!s.redo;$("sk-finish").disabled=this.busy;$("sk-cancel").disabled=this.busy;
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
 draw(){if(!this.active||!this.state||!this.w)return;const c=this.ctx;c.fillStyle="#6d7680";c.fillRect(0,0,this.w,this.h);
  const step=Math.pow(10,Math.floor(Math.log10(55/this.scale)));const spacing=step*this.scale<18?step*5:step;const lo=this.uv([0,this.h]),hi=this.uv([this.w,0]);
  for(let x=Math.ceil(lo[0]/spacing)*spacing;x<=hi[0];x+=spacing)this.line([x,lo[1]],[x,hi[1]],"#77818b");
  for(let y=Math.ceil(lo[1]/spacing)*spacing;y<=hi[1];y+=spacing)this.line([lo[0],y],[hi[0],y],"#77818b");
  this.line([lo[0],0],[hi[0],0],"#c78383");this.line([0,lo[1]],[0,hi[1]],"#79ad87");
  if($("sk-show-regions").checked){c.fillStyle="#9bc8ff35";for(const region of this.state.regions||[]){c.beginPath();for(const tri of region.triangles){c.moveTo(...this.screen(region.vertices[tri[0]]));c.lineTo(...this.screen(region.vertices[tri[1]]));c.lineTo(...this.screen(region.vertices[tri[2]]));c.closePath();}c.fill();}}
  const {entities,points}=this.state.draft;
  const highlighted=new Set(this.mouse?.ref?.ids||[this.mouse?.ref?.id]);
  for(const [id,paths] of Object.entries(this.state.curves)){const e=entities[id];c.strokeStyle=this.selection.has(id)?"#e89116":highlighted.has(id)?(this.tool==="trim"?"#f08b80":"#dca527"):"#9bc8ff";c.lineWidth=this.selection.has(id)||highlighted.has(id)?2.6:1.8;c.setLineDash(e.construction?[6,4]:[]);
   for(const path of paths){if(!path.length)continue;c.beginPath();c.moveTo(...this.screen(path[0]));for(const p of path.slice(1))c.lineTo(...this.screen(p));c.stroke();}c.setLineDash([]);
  }
  for(const [id,p] of Object.entries(points)){const q=this.screen(p);c.fillStyle=this.selection.has(id)?"#e89116":id==="origin"?"#b84545":"#a7d0ff";c.beginPath();c.arc(...q,id==="origin"?4:3,0,tau);c.fill();}
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
    const pts=[...this.anchors.map(p=>p.uv),b];for(let i=1;i<pts.length;i++)this.line(pts[i-1],pts[i],color,1.5,dash);if($("sk-spline-closed").checked&&pts.length>2)this.line(pts.at(-1),pts[0],color,1,dash);
   }else if(this.tool==="rect"||this.tool==="center_rect"){const first=this.tool==="center_rect"?add(a,sub(a,b)):a,p=[b[0],first[1]],q=[first[0],b[1]];for(const [x,y] of [[first,p],[p,b],[b,q],[q,first]])this.line(x,y,color,1.5,dash);if(this.tool==="center_rect")this.line(first,b,color,1,dash);}else if(this.tool==="circle"){c.strokeStyle=color;c.setLineDash(dash);c.beginPath();c.arc(...this.screen(a),distance(a,b)*this.scale,0,tau);c.stroke();c.setLineDash([]);}else {this.line(this.anchors.at(-1).uv,b,color,1.5,dash);if(this.anchors.length===2)this.line(a,this.anchors[1].uv,color,1.5,dash);}}
  if(this.mouse?.label&&this.tool!=="select"){const q=this.screen(b);if(this.mouse.guide)this.line(this.mouse.guide,b,"#dca527",1,[4,4]);c.strokeStyle="#dca527";c.lineWidth=2;c.beginPath();c.moveTo(q[0]-6,q[1]);c.lineTo(q[0],q[1]-6);c.lineTo(q[0]+6,q[1]);c.lineTo(q[0],q[1]+6);c.closePath();c.stroke();c.font="12px system-ui";const w=c.measureText(this.mouse.label).width+12,x=Math.min(q[0]+12,this.w-w-4),y=Math.min(q[1]+12,this.h-23);c.fillStyle="#fff5d9";c.fillRect(x,y,w,22);c.fillStyle="#76530b";c.fillText(this.mouse.label,x+6,y+15);}
 }
}
