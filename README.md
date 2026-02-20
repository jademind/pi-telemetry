# pi-telemetry

Structured runtime telemetry for `pi-coding-agent`, designed for external services (menu bar apps, daemons, web dashboards, alerting pipelines).

`pi-telemetry` publishes one JSON heartbeat file per running Pi process and ships a snapshot CLI to aggregate all active processes into a single machine-level payload.

---

## Highlights

- **Per-process telemetry heartbeat** (PID-scoped JSON files)
- **Session + model metadata** for each running Pi instance
- **Activity state** (`working`, `waiting_input`, `unknown`)
- **Context-window pressure metrics** (including near-limit detection)
- **External-service friendly snapshot** with aggregate + grouped maps
- **Atomic file writes** for robust consumers
- **No daemon required**: integrate by reading files or invoking snapshot CLI

---

## Installation

```bash
pi install npm:pi-telemetry
```

The extension is auto-loaded through the package `pi.extensions` manifest.

---

## Runtime behavior

On key Pi lifecycle events (`session_start`, `turn_start`, `turn_end`, etc.), the extension writes/updates:

```text
~/.pi/agent/telemetry/instances/<pid>.json
```

On graceful shutdown (`session_shutdown`), the process file is removed.

### Configuration

Environment variables:

- `PI_TELEMETRY_DIR` (default: `~/.pi/agent/telemetry/instances`)
- `PI_TELEMETRY_HEARTBEAT_MS` (default: `1500`, minimum: `250`)
- `PI_TELEMETRY_CLOSE_PERCENT` (default: `85`)
- `PI_TELEMETRY_NEAR_PERCENT` (default: `95`)
- `PI_TELEMETRY_STALE_MS` (used by snapshot CLI; default: `10000`)

Inside Pi, use:

- `/pi-telemetry` to display the active telemetry file path.

---

## Snapshot CLI

Aggregate all live telemetry into one JSON document:

```bash
pi-telemetry-snapshot --pretty
```

### CLI options

- `--stale-ms <ms>`: stale threshold override
- `--pretty`: pretty-printed JSON output

### Exit behavior

- Returns JSON even when no instances exist (`counts.total = 0`)
- Skips invalid/corrupt JSON files

---

## Output schema

Top-level snapshot (`schemaVersion: 2`) includes:

- `aggregate`: `none | working | waiting_input | mixed`
- `counts`: totals by activity
- `context`: fleet-level context pressure summary
- `sessions`: map keyed by `session.id`
- `instancesByPid`: map keyed by string pid
- `instances`: ordered array of full active records

### Per-instance fields

- `process`: pid/ppid/uptime/heartbeat timestamps
- `system`: host/user/platform/arch/nodeVersion
- `workspace`: cwd + optional git branch/commit
- `session`: id/file/name
- `model`: provider/id/name/thinkingLevel (if available)
- `state`: activity and idleness flags
- `context`: token usage and pressure classification
- `capabilities`: currently `hasUI`
- `lastEvent`: most recent triggering Pi lifecycle event
- `telemetry`: snapshot-side metadata (`alive`, `stale`, `ageMs`, source file)

### Context pressure model

Derived from `context.percent`:

- `normal`
- `approaching_limit` (>= `PI_TELEMETRY_CLOSE_PERCENT`)
- `near_limit` (>= `PI_TELEMETRY_NEAR_PERCENT`)
- `at_limit` (>= `100`)

Additional booleans are provided for easy filtering:

- `closeToLimit`
- `nearLimit`

---

## Example integration

### Poll from a daemon

```bash
pi-telemetry-snapshot | jq '.aggregate, .counts, .context'
```

### Get all sessions currently near context limit

```bash
pi-telemetry-snapshot | jq '
  .sessions
  | to_entries
  | map(select(.value.context.nearLimit > 0))
'
```

### Check whether any Pi is waiting for input

```bash
pi-telemetry-snapshot | jq '.counts.waiting_input > 0'
```

---

## Development

```bash
npm pack --dry-run
node ./bin/pi-telemetry-snapshot.mjs --pretty
```

Suggested release checklist:

1. Update version in `package.json`
2. Validate tarball with `npm pack --dry-run`
3. Verify CLI output in a live Pi session
4. Tag and publish

---

## Security model

- Telemetry is written to the local filesystem under your user account.
- Consumers should treat files as untrusted input and validate JSON.
- Snapshot CLI performs liveness/staleness filtering; downstream systems should still apply their own policy checks.

---

## License

MIT — see [LICENSE](./LICENSE).
