"""Thin browser adapter to the original FreeShape kernel."""
import base64
import json
import math
import pathlib
import sys
import time
from freeshape import __version__, kernel as K, features as F
from freeshape.document import Document
from freeshape.sketch import Sketch

doc = None


def demo():
    d = Document()
    d.name = "Browser test"
    s = Sketch()
    p = [s.add_point(x, y) for x, y in ((0, 0), (40, 0), (40, 30), (0, 30))]
    for a, b in zip(p, p[1:] + p[:1]):
        s.add_line(a, b)
    if not s.solve():
        raise RuntimeError("Sketch solver failed")
    f = d.make_feature("sketch")
    f["params"]["sketch"] = s.to_dict()
    d.add_feature(f)
    sr = d.state.sketches[f["id"]]
    e = d.make_feature("extrude")
    e["params"].update(regions=[F.region_ref(sr, f["id"], sr.regions[0])], depth=10, op="new")
    d.add_feature(e)
    if d.errors or not d.state.parts:
        raise RuntimeError(str(d.errors))
    return d


def summary(d):
    meshes = []
    for p in d.state.parts.values():
        if p.id in d.hidden_parts:
            continue
        m = K.tessellate(p.shape)
        meshes.append({"id": p.id, "vertices": m.verts.ravel().tolist(),
                       "normals": m.normals.ravel().tolist(), "triangles": m.tris.ravel().tolist(),
                       "edges": [e.ravel().tolist() for e in m.edge_polys]})
    return {"name": d.name, "features": [{"id": f["id"], "name": f.get("name", f["type"]),
            "type": f["type"], "depth": f.get("params", {}).get("depth"),
            "suppressed": f.get("suppressed", False)} for f in d.features],
            "errors": d.errors, "meshes": meshes,
            "volume": sum(float(K.volume(p.shape)) for p in d.state.parts.values())}


def open_document(content):
    d = json.loads(content)
    if d.get("format") != "freeshape" or not isinstance(d.get("features"), list):
        raise ValueError("Expected a FreeShape Part Studio (.fshape)")
    if any(str(f.get("type", "")).startswith("plugin:") or f.get("type") in ("derived", "script")
           for f in d["features"]):
        raise ValueError("External derived documents, scripts and plugins are not supported")
    return Document.from_dict(d)


def call(request):
    global doc
    start = time.perf_counter()
    op = request["op"]
    if op == "demo":
        doc = demo()
    elif op == "open":
        doc = open_document(request["content"])
    elif doc is None:
        raise ValueError("Open or create a document first")
    elif op == "depth":
        value = float(request["value"])
        if not math.isfinite(value) or not 0 < value <= 100000:
            raise ValueError("Depth must be positive and finite")
        d = Document.from_dict(json.loads(doc.to_json()))
        f = next(f for f in d.features if f["id"] == request["id"])
        if f["type"] != "extrude" or f.get("params", {}).get("end", "blind") != "blind":
            raise ValueError("Only blind extrusions can be edited in this prototype")
        f["params"]["depth"] = value
        d.rebuild()
        if d.errors:
            raise RuntimeError(str(d.errors))
        doc = d
    elif op == "save":
        return {"file": doc.to_json(), "name": "model.fshape"}
    elif op == "export":
        ext = request["format"]
        if ext not in ("step", "stl"):
            raise ValueError("Unknown export format")
        if doc.errors:
            raise ValueError("Fix rebuild errors before exporting")
        path = pathlib.Path("/tmp/export." + ext)
        try:
            doc.export(str(path))
            data = path.read_bytes()
            if not data:
                raise RuntimeError("Empty export")
            return {"file": base64.b64encode(data).decode("ascii"), "name": "model." + ext}
        finally:
            path.unlink(missing_ok=True)
    elif op == "rebuild":
        doc.rebuild()
    else:
        raise ValueError("Unknown command")
    result = summary(doc)
    result["ms"] = round((time.perf_counter() - start) * 1000)
    return result


def dispatch(payload):
    return json.dumps(call(json.loads(payload)), allow_nan=False)


def runtime_info():
    import OCP
    import numpy
    return json.dumps({"freeshape": __version__, "python": sys.version.split()[0],
                       "numpy": numpy.__version__, "platform": sys.platform,
                       "ocp": getattr(OCP, "__version__", "available")})
