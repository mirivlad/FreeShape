"""Thin browser adapter to the original FreeShape kernel."""
import base64
import copy
import json
import math
import pathlib
import sys
import time
import traceback
from freeshape import __version__, kernel as K, features as F
from freeshape.document import Document
from freeshape.sketch import Sketch

doc = None
draft = None


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


def state_meshes(state, hidden=()):
    meshes = []
    for p in state.parts.values():
        if p.id in hidden:
            continue
        m = K.tessellate(p.shape)
        meshes.append({"id": p.id, "name": p.name, "vertices": m.verts.ravel().tolist(),
                       "normals": m.normals.ravel().tolist(), "triangles": m.tris.ravel().tolist(),
                       "tri_face": m.tri_face.tolist(),
                       "edges": [e.ravel().tolist() for e in m.edge_polys]})
    return meshes


def region_mesh(face, plane=None):
    m = K.tessellate(face)
    vertices = [list(plane.to_local(v)) for v in m.verts] if plane is not None else m.verts.tolist()
    return {"vertices": vertices, "triangles": m.tris.tolist(),
            "edges": [e.ravel().tolist() for e in m.edge_polys] if plane is None else []}


def sketch_regions_view(result):
    return [region_mesh(face) for face in result.regions]


def summary(d):
    meshes = state_meshes(d.state, d.hidden_parts)
    return {"name": d.name, "units": d.units, "parts": [{"id": p.id, "name": p.name} for p in d.state.parts.values()], "undo": d.can_undo(), "redo": d.can_redo(), "features": [{"id": f["id"], "name": f.get("name", f["type"]),
            "type": f["type"], "depth": f.get("params", {}).get("depth"),
            "params": {k: v for k, v in f.get("params", {}).items() if k in ("depth", "radius", "distance", "op", "end", "flip", "angle")},
            "regions": len(d.state.sketches[f["id"]].regions) if f["id"] in d.state.sketches else 0,
            "suppressed": f.get("suppressed", False)} for f in d.features],
            "errors": d.errors, "meshes": meshes,
            "sketch_regions": {fid: sketch_regions_view(sr) for fid, sr in d.state.sketches.items()},
            "volume": sum(float(K.volume(p.shape)) for p in d.state.parts.values())}


def open_document(content):
    d = json.loads(content)
    if d.get("format") != "freeshape" or not isinstance(d.get("features"), list):
        raise ValueError("Expected a FreeShape Part Studio (.fshape)")
    if any(str(f.get("type", "")).startswith("plugin:") or f.get("type") in ("derived", "script")
           for f in d["features"]):
        raise ValueError("External derived documents, scripts and plugins are not supported")
    return Document.from_dict(d)


def number(value, minimum=None):
    n = float(value)
    if not math.isfinite(n) or abs(n) > 1000000 or (minimum is not None and n < minimum):
        raise ValueError("Invalid numeric value")
    return n


def transaction(fn):
    """Keep native undo history; roll back a failed feature edit."""
    before = doc._snapshot()
    undo, redo, dirty = list(doc._undo), list(doc._redo), doc.dirty
    previous = set(doc.errors)
    try:
        fn()
        bad = set(doc.errors) - previous
        if bad:
            raise ValueError(str({k: doc.errors[k] for k in bad}))
    except Exception:
        doc._restore(before)
        doc._undo, doc._redo, doc.dirty = undo, redo, dirty
        doc.rebuild()
        raise


def subref(pick, kind):
    part = doc.state.parts[pick["part"]]
    seq = K.faces(part.shape) if kind == "face" else K.edges(part.shape)
    idx = int(pick["index"])
    if not 0 <= idx < len(seq):
        raise ValueError("Invalid selection")
    return part, seq[idx], F.make_ref(part.id, seq[idx], kind, part.shape)


def sketch_view():
    s = draft["sketch"]
    plane = K.std_plane("Top")
    regions = [region_mesh(face, plane) for face in K.sketch_regions(plane, s.curves())]
    return {"regions": regions, "draft": s.to_dict(), "plane": draft["plane"], "id": draft["id"],
            "dof": s.status.get("dof"), "bad": list(s.status.get("bad", [])),
            "curves": {eid: [q.tolist() for q in s.polylines(eid, 80)]
                       for eid in s.entities if s.entities[eid]["type"] not in ("image", "text")},
            "undo": bool(draft["undo"]), "redo": bool(draft["redo"])}


def begin_sketch(req):
    global draft
    fid = req.get("id")
    if fid:
        f = doc.feature(fid)
        if f["type"] != "sketch":
            raise ValueError("Select a sketch")
        s = Sketch.from_dict(f["params"]["sketch"])
        plane = copy.deepcopy(f["params"]["plane"])
    else:
        if req.get("face"):
            part, face, ref = subref(req["face"], "face")
            pl = K.planar_face_plane(face)
            if pl is None:
                raise ValueError("Sketch needs a planar face")
            plane = {"kind": "face", "face": ref, "origin": pl.origin.tolist(), "xdir": pl.xdir.tolist()}
        else:
            name = req.get("plane", "Top")
            if name not in ("Top", "Front", "Right"):
                raise ValueError("Unknown sketch plane")
            plane = {"kind": "std", "name": name}
        s = Sketch()
    s.solve()
    draft = {"id": fid, "plane": plane, "sketch": s, "undo": [], "redo": []}
    return sketch_view()


def point_at(s, p):
    x, y = [number(v) for v in p["uv"]]
    ref = p.get("ref")
    if ref and ref["kind"] == "point" and ref["id"] in s.points:
        return ref["id"]
    pid = s.add_point(x, y)
    if ref:
        kind = ref["kind"]
        if kind in ("mid", "on") and ref["id"] in s.entities:
            s.add_constraint("midpoint" if kind == "mid" else "point_on", pid, ref["id"])
        elif kind == "intersection":
            for eid in ref["ids"]:
                if eid in s.entities:
                    s.add_constraint("point_on", pid, eid)
        elif kind == "quadrant" and ref["id"] in s.entities:
            eid = ref["id"]
            s.add_constraint("point_on", pid, eid)
            s.add_constraint(ref["axis"], s.entities[eid]["c"], pid)
        elif kind == "align" and ref["id"] in s.points:
            s.add_constraint(ref["axis"], ref["id"], pid)
    return pid


def sketch_edit(req):
    s = draft["sketch"]
    before = s.to_dict()
    old_bad = set(s.status.get("bad", []))
    weights = None
    try:
        op = req["op"]
        if op == "sketch_draw":
            tool = req["tool"]
            ps = req["points"]
            construction = bool(req.get("construction"))
            a = point_at(s, ps[0])
            if tool == "point":
                s.add_point_entity(a)
            elif tool == "line":
                b = point_at(s, ps[1])
                if a == b or math.dist(s.points[a], s.points[b]) < 1e-8:
                    raise ValueError("Zero length line")
                eid = s.add_line(a, b, construction)
                if not ps[1].get("free") and abs(s.points[a][1]-s.points[b][1]) < 1e-8:
                    s.add_constraint("horizontal", eid)
                elif not ps[1].get("free") and abs(s.points[a][0]-s.points[b][0]) < 1e-8:
                    s.add_constraint("vertical", eid)
            elif tool in ("rect", "center_rect"):
                b = point_at(s, ps[1])
                x,y = s.points[a]
                u,v = s.points[b]
                if abs(x-u)<1e-8 or abs(y-v)<1e-8:
                    raise ValueError("Rectangle needs positive width and height")
                center = a if tool == "center_rect" else None
                if center is not None:
                    x,y = 2*x-u,2*y-v
                    a = s.add_point(x,y)
                c,d = s.add_point(u,y),s.add_point(x,v)
                ids = [s.add_line(p,q,construction) for p,q in ((a,c),(c,b),(b,d),(d,a))]
                for eid,ctype in zip(ids, ("horizontal","vertical","horizontal","vertical")):
                    s.add_constraint(ctype,eid)
                if center is not None:
                    diag = s.add_line(a,b,True)
                    s.entities[diag]["helper"] = True
                    s.add_constraint("midpoint",center,diag)
            elif tool == "circle":
                r = math.dist(s.points[a], ps[1]["uv"])
                if r < 1e-8:
                    raise ValueError("Zero radius")
                eid = s.add_circle(a,r,construction)
                if ps[1].get("ref"):
                    rim = point_at(s,ps[1])
                    if rim != a:
                        s.add_constraint("point_on",rim,eid)
                        if not any(rim in s.entity_points(i) for i in s.entities):
                            s.add_point_entity(rim)
            elif tool == "arc":
                # Three points on the arc: start, through, end.
                p,q,r = [item["uv"] for item in ps]
                x,y = p
                u,v = q
                w,z = r
                den = 2*(x*(v-z)+u*(z-y)+w*(y-v))
                if abs(den)<1e-10:
                    raise ValueError("Arc needs three non-collinear points")
                pp,qq,rr = x*x+y*y,u*u+v*v,w*w+z*z
                center = [(pp*(v-z)+qq*(z-y)+rr*(y-v))/den,
                          (pp*(w-u)+qq*(x-w)+rr*(u-x))/den]
                c = s.add_point(*center)
                b = point_at(s,ps[2])
                if den < 0:
                    a,b = b,a
                s.add_arc(c,a,b,construction)
            else:
                raise ValueError("Unsupported sketch tool")
        elif op == "sketch_drag":
            pid = req["id"]
            if pid not in s.points or pid == "origin":
                raise ValueError("Select a movable point")
            s.points[pid] = [number(v) for v in req["uv"]]
            weights = {(pid, 0): 1e3, (pid, 1): 1e3}
        elif op == "sketch_dimension":
            c = next(c for c in s.constraints if c["id"] == req["id"])
            if c["type"] not in ("distance","hdistance","vdistance","radius","diameter","angle") or "expr" in c:
                raise ValueError("This dimension cannot be edited here")
            c["value"] = number(req["value"], 1e-8)
            old_bad.discard(c["id"])
        elif op == "sketch_delete":
            s.delete(req["ids"])
        elif op == "sketch_constraint":
            kind = req["kind"]
            refs = req["refs"]
            ents = s.entities
            if kind in ("horizontal","vertical"):
                if not ((len(refs) == 1 and ents.get(refs[0],{}).get("type") == "line") or
                        (len(refs) == 2 and all(p in s.points for p in refs))):
                    raise ValueError("Select one line or two points")
                s.add_constraint(kind,*refs)
            elif kind == "fix":
                if len(refs)!=1 or refs[0] not in s.points or refs[0]=="origin":
                    raise ValueError("Select one movable point")
                s.add_constraint("fix",refs[0],value=s.points[refs[0]])
            elif kind == "coincident":
                if len(refs)!=2 or any(p not in s.points for p in refs):
                    raise ValueError("Select two points")
                s.add_constraint("coincident",*refs)
            elif kind in ("point_on","midpoint"):
                if len(refs)!=2:
                    raise ValueError("Select one point and one curve")
                p,e=refs if refs[0] in s.points else refs[::-1]
                if p not in s.points or ents.get(e,{}).get("type") not in (("line","arc") if kind=="midpoint" else ("line","circle","arc")):
                    raise ValueError("Invalid point/curve selection")
                s.add_constraint(kind,p,e)
            elif kind == "concentric":
                if len(refs)!=2 or any(ents.get(e,{}).get("type") not in ("circle","arc") for e in refs):
                    raise ValueError("Select two circular curves")
                s.add_constraint(kind,*refs)
            elif kind in ("parallel","perpendicular","equal"):
                if len(refs)!=2 or any(ents.get(e,{}).get("type")!="line" for e in refs):
                    raise ValueError("Select two lines")
                s.add_constraint(kind,*refs)
            elif kind in ("distance","hdistance","vdistance"):
                if not ((len(refs)==1 and ents.get(refs[0],{}).get("type")=="line") or
                        (len(refs)==2 and all(p in s.points for p in refs))):
                    raise ValueError("Select one line or two points")
                s.add_constraint(kind,*refs,value=number(req["value"],1e-8))
            elif kind in ("radius","diameter"):
                if len(refs)!=1 or ents.get(refs[0],{}).get("type") not in ("circle","arc"):
                    raise ValueError("Select a circle or arc")
                s.add_constraint(kind,*refs,value=number(req["value"],1e-8))
            else:
                raise ValueError("Unsupported constraint")
        if not s.solve(weights=weights) and set(s.status.get("bad", [])) - old_bad:
            raise ValueError("Constraint cannot be solved")
    except Exception:
        draft["sketch"] = Sketch.from_dict(before)
        draft["sketch"].solve()
        raise
    draft["undo"].append(before)
    del draft["undo"][:-100]
    draft["redo"].clear()
    return sketch_view()


def finish_sketch():
    global draft
    s = draft["sketch"]
    # Match desktop: discard an empty new sketch, but save edits to an existing one.
    if not s.entities and not draft["id"]:
        draft = None
        return
    f = copy.deepcopy(doc.feature(draft["id"])) if draft["id"] else doc.make_feature("sketch")
    f["params"].update(plane=draft["plane"],sketch=s.to_dict())
    transaction(lambda: doc.replace_feature(f) if draft["id"] else doc.add_feature(f))
    draft = None


def build_solid(req):
    kind = req["kind"]
    if kind not in ("extrude","revolve","fillet","chamfer"):
        raise ValueError("Unsupported feature")
    f = doc.make_feature(kind)
    p = f["params"]
    if kind in ("extrude","revolve"):
        fid = req["sketch"]
        sr = doc.state.sketches[fid]
        indexes = list(dict.fromkeys(int(i) for i in req["regions"]))
        if not indexes or any(i<0 or i>=len(sr.regions) for i in indexes):
            raise ValueError("Select sketch regions")
        op = req.get("operation","new")
        if op not in ("new","add","remove","intersect"):
            raise ValueError("Invalid operation")
        p.update(regions=[F.region_ref(sr,fid,sr.regions[i]) for i in indexes],op=op,flip=bool(req.get("flip")))
        if kind == "extrude":
            p.update(depth=number(req["value"],1e-8),end="blind")
        else:
            axis = req.get("axis","Z")
            if axis not in ("X","Y","Z"):
                raise ValueError("Invalid axis")
            angle = number(req["value"],1e-8)
            if angle>360:
                raise ValueError("Angle exceeds 360 degrees")
            p.update(axis={"kind":"std","name":axis},end="full" if angle==360 else "blind",angle=angle)
    else:
        picks = req.get("edges",[])
        if not picks:
            raise ValueError("Select model edges")
        p["edges"] = [subref(item,"edge")[2] for item in picks]
        p["radius" if kind=="fillet" else "distance"] = number(req["value"],1e-8)
    return f


def preview_solid(req):
    # A preview must not consume persistent IDs or create undo history.
    counter = doc._counter
    try:
        f = build_solid(req)
        state, error = doc.preview(f, doc.insert_index())
        if error:
            raise ValueError(str(error))
        return {"meshes": state_meshes(state, doc.hidden_parts),
                "volume": sum(float(K.volume(p.shape)) for p in state.parts.values())}
    finally:
        doc._counter = counter


def add_solid(req):
    f = build_solid(req)
    transaction(lambda: doc.add_feature(f))


def call(request):
    global doc, draft
    start = time.perf_counter()
    op = request["op"]
    if op == "new":
        doc = Document()
        draft = None
    elif op == "demo":
        doc = demo()
        draft = None
    elif op == "open":
        doc = open_document(request["content"])
        draft = None
    elif doc is None:
        raise ValueError("Open or create a document first")
    elif op == "depth":
        value = float(request["value"])
        if not math.isfinite(value) or not 0 < value <= 100000:
            raise ValueError("Depth must be positive and finite")
        f = copy.deepcopy(doc.feature(request["id"]))
        if f["type"] != "extrude" or f.get("params", {}).get("end", "blind") != "blind":
            raise ValueError("Only blind extrusions can be edited in this prototype")
        f["params"]["depth"] = value
        transaction(lambda: doc.replace_feature(f))
    elif op == "begin_sketch":
        return begin_sketch(request)
    elif op in ("sketch_draw","sketch_delete","sketch_constraint","sketch_drag","sketch_dimension"):
        return sketch_edit(request)
    elif op in ("sketch_undo","sketch_redo"):
        source,target = ("undo","redo") if op=="sketch_undo" else ("redo","undo")
        if draft[source]:
            draft[target].append(draft["sketch"].to_dict())
            draft["sketch"] = Sketch.from_dict(draft[source].pop())
            draft["sketch"].solve()
        return sketch_view()
    elif op == "sketch_finish":
        finish_sketch()
    elif op == "sketch_cancel":
        draft = None
    elif op == "solid_preview":
        return preview_solid(request)
    elif op == "solid":
        add_solid(request)
    elif op == "undo":
        doc.undo()
    elif op == "redo":
        doc.redo()
    elif op == "suppress":
        doc.set_suppressed(request["id"],bool(request["value"]))
    elif op == "delete":
        doc.delete_features([request["id"]])
    elif op == "rename":
        doc.rename_feature(request["id"],str(request["name"])[:200])
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
    try:
        return json.dumps({"result": call(json.loads(payload))}, allow_nan=False)
    except Exception as exc:
        # Keep full diagnostic detail in the developer console, not the CAD UI.
        detail = traceback.format_exc()
        if isinstance(exc, (ValueError, K.KernelError, RuntimeError)):
            message = str(exc).strip() or type(exc).__name__
        else:
            message = "Внутренняя ошибка вычисления"
        return json.dumps({"error": message, "detail": detail}, ensure_ascii=False)


def runtime_info():
    import OCP
    import numpy
    return json.dumps({"freeshape": __version__, "python": sys.version.split()[0],
                       "numpy": numpy.__version__, "platform": sys.platform,
                       "ocp": getattr(OCP, "__version__", "available")})
