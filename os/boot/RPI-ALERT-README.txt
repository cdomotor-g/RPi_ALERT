RPi ALERT — a Raspberry Pi base station for ALERT flood-warning telemetry
=========================================================================

This SD card runs RPi ALERT: Raspberry Pi OS Lite plus an agent that receives
ALERT and ALERT2 field-station bursts from an RTL-SDR stick, a Quansheng
UV-K5/UV-K1 radio on the ALERT receiver firmware, or an ELPRO ERT-A2, and posts
every reading to MegaNet (floodwarning.net).

Setting it up without a screen
------------------------------
1. Copy rpi-alert.conf.example (on this drive) to rpi-alert.conf and fill in at
   least the MegaNet token and the location. Or use the flasher page, which
   writes the file for you:  https://cdomotor-g.github.io/RPi_ALERT/
2. Put the card in the Pi, plug in the receivers, the network and the power.
3. Open http://rpi-alert.local/ from a computer on the same network.

With a screen
-------------
Plug in a monitor, keyboard and mouse: the dashboard comes up full screen,
and its Settings tab does everything. Unplug them when you are done.

Over SSH (PuTTY on Windows)
---------------------------
ssh <your user>@rpi-alert.local, then:   rpi-alert status   rpi-alert setup

Everything else: https://github.com/cdomotor-g/RPi_ALERT
