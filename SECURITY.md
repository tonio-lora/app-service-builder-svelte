# Security policy

This classroom app targets App Service Builder Private Preview for development
and testing, not high-stakes or production graded assessments. Student identity
and answer records are private educational data, not public sample metadata.
Obtain institutional approval and define retention/backups before real use.

Require Builder-managed Microsoft Entra sign-in restricted to `iastate.edu`.
The backend trusts Builder-verified identity headers: never expose it directly
to untrusted clients without an equivalent authentication proxy. Professor
authorization is a separate, server-side `PROFESSOR_EMAILS` allowlist.

Use the production `npm start` entry point, managed identity, and an authorized
Azure SQL connection. `npm run dev` deliberately uses simulated accounts and
local SQLite and must remain loopback-only. Never put secrets, private data,
or database settings in `VITE_*` variables or static assets.

## Reporting a vulnerability

Do not report security vulnerabilities in public GitHub issues or pull requests.
Follow the
[Microsoft Security Response Center reporting guidance](https://www.microsoft.com/msrc/how-to-report-a-vulnerability).

Include affected versions, reproduction steps, and the potential impact in
your private report. Do not include real credentials or unrelated private data.
