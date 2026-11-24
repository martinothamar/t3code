# Telemetry and diagnostics

Fork builds disable product usage analytics, T3 Connect diagnostic traces, and mobile crash and
startup uploads. Local diagnostics and resource history are available in the app. Your provider
CLI runs separately and has its own telemetry controls. If you connect through app.t3.codes or
use an upstream mobile app, that client can still send its own telemetry.

**Agent feedback** in **Settings > Labs** keeps the reports agents write on your machine. Fork
builds never send them; `t3 feedback list` shows what was saved.

## Agent activity for mobile notifications

**Settings → Sharing & access → Publish agent activity** sends project/thread titles, model names, and turn status to the T3 Connect relay for [mobile notifications and live activities](./mobile-notifications.md). This is independent of telemetry—turn it off directly on the host if you don't want it.

## Export diagnostics to your own OpenTelemetry receiver

Open **Settings → Maintenance → Diagnostics** (per environment) and enter OTLP HTTP endpoints (e.g. `http://localhost:4318/v1/traces`), save, and restart the server. Use **Test** to verify connectivity.

`T3CODE_OTLP_*_URL` and standard `OTEL_EXPORTER_OTLP_*` env vars override saved settings (use `T3CODE_OTLP_HEADERS` / `T3CODE_OTLP_PROTOCOL=http/protobuf` or the standard `OTEL_EXPORTER_OTLP_*` equivalents for auth and protobuf).
