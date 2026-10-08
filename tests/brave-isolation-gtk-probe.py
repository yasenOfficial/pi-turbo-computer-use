#!/usr/bin/env python3
"""Disposable private-Xephyr GTK AT-SPI control probe; never uses the host bus."""
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, Gdk

window = Gtk.Window(title='Pi Brave isolation GTK probe')
window.set_default_size(240, 100)
window.set_accept_focus(False)
window.set_focus_on_map(False)
window.set_skip_taskbar_hint(True)
window.set_skip_pager_hint(True)
window.set_type_hint(Gdk.WindowTypeHint.UTILITY)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
entry = Gtk.Entry()
entry.get_accessible().set_name('Pi Brave GTK probe input')
button = Gtk.Button(label='Pi Brave GTK probe button')
box.pack_start(entry, False, False, 0)
box.pack_start(button, False, False, 0)
window.add(box)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
