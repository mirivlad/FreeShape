"""Thin browser adapter to the original FreeShape kernel."""
import base64
import copy
import json
import math
import pathlib
import re
import sys
import time
import traceback
import numpy as np
from freeshape import __version__, kernel as K, features as F
from freeshape.document import Document
from freeshape.sketch import Sketch
from freeshape import sketch_ops as OPS
from freeshape.ui import smart_snap as SS
from freeshape.expr import parse_number, has_vars, var_names, check_units, text_problem, with_unit
from freeshape import measure_value as MV, units as U

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
                       "edges": [e.ravel().tolist() for e in m.edge_polys],
                       "points": [list(map(float,v)) for v in K.vertex_points(p.shape)], "color":list(p.color)})
    return meshes


def region_mesh(face, plane=None):
    m = K.tessellate(face)
    vertices = [list(plane.to_local(v)) for v in m.verts] if plane is not None else m.verts.tolist()
    return {"vertices": vertices, "triangles": m.tris.tolist(), "area": K.face_info(face)["area"],
            "edges": [e.ravel().tolist() for e in m.edge_polys] if plane is None else []}


def sketch_regions_view(result):
    return [region_mesh(face) for face in result.regions]


def model_sketch_curves(state):
    return {fid:[{"id":eid,"type":e["type"],"construction":bool(e.get("construction")),
                  "paths":[[list(map(float,sr.plane.to_world(*q))) for q in path] for path in sr.sketch.polylines(eid,48)]}
                 for eid,e in sr.sketch.entities.items() if not e.get("helper") and e["type"] not in ("point","text","image")]
            for fid,sr in state.sketches.items()}


def summary(d):
    meshes = state_meshes(d.state, d.hidden_parts)
    return {"name": d.name, "units": d.units, "parts": [{"id": p.id, "name": p.name} for p in d.state.parts.values()], "undo": d.can_undo(), "redo": d.can_redo(), "features": [{"id": f["id"], "name": f.get("name", f["type"]),
            "type": f["type"], "depth": f.get("params", {}).get("depth"),
            "params": {k: v for k, v in f.get("params", {}).items() if k in ("depth", "radius", "distance", "op", "end", "flip", "angle", "name", "expr", "mtype", "unit", "aunit", "creation")},
            "regions": len(d.state.sketches[f["id"]].regions) if f["id"] in d.state.sketches else 0,
            "suppressed": f.get("suppressed", False)} for f in d.features],
            "errors": d.errors, "meshes": meshes,
            "sketch_regions": {fid: sketch_regions_view(sr) for fid, sr in d.state.sketches.items()},"sketch_curves":model_sketch_curves(d.state),
            "volume": sum(abs(float(K.volume(sol))) for p in d.state.parts.values() for sol in K.solids(p.shape))}


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
            "undo": bool(draft["undo"]), "redo": bool(draft["redo"]),
            "rectangle_centres": [{"uv": q.tolist(), "diagonal": list(ab), "ids": list(ids)}
                                  for q, ab, ids in SS.rectangle_centres(s)],
            "model_edges": draft["model_edges"], "variables": dict(draft["variables"]),
            "variable_kinds": dict(draft["variable_kinds"]), "pending_variables": copy.deepcopy(draft["pending_variables"])}


def model_snap_geometry(state, plane, hidden=()):
    """Cache exact in-plane model edges; never snap to edges behind the sketch."""
    out = []
    for part in state.parts.values():
        if part.id in hidden:
            continue
        lo, hi = K.bbox(part.shape)
        tol = 1e-6 * max(1., float(np.linalg.norm(hi-lo)))
        for i, edge in enumerate(K.edges(part.shape)):
            try:
                poly = np.asarray(K.discretize_edge(edge), float)
                if len(poly) < 2 or np.abs((poly-plane.origin) @ plane.normal).max() > tol:
                    continue
                uv = np.array([plane.to_local(q) for q in poly])
                info = K.edge_info(edge)
                closed = np.linalg.norm(poly[0]-poly[-1]) < 1e-7
                pts = [] if closed else [{"uv": uv[0].tolist(), "label":"Вершина модели"},
                                         {"uv": uv[-1].tolist(), "label":"Вершина модели"}]
                item = {"id": f"{part.id}:{i}", "path": uv.tolist(), "points": pts}
                if "r" in info and abs(abs(np.asarray(info["axis"]) @ plane.normal)-1) < 1e-6:
                    c = np.array(plane.to_local(info["center"]))
                    item.update(kind="circle", c=c.tolist(), r=info["r"])
                    pts.append({"uv": c.tolist(), "label":"Центр ребра модели"})
                    if not closed:
                        a,b,m = uv[0],uv[-1],uv[len(uv)//2]
                        angle = lambda q: math.atan2(q[1]-c[1],q[0]-c[0])
                        start,end = angle(a),angle(b)
                        if (angle(m)-start)%(2*math.pi) > (end-start)%(2*math.pi):
                            a,b=b,a
                            start,end=end,start
                        item.update(arc=[start,(end-start)%(2*math.pi)], a=a.tolist(), b=b.tolist())
                elif not closed:
                    a,b=uv[0],uv[-1]
                    d=b-a
                    off=np.abs((uv-a) @ np.array([-d[1],d[0]]))/max(np.linalg.norm(d),1e-12)
                    if np.linalg.norm(d)>1e-9 and off.max()<tol:
                        item.update(kind="line",a=a.tolist(),b=b.tolist())
                        pts.append({"uv": ((a+b)/2).tolist(), "label":"Середина ребра модели"})
                out.append(item)
            except (RuntimeError, ValueError, K.KernelError):
                continue
    return out


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
    index = next(i for i,f in enumerate(doc.features) if f["id"]==fid) if fid else doc.insert_index()
    state = doc.state_before(index)
    if fid:
        # Evaluate the sketch against variables visible before it, including updates
        # made since the sketch was last saved.
        for c in s.constraints:
            if isinstance(c.get("expr"),str):
                value=parse_number(c["expr"],angle=c["type"]=="angle",variables=state.vars)
                if value is None:raise ValueError("Unresolved dimension: "+c["expr"])
                c["value"]=value
    s.solve()
    model_edges = model_snap_geometry(state, F.resolve_plane(state,plane), doc.hidden_parts)
    draft = {"id": fid, "plane": plane, "sketch": s, "undo": [], "redo": [], "model_edges": model_edges, "variables": dict(state.vars), "variable_kinds": dict(state.var_kinds), "pending_variables": [], "index": index}
    return sketch_view()


def fixed_point(s, uv):
    pid=s.add_point(*uv)
    s.add_constraint("fix",pid,value=list(uv))
    return pid


def model_ref(s, ref, uv):
    item=next((e for e in draft["model_edges"] if e["id"]==ref["id"]),None)
    if item is None:
        raise ValueError("Unknown model edge")
    if ref["kind"]=="model_point":
        i=int(ref["index"])
        if not 0<=i<len(item["points"]):
            raise ValueError("Unknown model point")
        return fixed_point(s,item["points"][i]["uv"])
    eid=next((i for i,e in s.entities.items() if e.get("model_snap")==item["id"]),None)
    if eid is None:
        if item.get("kind")=="line":
            eid=s.add_line(fixed_point(s,item["a"]),fixed_point(s,item["b"]),True)
        elif item.get("kind")=="circle":
            c=fixed_point(s,item["c"])
            if "arc" in item:
                eid=s.add_arc(c,fixed_point(s,item["a"]),fixed_point(s,item["b"]),True)
            else:
                eid=s.add_circle(c,item["r"],True)
                s.add_constraint("radius",eid,value=item["r"])
        else:
            return fixed_point(s,uv)
        s.entities[eid].update(helper=True,model_snap=item["id"])
    pid=s.add_point(*uv)
    s.add_constraint("point_on",pid,eid)
    return pid


def point_at(s, p):
    x,y=[number(v) for v in p["uv"]]
    ref=p.get("ref") or {}
    kind=ref.get("kind")
    if kind=="point" and ref["id"] in s.points:
        return ref["id"]
    if kind in ("model_point","model_edge"):
        pid=model_ref(s,ref,[x,y])
    else:
        pid=s.add_point(x,y)
        if kind in ("mid","on") and ref["id"] in s.entities:
            s.add_constraint("midpoint" if kind=="mid" else "point_on",pid,ref["id"])
        elif kind=="intersection":
            for eid in ref["ids"]:
                if eid in s.entities:
                    s.add_constraint("point_on",pid,eid)
        elif kind=="quadrant" and ref["id"] in s.entities:
            eid=ref["id"]
            s.add_constraint("point_on",pid,eid)
            s.add_constraint(ref["axis"],s.entities[eid]["c"],pid)
        elif kind=="rect_center":
            a,b=ref["diagonal"]
            if a not in s.points or b not in s.points:
                raise ValueError("Unknown rectangle")
            diag=next((i for i,e in s.entities.items() if e["type"]=="line" and e.get("helper") and {e["p1"],e["p2"]}=={a,b}),None)
            if diag is None:
                diag=s.add_line(a,b,True)
                s.entities[diag]["helper"]=True
            s.add_constraint("midpoint",pid,diag)
        elif kind=="align" and ref["id"] in s.points:
            s.add_constraint(ref["axis"],ref["id"],pid)
    for guide in p.get("alignments",[])[:2]:
        axis=guide["axis"]
        if axis not in ("horizontal","vertical"):
            raise ValueError("Invalid guide")
        src=guide["source"]
        r=src.get("ref",{})
        if r.get("kind")=="point":
            q=r.get("id")
            if q not in s.points:
                continue
        else:
            q=None
            if r.get("kind")=="mid":
                q=next((c["refs"][0] for c in s.constraints if c["type"]=="midpoint" and c["refs"][1]==r["id"]),None)
            if q is None:
                q=point_at(s,{"uv":src["uv"],"ref":r})
                s.add_point_entity(q)
        if q!=pid:
            s.add_constraint(axis,q,pid)
    return pid


def trim_line(s, eid, at):
    """Remove the clicked interval of a line, bounded by real intersections."""
    e = s.entities[eid]
    a, b = s.P(e["p1"]), s.P(e["p2"])
    d = b-a
    length2 = float(d @ d)
    if length2 < 1e-12:
        raise ValueError("Line is too short")
    hits = [(0., None), (1., None)]
    for oid, o in s.entities.items():
        if oid == eid or o.get("helper"):
            continue
        if o["type"] == "line":
            c, f = s.P(o["p1"]), s.P(o["p2"])-s.P(o["p1"])
            if float(f @ f) < 1e-12:
                continue
            target = ("line", c, f)
        elif o["type"] in ("circle", "arc"):
            target = ("circle", s.P(o["c"]), s.radius(oid))
        else:
            continue
        for q in OPS._intersections(("line", a, d), target):
            t = float((q-a) @ d / length2)
            if not 1e-6 < t < 1-1e-6:
                continue
            if o["type"] == "line":
                u = float((q-c) @ f / (f @ f))
                if not -1e-8 <= u <= 1+1e-8:
                    continue
            elif o["type"] == "arc":
                a1, a2 = s.arc_angles(oid)
                ang = (math.atan2(q[1]-target[1][1],q[0]-target[1][0])-a1) % (2*math.pi)
                if ang > (a2-a1)+1e-8 and ang < 2*math.pi-1e-8:
                    continue
            hits.append((t, oid))
    t = float(np.clip((np.asarray(at)-a) @ d/length2, 0, 1))
    if any(oid is not None and abs(t-u)<1e-6 for u,oid in hits):
        raise ValueError("Click between intersections")
    lo = max((h for h in hits if h[0]<=t), key=lambda h:h[0], default=(0.,None))
    hi = min((h for h in hits if h[0]>=t), key=lambda h:h[0], default=(1.,None))
    hv = [c["type"] for c in s.constraints if c["refs"] == [eid] and c["type"] in ("horizontal","vertical")]
    # Create remaining pieces before deleting the original, preserving shared endpoints.
    for (u, target), end in ((lo,"p1"), (hi,"p2")):
        if target is None:
            continue
        q = s.add_point(*(a+u*d))
        new = s.add_line(e[end],q,e.get("construction",False)) if end=="p1" else s.add_line(q,e[end],e.get("construction",False))
        for kind in hv:
            s.add_constraint(kind,new)
        s.add_constraint("point_on",q,target)
    s.delete([eid])


class SketchConstraintSelection:
    """Qt-independent port of desktop Sketcher constraint selection semantics."""
    NORMAL_CURVES = ("circle", "arc", "ellipse", "ellipse_arc")

    def __init__(self, sketch):
        self.sk = sketch

    def _etype(self, i):
        if i in self.sk.points:
            return "point"
        return self.sk.entities.get(i, {}).get("type")

    def _as_point(self, i):
        return self.sk.entities.get(i, {}).get("p", i)

    def apply(self, tool, picks) -> bool:
        picks = [p for p in picks if p in self.sk.points or p in self.sk.entities]
        types = [self._etype(p) for p in picks]
        sk = self.sk
        curves = ("circle", "arc")
        made = []
        if tool == "fix" and picks:
            for p in picks:
                pts = [self._as_point(p)] if types[picks.index(p)] == "point" else sk.entity_points(p)
                for pid in pts:
                    if pid != "origin":
                        made.append(("fix", [pid], list(sk.points[pid])))
                if p in sk.entities and sk.entities[p]["type"] in ("circle", "ellipse", "ellipse_arc"):
                    made.append(("radius", [p], sk.entities[p]["r"]))
        elif tool in ("horizontal", "vertical") and picks and all(t == "line" for t in types):
            for p in picks:                        # one or several lines: each one made horizontal / vertical
                made.append((tool, [p], None))
        elif len(picks) == 2:
            a, b = picks
            ta, tb = types
            if tool == "coincident":
                if ta == "point" and tb == "point":
                    made.append(("coincident", [self._as_point(a), self._as_point(b)], None))
                elif ta == "point" and tb in ("line",) + self.NORMAL_CURVES:
                    made.append(("point_on", [self._as_point(a), b], None))
                elif tb == "point" and ta in ("line",) + self.NORMAL_CURVES:
                    made.append(("point_on", [self._as_point(b), a], None))
                elif ta in curves and tb in curves:
                    made.append(("concentric", [a, b], None))
            elif tool in ("horizontal", "vertical") and ta == "point" and tb == "point":
                made.append((tool, [self._as_point(a), self._as_point(b)], None))
            elif tool in ("parallel", "perpendicular") and ta == "line" and tb == "line":
                made.append((tool, [a, b], None))
            elif tool in ("perpendicular", "normal") and "line" in (ta, tb) \
                    and (ta in self.NORMAL_CURVES or tb in self.NORMAL_CURVES):
                line, curve = (a, b) if ta == "line" else (b, a)
                refs = [line, curve]
                if sk.entities[curve]["type"] in ("ellipse", "ellipse_arc"):
                    ln = sk.entities[line]                        # the line's end that meets the ellipse
                    poly = sk.polyline(curve, 96)
                    near = lambda pid: float(np.min(np.linalg.norm(poly - sk.P(pid), axis=1)))
                    refs.append(min((ln["p1"], ln["p2"]), key=near))
                made.append(("normal", refs, None))
            elif tool == "equal" and ((ta == tb == "line") or (ta in curves and tb in curves)):
                made.append(("equal", [a, b], None))
            elif tool == "concentric" and ta in curves + ("point",) and tb in curves + ("point",):
                made.append(("concentric", [a if ta in curves else self._as_point(a),
                                            b if tb in curves else self._as_point(b)], None))
            elif tool in ("midpoint", "point_on"):
                if ta == "point" and tb in (("line", "arc") if tool == "midpoint" else ("line",) + self.NORMAL_CURVES):
                    made.append((tool, [self._as_point(a), b], None))
                elif tb == "point" and ta in (("line", "arc") if tool == "midpoint" else ("line",) + self.NORMAL_CURVES):
                    made.append((tool, [self._as_point(b), a], None))
            elif tool == "tangent":
                if (ta == "line" and tb in curves) or (tb == "line" and ta in curves) or (ta in curves and tb in curves):
                    val = None
                    if ta in curves and tb in curves:
                        d = np.linalg.norm(sk.P(sk.entities[a]["c"]) - sk.P(sk.entities[b]["c"]))
                        internal = d < max(sk.radius(a), sk.radius(b))
                        val = -1.0 if internal else 1.0
                    made.append(("tangent", [b, a] if tb == "line" else [a, b], val))
        if tool == "symmetric" and len(picks) == 3:
            lines_ = [p for p, t in zip(picks, types) if t == "line"]
            axis = picks[2] if types[2] == "line" else (lines_[-1] if lines_ else None)
            others = [(p, t) for p, t in zip(picks, types) if p != axis]
            if axis and len(others) == 2:
                (a, ta), (b, tb) = others
                if ta == "point" and tb == "point":
                    made.append(("symmetric", [self._as_point(a), self._as_point(b), axis], None))
                elif ta in curves and tb in curves:
                    made.append(("symmetric", [sk.entities[a]["c"], sk.entities[b]["c"], axis], None))
                    made.append(("equal", [a, b], None))
                elif ta == "line" and tb == "line":
                    ea, eb = sk.entities[a], sk.entities[b]
                    A0, A1 = sk.P(sk.entities[axis]["p1"]), sk.P(sk.entities[axis]["p2"])
                    d = (A1 - A0) / max(np.linalg.norm(A1 - A0), 1e-12)
                    refl = lambda q: A0 + 2 * ((q - A0) @ d) * d - (q - A0)
                    straight = np.linalg.norm(refl(sk.P(ea["p1"])) - sk.P(eb["p1"]))
                    crossed = np.linalg.norm(refl(sk.P(ea["p1"])) - sk.P(eb["p2"]))
                    q1, q2 = (eb["p1"], eb["p2"]) if straight <= crossed else (eb["p2"], eb["p1"])
                    made.append(("symmetric", [ea["p1"], q1, axis], None))
                    made.append(("symmetric", [ea["p2"], q2, axis], None))
        if not made:
            return tool == "fix" and bool(picks) and all(self._as_point(p) == "origin" for p in picks)
        for t, refs, val in made:
            if t in ("horizontal", "vertical"):
                # a line can't be both: horizontal replaces vertical and the other way round (otherwise the line
                # shrinks to a dot), and asking again for what it already is changes nothing
                pair = self._hv_pair(refs)
                other = "vertical" if t == "horizontal" else "horizontal"
                if any(c["type"] == t and self._hv_pair(c["refs"]) == pair for c in sk.constraints):
                    continue
                sk.constraints = [c for c in sk.constraints
                                  if not (c["type"] == other and self._hv_pair(c["refs"]) == pair)]
                self._swing_to(pair, t)
            if any(c["type"] == t and (c["refs"] == refs or (t in ("equal","parallel","perpendicular","coincident","concentric") and c["refs"] == refs[::-1])) and c.get("value") == val for c in sk.constraints):
                continue
            sk.add_constraint(t, *refs, value=val)
        return True

    def _swing_to(self, pair, t):
        """Turn two points about their midpoint so they line up horizontally / vertically, keeping their distance.
        Without this a vertical line made horizontal is squashed to a dot (the smallest move that satisfies the
        solver), instead of being turned."""
        sk = self.sk
        a, b = sorted(pair)
        if a not in sk.points or b not in sk.points:
            return
        A, B = sk.P(a), sk.P(b)
        d = B - A
        L = float(np.linalg.norm(d))
        along = abs(d[0]) if t == "horizontal" else abs(d[1])
        across = abs(d[1]) if t == "horizontal" else abs(d[0])
        if L < 1e-9 or along >= across:
            return                              # already more that way than the other: the solver just nudges it
        m = (A + B) / 2
        sgn = 1.0 if (d[1] if t == "horizontal" else d[0]) >= 0 else -1.0
        half = np.array([sgn * L / 2, 0.0]) if t == "horizontal" else np.array([0.0, sgn * L / 2])
        fixed = {"origin"} | {c["refs"][0] for c in sk.constraints if c["type"] == "fix"}
        if a in fixed and b in fixed:
            return
        if a in fixed:
            sk.points[b] = (A + 2*half).tolist()
        elif b in fixed:
            sk.points[a] = (B - 2*half).tolist()
        else:
            sk.points[a] = (m - half).tolist()
            sk.points[b] = (m + half).tolist()

    def _hv_pair(self, refs):
        """The two points a horizontal / vertical constraint lines up (from a line, or two points), unordered."""
        sk = self.sk
        if len(refs) == 1 and refs[0] in sk.entities and sk.entities[refs[0]].get("type") == "line":
            e = sk.entities[refs[0]]
            return frozenset((e["p1"], e["p2"]))
        return frozenset(refs[:2])


def drag_geometry(s, req, old_bad):
    """Compute a drag from the committed sketch, never from the previous preview."""
    pid = req["id"]
    target = np.asarray([number(v) for v in req["uv"]])
    if len(target) != 2:
        raise ValueError("Invalid drag target")
    if pid in s.points:
        if pid == "origin":
            return
        targets = {pid: target.tolist()}
    elif pid in s.entities:
        ent = s.entities[pid]
        if ent["type"] == "circle":
            radius = max(1e-3, float(np.linalg.norm(target-s.P(ent["c"]))))
            s.entities[pid]["r"] = radius
            s.solve(weights={(pid,"r"):1e3}, ignore=old_bad)
            return
        delta = target-np.asarray([number(v) for v in req["start"]])
        targets = {p:(s.P(p)+delta).tolist() for p in s.entity_points(pid) if p!="origin"}
    else:
        raise ValueError("Select a movable point or curve")
    for p,q in targets.items():
        s.points[p]=q
    weights={(p,j):1e3 for p in targets for j in (0,1)}
    trial=s.copy()
    pins=[trial.add_constraint("fix",p,value=q) for p,q in targets.items()]
    trial.solve(ignore=old_bad)
    if not (set(trial.status.get("bad",[]))-old_bad) and all(math.dist(trial.points[p],q)<1e-6 for p,q in targets.items()):
        s.points,s.entities=trial.points,trial.entities
    s.solve(weights=weights,ignore=old_bad)


def drag_preview(req):
    original=draft["sketch"]
    trial=original.copy()
    old_bad=set(original.status.get("bad",[]))
    drag_geometry(trial,req,old_bad)
    if set(trial.status.get("bad",[]))-old_bad:
        trial=original.copy()
        trial.solve(ignore=old_bad)
    draft["sketch"]=trial
    try:
        return sketch_view()
    finally:
        draft["sketch"]=original


def dimension_value(value,kind):
    if len(str(value))>256:
        raise ValueError("Dimension expression is too long")
    val=parse_number(value,angle=kind=="angle",variables=draft["variables"])
    if val is None:
        raise ValueError("Invalid expression or unknown variable")
    val=number(val,1e-8)
    if kind=="angle" and val>180:
        raise ValueError("Angle must not exceed 180 degrees")
    return val


def set_dimension(s, kind, refs, value, pos=None):
    # Convert point entities and circular centers to native point references.
    refs=list(refs)
    ents=s.entities
    def ptof(ref):
        return ref if ref in s.points else ents.get(ref,{}).get("c",ents.get(ref,{}).get("p"))
    if kind=="auto":
        if len(refs)==1:
            typ=ents.get(refs[0],{}).get("type")
            kind={"line":"distance","circle":"diameter","arc":"radius","ellipse":"radius","ellipse_arc":"radius"}.get(typ)
        elif len(refs)==2:
            if all(ents.get(r,{}).get("type")=="line" for r in refs):
                a,b=[ents[r] for r in refs]
                u=s.P(a["p2"])-s.P(a["p1"]);v=s.P(b["p2"])-s.P(b["p1"])
                if abs(float(u[0]*v[1]-u[1]*v[0]))/max(np.linalg.norm(u)*np.linalg.norm(v),1e-12)<1e-3:
                    refs=[b["p1"],refs[0]]
                    kind="distance"
                else:
                    kind="angle"
            elif any(ents.get(r,{}).get("type")=="line" for r in refs):
                kind="distance"
            else:
                a,b=[ptof(r) for r in refs]
                kind="distance"
                if a and b and pos is not None:
                    A,B=s.P(a),s.P(b)
                    lo,hi=np.minimum(A,B),np.maximum(A,B)
                    if abs(A[0]-B[0])>1e-6 and abs(A[1]-B[1])>1e-6:
                        if lo[0]<=pos[0]<=hi[0] and not lo[1]<=pos[1]<=hi[1]:kind="hdistance"
                        elif lo[1]<=pos[1]<=hi[1] and not lo[0]<=pos[0]<=hi[0]:kind="vdistance"
    if kind in ("distance","hdistance","vdistance"):
        if len(refs)==1 and ents.get(refs[0],{}).get("type")=="line":
            e=ents[refs[0]]
            a,b=s.P(e["p1"]),s.P(e["p2"])
            current=math.dist(a,b) if kind=="distance" else abs(b[0 if kind=="hdistance" else 1]-a[0 if kind=="hdistance" else 1])
        elif len(refs)==2:
            if kind=="distance" and any(ents.get(r,{}).get("type")=="line" for r in refs):
                if ents.get(refs[0],{}).get("type")=="line":refs.reverse()
                p=ptof(refs[0]);e=ents.get(refs[1],{})
                if p is None or e.get("type")!="line":raise ValueError("Select point and line")
                refs[0]=p
                a,b=s.P(e["p1"]),s.P(e["p2"])
                d=b-a
                current=abs(float(d[0]*(s.P(p)-a)[1]-d[1]*(s.P(p)-a)[0]))/max(np.linalg.norm(d),1e-12)
            else:
                refs=[ptof(r) for r in refs]
                if any(r is None for r in refs):raise ValueError("Select two points")
                a,b=map(s.P,refs)
                current=math.dist(a,b) if kind=="distance" else abs(b[0 if kind=="hdistance" else 1]-a[0 if kind=="hdistance" else 1])
        else:raise ValueError("Select a line or two points")
    elif kind in ("radius","diameter") and len(refs)==1 and ents.get(refs[0],{}).get("type") in ("circle","arc","ellipse","ellipse_arc"):
        current=s.radius(refs[0])*(2 if kind=="diameter" else 1)
    elif kind=="angle" and len(refs)==2 and all(ents.get(r,{}).get("type")=="line" for r in refs):
        a,b=[ents[r] for r in refs]
        u=s.P(a["p2"])-s.P(a["p1"]);v=s.P(b["p2"])-s.P(b["p1"])
        current=math.degrees(math.atan2(abs(float(u[0]*v[1]-u[1]*v[0])),float(u@v)))
    else:raise ValueError("Invalid dimension selection")
    value=current if value is None else value
    c=s.add_constraint(kind,*refs,value=dimension_value(value,kind))
    if has_vars(str(value)):c["expr"]=str(value)
    if pos is not None:c["pos"]=[number(v) for v in pos]
    return c


def sketch_snapshot():
    return {"sketch":draft["sketch"].to_dict(),"variables":dict(draft["variables"]),
            "variable_kinds":dict(draft["variable_kinds"]),"pending_variables":copy.deepcopy(draft["pending_variables"])}


def restore_sketch_snapshot(snapshot):
    draft["sketch"]=Sketch.from_dict(snapshot["sketch"])
    for key in ("variables","variable_kinds","pending_variables"):
        draft[key]=copy.deepcopy(snapshot[key])
    draft["sketch"].solve()


def stage_variable(req):
    """Only allow creating the single unknown name used by this dimension.
    The variable is part of the sketch transaction, not a separate document edit."""
    new=req.get("new_variable")
    if new is None:return
    if req["op"] not in ("sketch_constraint","sketch_dimension","sketch_offer_dimension"):
        raise ValueError("Variables can only be created from a dimension")
    name=str(new.get("name",""))
    expr=str(new.get("expr","")).strip()
    missing=set(var_names(req.get("value")))-draft["variables"].keys()
    if missing!={name} or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}",name) or len(expr)>256:
        raise ValueError("Expected exactly one new variable in the dimension")
    kind=req.get("kind")
    if req["op"]=="sketch_dimension":
        kind=next(c["type"] for c in draft["sketch"].constraints if c["id"]==req["id"])
    if kind not in ("distance","hdistance","vdistance","radius","diameter","angle"):
        raise ValueError("Select a length or angle dimension")
    mtype="fixed_angle" if kind=="angle" else "fixed_length"
    params=dict(MV.DEFAULTS,name=name,mtype=mtype,expr=expr,unit="mm",aunit="deg",entities=[])
    state=F.ModelState(vars=dict(draft["variables"]),var_kinds=dict(draft["variable_kinds"]))
    value,vkind=MV.fixed_value(state,params)
    number(value)
    draft["variables"][name]=value
    draft["variable_kinds"][name]=vkind
    draft["pending_variables"].append(params)


def sketch_edit(req):
    s = draft["sketch"]
    before = sketch_snapshot()
    old_bad = set(s.status.get("bad", []))
    weights = None
    offers = []
    chain_end = None
    try:
        op = req["op"]
        stage_variable(req)
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
                offers.append(("distance", [eid], "Длина"))
                if (ps[1].get("ref") or {}).get("kind") != "point":
                    chain_end = b
                if not ps[1].get("free") and abs(s.points[a][1]-s.points[b][1]) < 1e-8:
                    s.add_constraint("horizontal", eid)
                elif not ps[1].get("free") and abs(s.points[a][0]-s.points[b][0]) < 1e-8:
                    s.add_constraint("vertical", eid)
                rel=ps[1].get("relation")
                if rel:
                    target=rel["id"]
                    kind=rel["kind"]
                    target_type=s.entities.get(target,{}).get("type")
                    if kind in ("parallel","perpendicular","equal") and target_type=="line":
                        s.add_constraint(kind,eid,target)
                    elif kind=="tangent" and target_type in ("circle","arc"):
                        s.add_constraint("tangent",eid,target)
                    else:
                        raise ValueError("Invalid inferred line relation")
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
                offers.extend([("distance", [ids[0]], "Ширина"), ("distance", [ids[1]], "Высота")])
                if center is not None:
                    diag = s.add_line(a,b,True)
                    s.entities[diag]["helper"] = True
                    s.add_constraint("midpoint",center,diag)
            elif tool == "circle":
                r = math.dist(s.points[a], ps[1]["uv"])
                if r < 1e-8:
                    raise ValueError("Zero radius")
                eid = s.add_circle(a,r,construction)
                offers.append(("diameter", [eid], "Диаметр"))
                rel=ps[1].get("relation")
                if rel and rel["kind"]=="equal" and s.entities.get(rel["id"],{}).get("type") in ("circle","arc"):
                    s.add_constraint("equal",eid,rel["id"])
                elif ps[1].get("ref") or ps[1].get("alignments"):
                    rim = point_at(s,ps[1])
                    if rim != a:
                        s.add_constraint("point_on",rim,eid)
                        if not any(rim in s.entity_points(i) for i in s.entities):
                            s.add_point_entity(rim)
            elif tool == "ellipse":
                b = point_at(s, ps[1])
                x, y = s.points[a]
                u, v = s.points[b]
                dx, dy = u-x, v-y
                major = math.hypot(dx, dy)
                qx, qy = (number(v) for v in ps[2]["uv"])
                minor = abs((-(qx-x)*dy+(qy-y)*dx)/major) if major > 1e-8 else 0
                if minor < 1e-8:
                    raise ValueError("Ellipse needs two non-zero axes")
                eid = s.add_ellipse(a, b, minor, construction)
                s.add_line(a, b, True)
                offers.append(("radius", [eid], "Вторая полуось"))
            elif tool in ("polygon", "polygon_out"):
                sides = number(req.get("sides", 6))
                if not sides.is_integer() or not 3 <= sides <= 64:
                    raise ValueError("Polygon needs 3 to 64 sides")
                sides = int(sides)
                x, y = s.points[a]
                u, v = (number(v) for v in ps[1]["uv"])
                d = (u-x, v-y)
                size = math.hypot(*d)
                inscribed = tool == "polygon"
                angle, level = OPS.polygon_angle(d, sides, inscribed)
                made = OPS.polygon(s, (x,y), angle, size, sides, inscribed, construction, a, level)
                offers.append(("diameter", [made["circle"]], "Диаметр" if inscribed else "Размер между гранями"))
            elif tool == "spline":
                ids = [a] + [point_at(s, p) for p in ps[1:]]
                closed = bool(req.get("closed"))
                if len(ids) < (3 if closed else 2) or len(ids) > 128:
                    raise ValueError("Invalid number of spline points")
                if len(set(ids)) != len(ids) or any(math.dist(s.points[p],s.points[q]) < 1e-8 for i,p in enumerate(ids) for q in ids[i+1:]):
                    raise ValueError("Spline needs distinct points")
                s.add_spline(ids, closed, construction)
            elif tool == "arc":
                # Desktop order: start, end, through.
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
                b = point_at(s,ps[1])
                if den > 0:
                    a,b = b,a
                eid = s.add_arc(c,a,b,construction)
                m = point_at(s,ps[2])
                if m in (a,b,c):
                    raise ValueError("Arc needs three distinct points")
                s.add_constraint("point_on",m,eid)
                if not any(m in s.entity_points(i) for i in s.entities):
                    s.add_point_entity(m)
            else:
                raise ValueError("Unsupported sketch tool")
        elif op == "sketch_modify":
            tool, eid = req["tool"], req["id"]
            e = s.entities.get(eid, {})
            if e.get("helper") or e.get("type") not in ("line","arc"):
                raise ValueError("Select a line or arc")
            at = [number(v) for v in req["uv"]]
            if tool == "trim":
                if e["type"] != "line":
                    raise ValueError("Trim currently supports lines only")
                trim_line(s,eid,at)
            elif tool == "split":
                OPS.split(s,eid,at)
            elif tool == "extend":
                OPS.extend(s,eid,at)
            else:
                raise ValueError("Unknown modification tool")
        elif op == "sketch_drag":
            drag_geometry(s,req,old_bad)
        elif op == "sketch_dimension_pos":
            c=next(c for c in s.constraints if c["id"]==req["id"])
            if c["type"] not in ("distance","hdistance","vdistance","radius","diameter","angle"):
                raise ValueError("Not a dimension")
            c["pos"]=[number(v) for v in req["uv"]]
        elif op == "sketch_offer_dimension":
            kind, refs = req["kind"], req["refs"]
            if len(refs) != 1 or refs[0] not in s.entities:
                raise ValueError("Select a drawn entity")
            eid = refs[0]
            typ = s.entities[eid]["type"]
            if not ((kind == "distance" and typ == "line") or
                    (kind in ("radius","diameter") and typ in ("circle","arc","ellipse"))):
                raise ValueError("Invalid drawing dimension")
            set_dimension(s,kind,[eid],req["value"],req.get("pos"))
        elif op == "sketch_dimension":
            c = next(c for c in s.constraints if c["id"] == req["id"])
            if c["type"] not in ("distance","hdistance","vdistance","radius","diameter","angle"):
                raise ValueError("This dimension cannot be edited here")
            c["value"] = dimension_value(req["value"],c["type"])
            if has_vars(str(req["value"])):c["expr"]=str(req["value"])
            else:c.pop("expr",None)
            old_bad.discard(c["id"])
        elif op == "sketch_delete":
            s.delete(req["ids"])
        elif op == "sketch_constraint":
            kind = req["kind"]
            refs = req["refs"]
            ents = s.entities
            if kind in ("horizontal","vertical","fix","coincident","point_on","midpoint",
                        "concentric","parallel","perpendicular","equal","tangent","normal","symmetric"):
                if len(refs) != len(set(refs)) or any(r not in s.points and r not in ents for r in refs):
                    raise ValueError("Invalid selection")
                if not SketchConstraintSelection(s).apply(kind, refs):
                    raise ValueError("Invalid selection for " + kind)
            elif kind in ("distance","hdistance","vdistance","radius","diameter","angle","auto"):
                set_dimension(s,kind,refs,req.get("value"),req.get("pos"))
            else:
                raise ValueError("Unsupported constraint")
        if not s.solve(weights=weights, ignore=old_bad) and set(s.status.get("bad", [])) - old_bad:
            raise ValueError("Constraint cannot be solved")
        # Build the browser geometry before recording the change. If OCP cannot
        # render a new entity, the sketch and its history must stay unchanged.
        result = sketch_view()
    except Exception:
        restore_sketch_snapshot(before)
        raise
    if sketch_snapshot() == before:
        return result
    draft["undo"].append(before)
    del draft["undo"][:-100]
    draft["redo"].clear()
    result.update(undo=True, redo=False, chain_end=chain_end)
    result["offers"] = []
    for kind, refs, label in offers:
        e = s.entities[refs[0]]
        value = math.dist(s.points[e["p1"]],s.points[e["p2"]]) if kind == "distance" else s.radius(refs[0]) * (2 if kind == "diameter" else 1)
        result["offers"].append({"kind": kind, "refs": refs, "label": label, "value": value})
    return result


def finish_sketch():
    global draft
    s = draft["sketch"]
    # Match desktop: discard an empty new sketch, but save edits to an existing one.
    if not s.entities and not draft["id"]:
        draft = None
        return
    f = copy.deepcopy(doc.feature(draft["id"])) if draft["id"] else doc.make_feature("sketch")
    f["params"].update(plane=draft["plane"],sketch=s.to_dict())
    if draft["pending_variables"]:
        def commit():
            index=draft["index"]
            feats=[]
            for params in draft["pending_variables"]:
                v=doc.make_feature("measure_value")
                v["params"].update(copy.deepcopy(params))
                v["name"]="#"+params["name"]
                feats.append(v)
            doc.checkpoint()
            doc.features[index:index]=feats
            index+=len(feats)
            if draft["id"]:
                doc.features[index]=f
                if doc.rollback is not None and doc.rollback>=draft["index"]:
                    doc.rollback+=len(feats)
            else:
                doc.features.insert(index,f)
                if doc.rollback is not None:
                    doc.rollback=index+1 if index+1<len(doc.features) else None
            doc.rebuild()
        transaction(commit)
    else:
        transaction(lambda: doc.replace_feature(f) if draft["id"] else doc.add_feature(f))
    draft = None


SOLID_KINDS=("extrude","revolve","fillet","chamfer")


def solid_base(req):
    fid=req.get("id")
    if fid:
        f=doc.feature(fid)
        if f["type"] not in SOLID_KINDS or f["type"]!=req.get("kind",f["type"]):
            raise ValueError("Invalid operation to edit")
        index=next(i for i,x in enumerate(doc.features) if x["id"]==fid)
        return doc.state_before(index),index,f
    return doc.state,doc.insert_index(),None


def ref_for_pick(state,pick,kind):
    part=state.parts[pick["part"]]
    seq=K.faces(part.shape) if kind=="face" else K.edges(part.shape)
    index=int(pick["index"])
    if not 0<=index<len(seq):
        raise ValueError("Invalid geometry selection")
    return F.make_ref(part.id,seq[index],kind,part.shape)


def target_ref(state,pick,end):
    if not pick:raise ValueError("Select end target")
    kind=pick["kind"]
    if end=="up_to_face" and kind=="face":
        return {"kind":"face","ref":ref_for_pick(state,pick,"face")}
    if end=="up_to_face" and kind=="plane":
        ref={"kind":"std","name":pick["name"]} if "name" in pick else {"kind":"plane","fid":pick["id"]}
        F.resolve_plane(state,ref)
        return {"kind":"plane","ref":ref}
    if end=="up_to_part" and kind=="part" and pick["id"] in state.parts:
        return {"kind":"part","id":pick["id"]}
    if end=="up_to_vertex" and kind=="vertex":
        part=state.parts[pick["part"]]
        pts=K.vertex_points(part.shape);i=int(pick["index"])
        if not 0<=i<len(pts):raise ValueError("Invalid vertex")
        return {"kind":"vertex","ref":F.make_vertex_ref(part.id,pts[i],part.shape)}
    if end=="up_to_vertex" and kind=="sketch_point":
        sr=state.sketches[pick["sketch"]]
        return {"kind":"vertex","ref":F.sketch_point_ref(sr,pick["sketch"],pick["point"])}
    raise ValueError("Invalid end target")


def solid_catalog(state):
    result={"sketches":{},"parts":[],"planes":[]}
    for fid,sr in state.sketches.items():
        curves=[]
        for eid,e in sr.sketch.entities.items():
            if e.get("helper") or e["type"] in ("point","text","image"):continue
            paths=[[list(map(float,sr.plane.to_world(*q))) for q in path] for path in sr.sketch.polylines(eid,64)]
            ends=OPS._ends(e)
            connected=[eid]
            if ends:
                # The native surface chain includes branches; construction/helper curves are excluded.
                todo=list(ends);seen=set()
                while todo:
                    pt=todo.pop()
                    if pt in seen:continue
                    seen.add(pt)
                    for k,v in sr.sketch.entities.items():
                        if v.get("construction") or v.get("helper"):continue
                        ee=OPS._ends(v)
                        if ee and pt in ee and k not in connected:
                            connected.append(k);todo.extend(ee)
            curves.append({"id":eid,"type":e["type"],"construction":bool(e.get("construction")),"paths":paths,"chain":connected,"ends":list(ends or [])})
        result["sketches"][fid]={"curves":curves,"points":{i:list(map(float,sr.plane.to_world(*q))) for i,q in sr.sketch.points.items()},"regions":len(sr.regions),"region_edges":[len(K.edges(f)) for f in sr.regions]}
    for p in state.parts.values():
        result["parts"].append({"id":p.id,"name":p.name,
             "faces":[{"index":i,"planar":K.planar_face_plane(f) is not None,"edges":[j for j,e in enumerate(K.edges(p.shape)) if any(e.IsSame(x) for x in K.edges(f))]} for i,f in enumerate(K.faces(p.shape))],
             "edges":[{"index":i,"axis":K.edge_line(e) is not None or "axis" in K.edge_info(e)} for i,e in enumerate(K.edges(p.shape))],
             "vertices":len(K.vertex_points(p.shape))})
    result["planes"]=list(state.planes)
    return result


def saved_solid_picks(state,p):
    """Resolve saved native references against the model BEFORE the feature."""
    missing=[]
    def pick(ref,kind):
        pid,shape=F.resolve(state,ref,kind)
        seq=K.faces(state.parts[pid].shape) if kind=="face" else K.edges(state.parts[pid].shape)
        return {"part":pid,"index":next(i for i,e in enumerate(seq) if e.IsSame(shape))}
    def region(ref):
        sr=state.sketches[ref["sketch"]]
        face=F.resolve_regions(state,[ref])[0]
        return {"sketch":ref["sketch"],"index":next(i for i,e in enumerate(sr.regions) if e.IsSame(face))}
    def target(t):
        if not t:return None
        k=t["kind"]
        if k=="part":
            if t["id"] not in state.parts:raise ValueError("Missing part")
            return {"kind":k,"id":t["id"]}
        r=t["ref"]
        if k=="face":return {"kind":k,**pick(r,"face")}
        if k=="plane":
            if r["kind"]=="std":return {"kind":k,"name":r["name"]}
            if r["kind"]=="plane":
                if r["fid"] not in state.planes:raise ValueError("Missing plane")
                return {"kind":k,"id":r["fid"]}
            if r["kind"]=="face":return {"kind":"face",**pick(r["face"],"face")}
        if k=="vertex":
            if r["kind"]=="sketch_point":
                if r["point"] not in state.sketches[r["sketch"]].sketch.points:raise ValueError("Missing point")
                return {"kind":"sketch_point","sketch":r["sketch"],"point":r["point"]}
            q=F.resolve_point(state,r)
            return {"kind":"vertex","part":r["part"],"index":min(range(len(K.vertex_points(state.parts[r["part"]].shape))),key=lambda i:math.dist(q,K.vertex_points(state.parts[r["part"]].shape)[i]))}
        raise ValueError("Unsupported saved target")
    def recover(fn,label,r):
        try:return fn(r)
        except (K.KernelError,KeyError,IndexError,ValueError,TypeError,StopIteration):
            missing.append(label);return None
    def curve(r):
        k=r["kind"]
        if k=="sketch_chain":
            sr=state.sketches[r["sketch"]]
            if r["entity"] not in sr.sketch.entities or any(x not in sr.sketch.entities for x in r.get("only",[])):raise ValueError("Missing curve")
            return {"kind":k,"sketch":r["sketch"],"entity":r["entity"],**({"only":r["only"]} if r.get("only") else {})}
        if k=="edge":return {"kind":k,**pick(r["edge"],"edge")}
        if k=="outline":return {"kind":"outline_region",**region(r["ref"])} if r["of"]=="region" else {"kind":"outline_face",**pick(r["ref"],"face")}
        if k=="region_edge":
            rr=region(r["region"]);face=F.resolve_regions(state,[r["region"]])[0];edge=F.region_edge(state,r)
            return {"kind":k,**rr,"edge":next(i for i,e in enumerate(K.edges(face)) if e.IsSame(edge))}
        raise ValueError("Unsupported saved curve")
    def axis_pick(r):
        F.resolve_axis(state,r)
        return {"kind":"edge",**pick(r["edge"],"edge")} if r["kind"]=="edge" else r
    def batch(fn,label,items):
        return [x for r in items if (x:=recover(fn,label,r)) is not None]
    return {"profiles":batch(region,"region",p.get("regions",[])),
            "faces":batch(lambda r:pick(r,"face"),"face",p.get("faces",[])),
            "curves":batch(curve,"curve",p.get("curves",[])),
            "edges":batch(lambda r:pick(r,"edge"),"edge",p.get("edges",[])),
            "scope":[i for i in (p.get("scope") or []) if i in state.parts],
            "axis":recover(axis_pick,"axis",p["axis"]) if p.get("axis") else None,
            "target":recover(target,"target",p["up_to"]) if p.get("up_to") else None,
            "target2":recover(target,"target2",p["up_to2"]) if p.get("up_to2") else None,
            "missing":missing}


def solid_context(req):
    state,index,f=solid_base(req)
    result={"catalog":solid_catalog(state),"variables":dict(state.vars),"variable_kinds":dict(state.var_kinds),"units":doc.units}
    if f:
        # Preserve the document, including the final history, while editing its earlier operation.
        result.update(params=copy.deepcopy(f["params"]),picks=saved_solid_picks(state,f["params"]),
                      meshes=state_meshes(state,doc.hidden_parts),
                      sketch_regions={fid:sketch_regions_view(sr) for fid,sr in state.sketches.items()},sketch_curves=model_sketch_curves(state))
    return result


def solid_pending(state,req):
    state=state.copy();extra=[]
    for item in req.get("new_variables",[]):
        name=str(item.get("name",""));expr=str(item.get("expr",""));kind=item.get("kind")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}",name) or name in state.vars or kind not in ("length","angle") or len(expr)>256:
            raise ValueError("Invalid new variable")
        f=doc.make_feature("measure_value",state)
        f["name"]="#"+name
        f["params"].update(name=name,expr=expr,mtype="fixed_angle" if kind=="angle" else "fixed_length",unit=doc.units,aunit="deg")
        F.RUNNERS["measure_value"](state,F.prepare(f,state))
        extra.append(f)
    return state,extra


def build_solid(req,base=None):
    kind=req["kind"]
    if kind not in SOLID_KINDS:raise ValueError("Unsupported feature")
    state,index,old=base if base is not None else solid_base(req)
    f=copy.deepcopy(old) if old else doc.make_feature(kind,state)
    p=f["params"]
    def choice(key,options,default):
        v=req.get(key,default)
        if v not in options:raise ValueError("Invalid "+key)
        return v
    def val(key,default,minval=None,angle=False):
        raw=req.get(key,default)
        if isinstance(raw,str):
            if len(raw)>256:raise ValueError("Expression too long")
            if not angle:raw=with_unit(raw,doc.units,state.var_kinds)
            why=text_problem(raw,state.vars) or check_units(raw,"angle" if angle else "length",state.var_kinds)
            if why:raise ValueError(key+": "+why)
        n=parse_number(raw,angle=angle,variables=state.vars)
        if n is None:raise ValueError("Invalid "+key)
        n=number(n,minval)
        return raw if isinstance(raw,str) and has_vars(raw) else n
    def region(pick):
        sr=state.sketches[pick["sketch"]];i=int(pick["index"])
        if not 0<=i<len(sr.regions):raise ValueError("Invalid sketch region")
        return F.region_ref(sr,pick["sketch"],sr.regions[i])
    if kind in ("extrude","revolve"):
        creation=choice("creation",("solid","surface","thin"),"solid")
        profiles=req.get("profiles",[{"sketch":req.get("sketch"),"index":i} for i in req.get("regions",[])])
        p.update(creation=creation,regions=[region(r) for r in profiles],
                 faces=[ref_for_pick(state,r,"face") for r in req.get("faces",[])],curves=[])
        for r in req.get("curves",[]) if creation!="solid" else []:
            k=r["kind"]
            if k=="sketch_chain":
                sr=state.sketches[r["sketch"]];e=sr.sketch.entities[r["entity"]]
                if e["type"] in ("point","text","image") or e.get("helper"):raise ValueError("Invalid sketch curve")
                ref={"kind":k,"sketch":r["sketch"],"entity":r["entity"]}
                if r.get("only"):
                    if any(x not in sr.sketch.entities for x in r["only"]):raise ValueError("Unknown curve")
                    ref["only"]=list(r["only"])
            elif k=="edge":ref={"kind":k,"edge":ref_for_pick(state,r,"edge")}
            elif k=="outline_region":ref={"kind":"outline","of":"region","ref":region(r)}
            elif k=="outline_face":ref={"kind":"outline","of":"face","ref":ref_for_pick(state,r,"face")}
            elif k=="region_edge":
                rr=region(r);face=F.resolve_regions(state,[rr])[0];i=int(r["edge"]);es=K.edges(face)
                if not 0<=i<len(es):raise ValueError("Invalid region edge")
                ref={"kind":k,"region":rr,"c":K.edge_info(es[i])["c"]}
            else:raise ValueError("Invalid profile curve")
            if ref not in p["curves"]:p["curves"].append(ref)
        if not (p["regions"] or p["faces"] or p["curves"]):raise ValueError("Select profiles")
        p.update(op=choice("operation",("new","add","remove","intersect"),"new"),
                 surface_op=choice("surface_op",("new","add"),"new"),flip=bool(req.get("flip")),
                 thickness=val("thickness",2,1e-8),thickness2=val("thickness2",1,0),
                 thin_side=choice("thin_side",("mid","one","other","two"),"mid"))
        p["separate"]=bool(req.get("separate")) and creation=="solid" and p["op"]=="new"
        p["separate_colors"]=bool(req.get("separate_colors")) and p["separate"]
        p["scope"]=list(dict.fromkeys(req.get("scope",[])))
        if any(x not in state.parts for x in p["scope"]):raise ValueError("Invalid merge scope")
        if kind=="extrude":
            end=choice("end",("blind","symmetric","through")+F.UP_TO,"blind")
            second=bool(req.get("second")) and end not in ("symmetric","through")
            end2=choice("end2",("blind","symmetric","through")+F.UP_TO,"blind")
            p.update(end=end,depth=val("value",25,1e-8),second=second,end2=end2,
                     depth2=val("depth2",10,1e-8),both=bool(req.get("both")),
                     draft=bool(req.get("draft")),draft_angle=val("draft_angle",3,angle=True),
                     draft2=bool(req.get("draft2")),draft_angle2=val("draft_angle2",3,angle=True))
        else:
            raw=req.get("axis","Z")
            axis={"kind":"std","name":raw} if isinstance(raw,str) else dict(raw or {})
            if axis.get("kind")=="edge":axis={"kind":"edge","edge":ref_for_pick(state,axis,"edge")}
            elif axis.get("kind")=="sketch_line":
                e=state.sketches[axis["sketch"]].sketch.entities[axis["line"]]
                if e["type"]!="line":raise ValueError("Select a straight sketch line")
            elif axis.get("kind")!="std" or axis.get("name") not in ("X","Y","Z"):raise ValueError("Invalid axis")
            F.resolve_axis(state,axis)
            angle=val("value",360,1e-8,True)
            end=choice("end",("full","one","blind","symmetric","two")+F.UP_TO,"full" if angle==360 else "one")
            angle2=val("angle2",90,1e-8,True)
            a1=parse_number(angle,angle=True,variables=state.vars);a2=parse_number(angle2,angle=True,variables=state.vars)
            if a1>360 or a2>360 or (end=="two" and a1+a2>360):raise ValueError("Invalid rotation angle")
            p.update(axis=axis,end="one" if end=="blind" else end,angle=angle,angle2=angle2,mirror_end=bool(req.get("mirror_end")))
        for suffix,active in (("",True),("2",kind=="extrude" and p.get("second"))):
            e=p.get("end"+suffix)
            p["up_to"+suffix]=target_ref(state,req.get("target"+suffix),e) if active and e in F.UP_TO and e!="up_to_next" else None
            p["offset"+suffix]=val("offset"+suffix,0) if active and e in ("up_to_face","up_to_vertex") else 0
    else:
        picks=list(req.get("edges",[]))
        for r in req.get("edge_faces",[]):
            part=state.parts[r["part"]];faces=K.faces(part.shape);i=int(r["index"])
            if not 0<=i<len(faces):raise ValueError("Invalid face")
            es=K.edges(part.shape)
            picks.extend({"part":part.id,"index":j} for j,e in enumerate(es) if any(e.IsSame(x) for x in K.edges(faces[i])))
        picks=list({(p["part"],p["index"]):p for p in picks}.values())
        if not picks:raise ValueError("Select model edges or faces")
        p["edges"]=[ref_for_pick(state,item,"edge") for item in picks]
        if kind=="fillet":p.update(radius=val("value",2,1e-8),variable=bool(req.get("variable")),radius2=val("radius2",1,1e-8))
        else:
            p.update(type=choice("chamfer_type",("equal","two","angle"),"equal"),distance=val("value",1,1e-8),
                     distance2=val("distance2",2,1e-8),angle=val("chamfer_angle",45,1e-8,True),
                     tangent=bool(req.get("tangent",True)),flip=bool(req.get("flip")))
    if req.get("name"):
        f["name"]=str(req["name"]).strip()[:128] or f["name"]
    infer_solid(state,f,req)
    return f


def infer_solid(state,f,req):
    """Same direction and contact inference used by the desktop dialog.
    Explicit user selections disable inference; commit repeats the exact calculation."""
    p=f["params"];kind=f["type"]
    if kind not in ("extrude","revolve"):return
    if req.get("auto_direction"):
        pp=F.prepare(f,state)["params"]
        side=F.up_to_side(state,kind,pp,1)
        if side:p["flip"]=side<0
        if kind=="extrude" and p.get("second"):
            cur=-1 if p.get("flip") else 1
            other=F.up_to_side(state,kind,pp,2)
            if other==cur and side!=cur:p["flip"]=not p.get("flip")
    if not req.get("auto_op") or p["creation"]=="surface" or p.get("separate"):return
    st=state.copy();before=set(st.parts)
    tool=copy.deepcopy(f);tool["params"].update(op="new",scope=[])
    try:
        F.RUNNERS[kind](st,F.prepare(tool,state))
        shapes=[pt.shape for pid,pt in st.parts.items() if pid not in before]
        touching=[pid for pid,pt in state.parts.items() if K.faces(pt.shape) and any(K.touches_or_intersects(pt.shape,t) for t in shapes)]
        p.update(op="add" if touching else "new",scope=touching)
    except (K.KernelError,ValueError,RuntimeError):
        pass


def solid_manipulators(state,f):
    p=F.prepare(f,state)["params"];kind=f["type"];out=[]
    def arrow(key,o,d,v,**kw):
        out.append({"key":key,"origin":list(map(float,o)),"dir":list(map(float,d)),"value":float(v),**kw})
    try:
        if kind in ("extrude","revolve"):
            profs=F._profiles(state,p)
            if not profs:return []
            infos=[K.face_info(x) for x in profs];area=sum(x["area"] for x in infos) or 1
            o=sum(np.asarray(x["c"])*x["area"] for x in infos)/area
            end=p["end"]
            if kind=="extrude":
                if end=="through":return []
                n=np.asarray(F._profile_normal(state,p,profs))
                if p["op"] in ("remove","intersect") and not p["regions"]:n=-n
                symmetric=end=="symmetric";flip=p["flip"];depth=p["depth"]
                if end in F.UP_TO:arrow("flip",o,n,-1 if flip else 1,screen=True,drag=False,flip=True,label=end)
                else:arrow("value",o,n,depth/2 if symmetric else -depth if flip else depth,drag=True,flip=not symmetric,factor=2 if symmetric else 1,positive=symmetric,label=str(round(depth,4))+" mm")
                if p.get("second") and end not in ("symmetric","through") and p.get("end2")=="blind":
                    arrow("depth2",o,n if flip else -n,p["depth2"],drag=True,positive=True,factor=1,label=str(round(p["depth2"],4))+" mm")
            elif end in ("one","two")+F.UP_TO:
                a,d=F.resolve_axis(state,p["axis"]);d=np.asarray(d)/np.linalg.norm(d)
                if p["flip"]:d=-d
                r=o-np.asarray(a);r-=np.dot(r,d)*d
                if np.linalg.norm(r)>1e-9:arrow("flip",o,np.cross(d,r/np.linalg.norm(r)),1,screen=True,drag=False,flip=True,label=end if end in F.UP_TO else str(round(p["angle"],4))+"°")
        elif kind=="fillet":
            pid,e=F.resolve(state,p["edges"][0],"edge")
            fr=K.fillet_frame(state.parts[pid].shape,e)
            if fr:
                o,_t,n1,n2,convex=fr
                inward=-(n1+n2) if convex else n1+n2
                half=.5*(math.pi-math.acos(max(-1,min(1,float(n1@n2)))))
                k=1/max(math.sin(half),1e-6)-1
                if k>1e-6 and np.linalg.norm(inward)>1e-9:
                    arrow("value",o,inward/np.linalg.norm(inward),p["radius"]*k,drag=True,positive=True,factor=1/k,label=str(round(p["radius"],4))+" mm")
    except (K.KernelError,KeyError,IndexError,ValueError,TypeError):return []
    return out


def preview_solid(req):
    counter=doc._counter
    try:
        base,index,old=solid_base(req)
        base,extra=solid_pending(base,req)
        f=build_solid(req,(base,index,old))
        state,error=doc.preview(f,index,extra)
        if error:
            if f["type"]=="fillet" and req.get("diagnostic"):
                outlines=[];p=F.prepare(f,base)["params"]
                for ref in p["edges"]:
                    pid,e=F.resolve(base,ref,"edge");shape=base.parts[pid].shape
                    outlines.extend({"points":np.asarray(poly).ravel().tolist(),"color":"purple"} for poly in K.fillet_outline(shape,e,p["radius"]))
                    outlines.append({"points":np.asarray(K.discretize_edge(e)).ravel().tolist(),"color":"red"})
                return {"error":str(error),"outlines":outlines,"manipulators":solid_manipulators(base,f)}
            raise ValueError(str(error))
        return {"meshes":state_meshes(state,doc.hidden_parts),"volume":sum(abs(float(K.volume(sol))) for p in state.parts.values() for sol in K.solids(p.shape)),
                "area":sum(K.face_info(face)["area"] for p in state.parts.values() for face in K.faces(p.shape)),
                "inferred":{"operation":f["params"].get("op"),"scope":f["params"].get("scope",[]),"flip":f["params"].get("flip",False)},
                "manipulators":solid_manipulators(base,f)}
    finally:doc._counter=counter


def add_solid(req):
    base,index,old=solid_base(req)
    base,extra=solid_pending(base,req)
    f=build_solid(req,(base,index,old))
    if not extra:
        transaction(lambda:doc.replace_feature(f) if old else doc.add_feature(f))
        return
    def commit():
        doc.checkpoint()
        doc.features[index:index+bool(old)]=extra+[f]
        if doc.rollback is not None and doc.rollback>=index:
            doc.rollback+=len(extra)+(0 if old else 1)
            if doc.rollback>=len(doc.features):doc.rollback=None
        doc.rebuild()
    transaction(commit)


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
    elif op == "variable":
        name=str(request["name"]).strip().lstrip("#")
        expr=str(request["expr"]).strip()
        if len(name)>64 or len(expr)>256:
            raise ValueError("Variable is too long")
        f=copy.deepcopy(doc.feature(request["id"])) if request.get("id") else doc.make_feature("variable")
        if f["type"]!="variable" and not (f["type"]=="measure_value" and f["params"].get("mtype") in MV.FIXED):
            raise ValueError("Select a fixed variable")
        f["params"].update(name=name,expr=expr)
        f["name"]="#"+name
        transaction(lambda: doc.replace_feature(f) if request.get("id") else doc.add_feature(f))
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
    elif op in ("sketch_draw","sketch_delete","sketch_constraint","sketch_drag","sketch_dimension","sketch_modify","sketch_offer_dimension","sketch_dimension_pos"):
        return sketch_edit(request)
    elif op in ("sketch_undo","sketch_redo"):
        source,target = ("undo","redo") if op=="sketch_undo" else ("redo","undo")
        if draft[source]:
            draft[target].append(sketch_snapshot())
            restore_sketch_snapshot(draft[source].pop())
        return sketch_view()
    elif op == "sketch_dimension_probe":
        c=set_dimension(draft["sketch"].copy(),request["kind"],request["refs"],None,request.get("pos"))
        return {"kind":c["type"],"value":c["value"]}
    elif op == "sketch_drag_preview":
        return drag_preview(request)
    elif op == "sketch_spline_preview":
        pts = [[number(v) for v in p] for p in request["points"]]
        if len(pts) > 128:
            raise ValueError("Too many spline points")
        return {"points": K.spline_sample(pts, bool(request.get("closed")), 24).tolist()}
    elif op == "sketch_finish":
        finish_sketch()
    elif op == "sketch_cancel":
        draft = None
    elif op == "solid_variables":
        counter=doc._counter
        try:
            base,_,_=solid_base(request)
            base,_=solid_pending(base,request)
            return {"variables":dict(base.vars),"variable_kinds":dict(base.var_kinds)}
        finally:doc._counter=counter
    elif op == "solid_context":
        return solid_context(request)
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
