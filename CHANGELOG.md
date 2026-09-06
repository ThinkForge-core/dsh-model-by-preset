# Changelog

## 0.1.0 — 2026-09-06

Initial public release under the name **dsh-model-by-preset** (rebranded and
generalised from a personal `dsh-preset-model` prototype).

- Auto-map a **new blank session's** model (provider + reasoning effort) from a
  per-agent-preset override, using the same `session.selectModel` RPC the model
  picker uses.
- `/model-by-preset` editor window: rows for **every preset the host really
  serves** (`agentPreset.list` — shipped and user-authored presets alike), each
  with a model dropdown built live from the host model catalog (`llm.models`:
  whatever your configured providers advertise, grouped by provider) and a
  reasoning-effort dropdown: the model's own `reasoning.efforts` when the
  catalog has them, falling back to known levels for the provider family
  (DeepSeek `off|low|high|max`, Ollama `off|on`), plus a free-text "type
  custom…" option for any other value. No hard-coded preset lists.
- Used (non-blank) sessions are never touched — manual picks always win.
- Debug sink: `POST /api-ext/dsh-model-by-preset.debug` writes
  `$DSH_HOME/dsh-model-by-preset-debug.logl` (off unless toggled), and
  `POST /api-ext/dsh-model-by-preset.debug-clear` deletes it (editor button
  "Clear debug log").
- Generalisation: removed the personal `qwen-chat-lite` → local-Ollama default;
  every preset defaults to "follow the global default" (empty override).
- Added `install.py` — a cross-platform (Linux/macOS/Windows) Python 3
  installer that discovers the DSH layout and toolchain and installs by dev
  symlink, tarball or GitHub repo (`<owner>/<repo>`, owner from `--owner` or the
  checkout's origin git remote; interactive menu, `--method`, `--dry-run`,
  `--list`, uninstall). Not shipped inside the package tarball.
