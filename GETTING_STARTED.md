# Getting Started with WordLight

This guide takes you from a box of parts to live captions on audience
phones. It is written for a theater with no IT person: you don't need to
know Linux, and every command you type is shown in full. If you already
know your way around a Raspberry Pi, the shorter version is in
[README.md](README.md#setup-script-easiest).

**What you'll end up with:** a small computer (a Raspberry Pi) on your
theater's Wi-Fi network. Your caption operator runs the show from a laptop
or tablet, and audience members scan a QR code to read the captions on
their own phones. Nothing gets installed on anyone's phone.

**How long it takes:** the setup script itself (step 6) took about 12
minutes on Des Moines Community Playhouse's Raspberry Pi 3, answering the
questions included. That Pi already had some of the system packages, so
a blank card takes a little longer. Writing the card, the first start
and the system update (steps 2 to 4) add their own time, mostly waiting,
which depends on your card and your internet speed. The optional extras
and the Script Converter come on top.

**What you need to know:** how to download and install a program on your
own computer, and how to copy and paste. That's it.

## Contents

1. [What you need](#1-what-you-need)
2. [Put Raspberry Pi OS on the microSD card](#2-put-raspberry-pi-os-on-the-microsd-card)
3. [Start the Pi and log in from your computer](#3-start-the-pi-and-log-in-from-your-computer)
4. [Update the system](#4-update-the-system)
5. [Setting a Static IP](#5-setting-a-static-ip)
6. [Install WordLight](#6-install-wordlight)
7. [Try it out](#7-try-it-out)
8. [Make it yours](#8-make-it-yours)
9. [Optional extras](#9-optional-extras)
10. [Later on: the setup menu](#10-later-on-the-setup-menu)
11. [Write these down](#11-write-these-down)
12. [Show-day checklist](#12-show-day-checklist)
13. [When something goes wrong](#13-when-something-goes-wrong)

### Reading the commands in this guide

Commands appear in grey boxes like this one:

```bash
hostname -I
```

Type them (or copy and paste them) into the terminal window, then press
**Enter**. A few things that surprise people the first time:

- **Passwords don't show while you type them.** No dots, no stars,
  nothing. That's normal. Type the password and press Enter.
- **`sudo`** at the start of a command means "do this as the
  administrator". The first time, it asks for *your* login password.
- **Words in capitals that you replace** are written like `ADDRESS`. If a
  command says `ssh wordlight@ADDRESS` and your Pi's address is
  `192.168.1.50`, you type `ssh wordlight@192.168.1.50`.
- **To stop a command** that keeps running, press **Ctrl+C**.
- **Pasting into the terminal:** on a Mac, ⌘V. In Windows PowerShell or
  Terminal, Ctrl+V or a right-click.

---

## 1. What you need

### Shopping list

<!-- photo: docs/images/shopping-list.jpg -->

| Item | Notes |
|---|---|
| **Raspberry Pi 3B, 3B+, 4 or 5** | A Pi 4 or 5 is faster if you'll use the Script Converter. The 512 MB boards (Pi 3A+ and Zero 2 W) will probably run WordLight, but haven't been tested, can't run the Script Converter and have no Ethernet socket. The Pi 1, Pi 2, Zero and Zero W can't run WordLight. See [Hardware requirements](README.md#hardware-requirements). |
| **The official power supply for that Pi** | Pi 3: micro-USB, 5 V 2.5 A. Pi 4: USB-C, 5 V 3 A. Pi 5: USB-C, 5 V 5 A. A weak phone charger makes a Pi slow down or crash. |
| **microSD card, 16 GB or more** | A name brand, marked A1 or A2. 8 GB is the bare minimum. |
| **A case** | Any case for your Pi model. |
| **Ethernet cable** | From the Pi to your Wi-Fi router. Ethernet is more reliable than the Pi's own Wi-Fi. |
| **A Wi-Fi router or access point for the audience** | Big enough for the number of phones you expect. Don't use the Pi's own Wi-Fi as the hotspot: it only handles about 8 devices. |
| **A laptop or tablet for the caption operator** | Any current web browser. |
| **A computer with an SD card reader** | To set up the card (step 2). A USB card reader works. |
| Optional: **a small UPS** | Keeps the Pi running through a power blip and protects the SD card. |
| Optional: **an OLED display with 4 buttons** | Shows the Pi's address and QR codes. See [OLED status display](#oled-status-display). |

### Not using a Raspberry Pi?

Any old laptop or mini PC with a 64-bit Intel/AMD or ARM processor works
too, running **Ubuntu Server 24.04** (tested) or Debian. Everything in
this guide applies except the Pi-only parts (the OLED display and the
Wi-Fi country). Instead of step 2:

1. Install Ubuntu Server from [ubuntu.com/download/server](https://ubuntu.com/download/server).
2. When the installer asks, tick **Install OpenSSH server**.
3. On the installer's network screen you can give it a fixed address
   right away (see [Option 3](#option-3-ubuntu-server-and-other-debian-computers)).
4. Then carry on from [step 3](#3-start-the-pi-and-log-in-from-your-computer),
   using the user name and computer name you chose in the installer.

A Mac can run WordLight too (by hand, without the setup script). See
[Hardware requirements](README.md#hardware-requirements).

---

## 2. Put Raspberry Pi OS on the microSD card

<!-- photo: docs/images/sd-card-slot.jpg -->

You'll use **Raspberry Pi Imager**, the official free tool. It copies the
operating system onto the card and sets the Pi up so you can reach it
over the network. No keyboard or screen on the Pi is needed.

1. Download Raspberry Pi Imager from
   [raspberrypi.com/software](https://www.raspberrypi.com/software/) and
   install it (Mac, Windows or Linux).
2. Put the microSD card in your computer's card reader. **Everything on
   the card will be erased.**
3. Open Imager and work through its steps:
   - **Device:** your Pi model (for example Raspberry Pi 3).
   - **Operating system:** choose **Raspberry Pi OS (other)**, then
     **Raspberry Pi OS Lite (64-bit)**. "Lite" means no desktop, which a
     server doesn't need. It must be the **64-bit** one.
   - **Storage:** your microSD card. Check the size, so you don't erase
     the wrong drive.
4. Imager then asks how to set up the system. Fill these in; don't skip
   them, or you won't be able to log in over the network:
   - **Hostname:** `wordlight`. You'll reach the Pi as `wordlight.local`.
     (Lower-case letters, numbers and hyphens only.)
   - **Localisation:** your capital city, time zone and keyboard.
   - **User:** user name `wordlight` and a password you'll remember.
     This guide uses `wordlight` throughout; if you pick another name, use
     yours wherever you see `wordlight@`.
   - **Wi-Fi:** leave it empty if the Pi will use Ethernet (recommended).
     If it must use Wi-Fi, enter your network's name and password here.
   - **Remote access (SSH):** turn SSH **on** and choose **Use password
     authentication**.
   - **Raspberry Pi Connect:** leave it off; WordLight doesn't use it.
5. Write the card. Imager warns that the card will be erased, then copies
   and checks the system. It takes a few minutes. When it says it's
   finished, take the card out.

---

## 3. Start the Pi and log in from your computer

1. Put the microSD card into the Pi (on a Pi 3 the slot is underneath, at
   the end opposite the USB sockets).
2. Plug the Ethernet cable into the Pi and into your Wi-Fi router.
3. Plug in the power supply last. There's no power switch: the Pi starts
   as soon as it has power.
4. **Wait about 5 minutes.** The first start takes longer than later ones,
   and the Pi may restart itself once while it sets up.

Your computer must be on the same network as the Pi (the same Wi-Fi
router).

### Log in from a Mac

Open **Terminal** (in Applications → Utilities) and type:

```bash
ssh wordlight@wordlight.local
```

### Log in from Windows

Windows 10 and 11 have the same command built in. Open **PowerShell** or
**Terminal** from the Start menu and type:

```bash
ssh wordlight@wordlight.local
```

If Windows says `ssh` isn't recognized, add **OpenSSH Client** under
**Optional features** in Settings (type "optional features" in the
Settings search box), then open a new PowerShell window.

### The first time you connect

ssh asks something like *"The authenticity of host 'wordlight.local'
can't be established… Are you sure you want to continue connecting?"*.
Type `yes` and press Enter. (It asks this once per Pi.) Then type the
password you set in Imager. When you see a line ending in `$`, you're
logged in to the Pi, and everything you type now runs on the Pi.

To log out, type `exit`.

### If `wordlight.local` isn't found

Some computers and some networks don't handle `.local` names. Use the
Pi's address (four numbers like `192.168.1.50`) instead:

- **Your router's list of connected devices:** log in to the router's
  admin page (its address is usually on a label on the router) and look
  for a device called `wordlight`.
- **On a Mac:** `ping -c 3 wordlight.local` sometimes works when ssh
  doesn't; the address is in brackets.
- **On Windows:** `ping -4 wordlight.local`.

Then log in with the address: `ssh wordlight@192.168.1.50` (your numbers).

---

## 4. Update the system

The card has the system as it was when Imager downloaded it. Bring it up
to date first (on a Pi 3 this can take a while, depending on how much has
changed since):

```bash
sudo apt update && sudo apt full-upgrade -y
```

Then restart the Pi:

```bash
sudo reboot
```

Your ssh connection closes. Wait a minute, then log in again as in step 3.

---

## 5. Setting a Static IP

Phones find WordLight by the Pi's address, and the QR code you print
contains it. Normally the router hands out addresses and may give the Pi
a different one next week, which breaks every printed QR code. So give
the Pi an address that never changes. You can do this now or after
installing WordLight (the setup script reminds you).

First, find the Pi's current address and its network connections:

```bash
ip -br addr
```

You'll see lines like `eth0  UP  192.168.1.73/24 …`. `eth0` is the
Ethernet socket and `wlan0` the Wi-Fi; the number before the `/` is the
address. (The setup script shows a shorter version of this list.)

### Option 1: reserve the address in your router (recommended)

This keeps every setting on the Pi as it is: the router simply always
gives the Pi the same address. Nothing can go wrong on the Pi, and it
works the same on every kind of computer.

1. Find the Pi's **hardware address** (MAC address):

   ```bash
   ip -br link
   ```

   On the `eth0` line (or `wlan0` if the Pi uses Wi-Fi), it's the part
   that looks like `b8:27:eb:12:34:56`.
2. Log in to your router's admin page (its address and login are usually
   on a label on the router, often `192.168.1.1` or `192.168.0.1`).
3. Look for **DHCP reservation**. Routers call it different things:
   *Address reservation*, *Static lease*, *Fixed IP*, *Reserved IP*. It's
   usually under LAN or DHCP settings. Many routers let you pick the Pi
   from the list of connected devices; otherwise type in the hardware
   address from step 1.
4. Keep the address the Pi has now, or choose another that the router
   allows. Save.
5. Restart the Pi (`sudo reboot`), log in again and check with
   `hostname -I` that it has the reserved address.

If you take the Pi to another venue, that venue's router needs its own
reservation.

### Option 2: set it on the Raspberry Pi

<!-- CHECK ON A REAL PI before 1.0.0: connection names and that the
     setting survives a reboot on Raspberry Pi OS Trixie (netplan). -->

Use this if you can't change the router's settings. You need three
things, all from the router's admin page or whoever runs the network:

- **An address for the Pi that's outside the router's automatic range.**
  If the router hands out `192.168.1.100` to `192.168.1.199`, choose
  something like `192.168.1.50`. An address inside that range could be
  given to a phone as well, and then neither works.
- **The router's address** (the "gateway"), often `192.168.1.1`.
- **A DNS server:** the router's address almost always works.

The Pi will move to its new address while you're logged in, so your
connection will freeze. That's expected: log in again at the new address.
If anything goes wrong, a keyboard and screen plugged into the Pi always
work, so it's best to have them nearby.

1. List the Pi's network connections:

   ```bash
   nmcli -f NAME,DEVICE,TYPE connection show
   ```

   On current Raspberry Pi OS, the Ethernet one is called `netplan-eth0`
   (older versions: `Wired connection 1`), and a Wi-Fi one
   `netplan-wlan0-` followed by the network's name. A connection added
   some other way may have any name. Use the name in the row whose DEVICE
   is `eth0` (or `wlan0` if the Pi uses Wi-Fi); rows showing `--` aren't
   in use right now.
2. Set the address, gateway and DNS server **in one command** (all on one
   line; replace the three addresses, and the connection name if yours
   differs). The `/24` stays as it is: it's right for almost every home
   and venue network.

   ```bash
   sudo nmcli connection modify "netplan-eth0" ipv4.method manual ipv4.addresses 192.168.1.50/24 ipv4.gateway 192.168.1.1 ipv4.dns 192.168.1.1
   ```

3. Switch to the new address:

   ```bash
   sudo nmcli connection up "netplan-eth0"
   ```

4. Your connection freezes. Close the window, open a new one and log in
   at the new address: `ssh wordlight@192.168.1.50`. Restart the Pi once
   (`sudo reboot`) and check with `hostname -I` that the address stays.

There's also a menu-based tool for the same setting: `sudo nmtui`, then
**Edit a connection**.

**To go back to automatic addresses:**

```bash
sudo nmcli connection modify "netplan-eth0" ipv4.method auto ipv4.addresses "" ipv4.gateway "" ipv4.dns ""
sudo nmcli connection up "netplan-eth0"
```

### Option 3: Ubuntu Server and other Debian computers

The easiest moment is during the Ubuntu Server installation: on the
network screen, choose the connection, **Edit IPv4**, **Manual**, and fill
in the same three things as in Option 2, plus the **subnet**: the
address with its last number replaced by 0 and `/24` added (for
`192.168.1.50`, that's `192.168.1.0/24`).

To do it afterwards, find the connection name with `ip -br addr` (for
example `enp1s0`), then make a settings file:

```bash
sudo nano /etc/netplan/99-wordlight-static.yaml
```

Type this in, with your connection name and addresses. The spaces at the
start of each line matter (use spaces, not Tab):

```yaml
network:
  version: 2
  ethernets:
    enp1s0:
      dhcp4: false
      addresses: [192.168.1.50/24]
      routes:
        - to: default
          via: 192.168.1.1
      nameservers:
        addresses: [192.168.1.1]
```

Save with **Ctrl+O**, Enter, and leave nano with **Ctrl+X**. Then:

```bash
sudo chmod 600 /etc/netplan/99-wordlight-static.yaml
sudo netplan apply
```

As in Option 2, your connection freezes if the address changed: log in
again at the new one.

---

## 6. Install WordLight

### Download it

Log in to the Pi, then:

```bash
sudo apt install -y git
cd ~
git clone https://github.com/traisjames/WordLight.git wordlight
```

(The first line makes sure `git` is there; if it already is, it just says
so.)

**No internet on this Pi?** On another computer, download WordLight from
[github.com/traisjames/WordLight](https://github.com/traisjames/WordLight)
(green **Code** button → **Download ZIP**). Copy it to the Pi from your
computer's terminal (not the Pi's), with the colon at the end:

```bash
scp WordLight-main.zip wordlight@wordlight.local:
```

Then, on the Pi:

```bash
cd ~
unzip WordLight-main.zip && mv WordLight-main wordlight
```

The first install still needs the internet for system packages and
Node.js, so the zip route is mainly for updating later.

### Run the setup script

```bash
cd ~/wordlight
./setup/setup.sh
```

Run it exactly like that, **without** `sudo` in front. It asks for your
login password at the start, for the steps that need it (and again if a
step took a long time).

The setup works through about a dozen steps, explaining each one, and
asks questions along the way. You can stop it at any point with Ctrl+C
and run it again later: it skips what's already done.

### The questions it asks

Answers in square brackets, like `[admin]` or `[y/N]`, are the defaults:
press Enter to accept them. A capital letter (`N` in `[y/N]`) is the
default for yes/no questions.

| Question | What to answer |
|---|---|
| Your login password | The password you set in Imager. Nothing shows while you type. |
| **Time zone** | Pick its number, or press Enter if the time shown is already right (Imager may have set it). The logs and the Script Converter's night hours use this clock. |
| **Wi-Fi country** (Pi only) | Your two-letter country code, such as `US` or `GB`. |
| **OLED display** | `n`, unless you've wired one up. If you say yes, the setup stops and asks you to restart the Pi (`sudo reboot`). Log in again and run `cd ~/wordlight && ./setup/setup.sh`: it carries on where it stopped. |
| **Your theater's name** | Shown on the audience screens. |
| **Support email** (optional) | Shown as a contact link on the home page, which anyone who scans your QR code can see. Leave it empty for no link. |
| **Admin username** and **password** | The login for the caption controller, the editor and the usage log. Choose a strong password and write it down. |
| **Use ports 80/443?** | `n` (keep the default 3000/3443). |
| **Editor login** | `y` gives script volunteers their own login that opens only the editor and the Scripts folder, never the controller. Its password must differ from the admin password. |
| **Ethernet or WiFi?** | Which one the Pi uses. The setup then points you to [Setting a Static IP](#5-setting-a-static-ip) and lists the Pi's connections. It never changes the network itself. |
| **Change this computer's name?** | `n` if you named it in Imager. |
| **Scripts folder** and the **name to show for it** | Press Enter twice for the defaults: `~/Scripts`, shown as "CC Storage". This is where caption files are kept. |
| **Share the Scripts folder on the network?** | `y` lets you copy files to and from the Pi like a shared drive (see [Network shares](#network-shares)). |
| **Let anyone READ the share without a password?** | `n`. Audience phones are on the same Wi-Fi, and could otherwise copy whole scripts. |
| **Samba passwords** | Passwords for the network shares, each typed twice: one for your login (all shares) and one for `WordMaker`, an account for script volunteers (the Scripts share only). |
| **Login welcome message** | `2` (system information when you log in) is fine. `1` adds a message with your name and email for whoever logs in next. |
| **Start WordLight after every reboot?** | `y`. |
| **Install the Script Converter?** | `n` for now, unless you want it (see [Script Converter](#script-converter)). You can add it later from the menu. |
| **Offline caption network?** | `n`, unless the audience Wi-Fi has no internet (see [Offline caption network](#offline-caption-network)). |

At the end it shows the address to open, something like
`https://192.168.1.50:3443/home`.

---

## 7. Try it out

### Open the home page

On your laptop, open the address the setup showed:

```
https://ADDRESS:3443/home
```

**The browser warns that the connection isn't private.** That's expected.
WordLight makes its own security certificate, because no certificate
company will issue one for an address on a private network. The
connection is still encrypted. Click **Advanced** (or **Show Details**),
then **Proceed** (or **visit this website**). Each phone, tablet and
laptop asks once; most remember it after that.

Use the Pi's **address** (the numbers), not `wordlight.local`, for
anything the audience uses: the certificate lists the address, and many
phones can't find `.local` names.

### A test run

1. **Make a test caption file.** On the home page, open the **Caption
   Editor** and log in with the admin or editor login. Type three or four
   lines of your own, one caption per line, then press **💾 Save to
   Scripts** and call it `Test`.
2. **Load it in the controller.** Back on the home page, open the
   **Caption Controller** and log in with the admin login. Press
   **📁 Scripts** and choose `Test`.
3. **Read it on a phone.** Join the phone to the same Wi-Fi as the Pi,
   scan the QR code on the home page, and go past the same warning.
4. **Move through the lines** in the controller with the arrow keys or
   Space. The phone follows within a moment.

The full list of script features (colors, notes, song cues, page markers)
is on the **Help** page, and in [README.md](README.md#script-file-format).

---

## 8. Make it yours

**Logo and icon:** replace these two files with your own, keeping the
same names:

| File | What it's for | Size |
|---|---|---|
| `public/iconlarge.png` | The logo at the top of the home, reader and backstage pages | A wide logo, about 290 × 60 pixels |
| `public/favicon.png` | The browser tab icon and phone home-screen icon | Square; 180 × 180 pixels looks sharp |

The easiest way is over the **CC Server** network share (see
[Network shares](#network-shares)): open its `public` folder and drag your
files in. Reload the pages to see them.

**Theater name or support email:** the setup asks for these once. To
change them later, run `./setup.sh` again and choose **3) Theater name and
support email**: press Enter to keep what's there, or type a new one (for
the email, `-` removes it). Reload the pages to see the change.

They are two lines near the top of `public/global.js`, so they can also be
edited by hand. Change only the text between the quote marks on the
`THEATER_NAME` or `SUPPORT_EMAIL` line. If a page then stops working, the
quote marks were probably changed: `node --check
~/wordlight/public/global.js` names the line with the problem.

Updates (see [step 10](#10-later-on-the-setup-menu)) keep your logo,
your name and your settings.

---

## 9. Optional extras

### OLED status display

<!-- photo: docs/images/oled-wiring.jpg -->

A 128×64 I2C OLED screen (SSD1306 or SSD1315) with 4 buttons shows the
Pi's address and QR codes for the home, reader and backstage pages, so
you can find the Pi without a laptop.

Wire it to the Pi's 40-pin header **with the Pi switched off**. Pin
numbers are the header positions (pin 1 is the corner nearest the SD
card on a Pi 3):

| Display | Pi header pin |
|---|---|
| VCC | 1 (3.3 V) |
| GND | 6 |
| SDA | 3 |
| SCL | 5 |
| K1 (next page) | 11 (GPIO 17) |
| K2, K3 (not used yet) | 13, 15 (GPIO 27, 22) |
| K4 (wake; hold 3 s to restart the Pi) | 36 (GPIO 16) |

The buttons connect their pin to ground when pressed. If your module is
wired differently, the pin numbers are near the top of `oled_display.py`.

Then answer `y` to the OLED question in the setup (or choose
**Run the full setup again** from the menu if it's already installed).
The setup turns on I2C, which needs one restart, and tells you when.

<!-- photo: docs/images/assembled-case.jpg -->

**K1** steps through the pages; a short press of **K4** wakes the screen.
Holding K4 for 3 seconds restarts the Pi, but only after a one-time
permission step described under "Reboot setup" at the top of
`oled_display.py`.

### Network shares

The setup can share three folders on the network, so you can copy files
to and from the Pi from any Mac or Windows computer:

| Share | What's in it | Who can open it |
|---|---|---|
| **CC Storage** (or the name you chose) | The caption files | Your login and `WordMaker` can change files. Nobody else, unless you allowed reading without a password. |
| **CC Server** | WordLight's own files (logo, settings) | Your login only |
| **Wordlight Home** | Your whole home folder on the Pi | Your login only |

The passwords are the **Samba passwords** you set during setup, not the
Pi's login password (unless you chose the same one).

- **Mac:** in Finder, choose **Go → Connect to Server** (⌘K), type
  `smb://ADDRESS` and press Connect. Choose **Registered User** and enter
  `wordlight` (or `WordMaker`) and its Samba password.
- **Windows:** in File Explorer's address bar, type `\\ADDRESS` and
  press Enter, then enter the user name and Samba password.

The editor and controller open files straight from CC Storage, so script
volunteers can do everything from the web pages and never need the share.

### Script Converter

The Script Converter turns a show script (PDF or Word, scanned or not)
into a WordLight caption file, from its own web page. When it's running,
WordLight's home page shows a **Script Converter** button, so the home
page is still the only link anyone needs.

It's slow on a Pi 3: about 35 seconds a scanned page, so an hour for a
100-page script. It waits whenever anyone is using WordLight, so it never
slows a show down. Install it from the setup menu (**Script Converter:
install or update**). The setup asks for a password for the converter's
page, which is separate from WordLight's. Details:
[README.md](README.md#script-converter-optional).

### Offline caption network

If the audience Wi-Fi has **no internet**, phones notice that their "am I
online?" checks fail, and may drop the Wi-Fi or switch to cellular data,
so the captions stop. The setup menu's **Offline caption network** option
makes the Pi answer those checks. Use it only for a network with no
internet. Details: [README.md](README.md#setup-script-easiest).

---

## 10. Later on: the setup menu

Run the setup again any time:

```bash
cd ~/wordlight
./setup/setup.sh
```

Once WordLight is installed, it shows a menu instead of the full install:

| Option | What it does |
|---|---|
| 1) Status | The Pi's health, what's running, who's connected, and every port with its address |
| 2) System settings | Time zone, computer name, Wi-Fi country, start on boot, your login password |
| 3) Theater name and support email | Change either one, or remove the email |
| 4) Network shares | Set the shares up again |
| 5) Reset a Samba password | For your login or `WordMaker` |
| 6) Scripts folder | Move or rename it |
| 7) Editor login | Add one, or change its name or password |
| 8) Script Converter | Install or update it |
| 9) Offline caption network | Set it up, test it or remove it |
| 10) Update WordLight | From the internet, or from a zip on the Pi |
| 11) Reset the WordLight admin password | |
| 12) Run the full setup again | Asks only the questions not yet answered |
| 13) Back up or restore | The Scripts folder, settings and Script Converter: to one file here or on a flash drive, and back |

Anything that restarts WordLight, or keeps the Pi busy for minutes,
refuses while anyone is connected, so the menu can't interrupt a show.

**Updating:** option 10 keeps your settings, passwords, certificate, logo
and theater name.

**Backing up:** option 13 saves the Scripts folder, WordLight's settings
(theater name, logos, ports) and the Script Converter (program, settings,
and its jobs if you choose) into one `.tar.gz` file. It goes in
`WordLight-backups` in your home folder (the **Wordlight Home** network share)
or on a USB flash drive: FAT32, exFAT, NTFS or ext4 work, but not a drive
formatted for Macs only. Setup checks the file after writing it and unmounts
the drive when it's done. **Passwords are never in a backup**, so a lost
flash drive gives nobody your logins. Keep backups private anyway: they hold
your show scripts and caption files.

No terminal needed for a backup: sign in to the **Logging** page
(`/logging`, the admin login) and use **Make and download a backup**. It
makes the same file and downloads it to your laptop (a copy stays on the Pi).

**Restoring:** option 13 again, then **Restore from a backup**. It checks
the backup first, then asks about each part before changing anything:

- **Scripts folder:** *merge* (add the backup's files; when a file here is
  different, both are kept and the backup's copy gets a "(2)" name),
  *replace* (the folder becomes exactly the backup), or *skip*.
- **WordLight settings:** it lists what differs (ports, user names, theater
  name, logos) and asks once. The Scripts folder's location stays this
  computer's own.
- **Script Converter:** installs it from the backup if it isn't here (this
  runs its self-tests, about 8 minutes on a Pi 3), puts back its settings,
  and adds any jobs that aren't here yet.

Everything it replaces is moved to a `WordLight-before-restore-<date>` folder
in your home first, so nothing is lost; delete that folder once all looks
right. Because backups hold no passwords, it ends by offering new admin,
editor and converter passwords (Enter keeps the current ones). On a new Pi,
run the full install first, then restore.

**Keeping the SD card healthy:** SD cards wear out with writing. The
setup already keeps WordLight's logs small (log rotation), and on
Raspberry Pi OS Trixie the logs live in memory, not on the card.
[README.md](README.md#reducing-sd-card-wear-optional) explains both, and
how to move the logs into memory on older systems.

---

## 11. Write these down

Keep these somewhere safe that the next person can find, such as your
theater's password manager or a sealed envelope with the production
manager:

- The Pi's **address** (and computer name, `wordlight`)
- The Pi's **login**: user name and password (from Imager)
- WordLight's **admin login** (username and password)
- The **editor login**, if you made one
- The **Samba passwords**: your login's and `WordMaker`'s
- The **Script Converter page password**, if installed
- The **audience Wi-Fi** name and password, and the router's admin login

---

## 12. Show-day checklist

**Before the audience arrives:**

- [ ] The Pi is powered (on its UPS, if you have one) and plugged into the
      audience Wi-Fi's router.
- [ ] From a phone **on the audience Wi-Fi**, scan the QR code: the reader
      page opens.
- [ ] On the operator's laptop, open the controller and load the show's
      caption file. Check that line 1 appears on the phone.
- [ ] The operator's laptop is plugged in, and set not to sleep. On
      Windows: Settings → System → Power. On a Mac: run `caffeinate -d`
      in Terminal and leave that window open until after the show
      (closing it, or pressing Ctrl+C, lets the Mac sleep again).
- [ ] Signs with the QR code are up. Print it from the home page opened by
      the Pi's **address**, not `wordlight.local`.
- [ ] The signs tell people the warning is expected, for example: *"Join
      the Wi-Fi NAME, then scan this code. If your phone says the
      connection isn't private, tap Advanced or Show Details and
      continue."*
- [ ] Optional: setup menu option 1 (Status). "Throttling: 0x0" means the
      Pi has had enough power.

**During the show:**

- **⏸ Intermission** (or the **I** key) in the controller shows the
  intermission screen on every phone; press it again to end it.
- Text typed in the live-type box appears on every phone at once, in
  place of the script, until you press **✕ Clear**.
- The emergency buttons above the live-type box (Fire alarm, Evacuate,
  and others) need two clicks: the first arms, the second sends.

**Between shows:** if the controller shows **📄 Converter waiting**,
**⏸ Pause 6 hours** keeps the Script Converter quiet until after the next
show.

**After the show:** close the controller page. The **Reader Logging**
page shows how many phones used captions; you can download it as a
spreadsheet (CSV).

---

## 13. When something goes wrong

| Problem | What to try |
|---|---|
| ssh can't find `wordlight.local` | Wait 5 minutes after first power-on. Check the Ethernet lights. Use the address instead (see [step 3](#if-wordlightlocal-isnt-found)). |
| ssh says **REMOTE HOST IDENTIFICATION HAS CHANGED** | Normal after you set up a new SD card with the same name. On your computer, run `ssh-keygen -R wordlight.local` (and `ssh-keygen -R ADDRESS`), then log in again. |
| ssh says **Permission denied** | Wrong user name or password. The user name is the one you typed in Imager. |
| `./setup/setup.sh: Permission denied` | Can happen after unpacking a zip. Run `chmod +x ~/wordlight/setup/*.sh`, then try again. |
| The setup stopped with an error | Read the line marked ✗. Most often it's the internet connection. Fix that and run the setup again: it carries on where it stopped. |
| Phones can't open the page | The phone must be on the same network as the Pi. **Guest networks** often block phones from reaching other devices ("client isolation" or "AP isolation" in the router's settings). |
| The page opens, but the captions don't move | Is the controller open and logged in? Reload the phone's page. |
| The time on the Pi is wrong after a power cut | A Pi has no clock battery. It sets its clock from the internet, so on a network without internet it can be wrong until it's online again. |
| Something else | Setup menu option 1 (Status) shows what's running. `pm2 logs wordlight --lines 50 --nostream` shows WordLight's last messages. More in [README.md](README.md#troubleshooting). |

### Getting help

Open an issue on GitHub:
[github.com/traisjames/WordLight/issues](https://github.com/traisjames/WordLight/issues).
Say what you did, what you expected and what happened instead. The
Status screen (setup menu option 1) and the log command above help a lot,
and neither shows any passwords. **Never post your `.env` file**: it holds
the passwords.
