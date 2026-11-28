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
