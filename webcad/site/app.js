import * as THREE from "three";
import {OrbitControls} from "./three/examples/jsm/controls/OrbitControls.js";
import {SketchEditor} from "./sketch-ui.js";
const $=id=>document.getElementById(id);
const worker=new Worker("./worker.js");
let seq=0,current=null,selected=null,busy=false,ready=false;
const pending=new Map();
function status(text){$("status").textContent=text==="Готово"?"":text;document.body.dataset.status=text;}
function error(err){$("errors").hidden=false;$("errors").textContent=String(err);status("Ошибка — см. диагностику");console.error(String(err));}
worker.onmessage=({data})=>{
 if(data.stage){status("Загрузка…");$("hint").textContent="Загрузка…";return;}
 const p=pending.get(data.requestId);if(!p)return;pending.delete(data.requestId);
 data.error?p.reject(Error(data.error)):p.resolve(data.result);
};
worker.onerror=e=>{for(const p of pending.values())p.reject(Error(e.message));pending.clear();error(e.message);};
function call(op,args={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});worker.postMessage({requestId:id,payload:{op,...args}});});}
const scene=new THREE.Scene();scene.background=new THREE.Color(0x6d7680);
const camera=new THREE.OrthographicCamera(-65,65,65,-65,0.1,1e7);camera.position.set(120,-150,110);camera.up.set(0,0,1);
let renderer,controls,frame=0,span=130,renderCount=0;
const group=new THREE.Group(),highlight=new THREE.Group();scene.add(group,highlight);
const raycaster=new THREE.Raycaster(),mouse=new THREE.Vector2();let pickables=[],edgeData=[],facePick=null,edgePicks=[],solidKind=null,partPick=null;
function invalidate(){if(!renderer||frame)return;frame=requestAnimationFrame(()=>{frame=0;renderer.render(scene,camera);document.body.dataset.renders=String(++renderCount);document.body.dataset.camera=JSON.stringify({position:camera.position.toArray(),target:controls.target.toArray()});});}
try{
 renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});renderer.setPixelRatio(Math.min(devicePixelRatio,1.5));$("view").prepend(renderer.domElement);
 controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=false;controls.screenSpacePanning=true;
 controls.mouseButtons.LEFT=-1;controls.mouseButtons.MIDDLE=THREE.MOUSE.PAN;controls.mouseButtons.RIGHT=THREE.MOUSE.ROTATE;
 controls.addEventListener("change",invalidate);
}catch(e){error("WebGL: "+e.message);}
scene.add(new THREE.HemisphereLight(0xffffff,0x879ab1,2.2));
const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(80,-100,180);scene.add(light);
function resize(){if(!renderer)return;const w=Math.max(1,$("view").clientWidth),h=Math.max(1,$("view").clientHeight),a=w/h;camera.left=-span*a/2;camera.right=span*a/2;camera.top=span/2;camera.bottom=-span/2;camera.updateProjectionMatrix();renderer.setSize(w,h);invalidate();}
new ResizeObserver(resize).observe($("view"));
function fit(){if(!controls)return;const box=new THREE.Box3().setFromObject(group);if(box.isEmpty())return;const c=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()).length(),direction=camera.position.clone().sub(controls.target).normalize();span=Math.max(size*1.45,1);camera.zoom=1;controls.target.copy(c);camera.position.copy(c).addScaledVector(direction,Math.max(size*2,10));resize();controls.update();invalidate();}
function view(name){if(!controls)return;const d={iso:[1,-1,1],top:[0,0,1],front:[0,-1,0],right:[1,0,0]}[name];camera.up.set(0,name==="top"?1:0,name==="top"?0:1);camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(...d).normalize(),Math.max(camera.position.distanceTo(controls.target),10));controls.update();invalidate();}
function dispose(g){for(const item of [...g.children]){item.geometry.dispose();item.material.dispose();g.remove(item);}}
function lineGeometry(v){const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(v,3));return g;}
function segments(v,out){for(let i=3;i<v.length;i+=3)out.push(...v.slice(i-3,i),...v.slice(i,i+3));}
function clearSelection(){facePick=null;edgePicks=[];partPick=null;updateSelection();}
function updateSelection(){dispose(highlight);for(const m of pickables)m.material.color.setHex(m.userData.part===partPick?0xeaa626:0xb9c8db);for(const b of $("parts").children)b.classList.toggle("selected",b.dataset.part===partPick);
 for(const p of edgePicks){const e=edgeData.find(x=>x.part===p.part&&x.index===p.index);if(e)highlight.add(new THREE.Line(lineGeometry(e.v),new THREE.LineBasicMaterial({color:0xe79616,depthTest:false})));}
 if(facePick){const m=pickables.find(x=>x.userData.part===facePick.part);if(m){const pos=m.geometry.attributes.position.array,idx=m.geometry.index.array,tri=m.userData.tri_face,v=[];for(let i=0;i<tri.length;i++)if(tri[i]===facePick.index)for(let j=0;j<3;j++){const a=idx[i*3+j]*3;v.push(pos[a],pos[a+1],pos[a+2]);}if(v.length){const g=lineGeometry(v);g.computeVertexNormals();highlight.add(new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0xeaa626,transparent:true,opacity:.45,side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2})));}}}
 $("selection-info").textContent=facePick?"Грань "+(facePick.index+1):edgePicks.length?"Рёбра: "+edgePicks.length:partPick?"Деталь: "+(current?.parts?.find(p=>p.id===partPick)?.name||partPick):"";
 if(solidKind==="fillet"||solidKind==="chamfer")$("solid-hint").textContent="Рёбра: "+edgePicks.length;
 invalidate();
}
function pick(e){if(!current||sketchEditor.active||busy||!renderer)return;const r=renderer.domElement.getBoundingClientRect();mouse.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);
 partPick=null;camera.updateMatrixWorld();raycaster.setFromCamera(mouse,camera);
 if($("edge-mode").checked){
  const q=[e.clientX-r.left,e.clientY-r.top];let best=null;
  const screen=(x,y,z)=>{const p=new THREE.Vector3(x,y,z).project(camera);return [(p.x+1)*r.width/2,(1-p.y)*r.height/2,p.z];};
  for(const edge of edgeData)for(let i=3;i<edge.v.length;i+=3){const a=screen(...edge.v.slice(i-3,i)),b=screen(...edge.v.slice(i,i+3)),dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((q[0]-a[0])*dx+(q[1]-a[1])*dy)/Math.max(dx*dx+dy*dy,1e-9))),d=Math.hypot(q[0]-a[0]-t*dx,q[1]-a[1]-t*dy),z=a[2]+t*(b[2]-a[2]);if(d<8&&(!best||d<best.d-1||(Math.abs(d-best.d)<=1&&z<best.z)))best={part:edge.part,index:edge.index,d,z};}
  facePick=null;if(!e.shiftKey)edgePicks=[];if(best){const i=edgePicks.findIndex(p=>p.part===best.part&&p.index===best.index);if(i>=0)edgePicks.splice(i,1);else edgePicks.push({part:best.part,index:best.index});}
 }else{edgePicks=[];const hit=raycaster.intersectObjects(pickables,false)[0];facePick=hit?{part:hit.object.userData.part,index:hit.object.userData.tri_face[hit.faceIndex]}:null;if(facePick?.index===undefined)facePick=null;}
 updateSelection();
}
let down=null;
if(renderer){renderer.domElement.addEventListener("pointerdown",e=>{down=[e.clientX,e.clientY,e.button];});renderer.domElement.addEventListener("pointerup",e=>{if(down&&down[2]===0&&Math.hypot(e.clientX-down[0],e.clientY-down[1])<4)pick(e);down=null;});}
function renderModel(result,refit=false){
 current=result;dispose(group);dispose(highlight);pickables=[];edgeData=[];facePick=null;edgePicks=[];partPick=null;
 for(const m of result.meshes){
  const g=lineGeometry(m.vertices);g.setIndex(m.triangles);
  if(m.normals.length===m.vertices.length)g.setAttribute("normal",new THREE.Float32BufferAttribute(m.normals,3));else g.computeVertexNormals();
  const mesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0xb9c8db,roughness:.65,metalness:.05,side:THREE.DoubleSide}));mesh.userData={part:m.id,tri_face:m.tri_face};group.add(mesh);pickables.push(mesh);
  const all=[];m.edges.forEach((v,index)=>{if(v.length<6)return;edgeData.push({part:m.id,index,v});segments(v,all);});
  if(all.length)group.add(new THREE.LineSegments(lineGeometry(all),new THREE.LineBasicMaterial({color:0x31465e})));
 }
 $("name").textContent=result.name;$("tab-name").textContent=result.name;$("units").textContent=result.units==="mm"?"миллиметр":result.units||"мм";$("feature-count").textContent="("+result.features.length+")";$("part-count").textContent="("+result.parts.length+")";$("parts").replaceChildren(...result.parts.map(p=>{const b=treeButton("part",p.name);b.dataset.part=p.id;b.onclick=()=>{facePick=null;edgePicks=[];partPick=partPick===p.id?null:p.id;updateSelection();};return b;}));$("features").replaceChildren();
 if(!result.features.some(x=>x.id===selected))selected=null;
 for(const f of result.features){const b=treeButton(f.type,f.name+(f.suppressed?" (подавлено)":""));b.dataset.feature=f.id;b.className=f.id===selected?"selected":"";b.onclick=()=>{selected=f.id;selectFeature();for(const n of $("features").children)n.classList.toggle("selected",n===b);};b.ondblclick=()=>{if(f.type==="sketch")startSketch(f.id);};$("features").append(b);}
 $("metrics").textContent="Объём: "+result.volume.toFixed(3)+" мм³ · деталей: "+result.meshes.length+" · "+result.ms+" мс";
 $("errors").textContent=Object.entries(result.errors||{}).map(([id,msg])=>id+": "+msg).join("\n");
 $("hint").textContent="";$("errors").hidden=!$("errors").textContent;filterTree();
 selectFeature();updateSelection();if(refit)fit();invalidate();
 document.body.dataset.volume=String(result.volume);document.body.dataset.meshes=String(result.meshes.length);
}
function treeButton(kind,label){const b=document.createElement("button"),img=document.createElement("img"),span=document.createElement("span");img.src="icons/"+(ICON_NAMES.has(kind)?kind:"part")+".png";img.alt="";span.textContent=label;b.append(img,span);return b;}
const ICON_NAMES=new Set(["part","origin","plane","sketch","extrude","revolve","fillet","chamfer","undo","redo","line","rect","circle","arc3","point","construction","dimension","horizontal","vertical","parallel","perpendicular","equal","fix","coincident","midpoint","concentric","delete","fit","iso","finish_sketch","error","select","history","folder","variable","hole","thread","shell","sweep","loft","mirror","boolean","split","move","linear_pattern","circular_pattern","derived","configs","offset_surface","thicken","rib","draft","delete_face","move_face","bounding_box","compound","explode_part","helix","measure_value","mate_connector","sm_base","sm_flange","ellipse","spline","center_rect","arc_center","sk_fillet","sk_chamfer","trim","use","offset","slot","sk_mirror","sk_lpattern","sk_cpattern"]);
function filterTree(){const q=$("feature-filter").value.toLowerCase();for(const b of $("features").children)b.hidden=!b.textContent.toLowerCase().includes(q);}
function selectedFeature(){return current?.features.find(x=>x.id===selected);}
function selectFeature(){const f=selectedFeature();$("feature-actions").hidden=!f;$("edit-sketch").hidden=f?.type!=="sketch";$("suppress").textContent=f?.suppressed?"Восстановить":"Подавить";$("edit").hidden=sketchEditor.active||!(f?.type==="extrude"&&typeof f.depth==="number");if(!$("edit").hidden)$("depth").value=f.depth;buttons();}
function buttons(){const active=sketchEditor?.active;
 for(const id of ["new","demo","open","save","step","stl","rebuild","fit","apply","sketch","extrude","revolve","fillet","chamfer","undo","redo"]){
  const needsDoc=!["new","demo","open"].includes(id);
  $(id).disabled=!ready||busy||!!active||(needsDoc&&!current)||(id==="undo"&&!current?.undo)||(id==="redo"&&!current?.redo)||(["fillet","chamfer","step","stl"].includes(id)&&!current?.meshes.length)||(["extrude","revolve"].includes(id)&&!current?.features.some(f=>f.regions>0));
 }
 $("main-tools").hidden=!!active;
}
async function request(op,args={}){if(busy)throw Error("Вычисление уже выполняется");if(sketchEditor.active&&!op.startsWith("sketch_"))throw Error("Сначала завершите эскиз");busy=true;buttons();$("errors").textContent="";$("errors").hidden=true;status("Вычисление…");try{const r=await call(op,args);status("Готово");return r;}catch(e){error(e);throw e;}finally{busy=false;buttons();}}
async function run(op,args={},refit=false){try{const r=await request(op,args);if(r.file!==undefined){const bytes=op==="export"?Uint8Array.from(atob(r.file),c=>c.charCodeAt(0)):r.file;const url=URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"}));const a=document.createElement("a");a.href=url;a.download=r.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}else{if(["open","demo","new"].includes(op))selected=null;renderModel(r,refit);}return r;}catch(e){return null;}}
const sketchEditor=new SketchEditor(request,result=>{renderModel(result,true);buttons();},error);
async function startSketch(id=null){if(busy||sketchEditor.active)return;try{const args=id?{id}:facePick?{face:facePick}:{plane:$("plane").value};const result=await request("begin_sketch",args);$("edit").hidden=true;$("solid-dialog").hidden=true;solidKind=null;sketchEditor.show(result);$("hint").textContent="";buttons();}catch(e){}}
function fillRegions(){const f=current.features.find(x=>x.id===$("solid-sketch").value);$("solid-regions").replaceChildren();for(let i=0;i<(f?.regions||0);i++){const l=document.createElement("label"),c=document.createElement("input");c.type="checkbox";c.value=i;c.checked=true;l.append(c,"Область "+(i+1));$("solid-regions").append(l);}}
function openSolid(kind){$("edit").hidden=true;solidKind=kind;$("solid-icon").src="icons/"+kind+".png";const profile=kind==="extrude"||kind==="revolve";$("solid-title").textContent={extrude:"Выдавливание",revolve:"Вращение",fillet:"Скругление",chamfer:"Фаска"}[kind];
 $("solid-sketch-label").hidden=!profile;$("solid-regions").hidden=!profile;$("solid-op-label").hidden=!profile;$("solid-axis-label").hidden=kind!=="revolve";$("solid-flip-label").hidden=!profile;
 $("solid-value-label").textContent=kind==="revolve"?"Угол, °":kind==="fillet"?"Радиус, мм":kind==="chamfer"?"Размер фаски, мм":"Глубина, мм";$("solid-value").value=kind==="revolve"?360:profile?10:1;$("solid-flip").checked=false;
 if(profile){$("solid-sketch").replaceChildren(...current.features.filter(f=>f.regions>0).map(f=>new Option(f.name,f.id)));if(selectedFeature()?.regions)$("solid-sketch").value=selected;fillRegions();$("solid-op").value=current.meshes.length?"add":"new";$("solid-hint").textContent="";}else{$("edge-mode").checked=true;updateSelection();}
 $("solid-dialog").hidden=false;}
$("solid-sketch").onchange=fillRegions;
$("solid-cancel").onclick=()=>{$("solid-dialog").hidden=true;solidKind=null;};
$("solid-dialog").onsubmit=async e=>{e.preventDefault();const kind=solidKind,args={kind,value:Number($("solid-value").value),sketch:$("solid-sketch").value,regions:[...$("solid-regions").querySelectorAll("input:checked")].map(x=>Number(x.value)),operation:$("solid-op").value,axis:$("solid-axis").value,flip:$("solid-flip").checked,edges:edgePicks};const r=await run("solid",args,true);if(r){$("solid-dialog").hidden=true;solidKind=null;}};
$("new").onclick=()=>run("new",{},true);$("demo").onclick=()=>run("demo",{},true);$("open").onclick=()=>$("file").click();
$("file").onchange=async()=>{const f=$("file").files[0];if(f){if(f.size>100*1024*1024)error("Файл больше 100 МиБ");else await run("open",{content:await f.text()},true);}$("file").value="";};
$("save").onclick=()=>run("save");$("step").onclick=()=>run("export",{format:"step"});$("stl").onclick=()=>run("export",{format:"stl"});$("rebuild").onclick=()=>run("rebuild");$("fit").onclick=fit;
$("edit").onsubmit=e=>{e.preventDefault();run("depth",{id:selected,value:Number($("depth").value)});};
$("sketch").onclick=()=>startSketch();$("edit-sketch").onclick=()=>startSketch(selected);
for(const kind of ["extrude","revolve","fillet","chamfer"])$(kind).onclick=()=>openSolid(kind);
$("close-edit").onclick=()=>{$("edit").hidden=true;};$("feature-filter").oninput=filterTree;for(const b of document.querySelectorAll("[data-plane]"))b.onclick=()=>{if(sketchEditor.active)return;clearSelection();selected=null;$("plane").value=b.dataset.plane;for(const n of document.querySelectorAll("[data-plane]"))n.classList.toggle("selected",n===b);for(const n of $("features").children)n.classList.remove("selected");selectFeature();};$("fit-menu").onclick=fit;for(const n of ["iso","top","front","right"])$("view-"+n).onclick=()=>view(n);document.addEventListener("click",e=>{for(const d of document.querySelectorAll(".menu[open],.tool-menu[open]"))if(!d.contains(e.target)||e.target.closest("button"))d.open=false;});$("clear-selection").onclick=clearSelection;$("edge-mode").onchange=clearSelection;for(const b of document.querySelectorAll("[data-view]"))b.onclick=()=>view(b.dataset.view);
$("undo").onclick=()=>run("undo");$("redo").onclick=()=>run("redo");
$("delete").onclick=()=>{if(selected&&confirm("Удалить выбранную операцию? Зависимые операции могут перестать работать."))run("delete",{id:selected});};
$("rename").onclick=()=>{const f=selectedFeature();if(f){const name=prompt("Название",f.name);if(name?.trim())run("rename",{id:f.id,name:name.trim()});}};
$("suppress").onclick=()=>{const f=selectedFeature();if(f)run("suppress",{id:f.id,value:!f.suppressed});};
window.addEventListener("keydown",e=>{if(sketchEditor.active||e.target.matches("input,textarea,select"))return;if(e.ctrlKey&&e.code==="KeyZ"){e.preventDefault();run(e.shiftKey?"redo":"undo");}else if(e.ctrlKey&&e.code==="KeyY"){e.preventDefault();run("redo");}else if(e.ctrlKey&&e.code==="KeyS"){e.preventDefault();run("save");}});
$("offline").onclick=async()=>{if(!("serviceWorker" in navigator)){error("Офлайн-кэш требует HTTPS или localhost");return;}try{status("Подготовка офлайн-кэша…");const registration=await navigator.serviceWorker.register("./sw.js");await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Офлайн-кэш не активировался")),240000);navigator.serviceWorker.addEventListener("controllerchange",()=>{clearTimeout(timer);resolve();},{once:true});});}status("Офлайн-кэш готов");document.body.dataset.offline="ready";}catch(e){error(e);}};
try{const info=await call("init");$("runtime").textContent="Python "+info.python+" · OCP "+info.ocp+" · "+info.platform;document.body.dataset.runtime="ready";if(!renderer)throw Error("WebGL недоступен");ready=true;buttons();const result=await run("new",{},true);if(!result)throw Error($("errors").textContent);document.body.dataset.ready="true";}catch(e){error(e);$("hint").textContent="Ядро не запустилось. См. диагностику.";document.body.dataset.ready="false";}
