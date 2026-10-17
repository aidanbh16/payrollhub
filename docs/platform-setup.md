# Platform setup notes and troubleshooting

The README's install steps work the same on Windows, macOS, and Linux. This page covers what differs by platform and
what to do when a step fails.

## Ports PayrollHub uses

| Port | What | Started by |
|---|---|---|
| 3000 | PayrollHub (`http://localhost:3000`) | `npm run dev` or `npm run start` |
| 8443 | Stand-in bank (`https://localhost:8443`, mTLS) | `npm run bank` |
| 6379 | Redis (rate-limit store) | `docker compose up -d` |
| 3100, 3102, 8444 | Production app, development app, and bank for the browser tests only | `npm run test:e2e` (starts and stops them itself) |

Every server listens on `127.0.0.1` only. If a port is taken, stop whatever holds it (on Windows:
`Get-NetTCPConnection -LocalPort 3000 -State Listen` shows the process id), or see "Running on another port" below.

## Only one PayrollHub Redis at a time

`docker-compose.yml` names its project `payrollhub` and its container `payrollhub-redis`, and binds port 6379. Two
extracted copies of PayrollHub on one machine therefore share that one container: `docker compose up -d` in the second
copy recreates it with the second copy's password, and the first copy then gets `WRONGPASS`. Run one copy at a time,
and after switching, run `docker compose up -d --force-recreate` in the copy you are using.

## Windows

- **Use the folder's exact casing when you `cd` into it.** Windows accepts `cd project` for a folder named
  `Project`, but Next.js then loads React twice: `npm run build` fails with "Invalid hook call" / "Cannot read
  properties of null (reading 'useContext')" on every page, and `npm run dev` shows the same errors. `cd` into the
  folder using the casing File Explorer shows. If you already ran a command from the wrong casing, delete the `.next`
  folder and run it again from the right one.
- **Shell:** every command in the README works in PowerShell, Command Prompt, and Git Bash. Where the README shows two
  commands for one step, run them in separate terminal windows.
- **Docker Desktop** must be running (its whale icon in the system tray) before `docker compose up -d`. It needs WSL 2,
  which the Docker Desktop installer sets up.
- **Paths:** extract the ZIP to a short path such as `C:\PayrollHub` if you see "path too long" errors from npm.

## macOS and Linux

- Docker Desktop (macOS) or Docker Engine with the Compose plugin (Linux). On Linux, if `docker` needs `sudo`, either
  add yourself to the `docker` group or run `sudo docker compose up -d`.
- `npx playwright install chromium` downloads the browser for the end-to-end tests. On Linux, if Chromium then fails
  to start for lack of system libraries, run `npx playwright install-deps chromium` once (it uses `sudo apt`).

## Redis without Docker

Run Redis 7+ bound to localhost with the password from your `.env` (`REDIS_PASSWORD`, which `npm run setup` wrote):

- **Windows:** install WSL (`wsl --install`), then inside Ubuntu: `sudo apt update && sudo apt install -y redis-server`
  and run `redis-server --bind 127.0.0.1 --requirepass "<REDIS_PASSWORD from .env>" --save ""`.
  WSL forwards `127.0.0.1:6379` to Windows automatically.
- **macOS:** `brew install redis`, then `redis-server --bind 127.0.0.1 --requirepass "<REDIS_PASSWORD from .env>" --save ""`.
- **Linux (Debian/Ubuntu):** `sudo apt install -y redis-server`, then the same `redis-server` command.

Check it with `redis-cli -a "<REDIS_PASSWORD from .env>" ping` (expects `PONG`). If you change the password, update
both `REDIS_PASSWORD` and `REDIS_URL` in `.env`. The app refuses to start with the password older versions of
`.env.example` published (RT-05); `npm run setup` replaces it.

## Running on another port

`npm run dev -- -p 3005` (or `npm run start -- -p 3005`) runs the app on port 3005. Then also set, in `.env`,
`INTERNAL_API_ORIGIN=http://127.0.0.1:3005` and `APP_ORIGIN=http://localhost:3005`, or "Run payroll" answers 502 and
mailbox links point at the wrong port. POSTs from scripts must send `Origin: http://localhost:3005`.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `npm install` fails building `better-sqlite3` | Your Node.js is older than 22.12 (`node -v`). better-sqlite3 13 ships prebuilt binaries for Node 22 and 24 on Windows, macOS, and Linux; install Node 22 or 24 LTS and run `npm install` again. |
| `docker compose up -d` says `Set REDIS_PASSWORD in .env` | `npm run setup` has not run yet (it writes the password into `.env`). Run it, then `docker compose up -d` again. |
| `docker compose up -d` cannot connect to the Docker daemon | Start Docker Desktop (or the Docker service) and wait until it reports it is running. |
| The server log shows `startup.redis_unreachable`, and sign-in answers 503 | Redis is not running (`docker compose up -d`), or it was started with another password than the one in `.env`. After `npm run setup` changed the password, recreate the container: `docker compose up -d --force-recreate`. |
| Redis answers `WRONGPASS` | Same as above: `docker compose up -d --force-recreate`. |
| The server exits with `startup.invalid_configuration` | `.env` is missing a value or holds an invalid one; the message names the variable. Run `npm run setup` (it never overwrites values you set). |
| Sign-in answers `Too many requests` (429) | The sign-in throttle (L1-05, D25). Wait for the number of seconds in the `Retry-After` header, or use **Locked out after too many attempts?** on the sign-in page to get an unlock link in the staff member's mailbox (D46). |
| "Run payroll" answers 502 | `INTERNAL_API_ORIGIN` does not match the port the app runs on (see "Running on another port"). |
| "Send to bank" fails and the run stays computed | `npm run bank` is not running, or it was started before `npm run setup` created the certificates. Start or restart it. |
| A TOTP code is refused | Each code works once per 30-second window. Wait for the countdown `npm run totp` prints and use the next code. After `npm run db:reset`, the secrets change: re-read `.data/dev-credentials.txt`. |
| `npm run test:e2e` cannot find Chromium | Run `npx playwright install chromium` once. |
| Many tests fail with 503 | Redis is not running; `npm test` needs it (see the README's "Running the tests"). |
