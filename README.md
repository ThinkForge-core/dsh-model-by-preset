# dsh-model-by-preset

Client (browser) plugin for **DeepSeek Harness web** that makes every **new**
session open on the model (and reasoning effort) configured for its **agent
preset** — so a model you pick in one preset no longer leaks into the others.

- Only **new blank** sessions are auto-mapped. Sessions that already have
  history are never touched — a manual pick always wins.
- Presets you leave un-configured keep the global default model.
- A fallback row (`*`) covers any other / future preset.

Full documentation (design, install options, usage, files, verification):
[`.github/README.md`](https://github.com/ThinkForge-core/dsh-model-by-preset/blob/main/.github/README.md).

## Install

```bash
dsh plugin --profile web add dsh-model-by-preset
```

Then restart `dsh web`.

For development installs (from a local checkout) and other installation methods,
see the full documentation linked above.

## Usage

1. Open the editor with the slash command:
   ```
   /model-by-preset
   ```
2. For each preset pick a model and a reasoning effort — the model dropdown
   lists what your configured providers actually advertise; the effort dropdown
   offers the model's own levels (with a "type custom…" option for anything
   else). Leave a preset on "(follow global default)" for no override.
3. Click **Save** — the mapping applies immediately (no restart, no reload).
4. Create a **new** session on that preset — the model seat auto-shows the pick.

The mapping is stored in the browser (`dsh-model-by-preset.overrides` in
localStorage); a debug toggle is available in the editor.

## Requirements

- DeepSeek Harness **web** profile.
- Developed and verified against **DSH `0.1.1-rc.2`**. Functionality on another
  version of DeepSeek Harness is **not guaranteed**.
- The provider(s)/model(s) you want to auto-assign must already be configured in
  your harness. This plugin only *selects* a model — it does not create providers.

## License

MIT. See [LICENSE](LICENSE).
