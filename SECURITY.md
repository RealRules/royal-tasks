# Security policy

## Reporting a vulnerability

Please do not report security problems in a public issue. Use GitHub's
private reporting instead: the repository's **Security** tab →
**Report a vulnerability**. Only the maintainer sees the report.

Helpful to include: what an attacker can do, the steps or request that show
it, and the version (the build shown in the browser console, or the commit).
You will get an answer, and credit in the fix if you want it. Please allow
time for a fix to be released before you disclose the problem.

## Supported versions

Fixes go into the latest version on the main branch. An installation is
updated by copying in the new files and running `upgrade.php` (see
[docs/install.md](docs/install.md#updating-an-installation)).

## What is in scope

Anything that lets someone read or change a board they are not a member of,
read an end-to-end encrypted board without its password, act as another user,
reach the server's network from the app (SSRF), run script in another user's
browser, or read the files and settings the server keeps. How the app is meant
to protect each of these is described in [docs/security.md](docs/security.md),
and the rules the code keeps are listed in [Agents.md](Agents.md) under
*Security invariants*.
