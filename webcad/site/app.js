import * as THREE from "three";
import {OrbitControls} from "./three/examples/jsm/controls/OrbitControls.js";
import {SketchEditor} from "./sketch-ui.js";
const $=id=>document.getElementById(id);
const worker=new Worker("./worker.js");
let seq=0,current=null,selected=null,busy=false,ready=false;
const pending=new Map();
function status(text){$("status").textContent=text==="Готово"?"":text;document.body.dataset.status=text;}
function error(err){const message=err instanceof Error?err.message:String(err);$("errors").hidden=false;$("errors").textContent=message;status("Ошибка");console.error(err); }
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
const group=new THREE.Group(),highlight=new THREE.Group(),previewGroup=new THREE.Group(),regionGroup=new THREE.Group();scene.add(group,highlight,previewGroup,regionGroup);
const raycaster=new THREE.Raycaster(),mouse=new THREE.Vector2();let pickables=[],edgeData=[],facePick=null,edgePicks=[],solidKind=null,partPick=null,sketchCurvePicks=[];
let solidContext=null,solidEdit=null,solidOriginal=null,solidProfiles=new Map(),solidAutoOp=true,solidAutoDirection=false,solidCreation="solid",solidOrigins=[],solidVars=[],solidVarOffer=null,solidArrows=[],solidDrag=null;
const solidDefaults=new Map();
let previewTimer=0,previewVersion=0,previewInFlight=false,previewQueued=false,previewFitted=false;
function invalidate(){if(!renderer||frame)return;frame=requestAnimationFrame(()=>{frame=0;renderer.render(scene,camera);drawSolidArrows();document.body.dataset.renders=String(++renderCount);document.body.dataset.camera=JSON.stringify({position:camera.position.toArray(),target:controls.target.toArray()});});}
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
function fit(){if(!controls)return;const box=new THREE.Box3().setFromObject(previewGroup.children.length?previewGroup:group);if(!previewGroup.children.length)box.expandByObject(regionGroup);if(box.isEmpty())return;const c=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()).length(),direction=camera.position.clone().sub(controls.target).normalize();span=Math.max(size*1.45,1);camera.zoom=1;controls.target.copy(c);camera.position.copy(c).addScaledVector(direction,Math.max(size*2,10));resize();controls.update();invalidate();}
function view(name){if(!controls)return;const d={iso:[1,-1,1],top:[0,0,1],front:[0,-1,0],right:[1,0,0]}[name];camera.up.set(0,name==="top"?1:0,name==="top"?0:1);camera.position.copy(controls.target).addScaledVector(new THREE.Vector3(...d).normalize(),Math.max(camera.position.distanceTo(controls.target),10));controls.update();invalidate();}
function dispose(g){for(const item of [...g.children]){item.geometry.dispose();item.material.dispose();g.remove(item);}}
function lineGeometry(v){const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(v,3));return g;}
function segments(v,out){for(let i=3;i<v.length;i+=3)out.push(...v.slice(i-3,i),...v.slice(i,i+3));}
function clearSelection(){facePick=null;edgePicks=[];partPick=null;sketchCurvePicks=[];updateSelection();drawRegions();schedulePreview();}
function updateSelection(){dispose(highlight);for(const m of pickables)m.material.color.set(m.userData.part===partPick?0xeaa626:m.userData.color);for(const b of $("parts").children)b.classList.toggle("selected",b.dataset.part===partPick);
 for(const p of edgePicks){const e=edgeData.find(x=>x.part===p.part&&x.index===p.index);if(e)highlight.add(new THREE.Line(lineGeometry(e.v),new THREE.LineBasicMaterial({color:0xe79616,depthTest:false})));}
 if(facePick){const m=pickables.find(x=>x.userData.part===facePick.part);if(m){const pos=m.geometry.attributes.position.array,idx=m.geometry.index.array,tri=m.userData.tri_face,v=[];for(let i=0;i<tri.length;i++)if(tri[i]===facePick.index)for(let j=0;j<3;j++){const a=idx[i*3+j]*3;v.push(pos[a],pos[a+1],pos[a+2]);}if(v.length){const g=lineGeometry(v);g.computeVertexNormals();highlight.add(new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:0xeaa626,transparent:true,opacity:.45,side:THREE.DoubleSide,depthWrite:false,polygonOffset:true,polygonOffsetFactor:-2})));}}}
 $("selection-info").textContent=facePick?"Грань "+(facePick.index+1):edgePicks.length?"Рёбра: "+edgePicks.length:partPick?"Деталь: "+(current?.parts?.find(p=>p.id===partPick)?.name||partPick):"";
 if(solidKind==="fillet"||solidKind==="chamfer")$("solid-hint").textContent="Рёбра: "+edgePicks.length;
 invalidate();
}
function profileMode(){return solidKind==="extrude"||solidKind==="revolve";}
function regionSketch(){return profileMode()?$("solid-sketch").value:selectedFeature()?.type==="sketch"?selected:!current?.meshes.length?current?.features.filter(f=>f.type==="sketch"&&!f.suppressed).at(-1)?.id:null;}
function drawRegions(){
 dispose(regionGroup);const fid=regionSketch(),regions=current?.sketch_regions?.[fid]||[];
 const checked=new Set([...$("solid-regions").querySelectorAll("input:checked")].map(x=>Number(x.value)));
 for(let i=0;i<regions.length;i++){
  const r=regions[i],g=lineGeometry(r.vertices.flat());g.setIndex(r.triangles.flat());
  const active=profileMode()&&checked.has(i);
  const mesh=new THREE.Mesh(g,new THREE.MeshBasicMaterial({color:active?0xe8b34c:0x8dbde8,opacity:active?.38:.22,transparent:true,side:THREE.DoubleSide,depthWrite:false,depthTest:!profileMode(),polygonOffset:true,polygonOffsetFactor:-2}));
  mesh.userData={region:i,sketch:fid};mesh.renderOrder=4;regionGroup.add(mesh);
  const lines=[];for(const v of r.edges)segments(v,lines);
  if(lines.length){const edge=new THREE.LineSegments(lineGeometry(lines),new THREE.LineBasicMaterial({color:active?0xf8cf80:0x9fcfff,depthTest:!profileMode()}));edge.renderOrder=5;regionGroup.add(edge);}
 }
 if(profileMode()&&solidContext){for(const [sketch,s] of Object.entries(solidContext.catalog.sketches)){if(sketch!==fid&&$("solid-pick").value!=="axis")continue;for(const c of s.curves){const lines=[];for(const path of c.paths)segments(path.flat(),lines);if(!lines.length)continue;const selectedCurve=vals("solid-curves").some(r=>r.sketch===sketch&&(r.only?r.only.includes(c.id):r.entity===c.id||s.curves.find(x=>x.id===r.entity)?.chain?.includes(c.id))),axis=val("solid-axis"),active=selectedCurve||(axis?.sketch===sketch&&axis.line===c.id);const l=new THREE.LineSegments(lineGeometry(lines),new THREE.LineBasicMaterial({color:active?0xf8cf80:c.construction?0xa4a9b1:0x9fcfff,depthTest:false}));l.renderOrder=6;regionGroup.add(l);}}}
 if(!profileMode()&&fid){for(const c of current?.sketch_curves?.[fid]||[]){const lines=[];for(const path of c.paths)segments(path.flat(),lines);if(!lines.length)continue;const active=sketchCurvePicks.some(r=>r.sketch===fid&&r.entity===c.id);const l=new THREE.LineSegments(lineGeometry(lines),new THREE.LineBasicMaterial({color:active?0xf8cf80:c.construction?0xa4a9b1:0x9fcfff,depthTest:false}));l.renderOrder=6;regionGroup.add(l);}}
 document.body.dataset.regions=String(regions.length);invalidate();
}
function pickRegion(e){
 if(!profileMode()||$("solid-pick").value!=="profile")return false;
 const hit=raycaster.intersectObjects(regionGroup.children.filter(x=>x.isMesh),false)[0];if(!hit)return false;
 const index=hit.object.userData.region;
 const boxes=[...$("solid-regions").querySelectorAll("input")],box=boxes.find(x=>Number(x.value)===index);
 if(!box)return false;
 if(e.shiftKey)box.checked=!box.checked;
 else box.checked=!box.checked;
 saveRegionChecks();drawRegions();schedulePreview();return true;
}
function pick(e){if(!current||sketchEditor.active||busy||!renderer)return;const r=renderer.domElement.getBoundingClientRect();mouse.set((e.clientX-r.left)/r.width*2-1,-(e.clientY-r.top)/r.height*2+1);
 partPick=null;camera.updateMatrixWorld();raycaster.setFromCamera(mouse,camera);if(pickRegion(e))return;
 const mode=solidKind?$("solid-pick").value:"";
 if(!solidKind&&$("edge-mode").checked){
  const fid=regionSketch(),q=[e.clientX-r.left,e.clientY-r.top];let best=null;
  for(const c of current?.sketch_curves?.[fid]||[])if(!c.construction)for(const path of c.paths)for(let i=1;i<path.length;i++){
   const a=arrowProject(path[i-1]),b=arrowProject(path[i]),dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((q[0]-a[0])*dx+(q[1]-a[1])*dy)/Math.max(dx*dx+dy*dy,1e-9))),d=Math.hypot(q[0]-a[0]-t*dx,q[1]-a[1]-t*dy);
   if(d<8&&(!best||d<best.d))best={d,entity:c.id};
  }
  if(best){facePick=null;edgePicks=[];if(!e.shiftKey)sketchCurvePicks=[];const i=sketchCurvePicks.findIndex(x=>x.sketch===fid&&x.entity===best.entity);if(i>=0)sketchCurvePicks.splice(i,1);else sketchCurvePicks.push({kind:"sketch_chain",sketch:fid,entity:best.entity,only:[best.entity]});updateSelection();drawRegions();return;}
 }
 if(mode==="scope"){const hit=raycaster.intersectObjects(pickables,false)[0];if(hit){setPicked("solid-scope",hit.object.userData.part,true);solidAutoOp=false;syncSolidHighlights();schedulePreview();}return;}
 if(solidKind&&["target","target2"].includes(mode)){const suffix=mode==="target2"?"2":"",end=$("solid-end"+suffix).value;if(end==="up_to_vertex"){const q=[e.clientX-r.left,e.clientY-r.top];let best=null;const offer=(p,pick)=>{const v=new THREE.Vector3(...p).project(camera),d=Math.hypot(q[0]-(v.x+1)*r.width/2,q[1]-(1-v.y)*r.height/2);if(d<10&&(!best||d<best.d))best={d,pick};};for(const m of current.meshes)for(const [index,p] of (m.points||[]).entries())offer(p,{kind:"vertex",part:m.id,index});for(const [sketch,s] of Object.entries(solidContext.catalog.sketches))for(const [point,p] of Object.entries(s.points))offer(p,{kind:"sketch_point",sketch,point});if(best){setPicked("solid-target"+suffix,best.pick);solidAutoDirection=true;}schedulePreview();return;}const hit=raycaster.intersectObjects(pickables,false)[0];if(hit){const part=hit.object.userData.part;setPicked("solid-target"+suffix,end==="up_to_part"?{kind:"part",id:part}:{kind:"face",part,index:hit.object.userData.tri_face[hit.faceIndex]});solidAutoDirection=true;schedulePreview();}return;}
 if(solidKind&&["axis","curve"].includes(mode)){const q=[e.clientX-r.left,e.clientY-r.top];let best=null;for(const [sketch,s] of Object.entries(solidContext.catalog.sketches))for(const c of s.curves){if(mode==="axis"?c.type!=="line":c.construction)continue;for(const path of c.paths)for(let i=1;i<path.length;i++){const project=p=>{const v=new THREE.Vector3(...p).project(camera);return [(v.x+1)*r.width/2,(1-v.y)*r.height/2];},a=project(path[i-1]),b=project(path[i]),dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((q[0]-a[0])*dx+(q[1]-a[1])*dy)/Math.max(dx*dx+dy*dy,1e-9))),d=Math.hypot(q[0]-a[0]-t*dx,q[1]-a[1]-t*dy);if(d<8&&(!best||d<best.d))best={d,pick:mode==="axis"?{kind:"sketch_line",sketch,line:c.id}:{kind:"sketch_chain",sketch,entity:e.shiftKey||c.chain?.length<=1?c.id:[...c.chain].sort()[0],...(e.shiftKey||c.chain?.length<=1?{only:[c.id]}:{})}};}}if(best){setPicked(mode==="axis"?"solid-axis":"solid-curves",best.pick,e.shiftKey);syncSolidHighlights();schedulePreview();return;}}
 if(solidKind?["edge","axis","curve"].includes(mode):$("edge-mode").checked){
  const q=[e.clientX-r.left,e.clientY-r.top];let best=null;
  const screen=(x,y,z)=>{const p=new THREE.Vector3(x,y,z).project(camera);return [(p.x+1)*r.width/2,(1-p.y)*r.height/2,p.z];};
  for(const edge of edgeData)for(let i=3;i<edge.v.length;i+=3){const a=screen(...edge.v.slice(i-3,i)),b=screen(...edge.v.slice(i,i+3)),dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((q[0]-a[0])*dx+(q[1]-a[1])*dy)/Math.max(dx*dx+dy*dy,1e-9))),d=Math.hypot(q[0]-a[0]-t*dx,q[1]-a[1]-t*dy),z=a[2]+t*(b[2]-a[2]);if(d<8&&(!best||d<best.d-1||(Math.abs(d-best.d)<=1&&z<best.z)))best={part:edge.part,index:edge.index,d,z};}
  if(solidKind&&best){const p={part:best.part,index:best.index};setPicked(mode==="axis"?"solid-axis":mode==="curve"?"solid-curves":"solid-edges",mode==="edge"?p:{kind:"edge",...p},e.shiftKey);syncSolidHighlights();schedulePreview();return;}
  if(solidKind&&mode==="curve"&&!best){
   const region=raycaster.intersectObjects(regionGroup.children.filter(x=>x.isMesh),false)[0];
   if(region){const {sketch,region:index}=region.object.userData;setPicked("solid-curves",{kind:"outline_region",sketch,index},true);syncSolidHighlights();schedulePreview();return;}
   const hit=raycaster.intersectObjects(pickables,false)[0];if(hit){setPicked("solid-curves",{kind:"outline_face",part:hit.object.userData.part,index:hit.object.userData.tri_face[hit.faceIndex]},true);syncSolidHighlights();schedulePreview();return;}
  }
  facePick=null;if(!e.shiftKey)edgePicks=[];if(best){const i=edgePicks.findIndex(p=>p.part===best.part&&p.index===best.index);if(i>=0)edgePicks.splice(i,1);else edgePicks.push({part:best.part,index:best.index});}
 }else{edgePicks=[];const hit=raycaster.intersectObjects(pickables,false)[0];facePick=hit?{part:hit.object.userData.part,index:hit.object.userData.tri_face[hit.faceIndex]}:null;if(facePick?.index===undefined)facePick=null;if(solidKind&&facePick){setPicked(mode==="edge_face"?"solid-edge-faces":"solid-faces",facePick,e.shiftKey);syncSolidHighlights();schedulePreview();return;}}
 updateSelection();schedulePreview();
}
let down=null;
if(renderer){renderer.domElement.addEventListener("pointerdown",e=>{down=[e.clientX,e.clientY,e.button];});renderer.domElement.addEventListener("pointerup",e=>{if(down&&down[2]===0&&Math.hypot(e.clientX-down[0],e.clientY-down[1])<4)pick(e);down=null;});}
function renderModel(result,refit=false){
 clearPreview();current=result;dispose(group);dispose(highlight);pickables=[];edgeData=[];facePick=null;edgePicks=[];partPick=null;sketchCurvePicks=[];
 for(const m of result.meshes){
  const g=lineGeometry(m.vertices);g.setIndex(m.triangles);
  if(m.normals.length===m.vertices.length)g.setAttribute("normal",new THREE.Float32BufferAttribute(m.normals,3));else g.computeVertexNormals();
  const mesh=new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0xb9c8db,roughness:.65,metalness:.05,side:THREE.DoubleSide}));mesh.userData={part:m.id,tri_face:m.tri_face,color:m.color?new THREE.Color(...m.color.slice(0,3)):0xb9c8db};group.add(mesh);pickables.push(mesh);
  const all=[];m.edges.forEach((v,index)=>{if(v.length<6)return;edgeData.push({part:m.id,index,v});segments(v,all);});
  if(all.length)group.add(new THREE.LineSegments(lineGeometry(all),new THREE.LineBasicMaterial({color:0x31465e})));
 }
 $("name").textContent=result.name;$("tab-name").textContent=result.name;$("units").textContent=result.units==="mm"?"миллиметр":result.units||"мм";$("feature-count").textContent="("+result.features.length+")";$("part-count").textContent="("+result.parts.length+")";$("parts").replaceChildren(...result.parts.map(p=>{const b=treeButton("part",p.name);b.dataset.part=p.id;b.onclick=()=>{if(solidKind){const mode=$("solid-pick").value;if(mode==="scope"){setPicked("solid-scope",p.id,true);solidAutoOp=false;syncSolidHighlights();schedulePreview();return;}if(["target","target2"].includes(mode)){const suffix=mode==="target2"?"2":"";if($("solid-end"+suffix).value==="up_to_part"){setPicked("solid-target"+suffix,{kind:"part",id:p.id});solidAutoDirection=true;schedulePreview();return;}}}facePick=null;edgePicks=[];partPick=partPick===p.id?null:p.id;updateSelection();};return b;}));$("features").replaceChildren();
 if(!result.features.some(x=>x.id===selected))selected=null;
 for(const f of result.features){const b=treeButton(f.type,f.name+(f.suppressed?" (подавлено)":""));b.dataset.feature=f.id;b.className=f.id===selected?"selected":"";b.onclick=()=>{if(solidKind&&f.type==="plane"&&["target","target2"].includes($("solid-pick").value)){const suffix=$("solid-pick").value==="target2"?"2":"";if($("solid-end"+suffix).value==="up_to_face"){setPicked("solid-target"+suffix,{kind:"plane",id:f.id});solidAutoDirection=true;schedulePreview();return;}}selected=f.id;selectFeature();for(const n of $("features").children)n.classList.toggle("selected",n===b);};b.ondblclick=()=>{if(f.type==="sketch")startSketch(f.id);else if(["extrude","revolve","fillet","chamfer"].includes(f.type))openSolid(f.type,f.id);};$("features").append(b);}
 $("metrics").textContent="Объём: "+result.volume.toFixed(3)+" мм³ · деталей: "+result.meshes.length+" · "+result.ms+" мс";
 $("errors").textContent=Object.entries(result.errors||{}).map(([id,msg])=>id+": "+msg).join("\n");
 $("hint").textContent="";$("errors").hidden=!$("errors").textContent;filterTree();
 selectFeature();updateSelection();if(refit)fit();invalidate();
 document.body.dataset.volume=String(result.volume);document.body.dataset.meshes=String(result.meshes.length);
}
function treeButton(kind,label){const b=document.createElement("button"),img=document.createElement("img"),span=document.createElement("span");img.src="icons/"+(ICON_NAMES.has(kind)?kind:"part")+".png";img.alt="";span.textContent=label;b.append(img,span);return b;}
const ICON_NAMES=new Set(["part","origin","plane","sketch","extrude","revolve","fillet","chamfer","undo","redo","line","rect","circle","arc3","point","construction","dimension","horizontal","vertical","parallel","perpendicular","equal","fix","coincident","midpoint","concentric","delete","fit","iso","finish_sketch","error","select","history","folder","variable","hole","thread","shell","sweep","loft","mirror","boolean","split","move","linear_pattern","circular_pattern","derived","configs","offset_surface","thicken","rib","draft","delete_face","move_face","bounding_box","compound","explode_part","helix","measure_value","mate_connector","sm_base","sm_flange","ellipse","spline","polygon","polygon_out","center_rect","arc_center","sk_fillet","sk_chamfer","trim","use","offset","slot","sk_mirror","sk_lpattern","sk_cpattern"]);
function filterTree(){const q=$("feature-filter").value.toLowerCase();for(const b of $("features").children)b.hidden=!b.textContent.toLowerCase().includes(q);}
function selectedFeature(){return current?.features.find(x=>x.id===selected);}
function selectFeature(){const f=selectedFeature();$("feature-actions").hidden=!f;$("edit-sketch").hidden=f?.type!=="sketch";$("edit-solid").hidden=!["extrude","revolve","fillet","chamfer"].includes(f?.type);$("suppress").textContent=f?.suppressed?"Восстановить":"Подавить";$("edit").hidden=sketchEditor.active||!(f?.type==="extrude"&&typeof f.depth==="number"&&(f.params?.end||"blind")==="blind")||!!solidKind;if(!$("edit").hidden)$("depth").value=f.depth;drawRegions();buttons();}
function buttons(){const active=sketchEditor?.active;
 for(const id of ["new","demo","open","save","step","stl","rebuild","variable","fit","apply","sketch","extrude","revolve","fillet","chamfer","undo","redo"]){
  const needsDoc=!["new","demo","open"].includes(id);
  $(id).disabled=!ready||busy||!!active||(needsDoc&&!current)||(id==="undo"&&!current?.undo)||(id==="redo"&&!current?.redo)||(["fillet","chamfer","step","stl"].includes(id)&&!current?.meshes.length)||(["extrude","revolve"].includes(id)&&!current?.features.some(f=>f.type==="sketch")&&!current?.meshes.length);
 }
 $("main-tools").hidden=!!active;
}
async function request(op,args={}){if(busy)throw Error("Вычисление уже выполняется");if(solidKind&&op!=="solid")closeSolid();if(sketchEditor.active&&!op.startsWith("sketch_"))throw Error("Сначала завершите эскиз");busy=true;buttons();$("errors").textContent="";$("errors").hidden=true;status("Вычисление…");try{const r=await call(op,args);status("Готово");return r;}catch(e){error(e);throw e;}finally{busy=false;buttons();}}
async function run(op,args={},refit=false){try{const r=await request(op,args);if(r.file!==undefined){const bytes=op==="export"?Uint8Array.from(atob(r.file),c=>c.charCodeAt(0)):r.file;const url=URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"}));const a=document.createElement("a");a.href=url;a.download=r.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}else{if(["open","demo","new"].includes(op))selected=null;if(op==="solid"){solidOriginal=null;solidEdit=null;solidKind=null;solidContext=null;$("solid-dialog").hidden=true;}renderModel(r,refit);}return r;}catch(e){return null;}}
const sketchEditor=new SketchEditor(request,result=>{renderModel(result,true);buttons();},error,call);
async function startSketch(id=null){if(busy||sketchEditor.active)return;try{const args=id?{id}:facePick?{face:facePick}:{plane:$("plane").value};const result=await request("begin_sketch",args);$("edit").hidden=true;$("solid-dialog").hidden=true;solidKind=null;sketchEditor.show(result);$("hint").textContent="";buttons();}catch(e){}}
const endOptions=[["up_to_next","До следующего"],["up_to_face","До грани / плоскости"],["up_to_part","До детали"],["up_to_vertex","До вершины"]];
const extrudeEnds=[["blind","На глубину"],["symmetric","Симметрично"],["through","Насквозь"],...endOptions];
const revolveEnds=[["full","Полный оборот"],["one","В одном направлении"],["symmetric","Симметрично"],["two","В двух направлениях"],...endOptions];
const j=JSON.stringify;
function options(id,items,selected=[]){const el=$(id),set=new Set(selected.map(v=>typeof v==="string"?v:j(v)));el.replaceChildren(...items.map(([v,label])=>{const o=new Option(label,typeof v==="string"?v:j(v));o.selected=set.has(o.value);return o;}));}
function vals(id){return [...$(id).selectedOptions].map(o=>JSON.parse(o.value));}
function val(id){try{return JSON.parse($(id).value);}catch{return null;}}
function setPicked(id,pick,add=false){
 const el=$(id),key=j(pick),opt=[...el.options].find(o=>o.value===key);
 if(!opt)return false;if(el.multiple){opt.selected=!opt.selected;}else el.value=el.value===key?"":key;
 return true;
}
function saveRegionChecks(){const fid=$("solid-regions").dataset.sketch;if(fid)solidProfiles.set(fid,[...$("solid-regions").querySelectorAll("input:checked")].map(x=>Number(x.value)));}
function fillRegions(){const fid=$("solid-sketch").value,regions=current?.sketch_regions?.[fid]||[];
 $("solid-regions").dataset.sketch=fid;$("solid-regions").replaceChildren();const chosen=solidProfiles.get(fid)||[];
 for(let i=0;i<regions.length;i++){const l=document.createElement("label"),c=document.createElement("input");c.type="checkbox";c.value=i;c.checked=chosen.includes(i);c.dataset.area=regions[i].area;l.append(c,"Область "+(i+1)+" · "+Number(c.dataset.area).toFixed(2)+" мм²");$("solid-regions").append(l);}drawRegions();
}
function catalogItems(){
 const c=solidContext.catalog,faces=[],allFaces=[],edges=[],axis=[],curves=[],targets={up_to_face:[],up_to_part:[],up_to_vertex:[]};
 for(const [fid,s] of Object.entries(c.sketches)){
  const name=current.features.find(f=>f.id===fid)?.name||fid;
  for(const e of s.curves){
   if(e.type==="line")axis.push([{kind:"sketch_line",sketch:fid,line:e.id},name+" · "+e.id+" (линия)"]);
   if(!e.construction){curves.push([{kind:"sketch_chain",sketch:fid,entity:e.id,only:[e.id]},name+" · "+e.id+" ("+e.type+")"]);if(e.chain?.length>1&&e.id===[...e.chain].sort()[0])curves.push([{kind:"sketch_chain",sketch:fid,entity:e.id},name+" · цепочка ("+e.chain.length+")"]);}
  }
  for(let i=0;i<s.regions;i++){curves.push([{kind:"outline_region",sketch:fid,index:i},name+" · контур "+(i+1)]);for(let e=0;e<(s.region_edges?.[i]||0);e++)curves.push([{kind:"region_edge",sketch:fid,index:i,edge:e},name+" · область "+(i+1)+", ребро "+(e+1)]);}
  for(const pid of Object.keys(s.points))targets.up_to_vertex.push([{kind:"sketch_point",sketch:fid,point:pid},name+" · "+pid]);
 }
 for(const p of c.parts){
  const name=p.name;
  for(const f of p.faces){const pick={part:p.id,index:f.index},label=name+" · грань "+(f.index+1);allFaces.push([pick,label]);if(f.planar)faces.push([pick,label]);targets.up_to_face.push([{kind:"face",...pick},label]);curves.push([{kind:"outline_face",...pick},label+" (контур)"]);}
  for(const e of p.edges){const pick={part:p.id,index:e.index},label=name+" · ребро "+(e.index+1);edges.push([pick,label]);curves.push([{kind:"edge",...pick},label]);if(e.axis)axis.push([{kind:"edge",...pick},label]);}
  for(let i=0;i<p.vertices;i++)targets.up_to_vertex.push([{kind:"vertex",part:p.id,index:i},name+" · вершина "+(i+1)]);
  targets.up_to_part.push([{kind:"part",id:p.id},name]);
 }
 for(const name of ["Top","Front","Right"])targets.up_to_face.push([{kind:"plane",name},"Плоскость "+name]);
 for(const id of c.planes)targets.up_to_face.push([{kind:"plane",id},current.features.find(f=>f.id===id)?.name||id]);
 return {faces,allFaces,edges,axis,curves,targets};
}
function fillTargets(suffix="",selected=null){
 const end=$("solid-end"+suffix).value,id="solid-target"+suffix,old=selected||val(id),items=catalogItems().targets[end]||[];
 options(id,[["","— Выбрать —"],...items],old?[old]:[""]);
}
function solidVisibility(){
 const profile=profileMode(),extr=solidKind==="extrude",rev=solidKind==="revolve",fil=solidKind==="fillet",ch=solidKind==="chamfer",creation=$("solid-creation").value,thin=creation==="thin",surface=creation==="surface",end=$("solid-end").value,end2=$("solid-end2").value,up=end.startsWith("up_to"),up2=end2.startsWith("up_to"),second=extr&&!["symmetric","through"].includes(end)&&$("solid-second").checked,ct=$("solid-chamfer-type").value;
 const vis=(id,on)=>$(id).hidden=!on;
 for(const id of ["creation","sketch","end"])vis("solid-"+id+"-label",profile);
 vis("solid-regions",profile&&creation==="solid");vis("solid-faces-label",profile&&creation==="solid");vis("solid-curves-label",profile&&creation!=="solid");
 vis("solid-op-label",profile&&!surface);vis("solid-surface-op-label",profile&&surface);vis("solid-scope-label",profile&&!surface&&$("solid-op").value!=="new");
 vis("solid-separate-label",profile&&creation==="solid"&&$("solid-op").value==="new");vis("solid-separate-colors-label",!$("solid-separate-label").hidden&&$("solid-separate").checked);vis("solid-thin",profile&&thin);vis("solid-thickness2-label",thin&&$("solid-thin-side").value==="two");
 vis("solid-axis-label",rev);vis("solid-value-row",!profile||(!up&&!["through","full"].includes(end)));
 vis("solid-target-label",profile&&up&&end!=="up_to_next");vis("solid-offset-label",profile&&(end==="up_to_face"||(extr&&end==="up_to_vertex")));
 vis("solid-flip-label",(profile&&end!=="symmetric"&&end!=="full")||(ch&&ct!=="equal"));
 vis("solid-both-label",extr&&end==="through");vis("solid-mirror-end-label",rev&&up);
 vis("solid-second-label",extr&&!["symmetric","through"].includes(end));vis("solid-second-options",second);vis("solid-depth2-label",second&&end2==="blind");vis("solid-target2-label",second&&up2&&end2!=="up_to_next");vis("solid-offset2-label",second&&["up_to_face","up_to_vertex"].includes(end2));
 vis("solid-angle2-label",rev&&end==="two");vis("solid-draft-label",extr&&!surface&&!up);vis("solid-draft-angle-label",extr&&!surface&&!up&&$("solid-draft").checked);vis("solid-draft2-label",second&&!surface&&$("solid-draft").checked&&!up2&&end2!=="symmetric");vis("solid-draft-angle2-label",!$("solid-draft2-label").hidden&&$("solid-draft2").checked);
 vis("solid-edges-label",fil||ch);vis("solid-edge-faces-label",fil||ch);vis("solid-variable-label",fil);vis("solid-radius2-label",fil&&$("solid-variable").checked);
 vis("solid-chamfer-type-label",ch);vis("solid-distance2-label",ch&&ct==="two");vis("solid-chamfer-angle-label",ch&&ct==="angle");vis("solid-tangent-label",ch);
 const modes=profile?[...(creation==="solid"?[["profile","Профиль / область / грань"]]:[["curve","Кривая или ребро"]]),...(rev?[["axis","Ось"]]:[]),...(!surface&&$("solid-op").value!=="new"?[["scope","Область объединения"]]:[]),...(up&&end!=="up_to_next"?[["target","Цель первого направления"]]:[]),...(second&&up2&&end2!=="up_to_next"?[["target2","Цель второго направления"]]:[])]:[["edge","Рёбра"],["edge_face","Все рёбра грани"]];
 const mode=$("solid-pick").value;options("solid-pick",modes,[mode]);if(!$("solid-pick").value)$("solid-pick").selectedIndex=0;
}
async function openSolid(kind,id=null){
 if(busy||sketchEditor.active)return;closeSolid();$("edit").hidden=true;busy=true;buttons();
 let ctx;try{ctx=await call("solid_context",{kind,id});}catch(e){error(e);return;}finally{busy=false;buttons();}
 solidContext=ctx;solidEdit=id;solidAutoOp=!id;solidAutoDirection=false;solidVars=[];solidOrigins=[];solidVarOffer=null;solidDefaults.clear();$("solid-new-variable").hidden=true;
 if(id){solidOriginal=current;renderModel({...current,meshes:ctx.meshes,sketch_regions:ctx.sketch_regions,sketch_curves:ctx.sketch_curves,parts:ctx.catalog.parts},true);}
 solidKind=kind;$("edit").hidden=true;solidProfiles=new Map();$("solid-regions").dataset.sketch="";
 $("solid-icon").src="icons/"+kind+".png";$("solid-title").textContent=(id?"Изменить: ":"")+{extrude:"Выдавливание",revolve:"Вращение",fillet:"Скругление",chamfer:"Фаска"}[kind];
 const profile=profileMode(),p=ctx.params||{},saved=ctx.picks||{},cat=catalogItems(),c=ctx.catalog;
 const factor=({mm:1,cm:10,m:1000,in:25.4,ft:304.8})[ctx.units]||1;const put=(id,value)=>$(id).value=String(typeof value==="number"&&$(id).matches("input[inputmode=decimal]")&&!id.includes("angle")&&!(id==="solid-value"&&kind==="revolve")?Number((value/factor).toFixed(8)):value),check=(id,value)=>$(id).checked=!!value;
 const sketches=Object.keys(c.sketches);
 options("solid-sketch",[["","— Нет —"],...sketches.map(fid=>[fid,current.features.find(f=>f.id===fid)?.name||fid])]);
 const fid=saved.profiles?.[0]?.sketch||saved.curves?.find(r=>r.sketch)?.sketch||(sketches.includes(selected)?selected:sketches.at(-1))||"";
 $("solid-sketch").value=fid;
 if(id){for(const r of saved.profiles||[]){const list=solidProfiles.get(r.sketch)||[];list.push(r.index);solidProfiles.set(r.sketch,list);}}
 else if(fid&&!facePick&&!edgePicks.length&&!sketchCurvePicks.length)solidProfiles.set(fid,Array.from({length:c.sketches[fid].regions},(_,i)=>i));
 options("solid-faces",cat.faces,saved.faces||(!id&&facePick?[facePick]:[]));options("solid-curves",cat.curves,saved.curves||(!id&&profile&&!facePick?[...edgePicks.map(p=>({kind:"edge",...p})),...sketchCurvePicks]:[]));
 // Preserve loaded chain / region-edge selections not directly represented by the one-curve catalogue.
 for(const r of saved.curves||[])if(![...$("solid-curves").options].some(o=>o.value===j(r))){const o=new Option("Сохранённая кривая · "+(r.entity||r.sketch||r.part),j(r),true,true);$("solid-curves").append(o);}
 options("solid-axis",[["","— Выбрать ось —"],["X","X"],["Y","Y"],["Z","Z"],...cat.axis],[saved.axis?.kind==="std"?saved.axis.name:saved.axis||(id&&kind==="revolve"?"":"Z")]);
 options("solid-scope",c.parts.map(p=>[j(p.id),p.name]),(saved.scope||[]).map(j));
 options("solid-edges",cat.edges,saved.edges||edgePicks);options("solid-edge-faces",cat.allFaces,!id&&facePick?[facePick]:[]);
 put("solid-name",id?(current.features.find(f=>f.id===id)?.name||""):"");put("solid-creation",p.creation||(!id&&profile&&!facePick&&(edgePicks.length||sketchCurvePicks.length)?"surface":"solid"));solidCreation=$("solid-creation").value;put("solid-op",p.op||(current.meshes.length?"add":"new"));put("solid-surface-op",p.surface_op||"new");
 options("solid-end",kind==="revolve"?revolveEnds:extrudeEnds,[p.end==="blind"&&kind==="revolve"?"one":p.end||(kind==="revolve"?"full":"blind")]);
 options("solid-end2",extrudeEnds,[p.end2||"blind"]);fillTargets("",saved.target);fillTargets("2",saved.target2);
 $("solid-value-label").textContent=kind==="revolve"?"Угол, °":(kind==="fillet"?"Радиус":kind==="chamfer"?"Размер фаски":"Глубина")+", "+(ctx.units||"mm");
 put("solid-value",p[kind==="revolve"?"angle":kind==="fillet"?"radius":kind==="chamfer"?"distance":"depth"]??(kind==="revolve"?360:profile?10:1));
 for(const [key,def] of Object.entries({thickness:2,thickness2:1,thin_side:"mid",depth2:10,angle2:90,offset:0,offset2:0,draft_angle:3,draft_angle2:3,radius2:1,distance2:2}))put("solid-"+key.replaceAll("_","-"),p[key]??def);
 for(const key of ["flip","second","both","mirror_end","draft","draft2","variable","separate","separate_colors"])check("solid-"+key.replaceAll("_","-"),p[key]);
 check("solid-tangent",p.tangent!==false);put("solid-chamfer-type",p.type||"equal");put("solid-chamfer-angle",kind==="chamfer"?p.angle??45:45);
 for(const input of $("solid-dialog").querySelectorAll("input[inputmode=decimal]"))solidDefaults.set(input.id,input.value);$("solid-dialog").hidden=false;fillRegions();solidVisibility();if(!profile)$("edge-mode").checked=true;
 syncSolidHighlights();previewFitted=false;if(saved.missing?.length){$("solid-hint").textContent="Утрачены ссылки: "+saved.missing.join(", ")+". Выберите геометрию заново.";}schedulePreview();
}
function solidCurveRefs(){
 const refs=vals("solid-curves"),groups=new Map(),out=[];
 for(const r of refs){
  if(r.kind!=="sketch_chain"||!r.only){out.push(r);continue;}
  if(refs.some(x=>x.kind==="sketch_chain"&&!x.only&&x.sketch===r.sketch&&solidContext.catalog.sketches[r.sketch].curves.find(c=>c.id===x.entity)?.chain?.includes(r.entity)))continue;
  const list=groups.get(r.sketch)||new Set();for(const id of r.only)list.add(id);groups.set(r.sketch,list);
 }
 for(const [sketch,ids] of groups){
  const curves=solidContext.catalog.sketches[sketch].curves;
  // Separate connected runs of exactly selected curves. Native chains stay unexpanded.
  while(ids.size){
   const first=ids.values().next().value,group=[first];ids.delete(first);
   for(let i=0;i<group.length;i++){const c=curves.find(x=>x.id===group[i]);for(const id of c?.chain||[])if(ids.has(id)&&curves.find(x=>x.id===id)?.ends?.some(p=>c.ends?.includes(p))){group.push(id);ids.delete(id);}}
   out.push({kind:"sketch_chain",sketch,entity:first,only:group});
  }
 }
 return out;
}
function moveSolidProfiles(next){
 if((next==="solid")===(solidCreation==="solid")){solidCreation=next;return;}
 saveRegionChecks();
 const el=$("solid-curves");
 if(next!=="solid"){
  for(const [sketch,indices] of solidProfiles)for(const index of indices){
   const n=solidContext.catalog.sketches[sketch].region_edges[index];solidOrigins.push({kind:"region",sketch,index,n});
   for(let edge=0;edge<n;edge++){const r={kind:"region_edge",sketch,index,edge};const o=[...el.options].find(x=>x.value===j(r));if(o)o.selected=true;}
  }
  for(const r of vals("solid-faces")){
   const face=solidContext.catalog.parts.find(p=>p.id===r.part)?.faces.find(f=>f.index===r.index);
   solidOrigins.push({kind:"face",part:r.part,index:r.index,edges:face?.edges||[]});
   for(const index of face?.edges||[]){const o=[...el.options].find(x=>x.value===j({kind:"edge",part:r.part,index}));if(o)o.selected=true;}
  }
  solidProfiles.clear();for(const o of $("solid-faces").options)o.selected=false;fillRegions();
 }else{
  const curves=vals("solid-curves");
  for(const [sketch,s] of Object.entries(solidContext.catalog.sketches))for(let index=0;index<s.regions;index++){
   const selected=curves.filter(r=>r.kind==="region_edge"&&r.sketch===sketch&&r.index===index);
   if(curves.some(r=>r.kind==="outline_region"&&r.sketch===sketch&&r.index===index)||selected.length===s.region_edges[index]){
    const a=solidProfiles.get(sketch)||[];a.push(index);solidProfiles.set(sketch,[...new Set(a)]);
   }
  }
  for(const p of solidContext.catalog.parts)for(const f of p.faces)if(f.planar&&(curves.some(r=>r.kind==="outline_face"&&r.part===p.id&&r.index===f.index)||solidOrigins.some(o=>o.kind==="face"&&o.part===p.id&&o.index===f.index&&o.edges.length&&o.edges.every(index=>curves.some(r=>r.kind==="edge"&&r.part===p.id&&r.index===index))))){
   const o=[...$("solid-faces").options].find(x=>x.value===j({part:p.id,index:f.index}));if(o)o.selected=true;
  }
  // Do not silently create a closed region from a partial outline.
  for(const o of el.options){const r=JSON.parse(o.value);if(["region_edge","outline_region","outline_face","edge"].includes(r.kind))o.selected=false;}
  solidOrigins=[];fillRegions();
 }
 solidCreation=next;
}
function solidArgs(){
 saveRegionChecks();const num=id=>{const input=$("solid-"+id);return input.closest("[hidden]")?(solidDefaults.get(input.id)||input.value.trim()):input.value.trim();},checked=id=>$("solid-"+id).checked,choice=id=>$("solid-"+id).value,axis=choice("axis"),creation=choice("creation");
 return {id:solidEdit,kind:solidKind,name:$("solid-name").value,auto_op:solidAutoOp,auto_direction:solidAutoDirection&&!solidDrag,new_variables:solidVars,diagnostic:true,value:num("value"),sketch:choice("sketch"),profiles:[...solidProfiles].flatMap(([sketch,ids])=>ids.map(index=>({sketch,index}))),
 faces:vals("solid-faces"),curves:creation==="solid"?[]:solidCurveRefs(),operation:choice("op"),creation,surface_op:choice("surface-op"),scope:vals("solid-scope"),separate:checked("separate"),separate_colors:checked("separate-colors"),axis:["X","Y","Z"].includes(axis)?axis:val("solid-axis"),flip:checked("flip"),end:choice("end"),end2:choice("end2"),second:checked("second"),both:checked("both"),mirror_end:checked("mirror-end"),target:val("solid-target"),target2:val("solid-target2"),offset:num("offset"),offset2:num("offset2"),depth2:num("depth2"),angle2:num("angle2"),thickness:num("thickness"),thickness2:num("thickness2"),thin_side:choice("thin-side"),draft:checked("draft")&&!$("solid-draft-label").hidden,draft2:checked("draft2")&&!$("solid-draft2-label").hidden,draft_angle:num("draft-angle"),draft_angle2:num("draft-angle2"),edges:vals("solid-edges"),edge_faces:vals("solid-edge-faces"),variable:checked("variable"),radius2:num("radius2"),chamfer_type:choice("chamfer-type"),distance2:num("distance2"),chamfer_angle:num("chamfer-angle"),tangent:checked("tangent")};
}
function syncSolidHighlights(){
 if(!solidKind)return;
 if(!profileMode()){edgePicks=vals("solid-edges");facePick=vals("solid-edge-faces")[0]||null;}
 else {facePick=vals("solid-faces")[0]||null;edgePicks=vals("solid-curves").filter(r=>r.kind==="edge");}
 updateSelection();drawRegions();
}
const svgNS="http://www.w3.org/2000/svg";
function arrowProject(p){const v=new THREE.Vector3(...p).project(camera),r=$("view").getBoundingClientRect();return [(v.x+1)*r.width/2,(1-v.y)*r.height/2];}
function arrowGeom(m){
 const a=arrowProject(m.origin),b=arrowProject(m.origin.map((x,i)=>x+m.dir[i])),dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy),dir=len>1e-9?[dx/len,dy/len]:[0,-1],sign=m.value<0?-1:1;
 const dist=m.screen?70*sign:m.value*len,t=[a[0]+dir[0]*dist,a[1]+dir[1]*dist];return {a,t,dir:dir.map(x=>x*sign),unit:len};
}
function drawSolidArrows(){
 const svg=$("solid-manipulators");if(!svg)return;const hide=!solidKind||!solidArrows.length;svg.toggleAttribute("hidden",hide);svg.replaceChildren();if(hide)return;
 const add=(tag,attrs,text)=>{const el=document.createElementNS(svgNS,tag);for(const [k,v] of Object.entries(attrs))el.setAttribute(k,String(v));if(text)el.textContent=text;svg.append(el);return el;};
 for(const [i,m] of solidArrows.entries()){
  const {a,t,dir,unit}=arrowGeom(m);if(m.drag&&Math.abs(new THREE.Vector3(...m.dir).dot(camera.getWorldDirection(new THREE.Vector3())))>0.9999)continue;const u=[-dir[1],dir[0]],head=[t[0]+dir[0]*20,t[1]+dir[1]*20],col="#087db7";
  add("line",{x1:a[0],y1:a[1],x2:t[0],y2:t[1],stroke:col,"stroke-width":2.5,"stroke-dasharray":"5 4"});
  add("polygon",{points:[head,[t[0]+u[0]*9,t[1]+u[1]*9],[t[0]-u[0]*9,t[1]-u[1]*9]].map(p=>p.join(",")).join(" "),fill:col,stroke:"#145173"});
  const x=head[0]+dir[0]*14,y=head[1]+dir[1]*14,label=m.label?.startsWith("up_to")?endOptions.find(r=>r[0]===m.label)?.[1]||m.label:m.label;
  add("rect",{x:x-42,y:y-10,width:84,height:20,rx:3,fill:"#fff",stroke:col});
  add("text",{x,y:y+4,fill:"#16405b","text-anchor":"middle","font-size":11},label);
  add("circle",{cx:t[0]+dir[0]*10,cy:t[1]+dir[1]*10,r:17,fill:"transparent",class:"manip-hit","data-arrow-index":i,"data-arrow-key":m.key});
 }
}
function pointerArrowParam(m,e){
 const r=$("view").getBoundingClientRect(),x=(e.clientX-r.left)/r.width*2-1,y=1-(e.clientY-r.top)/r.height*2;
 raycaster.setFromCamera(new THREE.Vector2(x,y),camera);
 const D=new THREE.Vector3(...m.dir),d=raycaster.ray.direction,P=new THREE.Vector3(...m.origin),w=P.sub(raycaster.ray.origin),b=D.dot(d),den=1-b*b;
 return Math.abs(den)<1e-9?null:(b*d.dot(w)-D.dot(w))/den;
}
const manipSvg=$("solid-manipulators");
manipSvg.addEventListener("pointerdown",e=>{
 const hit=e.target.closest(".manip-hit");if(!hit||e.button!==0)return;e.preventDefault();e.stopPropagation();
 const index=Number(hit.dataset.arrowIndex),m=solidArrows[index],v=pointerArrowParam(m,e);solidDrag={index,m:{...m},start:[e.clientX,e.clientY],offset:v===null?0:v-m.value,moved:false};manipSvg.setPointerCapture(e.pointerId);
});
manipSvg.addEventListener("pointermove",e=>{
 if(!solidDrag)return;const d=solidDrag,m=d.m;if(!m.drag)return;
 d.moved ||= Math.hypot(e.clientX-d.start[0],e.clientY-d.start[1])>3;if(!d.moved)return;
 let v=pointerArrowParam(m,e);if(v===null)return;v-=d.offset;
 const unit=arrowGeom(m).unit,raw=6/Math.max(unit,1e-8),mag=10**Math.floor(Math.log10(raw)),step=([1,2,5,10].find(x=>x*mag>=raw)||10)*mag*(m.key==="value"&&solidKind==="fillet"?1/m.factor:1);
 if(!e.altKey)v=Math.round(v/step)*step;if(m.positive)v=Math.max(v,.001/m.factor);else if(Math.abs(v)<.001)v=v<0?-.001:.001;
 const value=Number((Math.abs(v)*m.factor).toFixed(6)),factor=({mm:1,cm:10,m:1000,in:25.4,ft:304.8})[solidContext?.units]||1;$("solid-"+m.key).value=String(Number((value/factor).toFixed(8)));
 if(m.flip){$("solid-flip").checked=v<0;solidAutoDirection=false;}
 solidArrows[d.index]={...m,value:v,label:value+" mm"};if(m.flip)for(const a of solidArrows)if(a.key==="depth2")a.dir=m.dir.map(x=>x*(v<0?1:-1));
 drawSolidArrows();schedulePreview();
});
function endSolidArrow(e,cancel=false){
 if(!solidDrag)return;const d=solidDrag;solidDrag=null;
 if(!cancel&&!d.moved&&d.m.flip){$("solid-flip").checked=!$("solid-flip").checked;solidAutoDirection=false;}
 schedulePreview();invalidate();
}
manipSvg.addEventListener("pointerup",e=>endSolidArrow(e));manipSvg.addEventListener("pointercancel",e=>endSolidArrow(e,true));
function solidVariableCheck(input){
 const known=solidContext?.variables||{},names=[...new Set([...input.value.matchAll(/#([A-Za-z_][A-Za-z0-9_]*)/g)].map(m=>m[1]))].filter(n=>!Object.hasOwn(known,n));
 const btn=$("solid-new-variable");solidVarOffer=null;btn.hidden=true;if(names.length!==1)return;
 const kind=input.id.includes("angle")||input.id==="solid-value"&&solidKind==="revolve"?"angle":"length",value=solidDefaults.get(input.id)|| (kind==="angle"?"90":"10");
 solidVarOffer={name:names[0],expr:value,kind,input};btn.textContent="+ Создать #"+names[0]+" = "+value+" (Enter)";btn.hidden=false;
}
$("solid-new-variable").onclick=async()=>{
 const offer=solidVarOffer;if(!offer)return;const {name,expr,kind,input}=offer,extra=[...solidVars,{name,expr,kind}];
 try{const r=await call("solid_variables",{kind:solidKind,id:solidEdit,new_variables:extra});solidVars=extra;Object.assign(solidContext,r);solidVarOffer=null;$("solid-new-variable").hidden=true;input.focus();schedulePreview();}catch(e){$("preview-error").textContent=e.message;$("preview-error").hidden=false;}
};
let solidCompletion=null,solidCompleteInput=null,solidCompleteIndex=-1;
function closeSolidCompletion(){solidCompletion?.remove();solidCompletion=null;solidCompleteInput=null;solidCompleteIndex=-1;}
function solidComplete(input){
 closeSolidCompletion();const at=input.selectionStart??input.value.length,before=input.value.slice(0,at),m=before.match(/#([A-Za-z0-9_]*)$/)||before.match(/(?<![\w#.])([A-Za-z_]\w*)$/);
 if(!m||!m[0].startsWith("#")&&/[\d.)]\s*$/.test(before.slice(0,at-m[0].length)))return;
 const names=Object.keys(solidContext?.variables||{}).filter(n=>n.toLowerCase().startsWith(m[1].toLowerCase())).sort();if(!names.length)return;
 const pop=document.createElement("div");pop.className="variable-completion";pop.id="solid-variable-completion";
 for(const name of names){const b=document.createElement("button");b.type="button";b.textContent="#"+name+" = "+solidContext.variables[name];b.onpointerdown=e=>e.preventDefault();b.onclick=()=>{input.setRangeText("#"+name,at-m[0].length,at,"end");closeSolidCompletion();solidVariableCheck(input);schedulePreview();input.focus();};pop.append(b);}
 document.body.append(pop);const r=input.getBoundingClientRect();pop.style.left=Math.max(6,Math.min(r.left,innerWidth-226))+"px";pop.style.width="220px";if(innerHeight-r.bottom>Math.min(pop.scrollHeight,180))pop.style.top=r.bottom+"px";else pop.style.bottom=(innerHeight-r.top)+"px";
 solidCompletion=pop;solidCompleteInput=input;
}
for(const input of $("solid-dialog").querySelectorAll("input[inputmode=decimal]")){
 input.addEventListener("input",()=>{solidVariableCheck(input);solidComplete(input);});
 input.addEventListener("blur",()=>{if(solidCompleteInput===input)closeSolidCompletion();});
 input.addEventListener("keydown",e=>{
  if(solidCompleteInput===input&&solidCompletion){const opts=[...solidCompletion.children];if(["ArrowUp","ArrowDown"].includes(e.key)){e.preventDefault();solidCompleteIndex=(solidCompleteIndex<0?(e.key==="ArrowDown"?0:opts.length-1):(solidCompleteIndex+(e.key==="ArrowDown"?1:opts.length-1))%opts.length);opts.forEach((b,i)=>b.classList.toggle("active",i===solidCompleteIndex));return;}if(["Enter","Tab"].includes(e.key)&&solidCompleteIndex>=0){e.preventDefault();e.stopPropagation();opts[solidCompleteIndex].click();return;}if(e.key==="Escape"){e.preventDefault();closeSolidCompletion();return;}}
  if(e.key==="Enter"&&solidVarOffer?.input===input){e.preventDefault();$("solid-new-variable").click();}
 });
}
function clearPreview(){solidArrows=[];solidDrag=null;drawSolidArrows();clearTimeout(previewTimer);previewVersion++;previewQueued=false;dispose(previewGroup);group.visible=true;delete document.body.dataset.previewVolume;delete document.body.dataset.previewArea;$("preview-error").hidden=true;invalidate();}
function closeSolid(){closeSolidCompletion();clearPreview();const original=solidOriginal;solidOriginal=null;solidContext=null;solidEdit=null;solidKind=null;$("solid-dialog").hidden=true;if(original)renderModel(original,true);else drawRegions();}
function schedulePreview(){if(!solidKind||$("solid-dialog").hidden||busy)return;clearTimeout(previewTimer);previewVersion++;previewQueued=true;previewTimer=setTimeout(renderPreview,120);}
async function renderPreview(){
 if(previewInFlight||!previewQueued||!solidKind||busy)return;
 previewQueued=false;const version=previewVersion,args=solidArgs();
 if(!args.value||(["fillet","chamfer"].includes(args.kind)?!args.edges.length&&!args.edge_faces.length:!args.profiles.length&&!args.faces.length&&!args.curves.length)){clearPreview();return;}
 previewInFlight=true;
 try{
  const result=await call("solid_preview",args);
  if(version!==previewVersion||!solidKind||busy)return;
  if(!solidDrag){
   if(result.inferred){const inferred=result.inferred;
    for(const input of $("solid-dialog").querySelectorAll("input[inputmode=decimal]"))if(!input.value.includes("#"))solidDefaults.set(input.id,input.value);
    if(solidAutoOp&&inferred.operation){$("solid-op").value=inferred.operation;const scope=new Set(inferred.scope||[]);for(const o of $("solid-scope").options)o.selected=scope.has(JSON.parse(o.value));}
    if(solidAutoDirection){$("solid-flip").checked=inferred.flip;solidAutoDirection=false;}
    solidVisibility();
   }
   solidArrows=result.manipulators||[];
  }
  dispose(previewGroup);
  if(result.error){
   group.visible=true;for(const o of result.outlines||[]){const line=new THREE.Line(lineGeometry(o.points),new THREE.LineBasicMaterial({color:o.color==="red"?0xe33434:0xaa53da,depthTest:false}));line.renderOrder=8;previewGroup.add(line);}
   delete document.body.dataset.previewVolume;delete document.body.dataset.previewArea;$("preview-error").textContent=result.error;$("preview-error").hidden=false;invalidate();return;
  }
  for(const m of result.meshes){
   const g=lineGeometry(m.vertices);g.setIndex(m.triangles);
   if(m.normals.length===m.vertices.length)g.setAttribute("normal",new THREE.Float32BufferAttribute(m.normals,3));else g.computeVertexNormals();
   previewGroup.add(new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0xeac88d,roughness:.7,side:THREE.DoubleSide})));
   const edges=[];for(const v of m.edges)segments(v,edges);
   if(edges.length)previewGroup.add(new THREE.LineSegments(lineGeometry(edges),new THREE.LineBasicMaterial({color:0x69562f})));
  }
  group.visible=false;$("preview-error").hidden=true;document.body.dataset.previewVolume=String(result.volume);document.body.dataset.previewArea=String(result.area);
  if(!current.meshes.length&&!previewFitted){previewFitted=true;fit();}
  invalidate();
 }catch(e){if(version===previewVersion&&solidKind&&!busy){dispose(previewGroup);group.visible=true;delete document.body.dataset.previewVolume;$("preview-error").textContent=e.message;$("preview-error").hidden=false;invalidate();}}
 finally{previewInFlight=false;if(previewQueued&&solidKind&&!busy)renderPreview();}
}
$("solid-sketch").onchange=()=>{saveRegionChecks();fillRegions();schedulePreview();};
$("solid-end").onchange=()=>{fillTargets();solidAutoDirection=true;solidVisibility();if(["up_to_face","up_to_part","up_to_vertex"].includes($("solid-end").value))$("solid-pick").value="target";};
$("solid-end2").onchange=()=>{fillTargets("2");solidAutoDirection=true;solidVisibility();if(["up_to_face","up_to_part","up_to_vertex"].includes($("solid-end2").value))$("solid-pick").value="target2";};
$("solid-target").onchange=$("solid-target2").onchange=()=>{solidAutoDirection=true;};
$("solid-flip").onchange=()=>{solidAutoDirection=false;};
$("solid-op").onchange=$("solid-scope").onchange=()=>{solidAutoOp=false;};
$("solid-separate").onchange=()=>{if($("solid-separate").checked){solidAutoOp=false;$("solid-op").value="new";for(const o of $("solid-scope").options)o.selected=false;}};
$("solid-creation").onchange=()=>{moveSolidProfiles($("solid-creation").value);};

for(const [id,mode] of Object.entries({"solid-faces":"profile","solid-curves":"curve","solid-axis":"axis","solid-target":"target","solid-target2":"target2","solid-scope":"scope","solid-edges":"edge","solid-edge-faces":"edge_face"}))$(id).addEventListener("focus",()=>{if([...$("solid-pick").options].some(o=>o.value===mode))$("solid-pick").value=mode;});
$("solid-dialog").addEventListener("input",schedulePreview);
$("solid-dialog").addEventListener("change",()=>{saveRegionChecks();solidVisibility();syncSolidHighlights();schedulePreview();});
$("solid-cancel").onclick=closeSolid;
let repeatSolid=false;
$("solid-dialog").addEventListener("keydown",e=>{
 if(e.key==="Escape"&&!solidCompletion){e.preventDefault();e.stopPropagation();closeSolid();return;}
 if(e.key==="Enter"&&e.shiftKey&&!solidVarOffer&&!solidCompletion&&!solidEdit){e.preventDefault();repeatSolid=true;$("solid-dialog").requestSubmit();}
});
$("solid-dialog").onsubmit=async e=>{e.preventDefault();const args=solidArgs(),kind=solidKind,repeat=repeatSolid;repeatSolid=false;clearPreview();const r=await run("solid",args,true);if(r){closeSolid();if(repeat)openSolid(kind);}else schedulePreview();};
$("variable").onclick=()=>{
 const f=selectedFeature(),existing=(f?.type==="variable"||(f?.type==="measure_value"&&["fixed_length","fixed_angle","fixed_number","expression"].includes(f.params?.mtype)))?f:null;
 const name=prompt("Имя переменной (без #)",existing?.params?.name||"");if(!name?.trim())return;
 const expr=prompt("Значение или выражение",existing?.params?.expr||"10");if(!expr?.trim())return;
 run("variable",{id:existing?.id,name:name.trim(),expr:expr.trim()});
};
$("new").onclick=()=>run("new",{},true);$("demo").onclick=()=>run("demo",{},true);$("open").onclick=()=>$("file").click();
$("file").onchange=async()=>{const f=$("file").files[0];if(f){if(f.size>100*1024*1024)error("Файл больше 100 МиБ");else await run("open",{content:await f.text()},true);}$("file").value="";};
$("save").onclick=()=>run("save");$("step").onclick=()=>run("export",{format:"step"});$("stl").onclick=()=>run("export",{format:"stl"});$("rebuild").onclick=()=>run("rebuild");$("fit").onclick=fit;
$("edit").onsubmit=e=>{e.preventDefault();run("depth",{id:selected,value:Number($("depth").value)});};
$("sketch").onclick=()=>startSketch();$("edit-sketch").onclick=()=>startSketch(selected);$("edit-solid").onclick=()=>{const f=selectedFeature();if(f)openSolid(f.type,f.id);};
for(const kind of ["extrude","revolve","fillet","chamfer"])$(kind).onclick=()=>openSolid(kind);
$("close-edit").onclick=()=>{$("edit").hidden=true;};$("feature-filter").oninput=filterTree;for(const b of document.querySelectorAll("[data-plane]"))b.onclick=()=>{if(sketchEditor.active)return;if(solidKind&&["target","target2"].includes($("solid-pick").value)){const suffix=$("solid-pick").value==="target2"?"2":"";if($("solid-end"+suffix).value==="up_to_face"){setPicked("solid-target"+suffix,{kind:"plane",name:b.dataset.plane});solidAutoDirection=true;schedulePreview();return;}}clearSelection();selected=null;$("plane").value=b.dataset.plane;for(const n of document.querySelectorAll("[data-plane]"))n.classList.toggle("selected",n===b);for(const n of $("features").children)n.classList.remove("selected");selectFeature();};$("fit-menu").onclick=fit;for(const n of ["iso","top","front","right"])$("view-"+n).onclick=()=>view(n);document.addEventListener("click",e=>{for(const d of document.querySelectorAll(".menu[open],.tool-menu[open]"))if(!d.contains(e.target)||e.target.closest("button"))d.open=false;});$("clear-selection").onclick=clearSelection;$("edge-mode").onchange=clearSelection;for(const b of document.querySelectorAll("[data-view]"))b.onclick=()=>view(b.dataset.view);
$("undo").onclick=()=>run("undo");$("redo").onclick=()=>run("redo");
$("delete").onclick=()=>{if(selected&&confirm("Удалить выбранную операцию? Зависимые операции могут перестать работать."))run("delete",{id:selected});};
$("rename").onclick=()=>{const f=selectedFeature();if(f){const name=prompt("Название",f.name);if(name?.trim())run("rename",{id:f.id,name:name.trim()});}};
$("suppress").onclick=()=>{const f=selectedFeature();if(f)run("suppress",{id:f.id,value:!f.suppressed});};
window.addEventListener("keydown",e=>{if(sketchEditor.active||e.target.matches("input,textarea,select"))return;if(e.ctrlKey&&e.code==="KeyZ"){e.preventDefault();run(e.shiftKey?"redo":"undo");}else if(e.ctrlKey&&e.code==="KeyY"){e.preventDefault();run("redo");}else if(e.ctrlKey&&e.code==="KeyS"){e.preventDefault();run("save");}});
$("offline").onclick=async()=>{if(!("serviceWorker" in navigator)){error("Офлайн-кэш требует HTTPS или localhost");return;}try{status("Подготовка офлайн-кэша…");const registration=await navigator.serviceWorker.register("./sw.js");await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller){await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("Офлайн-кэш не активировался")),240000);navigator.serviceWorker.addEventListener("controllerchange",()=>{clearTimeout(timer);resolve();},{once:true});});}status("Офлайн-кэш готов");document.body.dataset.offline="ready";}catch(e){error(e);}};
try{const info=await call("init");$("runtime").textContent="Python "+info.python+" · OCP "+info.ocp+" · "+info.platform;document.body.dataset.runtime="ready";if(!renderer)throw Error("WebGL недоступен");ready=true;buttons();const result=await run("new",{},true);if(!result)throw Error($("errors").textContent);document.body.dataset.ready="true";}catch(e){error(e);$("hint").textContent="Ядро не запустилось. См. диагностику.";document.body.dataset.ready="false";}
