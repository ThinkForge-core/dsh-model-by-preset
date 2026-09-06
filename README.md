# dsh-model-by-preset

Client (browser) plugin for the **DeepSeek Harness** **web** profile that makes a
session's model follow its **agent preset** — so the model you pick in one preset
no longer leaks into every other new session.

[Русская версия](README.ru.md)

## What it does

Every time you start a **new (blank)** session, DeepSeek Harness opens it on the
*last-used* model (the global `agent-default-model`). If you switch between
presets that each want a different model (a local Ollama model for one, a DeepSeek
cloud model for another, a vision model for a third), you end up manually
re-selecting the model every time.

`dsh-model-by-preset` removes that friction: you configure, once, which model and
reasoning effort every new session should open with **for each agent preset**. A
new session on that preset is then automatically switched to the mapped model via
the very same `session.selectModel` RPC the model picker in the UI uses.

- Only **new blank sessions** are auto-mapped. A session that already has history
  is never changed — a manual pick always wins.
- Sessions you leave un-configured keep the **global default model** (no override).
- A fallback row (`*`) lets you set the model for **any other / future preset**.

## Why a client plugin (not a host one)

In the current harness a session's model is resolved lazily per request. An agent
with no explicit pick uses the global `agent-default-model`, and an explicit pick
lives in a per-agent selection store owned by the api-proxy. The supported way to
switch a session model is the RPC `session.selectModel` — exactly what the browser
model picker calls, and exactly what this plugin issues.

`selectModel` also persists the pick as the global default ("last model used = new
default"). That side-effect is left **intact on purpose** — it is what keeps the
model seat/chip honest. Because this plugin maps the model for *every* preset, the
persisted default simply tracks whichever preset you used last.

## How it triggers

Forwarded `session/event` frames go to per-session controllers, not the root
context, so `ctx.on("session/event")` does not fire on a root plugin. Instead the
plugin subscribes to the **client session-list store** (`ctx.sessions.list`, a
snapshot store refreshed on `session.create` / preset change). Each summary row
carries `agentPreset` and `blank`. A row is auto-mapped only when:

- `blank === true` (no history yet — already-used sessions are never reverted), and
- `agentPreset` is recorded (so we know which target to apply), and
- that preset has an override whose model differs from the session's current model.

## Requirements

- DeepSeek Harness **web** profile (DSH `0.1.1-rc.2` or later).
- The provider(s) and model(s) you want to auto-assign must already be configured
  in your harness (settings / providers). This plugin only *selects* a model — it
  does not create providers.
- Node.js with the `dsh` CLI available on `PATH`.

## Install

### Option 0 — automated cross-platform installer (recommended)

A dependency-free **Python 3** installer (`install.py`) discovers your DSH layout
(`DSH_HOME` / `~/.dsh`, profiles), checks the toolchain (`dsh`, `pnpm`, `npm`),
and walks you through choosing how to install. It works on Linux, macOS and
Windows and supports every method below, plus uninstall.

```bash
cd /path/to/dsh-model-by-preset
python3 install.py            # interactive menu
python3 install.py --list     # just show what it detected
python3 install.py --method A # dev symlink into the default profile (web)
python3 install.py --method B --profile web
python3 install.py --method C            # GitHub install; owner from the git remote
python3 install.py --method U --yes              # uninstall, no prompts
python3 install.py --dry-run  # show the commands without running them
```

See the docstring at the top of `install.py` for the full CLI.

### Option A — from source (dev symlink)

```bash
cd /path/to/dsh-model-by-preset
dsh plugin --profile web add .
```

This creates a symlink from the repo into your profile, so edits are picked up:

- `client.js` change → **browser hard-refresh** (Ctrl/Cmd+Shift+R) only;
- `lib/index.js` change → **restart `dsh web`**.

### Option B — from a built tarball

```bash
cd /path/to/dsh-model-by-preset
npm pack                      # -> dsh-model-by-preset-0.1.0.tgz
dsh plugin --profile web remove dsh-model-by-preset   # only if already installed
dsh plugin --profile web add file:/abs/path/to/dsh-model-by-preset-0.1.0.tgz
```

Then restart `dsh web`. Keep the filename in sync with the version in
`package.json`.

### Option C — from GitHub (public release)

```bash
dsh plugin --profile web add <owner>/dsh-model-by-preset
```

`dsh plugin` forwards to pnpm, which treats `<owner>/<repo>` as a GitHub
dependency: it clones the published repository from `github.com` and installs it
as the plugin package. The repo must be pushed to GitHub first. The `install.py`
`--method C` does the same and takes the owner either from `--owner` or from this
checkout's `origin` git remote (`git remote get-url origin`); there is no
hard-coded default owner.

## Usage

1. Open the editor with the slash command:

   ```
   /model-by-preset
   ```

2. For each preset (read live from your real preset roster — shipped presets and
   locally authored ones alike) choose a model:
   - the **model dropdown lists what your configured providers actually
     advertise** (fetched live via the host `llm.models` catalog, grouped by
     provider — no hard-coded model list), and
   - pick the **reasoning effort**: the dropdown offers the model's own
     advertised levels (`reasoning.efforts`) when the catalog has them, and
     falls back to known levels for the provider family (DeepSeek etc.
     `off | low | high | max`; Ollama `off | on` for `think`). The last item —
     **"type custom…"** — reveals a free-text box for any other value your
     provider accepts (e.g. `medium`), stored verbatim.
   - Leave the model on **"(follow global default)"** for no override.
   - `*` = any other / new preset.

3. Click **Save**. The mapping persists in localStorage
   (`dsh-model-by-preset.overrides`, key `"preset"` → `"provider/model[/effort]"`,
   `"*"` = fallback; debug flag `dsh-model-by-preset.debug`).

4. Create a **new** session on a preset — the model seat should auto-show the
   mapped model/effort for that preset.

Saving applies the new mapping **immediately** — no app restart and no browser
reload are needed for settings changes. (Only edits to the plugin's own
`client.js` need a hard refresh, and edits to `lib/index.js` need a `dsh web`
restart; changing the mapping in the editor needs neither.)

## Files

- `client.js` — browser half (`__ModuleLoader__` format, hand-written, no bundler):
  the whole feature (auto-map + `/model-by-preset` editor window).
- `lib/index.js` — host half: registers the optional debug sink
  `/api-ext/dsh-model-by-preset.debug` (writes
  `$DSH_HOME/dsh-model-by-preset-debug.logl`; used only when the debug toggle in
  the editor is on) and the clear helper
  `/api-ext/dsh-model-by-preset.debug-clear` (deletes that file — the editor has
  a "Clear debug log" button next to the debug toggle).
- `cordis.patch.yml` — inserts the plugin row into the profile composition.
- `package.json` — manifest (`dsh.client.web` + inject client-runtime/connection).
- `install.py` — cross-platform Python installer (repo tool; not shipped in the
  package tarball).

## Verify

1. hard-refresh the page;
2. type `/model-by-preset` → the editor opens: pick model + reasoning effort per
   preset, toggle debug if needed, Save;
3. create a NEW session on a preset; the model seat should auto-show the mapped
   model/effort for that preset (no restart needed after Save);
4. if it does not fire, enable the debug toggle in the editor and check
   `~/.dsh/dsh-model-by-preset-debug.logl` (client logs `scan`/`select` events
   there); the editor's "Clear debug log" button removes the file.

## License

MIT. See [LICENSE](LICENSE).
