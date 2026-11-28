const VERSION="freeshape-web-0.3.8";
self.addEventListener("install",event=>event.waitUntil((async()=>{
 const response=await fetch("./offline-files.json",{cache:"no-store"});
 if(!response.ok)throw Error("Offline manifest unavailable");
 const files=await response.json(),cache=await caches.open(VERSION);
 for(const file of files)await cache.add(new Request(new URL(file,self.registration.scope),{cache:"reload"}));
 await self.skipWaiting();
})()));
self.addEventListener("activate",event=>event.waitUntil((async()=>{
 for(const key of await caches.keys())if(key.startsWith("freeshape-web-")&&key!==VERSION)await caches.delete(key);
 await self.clients.claim();
})()));
self.addEventListener("fetch",event=>{
 if(event.request.method!=="GET"||new URL(event.request.url).origin!==self.location.origin)return;
 event.respondWith((async()=>{
  const cache=await caches.open(VERSION);
  const hit=await cache.match(event.request);
  if(hit)return hit;
  if(event.request.mode==="navigate"){const index=await cache.match(new URL("index.html",self.registration.scope));if(index)return index;}
  return fetch(event.request);
 })());
});
