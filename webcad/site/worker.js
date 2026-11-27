let py;
const send = stage => postMessage({stage});
const local = new URL("./", self.location.href);
async function boot() {
  send("Loading Python / WebAssembly");
  importScripts(new URL("runtime/pyodide.js", local).href);
  const config = await (await fetch(new URL("runtime.json", local))).json();
  py = await loadPyodide({indexURL: new URL("runtime/", local).href});
  send("Loading NumPy and OCP.wasm");
  await py.loadPackage(["numpy", "micropip"]);
  py.globals.set("wheel_url", new URL("runtime/" + config.wheel, local).href);
  await py.runPythonAsync("import micropip\nawait micropip.install(wheel_url, deps=False)");
  send("Importing original FreeShape modules");
  const zip = await fetch(new URL("freeshape.zip", local));
  if (!zip.ok) throw Error("Missing FreeShape sources");
  py.unpackArchive(await zip.arrayBuffer(), "zip", {extractDir: "/cad"});
  const response = await fetch(new URL("bridge.py", local));
  if (!response.ok) throw Error("Missing Python bridge");
  py.runPython("import sys, os\nsys.path.insert(0, '/cad')\nos.environ['FREESHAPE_NO_PLUGINS']='1'");
  py.runPython(await response.text());
  return JSON.parse(py.runPython("runtime_info()"));
}
let queue = Promise.resolve();
onmessage = ({data}) => {
  const {requestId,payload}=data;
  queue = queue.then(async () => {
    try {
      if (payload.op === "init") {
        postMessage({requestId, result: await boot()});
        return;
      }
      py.globals.set("request_json", JSON.stringify(payload));
      const reply=JSON.parse(py.runPython("dispatch(request_json)"));
      if(reply.error){console.error(reply.detail);postMessage({requestId,error:reply.error});}
      else postMessage({requestId,result:reply.result});
    } catch (err) {
      console.error(err);
      postMessage({requestId, error: payload.op==="init"?"Не удалось загрузить ядро FreeShape":"Ошибка вычисления"});
    }
  });
};
