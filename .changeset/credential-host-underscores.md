---
"apps": minor
"@executor-js/sdk": minor
---

Provider `hosts` may name hosts with underscores, such as the Docker container
`n8n_server_1:5678`. This is host protocol 14. Apps on earlier `apps` releases
keep running; an account they use never shows them a host with an underscore.
