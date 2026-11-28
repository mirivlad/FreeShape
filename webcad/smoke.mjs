import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const browser=await chromium.launch({headless:true,args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
try {
 const context=await browser.newContext({acceptDownloads:true,viewport:{width:1280,height:900}});
 const page=await context.newPage();
 page.on("console",msg=>console.log("browser",msg.type(),msg.text()));
 page.on("pageerror",err=>console.error("page",err));
 page.on("requestfailed",req=>console.error("request",req.url(),req.failure()));
 async function noError(){const err=await page.locator("#errors").textContent();assert.equal(err.trim(),"",err);}
 async function volume(v,tol=1){await page.waitForFunction(([v,tol])=>Math.abs(Number(document.body.dataset.volume)-v)<tol||document.querySelector("#errors").textContent.trim().length>0,[v,tol],{timeout:30000}).catch(async e=>{throw Error("Expected volume "+v+"; got "+await page.locator("body").getAttribute("data-volume")+"; status "+await page.locator("#status").textContent()+"; "+await page.locator("#errors").textContent(),{cause:e});});await noError();assert(Math.abs(Number(await page.locator("body").getAttribute("data-volume"))-v)<tol);}
 async function ready(){await page.waitForFunction(()=>document.body.dataset.ready!==undefined,{},{timeout:240000});assert.equal(await page.locator("body").getAttribute("data-ready"),"true",await page.locator("#errors").textContent());}
 async function menuCommand(id){const button=page.locator("#"+id);if(!(await button.isVisible()))await button.locator("xpath=ancestor::details[1]/summary").click();await button.click();}
 async function save(){const pending=page.waitForEvent("download",{timeout:90000});await menuCommand("save");return fs.readFile(await (await pending).path());}
 async function open(data){await page.locator("#file").setInputFiles({name:"test.fshape",mimeType:"application/json",buffer:data});}
 await page.goto(process.env.CAD_URL||"http://localhost:8086");
 await ready();await volume(0);
 assert(await page.locator("#main-tools").isVisible());assert(!(await page.locator("#sketch-tools").isVisible()));
 await page.waitForFunction(()=>[...document.querySelectorAll(".tool img,.brand img")].every(i=>i.complete&&i.naturalWidth>0));
 await page.screenshot({path:"webcad-model.png"});
 // Finishing an untouched new sketch must return to modeling without a feature or undo entry.
 for(const action of ["sk-finish","sk-cancel"]){
  await page.locator("#sketch").click();
  await page.locator("#sketch-canvas").waitFor({state:"visible"});
  await page.locator("#"+action).click();
  await page.locator("#sketch-canvas").waitFor({state:"hidden"});
  await page.locator("#main-tools").waitFor({state:"visible"});
  await noError();
  assert.equal(await page.locator("#features button").count(),0);
  assert(await page.locator("#undo").isDisabled());
 }
 console.log("PASS close empty sketch and cancel without changing document");
 await page.locator(".menu").filter({hasText:"Документ"}).locator("summary").first().click();await menuCommand("demo");await volume(12000);
 assert.equal(await page.locator("body").getAttribute("data-meshes"),"1");
 console.log("PASS native demo");
 // Check event-driven rendering and immediate camera response.
 const box=await page.locator("#view canvas:not(#sketch-canvas)").boundingBox();
 const initial=await page.locator("body").getAttribute("data-camera");
 await page.mouse.move(box.x+box.width*.45,box.y+box.height*.55);
 await page.mouse.down({button:"middle"});await page.mouse.move(box.x+box.width*.45,box.y+box.height*.55+70,{steps:6});await page.mouse.up({button:"middle"});
 await page.waitForFunction(initial=>document.body.dataset.camera!==initial,initial);
 await page.waitForTimeout(150);
 const camera=await page.locator("body").getAttribute("data-camera"),renders=await page.locator("body").getAttribute("data-renders");
 await page.waitForTimeout(350);
 assert.equal(await page.locator("body").getAttribute("data-camera"),camera,"camera must not drift after release");
 assert.equal(await page.locator("body").getAttribute("data-renders"),renders,"idle rendering must stop");
 console.log("PASS immediate pan and idle rendering");
 await page.locator("#features button").filter({hasText:/extrude/i}).click();
 await page.locator("#depth").fill("20");await page.locator("#apply").click();
 await volume(24000);console.log("PASS existing feature edit");
 await page.locator("#undo").click();await volume(12000);
 await page.locator("#redo").click();await volume(24000);
 const saved=await save();assert.equal(JSON.parse(saved.toString()).format,"freeshape");
 await menuCommand("demo");await volume(12000);await open(saved);await volume(24000);
 console.log("PASS undo, redo and native file roundtrip");
 for(const ext of ["step","stl"]){
  const pending=page.waitForEvent("download",{timeout:90000});await menuCommand(ext);
  const data=await fs.readFile(await (await pending).path());assert(data.length>100,ext+" export too small");
  if(ext==="step")assert(data.toString("ascii",0,30).includes("ISO-10303-21"));
 }
 console.log("PASS STEP and STL");
 await menuCommand("new");await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 assert(await page.locator("#sketch-tools").isVisible());assert(!(await page.locator("#main-tools").isVisible()));assert(await page.locator(".tree-panel").isVisible());
 await page.screenshot({path:"webcad-sketch.png"});
 await page.locator('[data-tool="rect"]').click();
 await page.waitForTimeout(150);
 const sk=await page.locator("#sketch-canvas").boundingBox(),unit=Math.min(sk.width,sk.height)/100;
 await page.mouse.click(sk.x+sk.width/2,sk.y+sk.height/2);
 await page.mouse.click(sk.x+sk.width/2+30*unit,sk.y+sk.height/2-20*unit);
 await page.waitForFunction(()=>document.querySelector("#sk-info").textContent.includes("4 объектов")||document.querySelector("#errors").textContent.trim());
 await noError();
 assert(await page.locator("#sk-show-regions").isChecked());
 await page.locator("#sk-show-regions").uncheck();await page.locator("#sk-show-regions").check();
 // Select top edge midpoint, add a length, edit it, undo and redo.
 await page.locator('[data-tool="select"]').click();
 await page.mouse.click(sk.x+sk.width/2+15*unit,sk.y+sk.height/2-20*unit);
 await page.locator("#sk-value").fill("30");
 await page.locator(".tool-menu summary").click();await page.locator('[data-constraint="distance"]').click();
 await page.locator("#sk-constraints input").waitFor({state:"visible"});
 await noError();
 await page.locator("#dimension-overlay .dimension-label").waitFor({state:"visible"});
 await page.locator("#dimension-overlay .dimension-label").click();
 await page.locator("#dimension-overlay .dimension-input").fill("40");
 await page.locator("#dimension-overlay .dimension-input").press("Enter");
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="40"&&document.body.dataset.status==="Готово");
 await page.locator("#sk-undo").click();
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="30");
 console.log("PASS edit dimension in sketch viewport");
 await page.locator("#sk-constraints input").fill("40");
 await page.locator("#sk-constraints input").press("Tab");
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="40"&&document.body.dataset.status==="Готово");
 await noError();
 await page.locator("#sk-undo").click();
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="30");
 await page.locator("#sk-redo").click();
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="40");
 await page.locator("#sk-undo").click();
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="30");
 console.log("PASS editable sketch dimension and sketch undo/redo");
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});assert(await page.locator("#main-tools").isVisible());
 await page.locator("#extrude").click();await page.locator("#solid-value").fill("10");
 await page.waitForFunction(()=>Number(document.body.dataset.previewVolume)>0);
 assert.equal(await page.locator("#features button").count(),1);
 assert.equal(Number(await page.locator("body").getAttribute("data-volume")),0);
 assert.equal(await page.locator("body").getAttribute("data-regions"),"1");
 const pv=Number(await page.locator("body").getAttribute("data-preview-volume"));
 await page.locator('[data-view="top"]').click();await page.locator("#fit").click();
 const vp=await page.locator("#view canvas:not(#sketch-canvas)").boundingBox();
 await page.keyboard.down("Shift");await page.mouse.click(vp.x+vp.width/2,vp.y+vp.height/2);await page.keyboard.up("Shift");
 assert(!(await page.locator("#solid-regions input").isChecked()));
 await page.waitForFunction(()=>document.body.dataset.previewVolume===undefined);
 await page.mouse.click(vp.x+vp.width/2,vp.y+vp.height/2);
 assert(await page.locator("#solid-regions input").isChecked());
 await page.waitForFunction(pv=>Math.abs(Number(document.body.dataset.previewVolume)-pv)<.1,pv);
 console.log("PASS viewport region picking");
 await page.locator("#solid-value").fill("20");
 await page.waitForFunction(pv=>Math.abs(Number(document.body.dataset.previewVolume)-pv*2)<.1,pv);
 await page.locator("#solid-cancel").click();
 assert.equal(await page.locator("body").getAttribute("data-preview-volume"),null);
 assert.equal(await page.locator("#features button").count(),1);
 await page.locator("#extrude").click();await page.locator("#solid-value").fill("10");await page.locator("#solid-apply").click();
 console.log("PASS live solid preview and cancel");
 const created=await save();const model=JSON.parse(created.toString());assert.equal(model.features.length,2);const pts=Object.values(model.features[0].params.sketch.points);const xs=pts.map(p=>p[0]),ys=pts.map(p=>p[1]);const width=Math.max(...xs)-Math.min(...xs),height=Math.max(...ys)-Math.min(...ys);assert(Math.abs(width-30)<0.01,"width constraint");const expected=width*height*10;await volume(expected,0.1);
 console.log("PASS create rectangle sketch and extrude through UI");
 await page.locator("#features button").filter({hasText:/sketch/i}).dblclick();
 await page.locator("#sketch-canvas").waitFor({state:"visible"});
 await page.locator("#sk-cancel").click();
 await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 await volume(expected,0.1);
 assert.equal(await page.locator("#features button").count(),2);
 console.log("PASS cancel existing sketch edit");
 // Centre rectangle and its real midpoint constraint, plus two separate regions.
 await menuCommand("new");await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 await page.locator('[data-tool="center_rect"]').click();await page.waitForTimeout(100);
 const sr=await page.locator("#sketch-canvas").boundingBox(),su=Math.min(sr.width,sr.height)/100;
 const origin=[sr.x+sr.width/2,sr.y+sr.height/2];
 await page.mouse.click(...origin);await page.mouse.click(origin[0]+10*su,origin[1]-10*su);
 await page.waitForFunction(()=>document.querySelector("#sk-info").textContent.includes("5 объектов")||document.querySelector("#errors").textContent.trim());await noError();
 await page.locator('[data-tool="rect"]').click();
 await page.mouse.click(origin[0]+22*su,origin[1]-10*su);
 await page.mouse.click(origin[0]+32*su,origin[1]-20*su);
 await page.waitForFunction(()=>document.querySelector("#sk-info").textContent.includes("9 объектов")||document.querySelector("#errors").textContent.trim());await noError();
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 assert.equal(await page.locator("body").getAttribute("data-regions"),"2");
 const profile=JSON.parse((await save()).toString()).features[0].params.sketch;
 const helper=Object.entries(profile.entities).find(([,e])=>e.helper);
 assert(helper&&helper[1].construction);
 assert(profile.constraints.some(c=>c.type==="midpoint"&&c.refs[0]==="origin"&&c.refs[1]===helper[0]));
 await page.locator("#extrude").click();await page.waitForFunction(()=>Number(document.body.dataset.previewVolume)>0);
 assert.equal(await page.locator("#solid-regions input").count(),2);
 const regionAreas=await page.locator("#solid-regions input").evaluateAll(els=>els.map(e=>Number(e.dataset.area)));
 assert(regionAreas.every(a=>a>0));
 await volume(0);
 const allVolume=regionAreas.reduce((a,b)=>a+b,0)*10;
 assert(Math.abs(Number(await page.locator("body").getAttribute("data-preview-volume"))-allVolume)<.01);
 await page.locator("#solid-regions input").first().uncheck();
 const oneVolume=regionAreas[1]*10;
 await page.waitForFunction(v=>Math.abs(Number(document.body.dataset.previewVolume)-v)<.01,oneVolume);
 await page.locator("#solid-apply").click();
 await page.waitForFunction(()=>document.querySelector("#solid-dialog").hidden);
 await noError();assert.equal(await page.locator("#features button").count(),2);
 const finalVolume=Number(await page.locator("body").getAttribute("data-volume"));
 assert(Math.abs(finalVolume-oneVolume)<.01,"only one solved profile is extruded: "+finalVolume+" vs "+oneVolume);
 assert.equal(JSON.parse((await save()).toString()).features[1].params.regions.length,1);
 console.log("PASS centre rectangle helper and selective multi-region extrusion");
 // Extended tools: actual clicks, native entities, and independently closed profiles.
 for(const tool of ["ellipse","polygon","polygon_out","spline"]){
  await menuCommand("new");await volume(0);
  await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
  await page.locator('[data-tool="'+tool+'"]').click();
  const canvas=await page.locator("#sketch-canvas").boundingBox(),u=Math.min(canvas.width,canvas.height)/100;
  const o=[canvas.x+canvas.width/2,canvas.y+canvas.height/2];
  async function at(x,y){await page.mouse.click(o[0]+x*u,o[1]-y*u);}
  if(tool==="ellipse"){await at(0,0);await at(-20,0);await at(0,10);}
  else if(tool==="spline"){
   await at(0,0);await at(-20,0);await at(-20,20);await at(0,20);
   await at(0,0);
  }else{
   await page.locator("#sk-sides").fill("6");
   await at(0,0);await at(-15,0);
  }
  const count=tool==="ellipse"?2:tool==="spline"?1:tool==="polygon"?7:8;
  await page.waitForFunction(n=>document.querySelector("#sk-info").textContent.startsWith(n+" объектов"),count);
  await page.locator("#sk-undo").click();
  await page.waitForFunction(()=>document.querySelector("#sk-info").textContent.startsWith("0 объектов"));
  await page.locator("#sk-redo").click();
  await page.waitForFunction(n=>document.querySelector("#sk-info").textContent.startsWith(n+" объектов"),count);
  await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
  await noError();assert.equal(await page.locator("body").getAttribute("data-regions"),"1",tool);
  const shape=JSON.parse((await save()).toString()).features[0].params.sketch;
  const entities=Object.values(shape.entities);
  if(tool==="ellipse")assert(entities.some(e=>e.type==="ellipse"));
  else if(tool==="spline")assert(entities.some(e=>e.type==="spline"&&e.closed&&e.pts.length===4));
  else assert.equal(entities.filter(e=>e.type==="line").length,6);
  await page.locator("#extrude").click();await page.waitForFunction(()=>Number(document.body.dataset.previewVolume)>0);
  await page.locator("#solid-apply").click();
  await page.waitForFunction(()=>Number(document.body.dataset.volume)>0);await noError();
  console.log("PASS "+tool+" sketch, history and extrusion");
 }
 // Editing tools: click geometry, not just the toolbar. Verify native saved segments.
 await menuCommand("new");await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 const mc=await page.locator("#sketch-canvas").boundingBox(),mu=Math.min(mc.width,mc.height)/100;
 const mo=[mc.x+mc.width/2,mc.y+mc.height/2];
 async function modAt(x,y){await page.mouse.click(mo[0]+x*mu,mo[1]-y*mu);}
 async function objects(n){await page.waitForFunction(n=>document.querySelector("#sk-info").textContent.startsWith(n+" объектов")&&document.body.dataset.status==="Готово",n);}
 await page.locator('[data-tool="line"]').click();
 await modAt(-30,-5);await modAt(-10,-5);await objects(1);
 await page.locator('[data-tool="line"]').click();
 await modAt(-5,-15);await modAt(-5,5);await objects(2);
 await page.locator('[data-tool="extend"]').click();await modAt(-11,-5);
 await page.waitForFunction(()=>document.querySelector("#sk-constraints").textContent.includes("point_on"));
 await page.locator('[data-tool="split"]').click();await modAt(-20,-5);await objects(3);
 await page.locator("#sk-undo").click();await objects(2);
 await page.locator('[data-tool="line"]').click();
 await modAt(-20,-15);await modAt(-20,5);await objects(3);
 await page.locator('[data-tool="trim"]').click();const rev=await page.locator("#sk-info").getAttribute("data-revision");await modAt(-12,-5);await page.waitForFunction(rev=>document.querySelector("#sk-info").dataset.revision!==rev,rev);await objects(3);
 await page.waitForFunction(()=>document.querySelector("#sk-constraints").textContent.includes("point_on"));
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 await noError();
 const edited=JSON.parse((await save()).toString()).features[0].params.sketch;
 const horizontals=Object.values(edited.entities).filter(e=>e.type==="line"&&Math.abs(edited.points[e.p1][1]-edited.points[e.p2][1])<.01);
 assert.equal(horizontals.length,1);
 const span=horizontals.map(e=>Math.abs(edited.points[e.p1][0]-edited.points[e.p2][0]))[0];
 assert(Math.abs(span-10)<1,"trimmed length "+span);
 console.log("PASS extend, split, undo and trim through UI");
 // Drawing parity: line chain, optional dimensions and parametric third arc point.
 await menuCommand("new");await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 const pc=await page.locator("#sketch-canvas").boundingBox(),pu=Math.min(pc.width,pc.height)/100;
 const po=[pc.x+pc.width/2,pc.y+pc.height/2];
 async function parityAt(x,y){await page.mouse.click(po[0]+x*pu,po[1]-y*pu);}
 await page.locator('[data-tool="line"]').click();
 await parityAt(0,0);await parityAt(-20,0);await objects(1);
 await page.locator("#sk-offer-value").fill("20");await page.locator("#sk-offer-value").press("Enter");
 await page.waitForFunction(()=>document.querySelector("#sk-draw-dims").hidden&&document.querySelector("#sk-constraints input")?.value==="20");
 await parityAt(-20,-20);await objects(2);
 await parityAt(0,-20);await objects(3);
 await parityAt(0,0);await objects(4);
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 await noError();assert.equal(await page.locator("body").getAttribute("data-regions"),"1");
 const chain=JSON.parse((await save()).toString()).features[0].params.sketch;
 const cl=Object.values(chain.entities);assert.equal(cl.length,4);assert.equal(new Set(cl.flatMap(e=>[e.p1,e.p2])).size,4);
 assert(chain.constraints.some(c=>c.type==="distance"&&c.value===20));
 console.log("PASS chained lines, close onto existing point and inline length");
 await menuCommand("new");await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 await page.locator('[data-tool="rect"]').click();await parityAt(0,0);await parityAt(-20,-20);await objects(4);
 await page.locator("#sk-offer-value").fill("25");await page.locator("#sk-offer-value").press("Enter");
 await page.waitForFunction(()=>document.querySelector("#sk-offer-label").textContent.includes("Высота"));
 await page.locator("#sk-offer-value").fill("15");await page.locator("#sk-offer-value").press("Enter");
 await page.waitForFunction(()=>document.querySelector("#sk-draw-dims").hidden);
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 await noError();await page.locator("#extrude").click();await page.waitForFunction(()=>Math.abs(Number(document.body.dataset.previewVolume)-3750)<.1);
 await page.locator("#solid-cancel").click();
 console.log("PASS rectangle drawing dimensions set exact profile area");
 await menuCommand("new");await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 await page.locator('[data-tool="arc"]').click();await parityAt(0,0);await parityAt(-20,0);await parityAt(-10,10);await objects(2);
 await page.locator('[data-tool="select"]').click();
 const dragRev=await page.locator("#sk-info").getAttribute("data-revision");
 await page.mouse.move(po[0]-10*pu,po[1]-10*pu);await page.mouse.down();await page.mouse.move(po[0]-10*pu,po[1]-6*pu,{steps:5});await page.mouse.up();
 await page.waitForFunction(rev=>document.querySelector("#sk-info").dataset.revision!==rev&&document.body.dataset.status==="Готово",dragRev);await noError();
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 const arcShape=JSON.parse((await save()).toString()).features[0].params.sketch;
 const [aid]=Object.entries(arcShape.entities).find(([,e])=>e.type==="arc");
 const third=Object.values(arcShape.entities).find(e=>e.type==="point").p;
 assert(arcShape.constraints.some(c=>c.type==="point_on"&&c.refs[0]===third&&c.refs[1]===aid));
 assert(Math.abs(arcShape.points[third][1]-6)<.1,JSON.stringify(arcShape.points));
 console.log("PASS editable third point of three-point arc");
 await menuCommand("new");await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 await page.locator('[data-tool="spline"]').click();await parityAt(0,0);await parityAt(-20,0);
 await page.mouse.dblclick(po[0]-20*pu,po[1]-20*pu);await objects(1);
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 const openSpline=Object.values(JSON.parse((await save()).toString()).features[0].params.sketch.entities)[0];
 assert.equal(openSpline.pts.length,3);assert(!openSpline.closed);
 console.log("PASS open spline double-click completion");
 // Constraint parity: native constraints applied from toolbar and through direct picking.
 await menuCommand("new");await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 const cb=await page.locator("#sketch-canvas").boundingBox(),cu=Math.min(cb.width,cb.height)/100;
 const co=[cb.x+cb.width/2,cb.y+cb.height/2];
 async function conAt(x,y,shift=false){if(shift)await page.keyboard.down("Shift");try{await page.mouse.click(co[0]+x*cu,co[1]-y*cu);}finally{if(shift)await page.keyboard.up("Shift");}}
 async function conCount(kind,n){await page.waitForFunction(([kind,n])=>document.querySelectorAll("#sk-constraints [data-constraint-type="+kind+"]").length===n&&document.body.dataset.status==="Готово",[kind,n]);await noError();}
 await page.locator('[data-tool="circle"]').click();
 await conAt(-25,0);await conAt(-19,0);await objects(1);
 await conAt(-7,0);await conAt(-3,0);await objects(2);
 await page.locator('[data-tool="select"]').click();await conAt(-25,6);
 await page.locator('[data-constraint="fix"]').click();await conCount("fix",1);await conCount("radius",1);
 await page.locator('[data-constraint="equal"]').click();
 await conAt(-25,6);await conAt(-7,4);await conCount("equal",1);
 // After equal, the second radius is 6. The two-circle tangent must bring the centers 12 apart.
 await page.locator('[data-constraint="tangent"]').click();
 await conAt(-25,6);await conAt(-7,6);await conCount("tangent",1);
 await page.locator("#sk-undo").click();await conCount("tangent",0);
 await page.locator("#sk-redo").click();await conCount("tangent",1);
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 const constrained=JSON.parse((await save()).toString()).features[0].params.sketch;
 const cc=Object.values(constrained.entities).filter(e=>e.type==="circle");
 assert.equal(cc.length,2);assert(Math.abs(cc[0].r-cc[1].r)<1e-6);
 assert(Math.abs(Math.hypot(...constrained.points[cc[0].c].map((v,i)=>v-constrained.points[cc[1].c][i]))-cc[0].r-cc[1].r)<1e-6);
 console.log("PASS circle fixation, equal radii, tangent, undo/redo and native save");
 await menuCommand("new");await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 await page.locator('[data-tool="line"]').click();await conAt(-25,-10);await conAt(-25,10);await objects(1);
 await page.locator('[data-tool="line"]').click();await conAt(-10,-10);await conAt(-10,10);await objects(2);
 await page.locator('[data-tool="select"]').click();await conAt(-25,0);await conAt(-10,0,true);
 await page.locator('[data-constraint="horizontal"]').click();await conCount("horizontal",2);await conCount("vertical",0);
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 const hv=JSON.parse((await save()).toString()).features[0].params.sketch;
 for(const e of Object.values(hv.entities)){const a=hv.points[e.p1],b=hv.points[e.p2];assert(Math.abs(a[1]-b[1])<1e-6);assert(Math.abs(Math.hypot(b[0]-a[0],b[1]-a[1])-20)<.2);}
 console.log("PASS group horizontal replaces vertical without collapse");
 await menuCommand("offline");
 await page.waitForFunction(()=>document.body.dataset.offline==="ready"||document.querySelector("#errors").textContent.trim(),{},{timeout:240000});await noError();
 await context.setOffline(true);await page.reload();await ready();await volume(0);
 await open(created);await volume(expected,0.1);
 console.log("WASM smoke PASS: actual CAD edit, creation, exports and offline");
} finally {await browser.close();}
