"""Exercise the browser bridge with the same native operations as Sketcher."""
import math
import unittest
from webcad import bridge as b

class SketchOperations(unittest.TestCase):
    def setUp(self):
        b.call({"op":"new"})
        b.call({"op":"begin_sketch","plane":"Top"})

    def draw(self,tool,ps,**kw):
        return b.call({"op":"sketch_draw","tool":tool,"points":[{"uv":p,"free":True} for p in ps],**kw})

    def operation(self,tool,**kw):
        req=dict(tool=tool,**kw)
        before=b.sketch_snapshot()
        undo=list(b.draft["undo"]);redo=list(b.draft["redo"])
        preview=b.call(dict(op="sketch_operation_preview",**req))
        self.assertEqual(b.sketch_snapshot(),before)
        self.assertEqual(b.draft["undo"],undo);self.assertEqual(b.draft["redo"],redo)
        result=b.call(dict(op="sketch_operation",**req))
        self.assertEqual(preview["draft"],result["draft"])
        self.assertFalse(result["bad"])
        self.assertEqual(len(b.draft["undo"]),len(undo)+1)
        b.call({"op":"sketch_undo"})
        self.assertEqual(b.sketch_snapshot(),before)
        r=b.call({"op":"sketch_redo"})
        self.assertEqual(r["draft"],result["draft"])
        return result

    def test_fillet_chamfer(self):
        for tool,area in [("sk_fillet",200-4+math.pi),("sk_chamfer",198)]:
            with self.subTest(tool=tool):
                self.setUp()
                r=self.draw("rect",[(10,0),(30,10)])
                pid=next(i for i,p in r["draft"]["points"].items() if p==[10,0])
                result=self.operation(tool,id=pid,value="2 mm")
                self.assertAlmostEqual(result["regions"][0]["area"],area,places=5)
                self.assertTrue(any(e.get("virtual") for e in result["draft"]["entities"].values()))
                before=b.sketch_snapshot()
                with self.assertRaises(ValueError):
                    b.call({"op":"sketch_operation","tool":tool,"id":pid,"value":100})
                self.assertEqual(b.sketch_snapshot(),before)

    def test_offset_closed_and_circle(self):
        r=self.draw("rect",[(10,0),(30,10)])
        eid=next(iter(r["draft"]["entities"]))
        r=self.operation("offset",id=eid,value=2)
        self.assertEqual(len(r["draft"]["entities"]),8)
        self.assertAlmostEqual(sum(x["area"] for x in r["regions"]),24*14,places=5)
        self.setUp()
        r=self.draw("circle",[(10,0),(15,0)])
        r=self.operation("offset",id=next(iter(r["draft"]["entities"])),value=-2)
        self.assertAlmostEqual(sum(x["area"] for x in r["regions"]),math.pi*25,places=4)
        self.assertEqual(sorted(e["r"] for e in r["draft"]["entities"].values()),[3,5])

    def test_slot_and_expression(self):
        b.draft["variables"]["width"]=4
        b.draft["variable_kinds"]["width"]="length"
        ps=[{"uv":[10,0],"free":True},{"uv":[30,0],"free":True}]
        r=self.operation("slot",points=ps,value="#width")
        self.assertEqual(len(r["draft"]["entities"]),5)
        self.assertAlmostEqual(r["regions"][0]["area"],80+4*math.pi,places=5)
        self.assertEqual(next(c for c in r["draft"]["constraints"] if c["type"]=="radius")["expr"],"(#width)*0.5")

    def test_mirror_and_patterns(self):
        for tool in ("sk_mirror","sk_lpattern","sk_cpattern"):
            with self.subTest(tool=tool):
                self.setUp()
                r=self.draw("circle",[(10,10),(12,10)])
                eid=next(iter(r["draft"]["entities"]))
                r=self.draw("line",[(0,-10),(0,20)],construction=True)
                axis=next(i for i,e in r["draft"]["entities"].items() if e["type"]=="line")
                kw=dict(ids=[eid])
                if tool=="sk_mirror":kw.update(axis=axis)
                elif tool=="sk_lpattern":kw.update(axis=axis,at=[0,20],count="3",spacing="10 mm")
                else:kw.update(centre=[0,0],count="4",angle="360")
                r=self.operation(tool,**kw)
                circles=[e for e in r["draft"]["entities"].values() if e["type"]=="circle"]
                self.assertEqual(len(circles),{"sk_mirror":2,"sk_lpattern":3,"sk_cpattern":4}[tool])
                self.assertTrue(all(abs(e["r"]-2)<1e-6 for e in circles))
                if tool=="sk_mirror":
                    self.assertTrue(any(c["type"]=="symmetric" for c in r["draft"]["constraints"]))

    def test_move_copy(self):
        r=self.draw("circle",[(10,0),(12,0)])
        eid=next(iter(r["draft"]["entities"]))
        r=self.operation("sk_transform",ids=[eid],centre=[0,0],dx=0,dy=5,angle=90)
        q=r["draft"]["points"][r["draft"]["entities"][eid]["c"]]
        self.assertAlmostEqual(q[0],0,places=5);self.assertAlmostEqual(q[1],15,places=5)
        r=self.operation("sk_copy",ids=[eid],centre=[0,0],dx=20,dy=0,angle=0)
        self.assertEqual(len(r["draft"]["entities"]),2)

    def test_failed_preview_does_not_mutate(self):
        r=self.draw("rect",[(10,0),(30,10)])
        pid=next(i for i,p in r["draft"]["points"].items() if p==[10,0])
        before=b.sketch_snapshot();undo=list(b.draft["undo"])
        for op in ("sketch_operation_preview","sketch_operation"):
            with self.assertRaises(ValueError):
                b.call({"op":op,"tool":"sk_fillet","id":pid,"value":100})
            self.assertEqual(b.sketch_snapshot(),before)
            self.assertEqual(b.draft["undo"],undo)

if __name__=="__main__":unittest.main()
