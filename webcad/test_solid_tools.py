"""Web adapter integration tests against real OpenCascade shapes."""
import math
import unittest
from webcad import bridge as b
from freeshape import kernel as K

class SolidTools(unittest.TestCase):
    def setUp(self):
        b.call({"op":"new"})

    def sketch(self,tool,points):
        b.call({"op":"begin_sketch","plane":"Top"})
        r=b.call({"op":"sketch_draw","tool":tool,"points":[{"uv":p,"free":True} for p in points]})
        b.call({"op":"sketch_finish"})
        return b.doc.features[-1]["id"],r

    def op(self,kind,**kw):
        return b.call({"op":"solid","kind":kind,**kw})

    def preview(self,kind,**kw):
        before=b.doc.to_json();undo=len(b.doc._undo);counter=b.doc._counter
        r=b.call({"op":"solid_preview","kind":kind,**kw})
        self.assertEqual(b.doc.to_json(),before)
        self.assertEqual(len(b.doc._undo),undo)
        self.assertEqual(b.doc._counter,counter)
        return r

    def test_extrude_end_modes_and_edit(self):
        sid,_=self.sketch("rect",[(10,0),(30,10)])
        kw=dict(sketch=sid,regions=[0],value=5)
        self.assertAlmostEqual(self.preview("extrude",**kw,end="symmetric")["volume"],1000,places=5)
        self.assertAlmostEqual(self.preview("extrude",**kw,second=True,depth2=7)["volume"],2400,places=5)
        self.assertLess(self.preview("extrude",**kw,draft=True,draft_angle=5)["volume"],1000)
        self.op("extrude",**kw)
        fid=b.doc.features[-1]["id"]
        ctx=b.call({"op":"solid_context","kind":"extrude","id":fid})
        self.assertEqual(ctx["picks"]["profiles"],[{"sketch":sid,"index":0}])
        self.assertFalse(ctx["meshes"])
        self.op("extrude",**{**kw,"value":10},id=fid,end="symmetric")
        self.assertEqual(b.doc.features[-1]["id"],fid)
        self.assertAlmostEqual(K.volume(next(iter(b.doc.state.parts.values())).shape),2000,places=5)
        b.call({"op":"undo"})
        self.assertEqual(b.doc.features[-1]["params"]["depth"],5)

    def test_thin_surface_open_curve_and_revolve(self):
        sid,r=self.sketch("line",[(10,0),(10,20)])
        eid=next(iter(r["draft"]["entities"]))
        curves=[{"kind":"sketch_chain","sketch":sid,"entity":eid,"only":[eid]}]
        kw=dict(curves=curves,value=5,creation="surface")
        p=self.preview("extrude",**kw)
        self.assertAlmostEqual(p["area"],100,places=4)
        self.assertAlmostEqual(self.preview("extrude",**{**kw,"creation":"thin"},thickness=2)["volume"],200,places=4)
        p=self.preview("revolve",**{**kw,"value":360},axis="Y",end="full")
        self.assertAlmostEqual(p["area"],400*math.pi,places=3)
        p=self.preview("revolve",**{**kw,"creation":"thin","value":360},axis="Y",end="full",thickness=2)
        self.assertAlmostEqual(p["volume"],800*math.pi,places=3)

    def test_revolve_sketch_axis_and_two_ends(self):
        sid,r=self.sketch("rect",[(10,0),(20,10)])
        b.call({"op":"begin_sketch","id":sid})
        r=b.call({"op":"sketch_draw","tool":"line","construction":True,"points":[{"uv":[0,-5]},{"uv":[0,15]}]})
        eid=next(i for i,e in r["draft"]["entities"].items() if e.get("construction"))
        b.call({"op":"sketch_finish"})
        axis={"kind":"sketch_line","sketch":sid,"line":eid}
        kw=dict(sketch=sid,regions=[0],axis=axis)
        full=self.preview("revolve",**kw,value=360,end="full")["volume"]
        self.assertAlmostEqual(full,3000*math.pi,places=4)
        self.assertAlmostEqual(self.preview("revolve",**kw,value=45,angle2=45,end="two")["volume"],full/4,places=4)
        self.op("revolve",**kw,value=90,end="symmetric")
        ctx=b.call({"op":"solid_context","kind":"revolve","id":b.doc.features[-1]["id"]})
        self.assertEqual(ctx["picks"]["axis"],axis)

    def test_model_face_and_up_to_vertex(self):
        b.call({"op":"demo"})
        part=next(iter(b.doc.state.parts.values()))
        faces=K.faces(part.shape)
        top=next(i for i,f in enumerate(faces) if abs(K.face_info(f)["c"][2]-10)<1e-6)
        pts=K.vertex_points(part.shape)
        v=next(i for i,p in enumerate(pts) if abs(p[2]-10)<1e-6)
        p=self.preview("extrude",sketch=b.doc.features[0]["id"],regions=[0],value=10,end="up_to_vertex",target={"kind":"vertex","part":part.id,"index":v},offset=2)
        self.assertAlmostEqual(p["volume"],21600,places=4)
        p=self.preview("extrude",faces=[{"part":part.id,"index":top}],value=5,operation="add")
        self.assertAlmostEqual(p["volume"],18000,places=4)

    def test_fillet_chamfer_and_edit(self):
        b.call({"op":"demo"})
        part=next(iter(b.doc.state.parts.values()))
        pick={"part":part.id,"index":0}
        for mode,opts in [("fillet",{"variable":True,"radius2":.5}),("chamfer",{"chamfer_type":"two","distance2":.5,"tangent":False}),("chamfer",{"chamfer_type":"angle","chamfer_angle":30,"tangent":False})]:
            r=self.preview(mode,edges=[pick],value=1,**opts)
            self.assertLess(r["volume"],12000)
            self.assertGreater(r["volume"],11000)
        self.op("chamfer",edges=[pick],value=1)
        f=b.doc.features[-1]
        ctx=b.call({"op":"solid_context","kind":"chamfer","id":f["id"]})
        self.assertEqual(ctx["picks"]["edges"],[pick])
        self.op("chamfer",id=f["id"],edges=[pick],value=.5)
        self.assertEqual(b.doc.features[-1]["id"],f["id"])
        self.assertEqual(b.doc.features[-1]["params"]["distance"],.5)

if __name__=="__main__":unittest.main()
