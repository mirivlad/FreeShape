"""Native regression for the same bridge imported by the browser worker."""
import math
import unittest

from webcad import bridge


class SketchTools(unittest.TestCase):
    def setUp(self):
        bridge.call({"op": "new"})
        bridge.call({"op": "begin_sketch", "plane": "Top"})

    def draw(self, tool, coords, **args):
        return bridge.call({"op": "sketch_draw", "tool": tool,
                            "points": [{"uv": p, "free": True} for p in coords], **args})

    def test_ellipse(self):
        result = self.draw("ellipse", [(0, 0), (20, 0), (0, 10)])
        eid, e = next((i, e) for i, e in result["draft"]["entities"].items() if e["type"] == "ellipse")
        self.assertEqual(e["r"], 10)
        self.assertEqual(len(result["regions"]), 1)
        result = bridge.call({"op": "sketch_constraint", "kind": "radius", "refs": [eid], "value": 8})
        self.assertAlmostEqual(result["draft"]["entities"][eid]["r"], 8, places=6)
        self.assertEqual(len(bridge.call({"op": "sketch_undo"})["regions"]), 1)
        self.assertAlmostEqual(bridge.call({"op": "sketch_redo"})["draft"]["entities"][eid]["r"], 8, places=6)
        bridge.call({"op": "sketch_finish"})
        self.assertFalse(bridge.doc.errors)

    def test_polygons(self):
        for tool, radius in [("polygon", 10), ("polygon_out", 10 / math.cos(math.pi / 6))]:
            with self.subTest(tool=tool):
                self.setUp()
                result = self.draw(tool, [(0, 0), (10, 0)], sides=6)
                ents = result["draft"]["entities"]
                lines = [e for e in ents.values() if e["type"] == "line"]
                self.assertEqual(len(lines), 6)
                self.assertEqual(len(result["regions"]), 1)
                self.assertFalse(result["bad"])
                pts = result["draft"]["points"]
                for line in lines:
                    self.assertAlmostEqual(math.dist(pts[line["p1"]], pts[line["p2"]]), radius, places=5)
                self.assertEqual(sum(c["type"] == "equal" for c in result["draft"]["constraints"]), 5)
                self.assertTrue(all(e["construction"] for e in ents.values() if e["type"] == "circle"))
                bridge.call({"op": "sketch_finish"})
                self.assertFalse(bridge.doc.errors)

    def test_spline(self):
        result = self.draw("spline", [(0, 0), (10, 10), (20, 0)])
        self.assertEqual(len(result["regions"]), 0)
        self.assertEqual(len(result["draft"]["entities"]), 1)
        self.assertGreater(len(next(iter(result["curves"].values()))[0]), 3)
        bridge.call({"op": "sketch_undo"})
        result = self.draw("spline", [(0, 0), (20, 0), (20, 20), (0, 20)], closed=True)
        self.assertEqual(len(result["regions"]), 1)
        bridge.call({"op": "sketch_finish"})
        self.assertFalse(bridge.doc.errors)

    def modify(self, tool, eid, uv):
        return bridge.call({"op": "sketch_modify", "tool": tool, "id": eid, "uv": uv})

    def test_trim_between_intersections(self):
        result = self.draw("line", [(0, 0), (30, 0)])
        eid = next(iter(result["draft"]["entities"]))
        self.draw("line", [(10, -5), (10, 5)])
        self.draw("line", [(20, -5), (20, 5)])
        result = self.modify("trim", eid, (15, 0))
        ents, pts = result["draft"]["entities"], result["draft"]["points"]
        self.assertEqual(len(ents), 4)
        self.assertNotIn(eid, ents)
        horizontal = sorted(tuple(sorted([pts[e["p1"]][0], pts[e["p2"]][0]]))
                            for e in ents.values() if abs(pts[e["p1"]][1]-pts[e["p2"]][1]) < 1e-6)
        self.assertEqual(horizontal, [(0, 10), (20, 30)])
        self.assertEqual(sum(c["type"] == "point_on" for c in result["draft"]["constraints"]), 2)
        self.assertEqual(len(bridge.call({"op": "sketch_undo"})["draft"]["entities"]), 3)
        self.assertEqual(len(bridge.call({"op": "sketch_redo"})["draft"]["entities"]), 4)

    def test_trim_line_against_circle(self):
        result = self.draw("line", [(0, 0), (30, 0)])
        eid = next(iter(result["draft"]["entities"]))
        self.draw("circle", [(15, 0), (15, 5)])
        result = self.modify("trim", eid, (15, 0))
        pts = result["draft"]["points"]
        intervals = sorted(tuple(sorted([pts[e["p1"]][0], pts[e["p2"]][0]]))
                           for e in result["draft"]["entities"].values() if e["type"] == "line")
        self.assertEqual(intervals, [(0, 10), (20, 30)])

    def test_split_and_extend(self):
        result = self.draw("line", [(0, 0), (10, 0)])
        eid = next(iter(result["draft"]["entities"]))
        result = self.modify("split", eid, (4, 0))
        lines = list(result["draft"]["entities"].values())
        self.assertEqual(len(lines), 2)
        self.assertEqual(lines[0]["p2"], lines[1]["p1"])
        result = bridge.call({"op": "sketch_undo"})
        self.assertEqual(len(result["draft"]["entities"]), 1)
        self.draw("line", [(20, -5), (20, 5)])
        result = self.modify("extend", eid, (9, 0))
        endpoint = result["draft"]["entities"][eid]["p2"]
        self.assertAlmostEqual(result["draft"]["points"][endpoint][0], 20, places=6)
        self.assertTrue(any(c["type"] == "point_on" for c in result["draft"]["constraints"]))

    def test_modify_failures_preserve_history(self):
        result = self.draw("line", [(0, 0), (10, 0)])
        eid = next(iter(result["draft"]["entities"]))
        before = bridge.draft["sketch"].to_dict()
        for tool, point in [("split", (0, 0)), ("extend", (9, 0))]:
            with self.assertRaises(ValueError):
                self.modify(tool, eid, point)
            self.assertEqual(bridge.draft["sketch"].to_dict(), before)
            self.assertEqual(len(bridge.draft["undo"]), 1)
        result = self.draw("circle", [(15, 15), (15, 20)])
        circle = next(i for i,e in result["draft"]["entities"].items() if e["type"] == "circle")
        with self.assertRaises(ValueError):
            self.modify("trim", circle, (15, 20))
        self.assertIn(circle, bridge.draft["sketch"].entities)

    def test_bad_inputs_roll_back(self):
        for tool, points, args in [
            ("ellipse", [(0, 0), (10, 0), (5, 0)], {}),
            ("polygon", [(0, 0), (10, 0)], {"sides": 2}),
            ("spline", [(0, 0), (0, 0)], {}),
        ]:
            with self.subTest(tool=tool):
                with self.assertRaises(ValueError):
                    self.draw(tool, points, **args)
                self.assertFalse(bridge.draft["sketch"].entities)
                self.assertFalse(bridge.draft["undo"])


if __name__ == "__main__":
    unittest.main()
