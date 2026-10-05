RPi ALERT — a Raspberry Pi base station for ALERT flood-warning telemetry
=========================================================================

This SD card runs RPi ALERT: Raspberry Pi OS Lite plus an agent that receives
ALERT and ALERT2 field-station bursts from an RTL-SDR stick, a Quansheng
UV-K5/UV-K1 radio on the ALERT receiver firmware, or an ELPRO ERT-A2, and posts
every reading to MegaNet (floodwarning.net).

Setting it up without a screen
------------------------------
1. Copy rpi-alert.conf.example (on this drive) to rpi-alert.conf and fill in at
   least the base station's name and the location. Or use the flasher page,
   which writes the file for you:  https://cdomotor-g.github.io/RPi_ALERT/
2. Put the card in the Pi, plug in the receivers, the network and the power.
3. The Pi asks MegaNet for its ingest token (request_token = yes). On a phone
   signed in to MegaNet as an administrator: Admin -> Ingest tokens -> Waiting
   for approval -> Approve. The code it shows is also on the Pi's web page.
4. Open http://rpi-alert.local/ from a computer on the same network.

With a screen
-------------
Plug in a monitor, keyboard and mouse: the dashboard comes up full screen,
and its Settings tab does everything. With no token yet, press "Request a
token" and scan the QR code it shows with a phone signed in to MegaNet as an
administrator, then press Approve there. Unplug them when you are done.

Over SSH (PuTTY on Windows)
---------------------------
ssh alert@rpi-alert.local with an SSH key you put on the card (ssh_key = ...
in rpi-alert.conf), or ssh <your user>@rpi-alert.local, then:
    rpi-alert status   rpi-alert setup   rpi-alert access
No token yet?   rpi-alert request-token   (shows a code and a QR code to approve)
ssh = on turns the SSH server on but makes no user. A password login needs
the user and password set in Raspberry Pi Imager's customisation (the
rpi-alert.conf the flasher page writes does not make one); otherwise log in
as alert with a key (ssh_key, ssh_github) or set alert_password. If SSH did
not start, rpi-alert-boot.log on this drive says why.

Nobody can log in?
------------------
Put a line   alert_password = something-long   in rpi-alert.conf on this drive,
boot the Pi, and log in as alert at its console. The password is removed from
the card once applied. (Or add your key:  ssh_key = ssh-ed25519 AAAA...)

Everything else: https://github.com/cdomotor-g/RPi_ALERT
