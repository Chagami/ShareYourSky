@echo off
rem  Copy this file to scripts\exhibit.env.cmd and edit the copy. The copy is not in git,
rem  because every machine's port and certificate paths are its own.
rem
rem  Port 443 is what makes the address plain https://sharedsky with no port on the end. It
rem  needs the server to run elevated, which the scheduled task does by running as SYSTEM.

set "SKY_PORT=443"

rem  A certificate issued for the *name* clients type - not for an IP address. Leave both
rem  unset to fall back to the built-in self-signed one, which serves but warns on every
rem  device, and which the tablet's camera permission does not survive cleanly.

set "SKY_CERT=C:\certs\sharedsky.crt"
set "SKY_KEY=C:\certs\sharedsky.key"
