# Rendez-vous — appointment booking app

A web app where **clients** book appointments with **professionals** from many professions (doctors, dentists, lawyers, tutors, barbers, …), managed by an **admin**. Works on phones and desktops.

## Run it

Requires Node.js 22.13 or newer (it uses the built-in SQLite, so there is nothing else to install).

```bash
npm install
npm run seed      # optional: demo professionals + a demo client
npm start         # http://localhost:3000
```

On the first start an admin account is created. Choose your own credentials:

```bash
ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='a-long-password' npm start
```

If you don't, a random password is generated and printed once in the terminal (email `admin@example.com`).

Demo accounts (after `npm run seed`, password `demo12345`): `client@demo.ma`, `sara@demo.ma` (doctor), `ikram@demo.ma` (dentist), `youssef@demo.ma` (lawyer), `salma@demo.ma` (tutor), `karim@demo.ma` (barber).

## What each role can do

| Role | Capabilities |
|---|---|
| Visitor | Browse and search professionals by profession, city or keyword |
| Client | Sign up, see free time slots, request an appointment, cancel, view history |
| Professional | Sign up with a profession, edit public profile and price, set weekly hours (several windows per day), confirm / decline / cancel / complete requests, see client contact details |
| Admin | Dashboard stats, add professions (EN/FR), enable or disable any account, see recent bookings |

Booking flow: client requests a slot → status `pending` → professional `confirmed` or `declined` → after the visit `completed`. Cancelling frees the slot. A slot can never be double-booked (checked in a transaction and enforced by a unique index).

## Configuration (environment variables)

| Variable | Purpose | Default |
|---|---|---|
| `PORT` | HTTP port | 3000 |
| `NODE_ENV=production` | Secure cookies, trust proxy (use behind HTTPS) | – |
| `SESSION_SECRET` | Cookie signing secret | generated into `.session-secret` |
| `DB_FILE` | SQLite file path | `./data.db` |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | First-run admin | see above |
| `TZ` | Time zone used for "today" and slots | `Africa/Casablanca` |

## Tests

`npm test` starts the server on a temporary database and runs 15 end-to-end checks (registration, roles, double-booking, privacy, admin, CSRF).

## Project layout

- `server.js` — Express API (auth, directory, slots, bookings, admin)
- `db.js` — SQLite schema and the default list of professions
- `public/` — the web interface (plain HTML/CSS/JS, no build step)
- `seed.js`, `test.js`

## Before going live

- Serve it over HTTPS and set `NODE_ENV=production` and a real `SESSION_SECRET`.
- Add email or SMS notifications (confirmations and reminders) — not included yet.
- Add password reset by email, and Arabic/French translations of the interface.
- The login throttle and sessions are kept on a single server; use a shared store if you run several instances.
- For a mobile app, the same API (`/api/...`) can be used from a React Native or Flutter client.
