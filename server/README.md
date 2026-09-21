# MatePad MDM — Server (Hostinger VPS)

## 1. Point a subdomain at your VPS
In Hostinger DNS, add an A record, e.g. `mdm.yourdomain.com` → your VPS IP.

## 2. Install Node.js, Nginx, Certbot on the VPS
```bash
ssh root@your-vps-ip

# Node 20 LTS
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs nginx certbot python3-certbot-nginx build-essential

npm install -g pm2
```

## 3. Deploy the code
```bash
mkdir -p /opt/matepad-mdm
# from your local machine:
scp -r server/* root@your-vps-ip:/opt/matepad-mdm/

ssh root@your-vps-ip
cd /opt/matepad-mdm
npm install
cp .env.example .env
nano .env   # fill in JWT_SECRET, BOOTSTRAP_ADMIN_USERNAME/PASSWORD, ENROLLMENT_SECRET
            # (use `openssl rand -hex 32`/`openssl rand -hex 24` for secrets)
```

## 4. Run it under pm2 (keeps it alive across reboots/crashes)
```bash
pm2 start src/index.js --name mdm-server
pm2 save
pm2 startup   # follow the printed instructions to enable on boot
```

## 5. Nginx + HTTPS
```bash
cp nginx.conf.example /etc/nginx/sites-available/mdm.yourdomain.com
ln -s /etc/nginx/sites-available/mdm.yourdomain.com /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx

certbot --nginx -d mdm.yourdomain.com
```

HTTPS/WSS is not optional here — the Android agent and dashboard both need TLS, and
the MediaProjection/Accessibility permissions on Android will only be trusted to
run reliably in the background if everything is talking over a secure connection.

## 6. Verify
Visit `https://mdm.yourdomain.com` — you should see the login screen.
Log in with `BOOTSTRAP_ADMIN_USERNAME`/`BOOTSTRAP_ADMIN_PASSWORD` from your `.env`
(this account is only created once, on first boot against an empty database — after
that, manage accounts from the dashboard's Accounts panel).

Each school/tablet will show **Offline** in the fleet sidebar until that tablet's
Android agent (see `../android-agent`) is registered (school + tablet number, from
the app's own registration screen) and connects with its own server-issued token.

## API summary
- `POST /api/login` `{ username, password }` → `{ token, username, role }`
- `GET /api/me` (auth) → `{ username, role }`
- `POST /api/enroll` `{ enrollmentSecret, schoolName, tabletNumber, deviceUid }` →
  `{ deviceId, deviceToken, schoolName, tabletNumber }` — called by the Android app's
  registration screen, not the dashboard
- `GET /api/schools` (auth) → schools with device/online counts
- `POST /api/schools` (full role) `{ name }` → create a school directly
- `PATCH /api/schools/:id` (full role) `{ name }` → rename a school
- `DELETE /api/schools/:id` (full role) → delete a school and every tablet registered under it
- `GET /api/devices` / `GET /api/devices?schoolId=` (auth) → device list + status
- `GET /api/devices/:id/status` (auth) → one device's online state, battery, last seen
- `PATCH /api/devices/:id` (full role) `{ tabletNumber }` → rename a tablet
- `DELETE /api/devices/:id` (full role) → remove a device
- `GET /api/devices/:id/commands` (auth) → last 50 commands + results for one device
- `POST /api/devices/:id/commands` (full role) `{ action, params }` → queues + pushes a command
- `GET /api/users` / `POST /api/users` / `DELETE /api/users/:id` (full role) → manage dashboard accounts
- `WS /ws/dashboard?token=<jwt>` → live status/log/screen-frame stream; send
  `{ type: 'watch_device', deviceId }` to subscribe to one device
- `WS /ws/device?token=<per-device token>` → used only by the Android agent

## Security notes
- Keep `.env` out of git (there's a `.gitignore` for this).
- `ENROLLMENT_SECRET` and account passwords should be long random values, not
  something guessable — a leaked `ENROLLMENT_SECRET` lets someone enroll a rogue
  device into your fleet, and a `full`-role account can lock/wipe any tablet in it.
- Consider restricting the VPS firewall to only 80/443/22, and disabling SSH password auth (key-only).
