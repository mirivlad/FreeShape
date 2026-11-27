"""Export the original FreeShape QPainter artwork at build time."""
import importlib.util
import pathlib
from PySide6.QtGui import QGuiApplication, QPixmap, QPainter, QColor, QPolygonF
from PySide6.QtCore import Qt, QPointF

app = QGuiApplication([])
spec = importlib.util.spec_from_file_location("freeshape_icons", "/src/freeshape/ui/icons.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
out = pathlib.Path("/site/icons")
names = "part origin plane sketch extrude revolve fillet chamfer undo redo line rect circle arc3 point construction dimension horizontal vertical parallel perpendicular equal fix coincident midpoint concentric delete fit iso finish_sketch error history folder variable hole thread shell sweep loft mirror boolean split move linear_pattern circular_pattern derived configs offset_surface thicken rib draft delete_face move_face bounding_box compound explode_part helix measure_value mate_connector sm_base sm_flange ellipse spline center_rect arc_center sk_fillet sk_chamfer trim use offset slot sk_mirror sk_lpattern sk_cpattern".split()
module.export_builtin(names, str(out), size=64)
pm = QPixmap(64, 64)
pm.fill(Qt.transparent)
p = QPainter(pm)
p.setRenderHint(QPainter.Antialiasing)
p.scale(2, 2)
p.setPen(Qt.NoPen)
p.setBrush(QColor("#3b4250"))
p.drawPolygon(QPolygonF([QPointF(7,3), QPointF(7,26), QPointF(13,20), QPointF(18,30), QPointF(22,28), QPointF(17,18), QPointF(26,18)]))
p.end()
assert pm.save(str(out / "select.png"))
for name in names + ["select"]:
    assert (out / (name + ".png")).stat().st_size > 100, name
