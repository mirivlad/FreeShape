"""Thin browser adapter to the original FreeShape kernel."""
import base64
import copy
import json
import math
import pathlib
import sys
import time
import traceback
import numpy as np
from freeshape import __version__, kernel as K, features as F
from freeshape.document import Document
from freeshape.sketch import Sketch
from freeshape import sketch_ops as OPS

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
    return {"vertices": vertices, "triangles": m.tris.tolist(), "area": K.face_info(face)["area"],
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


def sketch_edit(req):
    s = draft["sketch"]
    before = s.to_dict()
    old_bad = set(s.status.get("bad", []))
    weights = None
    offers = []
    chain_end = None
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
                offers.append(("distance", [eid], "Длина"))
                if (ps[1].get("ref") or {}).get("kind") != "point":
                    chain_end = b
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
                if ps[1].get("ref"):
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
            pid = req["id"]
            if pid not in s.points or pid == "origin":
                raise ValueError("Select a movable point")
            target = [number(v) for v in req["uv"]]
            # Aim for the actual cursor, not merely a weighted compromise. If
            # the exact target is constrained, fall back to the desktop-style
            # weighted solve without adding a permanent constraint.
            s.points[pid] = target
            trial = Sketch.from_dict(s.to_dict())
            pin = trial.add_constraint("fix", pid, value=target)
            trial.solve(ignore=old_bad)
            if not (set(trial.status.get("bad", [])) - old_bad) and math.dist(trial.points[pid], target) < 1e-6:
                trial.constraints.remove(pin)
                s.points = trial.points
                s.entities = trial.entities
            weights = {(pid, 0): 1e3, (pid, 1): 1e3}
        elif op == "sketch_offer_dimension":
            kind, refs = req["kind"], req["refs"]
            if len(refs) != 1 or refs[0] not in s.entities:
                raise ValueError("Select a drawn entity")
            eid = refs[0]
            typ = s.entities[eid]["type"]
            if not ((kind == "distance" and typ == "line") or
                    (kind in ("radius","diameter") and typ in ("circle","arc","ellipse"))):
                raise ValueError("Invalid drawing dimension")
            s.add_constraint(kind,eid,value=number(req["value"],1e-8))
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
            if kind in ("horizontal","vertical","fix","coincident","point_on","midpoint",
                        "concentric","parallel","perpendicular","equal","tangent","normal","symmetric"):
                if len(refs) != len(set(refs)) or any(r not in s.points and r not in ents for r in refs):
                    raise ValueError("Invalid selection")
                if not SketchConstraintSelection(s).apply(kind, refs):
                    raise ValueError("Invalid selection for " + kind)
            elif kind in ("distance","hdistance","vdistance"):
                if not ((len(refs)==1 and ents.get(refs[0],{}).get("type")=="line") or
                        (len(refs)==2 and all(p in s.points for p in refs))):
                    raise ValueError("Select one line or two points")
                s.add_constraint(kind,*refs,value=number(req["value"],1e-8))
            elif kind in ("radius","diameter"):
                if len(refs)!=1 or ents.get(refs[0],{}).get("type") not in ("circle","arc","ellipse","ellipse_arc"):
                    raise ValueError("Select a circular or elliptical curve")
                s.add_constraint(kind,*refs,value=number(req["value"],1e-8))
            else:
                raise ValueError("Unsupported constraint")
        if not s.solve(weights=weights, ignore=old_bad) and set(s.status.get("bad", [])) - old_bad:
            raise ValueError("Constraint cannot be solved")
        # Build the browser geometry before recording the change. If OCP cannot
        # render a new entity, the sketch and its history must stay unchanged.
        result = sketch_view()
    except Exception:
        draft["sketch"] = Sketch.from_dict(before)
        draft["sketch"].solve()
        raise
    if s.to_dict() == before:
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
    elif op in ("sketch_draw","sketch_delete","sketch_constraint","sketch_drag","sketch_dimension","sketch_modify","sketch_offer_dimension"):
        return sketch_edit(request)
    elif op in ("sketch_undo","sketch_redo"):
        source,target = ("undo","redo") if op=="sketch_undo" else ("redo","undo")
        if draft[source]:
            draft[target].append(draft["sketch"].to_dict())
            draft["sketch"] = Sketch.from_dict(draft[source].pop())
            draft["sketch"].solve()
        return sketch_view()
    elif op == "sketch_spline_preview":
        pts = [[number(v) for v in p] for p in request["points"]]
        if len(pts) > 128:
            raise ValueError("Too many spline points")
        return {"points": K.spline_sample(pts, bool(request.get("closed")), 24).tolist()}
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
