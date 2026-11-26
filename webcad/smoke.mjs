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
 async function save(){const pending=page.waitForEvent("download",{timeout:90000});await page.locator("#save").click();return fs.readFile(await (await pending).path());}
 async function open(data){await page.locator("#file").setInputFiles({name:"test.fshape",mimeType:"application/json",buffer:data});}
 await page.goto(process.env.CAD_URL||"http://localhost:8086");
 await ready();await volume(12000);
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
 await page.locator("#demo").click();await volume(12000);await open(saved);await volume(24000);
 console.log("PASS undo, redo and native file roundtrip");
 for(const ext of ["step","stl"]){
  const pending=page.waitForEvent("download",{timeout:90000});await page.locator("#"+ext).click();
  const data=await fs.readFile(await (await pending).path());assert(data.length>100,ext+" export too small");
  if(ext==="step")assert(data.toString("ascii",0,30).includes("ISO-10303-21"));
 }
 console.log("PASS STEP and STL");
 await page.locator("#new").click();await volume(0);
 await page.locator("#sketch").click();await page.locator("#sketch-canvas").waitFor({state:"visible"});
 await page.locator('[data-tool="rect"]').click();
 await page.waitForTimeout(150);
 const sk=await page.locator("#sketch-canvas").boundingBox(),unit=Math.min(sk.width,sk.height)/100;
 await page.mouse.click(sk.x+sk.width/2,sk.y+sk.height/2);
 await page.mouse.click(sk.x+sk.width/2+30*unit,sk.y+sk.height/2-20*unit);
 await page.waitForFunction(()=>document.querySelector("#sk-info").textContent.includes("4 объектов")||document.querySelector("#errors").textContent.trim());
 await noError();
 // Select top edge midpoint, add a length, edit it, undo and redo.
 await page.locator('[data-tool="select"]').click();
 await page.mouse.click(sk.x+sk.width/2+15*unit,sk.y+sk.height/2-20*unit);
 await page.locator("#sk-value").fill("30");
 await page.locator('[data-constraint="distance"]').click();
 await page.locator("#sk-constraints input").waitFor({state:"visible"});
 await noError();
 await page.locator("#sk-constraints input").fill("40");
 await page.locator("#sk-constraints input").press("Tab");
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="40"&&document.querySelector("#status").textContent==="Готово");
 await noError();
 await page.locator("#sk-undo").click();
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="30");
 await page.locator("#sk-redo").click();
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="40");
 await page.locator("#sk-undo").click();
 await page.waitForFunction(()=>document.querySelector("#sk-constraints input")?.value==="30");
 console.log("PASS editable sketch dimension and sketch undo/redo");
 await page.locator("#sk-finish").click();await page.locator("#sketch-canvas").waitFor({state:"hidden"});
 await page.locator("#extrude").click();await page.locator("#solid-value").fill("10");await page.locator("#solid-apply").click();
 await volume(6000,80);const created=await save();assert.equal(JSON.parse(created.toString()).features.length,2);
 console.log("PASS create rectangle sketch and extrude through UI");
 await page.locator("#offline").click();
 await page.waitForFunction(()=>document.body.dataset.offline==="ready"||document.querySelector("#errors").textContent.trim(),{},{timeout:240000});await noError();
 await context.setOffline(true);await page.reload();await ready();await volume(12000);
 await open(created);await volume(6000,80);
 console.log("WASM smoke PASS: actual CAD edit, creation, exports and offline");
} finally {await browser.close();}
