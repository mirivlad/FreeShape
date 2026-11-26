import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
const browser=await chromium.launch({headless:true,args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
try {
 const context=await browser.newContext({acceptDownloads:true});
 const page=await context.newPage();
 page.on("console",msg=>console.log("browser",msg.type(),msg.text()));
 page.on("pageerror",err=>console.error("page",err));
 page.on("requestfailed",req=>console.error("request",req.url(),req.failure()));
 await page.goto(process.env.CAD_URL||"http://localhost:8086");
 await page.waitForFunction(()=>document.body.dataset.ready!==undefined,{},{timeout:240000});
 assert.equal(await page.locator("body").getAttribute("data-ready"),"true",await page.locator("#errors").textContent());
 assert.equal(Math.round(Number(await page.locator("body").getAttribute("data-volume"))),12000);
 assert.equal(await page.locator("body").getAttribute("data-meshes"),"1");
 await page.getByRole("button",{name:/Extrude/i}).click();
 await page.locator("#depth").fill("20");
 await page.locator("#apply").click();
 await page.waitForFunction(()=>Math.round(Number(document.body.dataset.volume))===24000,{},{timeout:90000});
 let pending=page.waitForEvent("download");
 await page.locator("#save").click();
 let dl=await pending; const saved=await dl.path();
 assert.equal(JSON.parse(await fs.readFile(saved,"utf8")).format,"freeshape");
 await page.locator("#demo").click();
 await page.waitForFunction(()=>Math.round(Number(document.body.dataset.volume))===12000,{},{timeout:90000});
 await page.locator("#file").setInputFiles({name:"test.fshape",mimeType:"application/json",buffer:await fs.readFile(saved)});
 await page.waitForFunction(()=>Math.round(Number(document.body.dataset.volume))===24000,{},{timeout:90000});
 for(const ext of ["step","stl"]){
   pending=page.waitForEvent("download");await page.locator("#"+ext).click();dl=await pending;
   const data=await fs.readFile(await dl.path());assert(data.length>100,ext+" export too small");
   if(ext==="step")assert(data.toString("ascii",0,30).includes("ISO-10303-21"));
 }
 await page.locator("#offline").click();
 await page.waitForFunction(()=>document.body.dataset.offline==="ready",{},{timeout:240000});
 await context.setOffline(true);
 await page.reload();
 await page.waitForFunction(()=>document.body.dataset.ready!==undefined,{},{timeout:240000});
 assert.equal(await page.locator("body").getAttribute("data-ready"),"true",await page.locator("#errors").textContent());
 assert.equal(Math.round(Number(await page.locator("body").getAttribute("data-volume"))),12000);
 console.log("WASM smoke PASS: original document, edit, open/save, STEP/STL, offline reload");
} finally {await browser.close();}
