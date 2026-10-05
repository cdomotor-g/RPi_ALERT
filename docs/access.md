# Getting in: SSH access that outlives the person who set it up

## The problem

Raspberry Pi Imager asks whoever writes the card for a user name and a password. A year later
that person has moved on, nobody knows either, and the base station on the hill can only be
reached by driving to it with a screen and a keyboard. The obvious fix — one user name and
password for every base station — is worse than the problem: one leak opens every Pi, it can
never be changed everywhere at once, and nobody who leaves can be shut out without shutting
everybody out.

## What RPi ALERT does instead

| | |
|---|---|
| **One user name, everywhere** | Every RPi ALERT has the same maintenance account, **`alert`**, made by the installer. Nobody has to remember which name was chosen on which Pi. |
| **No password** | `alert` has no password at all — it logs in with SSH keys only, and may use `sudo`. There is nothing to forget, write on a sticker or pass on. |
| **Keys are people** | The keys that open it are a list each Pi shows (`rpi-alert access`, the web page's *Settings → SSH access*, MegaNet's Base Stations tab): one key per person, each with where it came from. Someone leaves: take their key off the list, and only theirs. |
| **The list is a team's, not a person's** | It can follow the GitHub accounts a team names, or MegaNet's team keys — so when someone joins or leaves, every base station that follows that list follows within the hour, without anyone visiting it. |
| **Fetched keys stay local** | Keys fetched from GitHub or MegaNet only work from a private network — the site's LAN or a VPN — unless the card says otherwise, so a Pi that ends up with a public address is not opened to the internet by a list somebody else keeps. |
| **A way back in, always** | Whoever holds the SD card holds the Pi. `alert_password = …` in `rpi-alert.conf` on the card gives `alert` a password for the console. It is wiped from the card once applied. |
| **Nothing new to run** | No server, no vault, no MegaNet account needed: a Pi that never talks to MegaNet does all of this from the SD card and GitHub. |

The account Raspberry Pi Imager made is left exactly as it was: its password and its own
`~/.ssh/authorized_keys` still work. RPi ALERT only adds `alert` beside it.

## Where keys come from

| Source | How it gets there | Works from |
|---|---|---|
| **The SD card** | `ssh_key = ssh-ed25519 AAAA… you@laptop` in `rpi-alert.conf` (a line each; the set-up page writes them). The card's lines replace the ones before; `ssh_key = none` clears them. | anywhere |
| **sudo on the Pi** | `sudo rpi-alert access add-key "ssh-ed25519 AAAA… you@laptop"`, `sudo rpi-alert access remove-key SHA256:…` | anywhere |
| **GitHub accounts** | `ssh_github = alice, bob` on the card, or `sudo rpi-alert access github alice bob`. Their public keys (`github.com/<name>.keys`) are fetched every hour. | private networks |
| **MegaNet's team keys** | `ssh_meganet_keys = yes` on the card, or *Settings → SSH access* on the Pi's page. MegaNet's administrators keep the list (public keys only) on its Base Stations tab; a Pi that takes it fetches it hourly, and within a minute of a change while it is checking in. | private networks |

"Private networks" means 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (carrier-grade
NAT, which Tailscale uses), link-local and loopback, and their IPv6 counterparts. `ssh_from = any`
on the card (or *Settings → SSH access*) lets fetched keys work from anywhere.

**Keys never arrive through the web page or a MegaNet request.** Only root writes the list — the
SD card's import at boot, `sudo rpi-alert access`, and `rpi-alert-access.service` fetching the
lists named in a policy only root can change. The agent (an unprivileged user facing the network)
may ask for a fetch, turn MegaNet's list on or off, and set password login and where fetched keys
work from; it can never put a key of its choosing on the list. So neither the web page's password
nor a fault in the agent is ever a way to a shell, and MegaNet is never told a secret of the Pi's —
it holds public keys, and the Pi fetches them.

## Day to day

```sh
ssh alert@mt-stuart-base.local                  # with a key on the list
rpi-alert access                                # who may log in, and how
sudo rpi-alert access add-key "ssh-ed25519 AAAA… jo@laptop"
sudo rpi-alert access remove-key SHA256:VeBIQNSQYe0G   # the start of a fingerprint will do
sudo rpi-alert access github alice bob          # or: none
rpi-alert access meganet on                     # MegaNet's team keys (off by default)
rpi-alert access password-login off             # keys only (refused while no account has a key)
rpi-alert access from private                   # or any
rpi-alert access sync                           # fetch the lists now
```

Making a key, if you have none: `ssh-keygen -t ed25519` (Windows 10 and later have it too, in
PowerShell). The public half is `~/.ssh/id_ed25519.pub` — that one line is what goes on the list.
PuTTY users: PuTTYgen → *Generate*, and copy the box marked *Public key for pasting into OpenSSH
authorized_keys file*.

## When nobody can get in

1. Shut the Pi down (or pull the power), take the SD card out and put it in any computer.
2. On its **bootfs** drive (the one with `config.txt`), make a file `rpi-alert.conf` with
   ```
   alert_password = something-long-you-will-change
   ssh_key = ssh-ed25519 AAAA… you@laptop
   ```
   (either line will do).
3. Put the card back and power up. Log in as `alert` at the console, or with your key over SSH.
   The password is wiped from the card as it is applied (`rpi-alert-boot.log` says what was done).
4. Once your key works, `sudo rpi-alert access alert-password --none` takes the password away
   again, and `sudo passwd <user>` resets the Imager user's if you need it.

## Password login

`ssh_password_login` decides whether SSH accepts passwords at all (`PasswordAuthentication`):

- absent (`unchanged`) — as Raspberry Pi Imager set it up;
- `off` — keys only. Refused while no account has a key, which would shut everybody out;
- `on` — passwords accepted.

The console always takes a password, for an account that has one.

## How it is built

| Piece | |
|---|---|
| `alert` | A system account (so Imager's user still gets user id 1000) with a login shell, no password (`*`: not one that can be typed, and not a locked account, which sshd would refuse even with a key), groups `adm systemd-journal dialout plugdev video audio`, and `/etc/sudoers.d/rpi-alert-maint` (`NOPASSWD`, since it has no password to ask for). |
| `/etc/ssh/rpi-alert/` | Root's: `policy.json` (GitHub accounts, MegaNet's list on or off, where fetched keys work from, password login), `local.keys` (the SD card's and sudo's), and `alert.keys`, the list sshd reads — written from all three. Outside `/etc/rpi-alert`, which the agent owns: sshd refuses a key file in a directory another user could write to. |
| `/etc/ssh/sshd_config.d/10-rpi-alert.conf` | `AuthorizedKeysFile .ssh/authorized_keys .ssh/authorized_keys2 /etc/ssh/rpi-alert/%u.keys` — every account keeps its own file; `alert`'s comes from the list — and `PasswordAuthentication` when the policy sets it. Written only if `sshd -t` accepts the whole configuration with it; the one before is put back otherwise. |
| `rpi-alert-access` | The root helper that does all of it (`agent/bin/rpi-alert-access`, `agent/lib/access.js`). Keys are checked the way OpenSSH reads them: Ed25519, ECDSA and security keys, RSA of 2048 bits or more; anything with options in front is refused, since options are the helper's to add. |
| `rpi-alert-access.timer` | Hourly (spread over ten minutes), and three minutes after boot: fetches the GitHub and MegaNet lists. The last good copy of each is kept in `/var/lib/rpi-alert-access/`, so a network outage removes nobody; an answer that the source no longer has it does — a GitHub account that is gone, or MegaNet refusing the Pi's token. |
