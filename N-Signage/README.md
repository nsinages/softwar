# N Signage — Raspberry Pi Digital Signage

A Raspberry Pi digital signage system for automatically displaying images and videos on a TV.

## Architecture

Power ON Raspberry Pi → `n-signage.service` starts Flask → LightDM/Labwc starts Wayland → Labwc autostart starts Chromium → Chromium opens `/display` in kiosk mode → media plays on the TV.

### Main paths

```text
/home/nsignage/n-signage/
├── app/app.py
├── media/
├── data/
└── static/
    ├── css/display.css
    └── js/display.js
```

Display URL:

```text
http://127.0.0.1:5000/display
```

From another device:

```text
http://<PI-IP>:5000/display
```

Example:

```text
http://10.10.40.94:5000/display
```

---

## 1. Check the Flask Server

```bash
sudo systemctl status n-signage.service --no-pager
```

Expected:

```text
Active: active (running)
```

Or:

```bash
sudo systemctl is-active n-signage.service
```

Expected:

```text
active
```

Check automatic startup:

```bash
sudo systemctl is-enabled n-signage.service
```

Expected:

```text
enabled
```

Restart after changing Python code:

```bash
sudo systemctl restart n-signage.service
```

---

## 2. Test the Display Page

```bash
curl -I http://127.0.0.1:5000/display
```

Expected:

```text
HTTP/1.1 200 OK
```

Check the title:

```bash
curl -s http://127.0.0.1:5000/display | grep -n "<title>"
```

Expected:

```text
<title>N Signage Display</title>
```

---

## 3. Check Media

```bash
curl -s http://127.0.0.1:5000/api/media
```

The response should contain the uploaded images/videos.

Example:

```json
{
  "count": 2,
  "media": [
    {
      "filename": "example.jpg",
      "type": "image",
      "url": "/media/example.jpg"
    },
    {
      "filename": "example.mp4",
      "type": "video",
      "url": "/media/example.mp4"
    }
  ]
}
```

If media appears here, the Flask media API is working.

---

## 4. Check Static Files

```bash
curl -I http://127.0.0.1:5000/static/js/display.js
```

```bash
curl -I http://127.0.0.1:5000/static/css/display.css
```

Both should return:

```text
HTTP/1.1 200 OK
```

---

## 5. Flask `render_template` Error

A previous `/display` error was:

```text
NameError: name 'render_template' is not defined
```

If the route uses:

```python
return render_template("display.html")
```

the import must contain:

```python
from flask import render_template
```

If the project uses an HTML string such as `DISPLAY_HTML`, the route can instead use:

```python
@app.route("/display", methods=["GET"])
def display():
    return Response(DISPLAY_HTML, mimetype="text/html")
```

Do not accidentally mix the two approaches.

---

# 6. Wayland / Labwc

This Raspberry Pi uses Wayland and Labwc.

Check LightDM:

```bash
systemctl status lightdm --no-pager
```

Check Labwc:

```bash
ps aux | grep -E "labwc|wayfire|openbox|lxsession" | grep -v grep
```

Check session:

```bash
loginctl show-session 1 -p Type -p Name -p Display
```

Expected:

```text
Type=wayland
```

Check Wayland socket:

```bash
ls -l /run/user/1000/wayland-*
```

Expected to see something similar to:

```text
wayland-0
```

### Important

When connected through SSH:

```bash
echo $DISPLAY
```

may be empty.

That does not necessarily mean the TV desktop is broken.

SSH is not the graphical Wayland session. Do not use an SSH terminal as the final test for Chromium kiosk startup.

---

# 7. Automatic Chromium Startup

For Labwc, use:

```text
~/.config/labwc/autostart
```

Create the directory:

```bash
mkdir -p ~/.config/labwc
```

Recommended autostart:

```bash
#!/bin/sh

sleep 20

mkdir -p /tmp/n-signage-chromium

exec /usr/bin/chromium   --user-data-dir=/tmp/n-signage-chromium   --ozone-platform=wayland   --kiosk   --start-fullscreen   --noerrdialogs   --disable-infobars   --disable-session-crashed-bubble   --no-first-run   --disable-features=Translate   --disable-pinch   --overscroll-history-navigation=0   http://127.0.0.1:5000/display
```

Make executable:

```bash
chmod +x ~/.config/labwc/autostart
```

Check:

```bash
cat ~/.config/labwc/autostart
```

---

# 8. Why `sleep 20` Is Used

The delay gives Flask time to start before Chromium loads the display page.

Without a delay:

```text
Chromium starts
     ↓
Flask is not ready
     ↓
/display cannot load
     ↓
possible error/white page
```

The delay can be reduced later after the system is stable.

---

# 9. Why `--user-data-dir` Is Used

Chromium can reuse an old browser session/profile.

That can cause:

- old tabs
- profile locks
- restore-session dialogs
- unexpected browser state
- kiosk startup problems

Use:

```text
--user-data-dir=/tmp/n-signage-chromium
```

This gives N Signage its own temporary Chromium profile.

---

# 10. Check Chromium After Boot

After reboot:

```bash
pgrep -af chromium
```

You should see options similar to:

```text
--ozone-platform=wayland
--kiosk
--start-fullscreen
http://127.0.0.1:5000/display
```

---

# 11. White Screen Troubleshooting

If the TV shows a white screen, check these in order.

### Step 1 — Server

```bash
sudo systemctl is-active n-signage.service
```

Must return:

```text
active
```

### Step 2 — Display

```bash
curl -I http://127.0.0.1:5000/display
```

Must return:

```text
HTTP/1.1 200 OK
```

### Step 3 — Media

```bash
curl -s http://127.0.0.1:5000/api/media
```

Make sure media is listed.

### Step 4 — Chromium

```bash
pgrep -af chromium
```

### Step 5 — Wayland

```bash
ls -l /run/user/1000/wayland-*
```

### Step 6 — Labwc

```bash
ps aux | grep labwc | grep -v grep
```

### Step 7 — Logs

```bash
journalctl -b --no-pager | grep -iE "gpu|drm|wayland|chromium" | tail -100
```

---

# 12. Chromium GPU / EGL Errors

Possible errors:

```text
eglCreateContext: Requested version is not supported
```

```text
Could not create context for info collection
```

```text
Exiting GPU process due to errors during initialization
```

Test Chromium with GPU disabled:

```bash
pkill -f chromium
```

Then:

```bash
/usr/bin/chromium   --user-data-dir=/tmp/n-signage-chromium   --ozone-platform=wayland   --disable-gpu   --kiosk   --start-fullscreen   --noerrdialogs   --disable-infobars   --disable-session-crashed-bubble   --no-first-run   http://127.0.0.1:5000/display
```

If this works, the problem is likely Chromium GPU/EGL initialization.

Only then consider adding:

```text
--disable-gpu
```

to the permanent autostart.

---

# 13. SSL Error `net_error -202`

You may see:

```text
handshake failed
SSL error code 1
net_error -202
```

First test the local N Signage page:

```bash
curl -I http://127.0.0.1:5000/display
```

If it returns:

```text
200 OK
```

the local Flask page is working.

Do not assume an SSL error is the cause of a white local page without testing the actual `/display` page.

---

# 14. Do Not Start Chromium From SSH as the Final Test

This can fail:

```bash
chromium http://127.0.0.1:5000/display
```

when executed from SSH because SSH is not the graphical Wayland session.

The correct final test is:

1. Reboot Raspberry Pi.
2. Let LightDM start.
3. Let Labwc start.
4. Let `~/.config/labwc/autostart` start Chromium.
5. Watch the TV.

---

# 15. Useful Commands

### Restart server

```bash
sudo systemctl restart n-signage.service
```

### Server status

```bash
sudo systemctl status n-signage.service --no-pager
```

### Server logs

```bash
sudo journalctl -u n-signage.service -n 100 --no-pager
```

### Follow server logs

```bash
sudo journalctl -u n-signage.service -f
```

### Chromium

```bash
pgrep -af chromium
```

### Stop Chromium

```bash
pkill -f chromium
```

### Display

```bash
curl -I http://127.0.0.1:5000/display
```

### Media

```bash
curl -s http://127.0.0.1:5000/api/media
```

### Labwc

```bash
ps aux | grep labwc | grep -v grep
```

### Wayland

```bash
ls -l /run/user/1000/wayland-*
```

### Boot graphics logs

```bash
journalctl -b --no-pager | grep -iE "gpu|drm|wayland|chromium" | tail -100
```

---

# 16. Check for Duplicate Chromium Startup

There should normally be one N Signage Chromium startup configuration.

Check:

```bash
grep -Rni "chromium" ~/.config/autostart ~/.config/labwc 2>/dev/null
```

If Chromium is configured in multiple autostart files, it may start twice.

---

# 17. Automatic Boot Flow

```text
Power ON
   ↓
Raspberry Pi boots
   ↓
n-signage.service starts
   ↓
Flask server starts
   ↓
LightDM starts
   ↓
User graphical session starts
   ↓
Labwc starts
   ↓
~/.config/labwc/autostart runs
   ↓
wait 20 seconds
   ↓
Chromium starts
   ↓
http://127.0.0.1:5000/display
   ↓
N Signage Display
   ↓
Images / Videos
   ↓
TV
```

The final target is:

**Power ON → wait for boot → N Signage automatically appears on the TV.**

---

# 18. ChatGPT Error-Solving Prompt

Copy this prompt whenever an error happens:

```text
You are helping me debug my Raspberry Pi N Signage project.

PROJECT:
N Signage is a Raspberry Pi digital signage system.

ENVIRONMENT:
- Raspberry Pi
- Debian / Raspberry Pi OS
- Python
- Flask
- Chromium
- Wayland
- Labwc
- LightDM
- TV connected through HDMI

PROJECT PATH:
/home/nsignage/n-signage

FLASK SERVER:
http://127.0.0.1:5000

DISPLAY PAGE:
http://127.0.0.1:5000/display

MEDIA API:
http://127.0.0.1:5000/api/media

CHROMIUM AUTOSTART:
~/.config/labwc/autostart

SYSTEMD SERVICE:
n-signage.service

FINAL GOAL:
Power ON Raspberry Pi
→ Flask server starts automatically
→ Wayland/Labwc graphical session starts
→ Chromium starts automatically
→ Chromium opens /display in kiosk mode
→ images/videos play automatically on the TV
→ no manual browser interaction
→ no white screen

ERROR / LOG:
[PASTE THE ERROR HERE]

Please:

1. Explain the exact problem in very simple language.
2. Identify whether it is:
   - Flask/server
   - media
   - HTML/JavaScript
   - Chromium
   - Wayland
   - Labwc
   - LightDM
   - GPU/EGL
   - network
   - boot/autostart
   - something else
3. Do not guess if the log does not prove the cause.
4. Give the smallest and safest fix first.
5. Give commands one by one.
6. Tell me exactly where each command should be run.
7. Tell me what output I should expect after each command.
8. Do not make me change multiple configuration files at once.
9. Do not remove working code unless necessary.
10. Preserve my current N Signage functionality.
11. Clearly tell me when a reboot is required.
12. If more information is needed, give me the exact command to collect it.
13. End with a short verification checklist.

Make the instructions easy for a beginner to follow.
```

---

# 19. Best Information to Include in GitHub Issues

When reporting a problem, provide:

```bash
sudo systemctl is-active n-signage.service
```

```bash
curl -I http://127.0.0.1:5000/display
```

```bash
curl -s http://127.0.0.1:5000/api/media
```

```bash
pgrep -af chromium
```

```bash
cat ~/.config/labwc/autostart
```

```bash
ls -l /run/user/1000/wayland-*
```

```bash
ps aux | grep labwc | grep -v grep
```

```bash
sudo journalctl -u n-signage.service -n 50 --no-pager
```

For graphics/Chromium problems:

```bash
journalctl -b --no-pager | grep -iE "gpu|drm|wayland|chromium" | tail -100
```

**Never post passwords, API keys, tokens, or other private credentials.**

---

# 20. Contributing

Pull requests and issue reports are welcome.

When opening an issue, include:

- Raspberry Pi model
- OS version
- N Signage version/commit
- exact error message
- relevant command output
- what happened before the error

Keep logs focused on the problem and remove private information.

---

## License

Add your preferred open-source license here, for example:

```text
MIT License
```

---

## Production security setup

1. Install dependencies (includes the `waitress` production server):

   ```bash
   pip3 install -r app/requirements.txt
   ```

2. Set an API key so only the dashboard can upload/delete media:

   ```bash
   sudo install -m 600 /dev/null /etc/n-signage.env
   echo "NSIGNAGE_API_KEY=$(openssl rand -hex 32)" | sudo tee /etc/n-signage.env >/dev/null
   sudo systemctl daemon-reload && sudo systemctl restart n-signage.service
   ```

   Enter the same key in the dashboard under **Settings → Security → Pi API Key**.
   Read-only endpoints (`/api/status`, `/api/media`, `/media/<file>`, `/display`) stay open on the LAN.

3. Re-copy `n-signage.service` / `n-signage-discovery.service` to `/etc/systemd/system/`
   after updating, then `sudo systemctl daemon-reload`.
