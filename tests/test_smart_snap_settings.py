from types import SimpleNamespace
from PySide6.QtCore import QSettings
from PySide6.QtGui import QAction
from test_nav import _window


def test_smart_snapping_menu_updates_and_restores_settings(tmp_path):
    app, w, vp = _window()
    w.settings = QSettings(str(tmp_path / "snap.ini"), QSettings.IniFormat)
    w.sketcher = SimpleNamespace()
    w._apply_snap_options()
    assert w.sketcher.snap_enabled and w.sketcher.snap_radius == 9
    actions = {a.text(): a for a in w.findChildren(QAction)}
    actions["Enable snapping"].setChecked(False)
    # Set explicitly if the action already reflected a stored disabled setting.
    w._set_snap_option("snap_enabled", False)
    assert not w.sketcher.snap_enabled
    actions["High"].trigger()
    assert w.sketcher.snap_radius == 13
    assert w.settings.value("snap_radius", type=int) == 13
    w.sketcher = SimpleNamespace()
    w._apply_snap_options()
    assert not w.sketcher.snap_enabled and w.sketcher.snap_radius == 13
    w.sketcher = None
    w.close()
