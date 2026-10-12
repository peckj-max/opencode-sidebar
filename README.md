# OpenCode Sidebar

An opencode chat panel that lives in the VS Code **secondary side bar**, with editor context.

## Features

- Chat with opencode in the secondary side bar (right-hand bar), one tab alongside other panels.
- **Auto context** — each prompt automatically carries the file in the active editor, or the
  selected line range if there is a selection. Toggle with the *auto-context* checkbox or the
  `opencode.autoAttach.enabled` setting.
- **Add selection to chat** — `Ctrl+L` (when text is selected) or `Ctrl+Alt+L` (always), plus an
  editor right-click entry. Adds the selection or whole file as a staged attachment chip.
  (`Ctrl+Shift+L` is deliberately avoided — it is VS Code's *Select All Occurrences of Find Match*.)
- **Open referenced files** — click a `path:line` the assistant mentions to open it in the editor.

## Requirements

- VS Code 1.106 or newer.
- The `opencode` CLI (v2) installed. It is discovered from the `PATH`, the usual install
  directories, and the desktop app's `cli/<version>/` folder; override with the
  `opencode.cliPath` setting.

The extension spawns its own `opencode serve` process on a free local port and reads the
generated password from its startup banner. If `opencode.server.port` is set and something
is already listening there — typically the OpenCode desktop app on `4096` — the extension
adopts that server instead of failing, authenticating with the password the desktop app
records in its `service.json`. Sessions share the same opencode data directory, so they are
visible to the desktop app too.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `opencode.cliPath` | *(auto)* | Path to `opencode.exe`. |
| `opencode.model` | `opencode-go/deepseek-v4.1-flash` | Model applied to new sessions, as `providerID/modelID`. |
| `opencode.autoAttach.enabled` | `true` | Attach the active file/selection to every prompt. |
| `opencode.server.hostname` | `127.0.0.1` | Interface the server binds to and the extension connects to. |
| `opencode.server.port` | `4096` | Port for the server; `0` picks a free one at random. |
| `opencode.server.password` | `"654321"` | Password for the server; empty = random per start. |
| `opencode.server.extraArgs` | `[]` | Extra args for `opencode serve`. |
| `opencode.attach.url` | `""` | Attach to an existing server instead of spawning one. |

`opencode.server.hostname` + `opencode.server.port` + `opencode.server.password` are written
to `~/.config/opencode/service.json` when the extension activates, in the same shape the
desktop app uses:

```json
{
  "hostname": "127.0.0.1",
  "port": 4096,
  "password": "654321"
}
```

The file is rewritten with the real endpoint once the server is up, so it stays truthful if
the port was taken and a different server was adopted, or if the port was set to `0`. This
defaults to port `4096`, the port the desktop app also uses; if it is already taken the
extension connects to the server already there rather than failing — and if it cannot
authenticate, it falls back to spawning its own on a free port.

The same three settings give a stable address you can bookmark in a browser:
`http://127.0.0.1:4096/`, username `opencode`.

`opencode.server.hostname` is `127.0.0.1` (loopback only) by default. Set it to `0.0.0.0` to
bind every interface and reach the web UI from another device — the extension still dials
loopback for its own requests. A wildcard bind is only as private as the password, which
defaults to a well-known value, so change `opencode.server.password` before doing this.

## Commands

- `OpenCode: Add Selection to Chat`
- `OpenCode: New Session`
- `OpenCode: Restart Server`
- `OpenCode: Show Server Address & Password` — reveals the running server's URL and copies its password
- `OpenCode: Open Web UI in Browser`

## Troubleshooting

Open the **OpenCode** output channel for server logs. `OpenCode: Restart Server` re-spawns the
backend. The v2 API is used (`/api/*`); older opencode 1.x builds that only serve `/session`
are not supported.
