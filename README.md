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
- **A transcript that shows the work** — the content area follows the Claude Code extension's
  rendering. Every block of an assistant message gets its own row and its own dot, in the order the
  model produced them: a collapsed **Thinking** disclosure that reads "Thought for 12s" and holds
  the model's reasoning, each **tool call** with an expandable body of labelled rows (arguments,
  result, exit code), then the prose, with the copy/bookmark actions under the last of them. Only
  the first row of a message carries the timestamp, so a message split across several rows still
  reads as one moment. Dots follow Claude Code's rule — colour is status, grey is the resting
  state — so a **completed tool call is green**, a failed one red, a warning amber, and anything
  still working blinks. A finished thought and the answer itself settle back to grey, and every
  row settles on its own rather than waiting for the turn to end. Your own prompt is a bordered
  bubble and deliberately *not* a timeline row, exactly as Claude Code treats it. A day divider is
  drawn as a wave | label | wave.

- **Questions are answered by clicking, not by a dropdown** — when the model asks something, each
  option is its own row with a radio or checkbox, a bold label and a description, so every choice is
  visible at once and the picked one is marked both by a filled dot (or a tick) and a bar down its
  left edge. That is Claude Code's question UI. The answer is submitted in the shape the server
  reads: a `questions` list is answered positionally — `q0`, `q1`, each holding the picked option
  labels — while a keyed `fields` form is answered by its own keys. A question with no options gets
  a text field instead.

  A reply to a system reminder — the plan-mode preamble is the usual one — is **not shown**. The
  server injects those as `synthetic` inbox items, and the reply's message is created before your
  first prompt while its streaming can finish after it, so it lands on whichever side of that
  prompt the timing happens to give. Both the live and restored views hide it rather than order it
  inconsistently.
  Reasoning and tool output survive a restore — `toTranscript` keeps them rather than discarding
  everything but the prose.
- **The prompt sticks while you read its answer** — each prompt and everything it produced sit in
  one turn wrapper, and the prompt is `position: sticky` within it, so it pins to the top of the
  content area while its turn is on screen and the next turn pushes it off. Its background fades
  out over the last 12px so the answer scrolling underneath is not cut off at a hard edge.
- **It follows the answer only while you are at the bottom** — scroll up to re-read something and
  the transcript stops chasing the stream, so a reply arriving under your eyes does not drag the
  view off the line you were reading. Scroll back to the bottom and following resumes. Three things
  come down regardless, because they are what the turn is waiting on: a prompt you just sent, a
  permission request, and a question. A permission Autopilot answered is only a transcript row, so
  it does not move you.
- **Agent, model and variant pickers** — the composer bar carries three dropdowns: the primary
  agent (`build`, `plan`), the model, and the model's reasoning-effort variant. Variants come
  from the model itself, so the list differs per model (`low`/`high`/`max` on one, `none` … `max`
  on another); **Default** sends no variant and lets the model's own setting apply. A variant the
  newly chosen model does not offer is dropped rather than carried across. The choice is
  remembered for the sessions that follow and re-applied to each session you switch to.
  Click the ☆ beside a model to pin it; the list is sorted pinned first, then alphabetically
  within each group. Hovering a model shows its pricing (USD per million tokens, from the
  server's own cost data), any higher-context tier, and its context window. Pins are stored in
  the extension's global state, so they apply to every workspace (vs. session pins, which are
  per-workspace).

- **Autopilot** — the toggle in the composer bar, beside the pickers, answers the agent's
  permission requests for you so a turn is not left sitting on a prompt while you are elsewhere.
  It replies *once*: approving a request never adds a standing rule to the server's saved
  permissions, so turning Autopilot off leaves your policy exactly as it was. Every approval still
  appears in the transcript — a settled, green row naming the action and the resources it covered
  — so an approval made on your behalf stays on the record rather than being swallowed. If the
  approval itself fails, the request is handed back as an ordinary answerable card rather than
  leaving the turn blocked on nothing. Off by default, and it is deliberately loud when on: what
  asks for permission is access outside the workspace and reads of `.env` files, which is exactly
  what is worth a look.

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

## Installing

There is no build step and no dependencies — the extension is plain CommonJS, the
webview is vanilla JavaScript — so what is in this folder is what runs. It is
installed **unpacked**: a plain folder in your VS Code extensions directory.

VS Code derives that folder's name from `publisher` and `version` in `package.json`,
so this extension lives in `local.opencode-sidebar-0.0.1`. Renaming it will stop it
loading; bumping the version means installing into the new folder and deleting the
old one.

1. **Copy the files in.** From the repository root, replacing any previous copy:

   ```powershell
   $dest = "$env:USERPROFILE\.vscode\extensions\local.opencode-sidebar-0.0.1"
   Remove-Item -Recurse -Force $dest -ErrorAction SilentlyContinue
   New-Item -ItemType Directory -Path $dest -Force | Out-Null
   Copy-Item package.json, extension.js, src, media, README.md, .vscodeignore -Recurse $dest
   ```

2. **Reload VS Code** so it picks the extension up: `Ctrl+Shift+P` →
   *Developer: Reload Window*. Editing an unpacked extension while VS Code is
   running has no effect until this is done — the old code keeps running, which
   looks like a change that "did not work".

3. **Open the panel.** `Ctrl+Shift+P` → *View: Toggle Secondary Side Bar* (`Ctrl+Alt+B`),
   then choose the **OpenCode** tab. It is in the right-hand bar, next to other
   secondary-side-bar panels, not the activity bar on the left.

To package it instead of installing unpacked:

```powershell
npx @vscode/vsce package --allow-missing-repository
code --install-extension opencode-sidebar-0.0.1.vsix
```

To uninstall, delete the folder in step 1 and reload. Settings under the
`opencode.*` keys stay in your `settings.json`, and pinned models stay in the
extension's global state — those are not removed with the folder.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `opencode.cliPath` | *(auto)* | Path to `opencode.exe`. |
| `opencode.model` | `opencode-go/deepseek-v4.1-flash` | Model applied to new sessions, as `providerID/modelID`. |
| `opencode.autoAttach.enabled` | `true` | Attach the active file/selection to every prompt. |
| `opencode.freeModels` | `true` | Offer free models (reported at zero cost) in the model list. |
| `opencode.goPlanOnly` | `false` | Offer only models from the OpenCode Go plan (`opencode-go`). |
| `opencode.autopilot` | `false` | Approve the agent's permission requests automatically, leaving each approval in the transcript. |
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
