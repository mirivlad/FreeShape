import * as THREE from "three";
import {OrbitControls} from "./three/examples/jsm/controls/OrbitControls.js";
const $=id=>document.getElementById(id);
const worker=new Worker("./worker.js");
let seq=0,current=null,selected=null,busy=false;
const pending=new Map();
function status(text){$("status").textContent=text;}
function error(err){$("errors").textContent=String(err);status("Ошибка — см. диагностику");}
worker.onmessage=({data})=>{
 if(data.stage){status(data.stage);$("hint").textContent=data.stage;return;}
 const p=pending.get(data.id);if(!p)return;pending.delete(data.id);
 data.error?p.reject(Error(data.error)):p.resolve(data.result);
};
worker.onerror=e=>{for(const p of pending.values())p.reject(Error(e.message));pending.clear();error(e.message);};
function call(op,args={}){return new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});worker.postMessage({id,op,...args});});}
const scene=new THREE.Scene();scene.background=new THREE.Color(0xdbe3ed);
const camera=new THREE.OrthographicCamera(-65,65,65,-65,0.1,1e7);camera.position.set(120,-150,110);camera.up.set(0,0,1);
let renderer,controls;
try{
 renderer=new THREE.WebGLRenderer({antialias:true});renderer.setPixelRatio(Math.min(devicePixelRatio,2));$("view").appendChild(renderer.domElement);
 controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;
}catch(e){error("WebGL: "+e.message);}
scene.add(new THREE.HemisphereLight(0xffffff,0x879ab1,2.2));
const light=new THREE.DirectionalLight(0xffffff,2);light.position.set(80,-100,180);scene.add(light);
const group=new THREE.Group();scene.add(group);
let span=130;
function resize(){
 if(!renderer)return;const w=$("view").clientWidth,h=Math.max(1,$("view").clientHeight),a=w/h;
 camera.left=-span*a/2;camera.right=span*a/2;camera.top=span/2;camera.bottom=-span/2;camera.updateProjectionMatrix();renderer.setSize(w,h);
}
new ResizeObserver(resize).observe($("view"));
function fit(){
 if(!controls)return;const box=new THREE.Box3().setFromObject(group);if(box.isEmpty())return;
 const c=box.getCenter(new THREE.Vector3()),size=box.getSize(new THREE.Vector3()).length();
 const direction=camera.position.clone().sub(controls.target).normalize();
 span=Math.max(size*1.45,1);camera.zoom=1;controls.target.copy(c);camera.position.copy(c).addScaledVector(direction,Math.max(size*2,10));resize();controls.update();
}
function dispose(){for(const item of [...group.children]){item.geometry.dispose();item.material.dispose();group.remove(item);}}
function renderModel(result,refit=false){
 current=result;dispose();
 for(const m of result.meshes){
  const g=new THREE.BufferGeometry();g.setAttribute("position",new THREE.Float32BufferAttribute(m.vertices,3));g.setIndex(m.triangles);
  if(m.normals.length===m.vertices.length)g.setAttribute("normal",new THREE.Float32BufferAttribute(m.normals,3));else g.computeVertexNormals();
  group.add(new THREE.Mesh(g,new THREE.MeshStandardMaterial({color:0x8daed2,roughness:.65,metalness:.05,side:THREE.DoubleSide})));
  for(const edge of m.edges){if(edge.length<6)continue;const eg=new THREE.BufferGeometry();eg.setAttribute("position",new THREE.Float32BufferAttribute(edge,3));group.add(new THREE.Line(eg,new THREE.LineBasicMaterial({color:0x31465e})));}
 }
 $("name").textContent=result.name;$("features").replaceChildren();
 for(const f of result.features){const b=document.createElement("button");b.textContent=f.name+" · "+f.type+(f.suppressed?" (off)":"");b.className=f.id===selected?"selected":"";b.onclick=()=>{selected=f.id;selectFeature();for(const n of $("features").children)n.classList.toggle("selected",n===b);};$("features").append(b);}
 $("metrics").textContent="Объём: "+result.volume.toFixed(3)+" мм³ · деталей: "+result.meshes.length+" · "+result.ms+" мс";
 $("errors").textContent=Object.entries(result.errors||{}).map(([id,msg])=>id+": "+msg).join("\n");
 $("hint").textContent=result.meshes.length?"":"Нет видимой геометрии";
 selectFeature();if(refit)fit();
 document.body.dataset.volume=String(result.volume);
 document.body.dataset.meshes=String(result.meshes.length);
}
function selectFeature(){const f=current?.features.find(x=>x.id===selected);$("edit").hidden=!(f?.type==="extrude"&&typeof f.depth==="number");if(!$("edit").hidden)$("depth").value=f.depth;}
function buttons(ready){for(const id of ["demo","open","save","step","stl","rebuild","fit","apply"]){$(id).disabled=!ready||busy||(["save","step","stl","rebuild","fit","apply"].includes(id)&&!current);}}
async function run(op,args={},refit=false){
 if(busy)return;busy=true;buttons(true);$("errors").textContent="";status("Вычисление: "+op);
 try{const r=await call(op,args);if(r.file!==undefined){const bytes=op==="export"?Uint8Array.from(atob(r.file),c=>c.charCodeAt(0)):r.file;const url=URL.createObjectURL(new Blob([bytes],{type:"application/octet-stream"}));const a=document.createElement("a");a.href=url;a.download=r.name;a.click();setTimeout(()=>URL.revokeObjectURL(url),2000);}else{if(op==="open"||op==="demo")selected=null;renderModel(r,refit);}status("Готово");return r;}catch(e){error(e);throw e;}finally{busy=false;buttons(true);}
}
const safe=(...args)=>run(...args).catch(()=>{});
$("demo").onclick=()=>safe("demo",{},true);$("open").onclick=()=>$("file").click();
$("file").onchange=async()=>{const f=$("file").files[0];if(f){if(f.size>100*1024*1024){error("Файл больше 100 МиБ");}else safe("open",{content:await f.text()},true);}$("file").value="";};
$("save").onclick=()=>safe("save");$("step").onclick=()=>safe("export",{format:"step"});$("stl").onclick=()=>safe("export",{format:"stl"});$("rebuild").onclick=()=>safe("rebuild");$("fit").onclick=fit;
$("edit").onsubmit=e=>{e.preventDefault();safe("depth",{id:selected,value:Number($("depth").value)});};
$("offline").onclick=async()=>{if(!("serviceWorker" in navigator)){error("Офлайн-кэш требует HTTPS или localhost");return;}try{status("Подготовка офлайн-кэша…");await navigator.serviceWorker.register("./sw.js");await navigator.serviceWorker.ready;status("Офлайн-кэш готов");document.body.dataset.offline="ready";}catch(e){error(e);}};
if(renderer)renderer.setAnimationLoop(()=>{controls.update();renderer.render(scene,camera);});
try{const info=await call("init");$("runtime").textContent="Python "+info.python+" · OCP "+info.ocp+" · "+info.platform;document.body.dataset.runtime="ready";if(!renderer)throw Error("WebGL недоступен");buttons(true);await run("demo",{},true);document.body.dataset.ready="true";}catch(e){error(e);$("hint").textContent="Ядро не запустилось. См. диагностику.";document.body.dataset.ready="false";}
