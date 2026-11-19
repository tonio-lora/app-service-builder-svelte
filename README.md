# Cyclone Classroom

A browser-based, professor-led multiple-choice competition for Iowa State
classrooms. Students use a phone or laptop: scan the lobby QR code, sign in
with their `iastate.edu` Microsoft account, and answer each timed question.

## What it does

- Professors import question banks from CSV and open competition lobbies.
- Each lobby has a QR code, six-character code, and short path: `/j/ABC234`.
  The hostname is the app's hostname; no external URL shortener is used.
- Students choose a public display name; their verified email is visible
  only to their professor in the roster and results export.
- The professor starts each question, can close it early, reveals the correct
  answer, and advances to the next question.
- Questions automatically close at their server-defined deadline. The
  professor controls when the next question begins.
- Each account gets one locked answer per question. Correct answers receive
  500 base points plus up to 500 speed points; incorrect/missed answers get 0.
  Speed uses server receipt time, not the student's device clock.
- Leaderboards update after the reveal, not while students are answering.
  Ties share a rank.
- Quizzes, competition snapshots, participants, and answers are saved.
  Professors can reopen competitions and export one CSV row per student/question.
- Rejoining an existing seat works after a refresh; new students cannot join
  after the first question starts.

Designed for a roughly 50-student class, not a high-stakes exam system.
Network latency affects speed points. Access to an `iastate.edu` account
does not establish enrollment in a particular course.

## Stack and structure

| Location | Responsibility |
|---|---|
| `src/App.svelte` | Responsive professor dashboard, student join screen, lobby, gameplay, results |
| `src/lib/` | Typed browser API helpers and shared data types |
| `src/app.css` | Responsive styles; no external fonts or UI service dependencies |
| `server/app.ts` | Same-origin Express API and production static-file serving |
| `server/auth.ts` | Builder-verified Entra identity, exact-domain check, professor allowlist |
| `server/quiz.ts` | CSV validation, competition rules, timing, scoring, safe CSV exports |
| `server/azure-sql.ts` | Encrypted, managed-identity Azure SQL access and transactional updates |
| `server/sqlite.ts` | Local-only SQLite persistence for development/tests |
| `server/schema.sql` | Idempotent Azure SQL schema migration; no seed data |
| `public/sample-questions.csv` | Downloadable CSV example |
| `tests/` | Competition, authorization, HTTP and persistence tests |
| `builder.yaml` | One Node.js web component serving the UI and API |

Competition state is stored as a JSON snapshot per competition in Azure SQL.
Updates lock that competition's row inside a serializable transaction:
concurrent submissions cannot overwrite each other, and duplicate professor
actions cannot advance two rounds. Immutable quiz snapshots keep an existing
competition independent of later imports. Timers are persisted deadlines,
not in-memory scheduled jobs. Browser clients poll once per second and
display a local countdown synchronized to server time.

## Run locally

Use Node.js 24 LTS (Node.js 22.13+ also supported).

```powershell
npm ci --ignore-scripts
npm run dev
```

Open the Vite URL printed in the terminal, normally `http://127.0.0.1:5173`.
The development API listens on loopback port 3001. A yellow **LOCAL DEMO**
banner makes simulated authentication explicit.

1. As **Professor**, download the example CSV, import it, and select **Host quiz**.
2. Copy the join link or note the code.
3. In a separate browser profile/private window, open the join link and select
   **Student One** in the demo account selector. Enter a display name and join.
   The selector is shared between tabs in the same browser profile; use separate
   profiles to keep professor and student identities independent.
4. Start the competition from the professor window, answer in the student
   window, and advance through the reveals to the final leaderboard.
5. Download the results CSV from the professor view.

Local quizzes/results persist in `.data/classroom.sqlite`. Override
`LOCAL_DB_PATH` if needed. No Azure resource or actual account is used by this
demo. Local URLs/QR codes only work on that computer; do not expose the demo
API to a network to test phones.

`npm start` is a different, production-only entry point: it requires Azure SQL
and verified Builder identity headers. It never falls back to local storage or
simulated sign-in. Vite preview alone does not run the API; use `npm run dev`
for local interactive use.

## CSV format

Use UTF-8 and these exact headers (order may vary):

```csv
question,option_a,option_b,option_c,option_d,correct_answer,time_limit_seconds
Which city is home to Iowa State University?,Ames,Des Moines,Cedar Rapids,Iowa City,A,20
```

- 1-100 questions per file; maximum 500 KB.
- Four nonempty choices, with one correct answer letter `A`-`D`.
- Whole-number time limits from 5 to 120 seconds.
- Question text: up to 1,000 characters; options: up to 300 each.
- Quote fields containing commas, quotes, or newlines using standard CSV quoting.
- Invalid files fail as a whole with a row/validation message; partial quizzes
  are not saved.

## App configuration

Copy `.env.example` to `.env` for optional local settings. Never commit `.env`.
In Builder, configure the same names as server-side variables/connection outputs;
none belong in `VITE_*` variables or the browser bundle.

| Variable | Meaning |
|---|---|
| `PROFESSOR_EMAILS` | Required in production: comma-separated professor accounts, initially `alora@iastate.edu` |
| `ALLOWED_DOMAIN` | Exact permitted domain; defaults to `iastate.edu` |
| `SQL_SERVER` | Azure SQL hostname, e.g. `your-server.database.windows.net` |
| `SQL_DATABASE` | Existing Azure SQL database name |
| `AZURE_CLIENT_ID` | Optional client ID to select an assigned user-managed identity |
| `PORT` | Production listener, default `8080`; keep aligned with the manifest |

Accounts not on `PROFESSOR_EMAILS` are students. Professors can control/export
only competitions they own. Changing that allowlist requires redeploying the
intended Builder configuration.

## Azure SQL setup (not provisioned by this repository)

Builder has no durable local disks. Production therefore requires a separately
provisioned **Azure SQL Database**, not a SQLite file on the app filesystem.

1. Use an Azure SQL logical server with Microsoft Entra administration configured.
   Use Entra-only authentication; no SQL passwords are needed.
2. Assign a managed identity to the Builder app. The existing app had a
   system-assigned identity when inspected; assignment alone is not SQL access.
3. An authorized database administrator creates a contained database user for
   that identity and grants only `SELECT`, `INSERT`, and `UPDATE` on
   `dbo.ClassroomRecords`. No runtime DDL/owner permissions are required.
   Creating the identity user and applying the migration are administrator
   operations, not automatic effects of setting environment variables.
4. Apply `server/schema.sql` as an authorized administrator, or set
   `SQL_SERVER`/`SQL_DATABASE`, sign in locally with `az login`, and run:

   ```powershell
   npm run db:migrate
   ```

   This explicit command uses the local Azure credential chain and needs schema
   creation permissions. The production web process uses only managed identity.
5. Allow the Builder runtime to reach the database through the SQL server's
   network rules. Do not assume a private endpoint is reachable from Builder or
   broadly open the firewall without evaluating the allowed source network.
6. In Builder Connections, use the Azure SQL profile and map its server/database
   outputs to `SQL_SERVER` and `SQL_DATABASE`. Configure the selected identity
   consistently with `AZURE_CLIENT_ID` if using a user-assigned identity.

Tokens are obtained server-side and connection pools rotate before token expiry.
Database errors are not replaced with successful empty results or local data.
`GET /api/health` performs an actual database/schema read and returns 503 on failure.

## Sign-in and security

The existing Builder app was inspected read-only on November 19, 2026:
Microsoft Entra sign-in is **required**, its managed provider is enabled, and
its allowed email domain is exactly **`iastate.edu`**. No authentication
settings were changed. Verify this policy again before deployment.

The backend reads `X-MS-CLIENT-PRINCIPAL*` headers only behind Builder's trusted
authentication proxy, which verifies visitors and strips caller-supplied copies.
It additionally enforces the exact email domain and professor allowlist.
Never expose this backend directly to untrusted clients without an equivalent
identity-verifying proxy: these headers are not independently signed by the app.
An email allowlist is practical here; Entra tenant/object IDs are preferable for
stronger long-term professor authorization.

All mutating API calls require same-origin JSON/custom-header requests; the
server does not enable CORS and rejects cross-site submissions. Student responses
exclude roster emails, future questions, correct answers, and current-round
scores before the reveal. CSV exports neutralize spreadsheet formulas.

Student names/emails and answers are educational records. Obtain institutional
approval and establish retention, backups, access reviews, and deletion procedures
before real classroom use. This initial version has no data-retention UI or
automated deletion policy. Configure database backup/retention accordingly.

## Build, test and deploy

```powershell
npm run check
npm run build
npm test
```

Build before testing: HTTP tests check the production HTML shell as well as API
behavior. Tests use isolated SQLite databases, exercise 50 concurrent students,
and verify deadlines, one-answer locking, hidden scores, replayed controls,
authorization, exports and persistence after reopening the database.
They do **not** establish Azure SQL or deployed authentication connectivity.
CI runs the same commands on Windows and Linux.

The manifest now publishes a Node.js **web** application, not the former static
Hello World site. The custom build stages `dist`, compiled server code, package
metadata, and production dependencies under Builder's `DESTINATION_DIR`.
The Node server serves the UI, `/j/:code`, `/host/:code`, and `/api/*`.

No Azure resources, permissions, variables or deployments were changed as part
of the local implementation. Before deploying:

1. Confirm this Builder target supports **Node.js compute activation**; some
   preview targets do not, even when builds succeed.
2. Provision/authorize Azure SQL, apply the schema, and configure variables.
3. Preserve required Entra sign-in and the exact domain restriction.
4. Push the reviewed source and explicitly deploy through Builder.
5. Verify the database health check, real professor/student sign-in, QR join,
   direct join links/refreshes, concurrent answers and CSV export on the app URL.

App Service Builder is in Private Preview and documented for development/test,
not production workloads. Do not use a successful local demo as evidence of
cloud deployment or readiness for graded assessments.

References: [Builder authentication](https://builder.appservice.azure.com/docs/guides/authentication/),
[storage boundaries](https://builder.appservice.azure.com/docs/guides/storage/),
[Azure connections](https://builder.appservice.azure.com/docs/guides/connect-to-services/),
[runtime availability](https://builder.appservice.azure.com/docs/reference/runtimes/).
