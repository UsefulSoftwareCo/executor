---
"@executor-js/hosted-self-host": patch
---

Self-host holds about 130 MB less memory at idle. Postgres's default 128 MB
buffer pool stayed resident in full whether or not the database used it; the
product's database now runs with the 16 MB pool the local server uses. The
setting applies to existing databases from the next start.
