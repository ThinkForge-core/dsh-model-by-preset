// dsh-model-by-preset client half (web).
//
// Loaded by the web app's module loader as /plugins/dsh-model-by-preset/client.js.
//
// Features:
//  1. Auto-map a NEW (blank) session's model by its agent preset, using the
//     same `session.selectModel` RPC the model picker issues. Because a blank
//     session is REUSED and only its agentPreset changes, a blank session is
//     re-evaluated whenever its agentPreset changes.
//  2. `/model-by-preset` editor window: rows for EVERY preset the host really
//     serves (agentPreset.list — shipped AND user-authored presets), and for
//     each row a MODEL dropdown built from the host's real model catalog
//     (llm.models: every provider that is configured, with the models that
//     provider advertises) plus a reasoning-EFFORT dropdown fed by that
//     model's own `reasoning.efforts`. A debug-log toggle lives here too.
//     Settings persist in localStorage (`dsh-model-by-preset.overrides`,
//     `dsh-model-by-preset.debug`).
//  3. Debug mirror to /api-ext/dsh-model-by-preset.debug is OFF by default and
//     enabled from the editor (the code stays in place).
//
// Command UI note: in 0.1.1 the command surface only supports `popupSelect`, so
// `/model-by-preset` is a launcher for this plugin's own DOM window.
//
// Format: hand-written `window.__ModuleLoader__.load({ id, factory })` (no bundler).

window.__ModuleLoader__.load({
	id: "dsh-model-by-preset",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		// Empty model value = "no override, follow the global default model".
		var LS_OVERRIDES = "dsh-model-by-preset.overrides";
		var LS_DEBUG = "dsh-model-by-preset.debug";

		// Fallback reasoning-effort levels, keyed by provider family, used only
		// when the model catalog does not advertise `reasoning.efforts` for a
		// model (host adapters advertise them lazily — e.g. Ollama only after a
		// thinking probe). A custom level can always be typed in manually.
		// Mirrors what the shipped adapters expose: DeepSeek off/low/high/max,
		// Ollama a boolean think switch off/on.
		var FALLBACK_DS_EFFORTS = [
			{ id: "off", name: "Off" },
			{ id: "low", name: "Low" },
			{ id: "high", name: "High" },
			{ id: "max", name: "Max" }
		];
		var FALLBACK_OLLAMA_EFFORTS = [
			{ id: "off", name: "Off (think: false)" },
			{ id: "on", name: "On (think: true)" }
		];
		var CUSTOM_EFFORT = "__custom__";

		function providerOf(modelValue) {
			return String(modelValue || "").split("/")[0];
		}
		function providerFamilyOf(modelValue) {
			var p = providerOf(modelValue);
			if (p === "ollama") return "ollama";
			return "other";
		}
		function knownEffortsFor(modelValue) {
			return providerFamilyOf(modelValue) === "ollama"
				? FALLBACK_OLLAMA_EFFORTS
				: FALLBACK_DS_EFFORTS;
		}

		var ONLY_BLANK = true;
		var MAX_RESCAN = 6;
		var RESCAN_DELAY_MS = 700;

		var state = new Map();
		var inFlight = false;
		var rescanLeft = 0;
		var rescanTimer = null;

		// ---- storage: preset -> "provider/model[/effort]" ----
		function readJSON(key) {
			try {
				var raw = localStorage.getItem(key);
				return raw ? JSON.parse(raw) : null;
			} catch (e) { return null; }
		}
		function overrides() { return readJSON(LS_OVERRIDES) || {}; }
		function debugEnabled() {
			try { return localStorage.getItem(LS_DEBUG) === "1"; } catch (e) { return false; }
		}

		function debug(obj) {
			if (!debugEnabled()) return;
			try {
				fetch("/api-ext/dsh-model-by-preset.debug", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(obj)
				}).catch(function () {});
			} catch (e) {}
		}

		function parseStored(v) {
			var parts = String(v || "").split("/");
			// "provider/model[/effort]"
			if (parts.length >= 3) {
				return { modelValue: parts[0] + "/" + parts[1], effort: parts.slice(2).join("/") };
			}
			if (parts.length === 2) {
				return { modelValue: parts[0] + "/" + parts[1], effort: "" };
			}
			return null;
		}
		// Default for every preset: empty model -> "no override" (global default).
		function noOverride() { return { modelValue: "", effort: "" }; }
		function currentRow(preset) {
			var ovr = overrides();
			var raw = ovr[preset] !== undefined ? ovr[preset] : ovr["*"];
			if (raw === undefined) return noOverride();
			var own = parseStored(raw);
			return own || noOverride();
		}
		function rowToTarget(row) {
			if (!row || !row.modelValue) return null;
			var p = row.modelValue.split("/");
			if (p.length < 2) return null;
			return {
				provider: p[0],
				model: p[1],
				reasoningEffort: row.effort || undefined
			};
		}
		function targetFor(preset) {
			return rowToTarget(currentRow(preset));
		}

		function same(a, b) {
			if (!a || !b) return false;
			if (a.provider !== b.provider || a.model !== b.model) return false;
			return (a.reasoningEffort || undefined) === (b.reasoningEffort || undefined);
		}

		// ---- live host data (root api; NOT api.sessions) ----
		function listPresets(api) {
			// agentPreset.list -> { presets: [{ id, trust, isDefault, name?, description?, broken? }], ... }
			return api.agentPresets.list({}).then(function (res) {
				var r = res && res.result;
				if (!r || !r.ok) return null;
				var presets = (r.value && r.value.presets) || [];
				return presets
					.filter(function (p) { return p && p.id && p.broken === undefined; })
					.map(function (p) { return { id: p.id, name: p.name }; });
			}).catch(function () { return null; });
		}
		function listCatalog(api) {
			// llm.models -> { groups: [{ id, name, models: [{ id, name, reasoning?: { efforts:[{id,name}], defaultEffort? } }] }], failures }
			return api.llm.models({}).then(function (res) {
				var r = res && res.result;
				if (!r || !r.ok) return null;
				var value = r.value || {};
				var catalog = {};
				var options = [];
				((value.groups) || []).forEach(function (group) {
					(group.models || []).forEach(function (model) {
						var mv = group.id + "/" + model.id;
						catalog[mv] = {
							reasoning: model.reasoning,
							groupName: group.name || group.id
						};
						options.push({
							value: mv,
							group: group.name || group.id,
							label: (model.name && model.name !== model.id ? model.name + " · " : "") + mv
						});
					});
				});
				return { catalog: catalog, options: options, failures: value.failures || [] };
			}).catch(function () { return null; });
		}

		function currentModel(sessionsApi, sessionId) {
			return sessionsApi
				.models({ sessionId: sessionId })
				.then(function (res) {
					var r = res && res.result;
					if (!r || !r.ok) return null;
					return (r.value && r.value.current) || null;
				})
				.catch(function () { return null; });
		}

		function select(sessionsApi, sessionId, target, ctx) {
			var payload = { sessionId: sessionId, provider: target.provider, model: target.model };
			if (target.reasoningEffort !== undefined) payload.reasoningEffort = target.reasoningEffort;
			return sessionsApi.selectModel(payload).then(function (res) {
				var r = res && res.result;
				var line =
					"=> " + target.provider + "/" + target.model +
					(target.reasoningEffort ? " (" + target.reasoningEffort + ")" : "") +
					" " + (r && r.ok ? "ok" : "err " + JSON.stringify(r && r.error)) +
					" session=" + sessionId;
				if (debugEnabled()) (ctx.logger || console).info("dsh-model-by-preset: " + line);
				debug({ kind: "select", line: line, sessionId: sessionId });
			});
		}

		function scheduleRescan(ctx, sessionsApi) {
			if (rescanLeft <= 0 || inFlight) return;
			rescanLeft -= 1;
			if (rescanTimer !== null) return;
			rescanTimer = setTimeout(function () {
				rescanTimer = null;
				scan(ctx, sessionsApi);
			}, RESCAN_DELAY_MS);
		}

		function scan(ctx, sessionsApi) {
			if (inFlight) return;
			var sessions = ctx.get && ctx.get("sessions");
			var list = sessions && sessions.list;
			if (!list) return;
			var snap;
			try { snap = list.getSnapshot(); } catch (e) { return; }
			var byId = snap && (snap.byId || snap.entries);
			if (!byId) return;
			var ids = Object.keys(byId);
			var pending = [];
			var unknown = 0;
			for (var i = 0; i < ids.length; i++) {
				var id = ids[i];
				var row = byId[id];
				if (!row) continue;
				var preset = row.agentPreset;
				var rec = state.get(id);
				if (ONLY_BLANK && row.blank !== true) {
					if (!rec || !rec.closed) state.set(id, { closed: true });
					continue;
				}
				if (rec && rec.closed) continue;
				if (!preset) { unknown += 1; continue; }
				if (rec && rec.preset === preset) continue;
				var t = targetFor(preset);
				if (!t) continue; // no override for this preset -> leave as-is
				pending.push({ id: id, target: t, preset: preset });
			}
			debug({
				kind: "scan",
				listSize: ids.length,
				unknownPreset: unknown,
				pending: pending.map(function (x) { return { id: x.id.slice(0, 12), preset: x.preset, target: x.target }; })
			});
			if (unknown > 0) scheduleRescan(ctx, sessionsApi);
			if (pending.length === 0) return;
			inFlight = true;
			Promise.resolve()
				.then(function () {
					var chain = Promise.resolve();
					pending.forEach(function (item) {
						chain = chain.then(function () {
							return currentModel(sessionsApi, item.id).then(function (cur) {
								if (!same(cur, item.target)) {
									return select(sessionsApi, item.id, item.target, ctx);
								}
								debug({ kind: "skip-same", sessionId: item.id.slice(0, 12), cur: cur });
								return;
							}).then(function () {
								state.set(item.id, { preset: item.preset });
							});
						});
					});
					return chain;
				})
				.catch(function (err) {
					(ctx.logger || console).warn(
						"dsh-model-by-preset: auto-select failed: " + String((err && err.message) || err)
					);
					debug({ kind: "error", message: String((err && err.message) || err) });
				})
				.finally(function () {
					inFlight = false;
				});
		}

		// ── editor window (opened by /model-by-preset) ─────────────────────
		var overlayEl = null;

		function cssBtn() {
			return {
				border: "1px solid #3a3d48", background: "#24262e", color: "#d7d9e0",
				borderRadius: "6px", padding: "5px 12px", cursor: "pointer", fontSize: "13px"
			};
		}
		function cssField() {
			return {
				background: "#101116", color: "#d7d9e0", border: "1px solid #3a3d48",
				borderRadius: "6px", padding: "5px 8px", fontSize: "13px"
			};
		}

		function closeEditor() {
			if (overlayEl && overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
			overlayEl = null;
		}

		// effort dropdown for one model:
		//   ""        -> provider default (no explicit effort)
		//   levels    -> the model's own reasoning.efforts when the catalog
		//                advertises them, else known levels for the provider
		//                family (DeepSeek off/low/high/max, Ollama off/on)
		//   __custom__-> reveal a free-text input so any other value can be
		//                typed (stored verbatim, validated by the host on use)
		// The control always stays enabled so it is visibly clickable.
		function effortOptionsFor(modelValue, catalog) {
			var entry = (catalog && modelValue && catalog[modelValue]) || null;
			var advertised = (entry && entry.reasoning && entry.reasoning.efforts) || null;
			if (advertised && advertised.length > 0) return advertised;
			return knownEffortsFor(modelValue);
		}
		function fillEffort(sel, customInput, modelValue, current, catalog) {
			sel.innerHTML = "";
			sel.disabled = false;
			var base = document.createElement("option");
			base.value = "";
			base.textContent = "(provider default)";
			sel.appendChild(base);
			var opts = effortOptionsFor(modelValue, catalog) || [];
			opts.forEach(function (effort) {
				var o = document.createElement("option");
				o.value = effort.id;
				o.textContent = effort.name || effort.id;
				sel.appendChild(o);
			});
			var cust = document.createElement("option");
			cust.value = CUSTOM_EFFORT;
			cust.textContent = "type custom…";
			sel.appendChild(cust);
			// choose: stored value if it is a known level; empty by default
			var knownIds = [""].concat(opts.map(function (e) { return e.id; }));
			var isKnown = knownIds.indexOf(current) >= 0;
			if (current && !isKnown) {
				// previously stored value is not in the offered set -> show it as custom
				sel.value = CUSTOM_EFFORT;
				customInput.value = current;
				customInput.style.display = "";
				customInput.focus && customInput.focus();
			} else {
				sel.value = current && isKnown ? current : "";
				customInput.value = "";
				customInput.style.display = "none";
			}
		}

		async function openEditor(ctx, rootApi, sessionsApi) {
			if (overlayEl) closeEditor();
			var modelSelects = {};
			var effortSelects = {};
			var effortCustomInputs = {};
			var rowPresets = [];
			var catalog = null;

			var overlay = document.createElement("div");
			overlayEl = overlay;
			Object.assign(overlay.style, {
				position: "fixed", inset: "0", zIndex: "2147483000", display: "flex",
				alignItems: "center", justifyContent: "center",
				background: "rgba(0,0,0,0.55)", fontFamily: "inherit"
			});
			var panel = document.createElement("div");
			Object.assign(panel.style, {
				background: "#191a20", color: "#d7d9e0", border: "1px solid #33353f",
				borderRadius: "10px", width: "760px", maxWidth: "94vw",
				maxHeight: "84vh", overflow: "auto", padding: "16px 18px",
				boxShadow: "0 12px 40px rgba(0,0,0,0.5)"
			});
			overlay.appendChild(panel);
			overlay.addEventListener("mousedown", function (e) {
				if (e.target === overlay) closeEditor();
			});
			document.body.appendChild(overlay);

			var header = document.createElement("div");
			Object.assign(header.style, {
				display: "flex", justifyContent: "space-between", alignItems: "center",
				marginBottom: "12px", fontSize: "15px", fontWeight: "600"
			});
			header.textContent = "Model & reasoning effort per preset";
			var closeBtn = document.createElement("button");
			closeBtn.textContent = "✕";
			Object.assign(closeBtn.style, cssBtn());
			closeBtn.onclick = closeEditor;
			header.appendChild(closeBtn);
			panel.appendChild(header);

			var hint = document.createElement("div");
			hint.style.cssText = "color:#8b8f9c;font-size:12px;margin:0 0 10px;line-height:1.5";
			hint.textContent =
				"Applied to new (blank) sessions only; sessions with history are left alone (manual picks win). " +
				"Model list = what your configured providers advertise; empty = follow the global default model.\n" +
				"Save applies the new mapping immediately (no app restart, no browser reload) to blank sessions " +
				"that still match an unmapped preset — open a new session on a preset to see its model.";
			hint.style.whiteSpace = "pre-line";
			panel.appendChild(hint);

			var statusEl = document.createElement("div");
			statusEl.style.cssText = "color:#8b8f9c;font-size:12px;margin:0 0 8px";
			statusEl.textContent = "Loading presets & model catalog…";
			panel.appendChild(statusEl);

			// column captions
			var cap = document.createElement("div");
			Object.assign(cap.style, {
				display: "flex", alignItems: "center", gap: "10px",
				color: "#8b8f9c", fontSize: "12px", padding: "2px 0 6px", borderBottom: "1px solid #26282f"
			});
			var c1 = document.createElement("div"); c1.style.cssText = "width:180px;flex:0 0 180px"; c1.textContent = "Preset";
			var c2 = document.createElement("div"); c2.style.cssText = "flex:1"; c2.textContent = "Model";
			var c3 = document.createElement("div"); c3.style.cssText = "width:250px;flex:0 0 250px"; c3.textContent = "Reasoning effort";
			cap.appendChild(c1); cap.appendChild(c2); cap.appendChild(c3);
			panel.appendChild(cap);

			// rows land here (populated asynchronously from the live roster)
			var rowsEl = document.createElement("div");
			panel.appendChild(rowsEl);

			var dline = document.createElement("div");
			Object.assign(dline.style, { display: "flex", alignItems: "center", gap: "10px", padding: "10px 0", flexWrap: "wrap" });
			var debugCheck = document.createElement("input");
			debugCheck.type = "checkbox";
			debugCheck.checked = debugEnabled();
			var dl = document.createElement("label");
			dl.style.cssText = "font-size:13px;color:#c5c8d2";
			dl.textContent = "Debug log to file (~/.dsh/dsh-model-by-preset-debug.logl)";
			dline.appendChild(debugCheck);
			dline.appendChild(dl);

			var clearBtn = document.createElement("button");
			clearBtn.textContent = "🗑 Clear debug log";
			Object.assign(clearBtn.style, cssBtn(), { marginLeft: "8px" });
			var clearState = document.createElement("span");
			clearState.style.cssText = "font-size:12px;color:#8b8f9c";
			clearState.textContent = "";
			clearBtn.onclick = function () {
				clearBtn.disabled = true;
				clearState.textContent = "…";
				fetch("/api-ext/dsh-model-by-preset.debug-clear", { method: "POST" })
					.then(function (res) { return res.json(); })
					.then(function (r) {
						clearState.textContent = r && r.ok ? "log deleted" : "failed";
					})
					.catch(function () { clearState.textContent = "failed"; })
					.finally(function () { clearBtn.disabled = false; });
			};
			dline.appendChild(clearBtn);
			dline.appendChild(clearState);
			panel.appendChild(dline);

			var footer = document.createElement("div");
			Object.assign(footer.style, { display: "flex", justifyContent: "flex-end", gap: "10px", marginTop: "12px" });
			var cancelBtn = document.createElement("button");
			cancelBtn.textContent = "Close";
			Object.assign(cancelBtn.style, cssBtn());
			var saveBtn = document.createElement("button");
			saveBtn.textContent = "Save";
			Object.assign(saveBtn.style, cssBtn(), { background: "#2e5bff", color: "#fff", fontWeight: "600" });
			footer.appendChild(cancelBtn);
			footer.appendChild(saveBtn);
			panel.appendChild(footer);
			cancelBtn.onclick = closeEditor;

			// render one row per preset
			function renderRows() {
				rowsEl.innerHTML = "";
				rowPresets.forEach(function (preset) {
					var row = currentRow(preset.id);
					var line = document.createElement("div");
					Object.assign(line.style, {
						display: "flex", alignItems: "center", gap: "10px",
						padding: "6px 0", borderBottom: "1px solid #26282f"
					});
					var label = document.createElement("div");
					label.style.cssText = "width:180px;flex:0 0 180px;font-size:13px;color:#c5c8d2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
					label.title = preset.id;
					label.textContent = preset.id === "*"
						? "any other / new preset"
						: (preset.name && preset.name !== preset.id ? preset.name + "  (" + preset.id + ")" : preset.id);
					line.appendChild(label);

					var msel = document.createElement("select");
					Object.assign(msel.style, cssField(), { flex: "1", minWidth: "0" });
					// empty option = follow the global default
					var auto = document.createElement("option");
					auto.value = "";
					auto.textContent = "(follow global default)";
					msel.appendChild(auto);
					// group options by provider
					var groups = {};
					(catalog ? catalog.options : []).forEach(function (opt) {
						if (!groups[opt.group]) {
							groups[opt.group] = document.createElement("optgroup");
							groups[opt.group].label = opt.group;
							msel.appendChild(groups[opt.group]);
						}
						var o = document.createElement("option");
						o.value = opt.value;
						o.textContent = opt.label;
						groups[opt.group].appendChild(o);
					});
					// keep any previously stored model that the catalog no longer lists
					if (row.modelValue && catalog && !catalog.catalog[row.modelValue]) {
						var extra = document.createElement("option");
						extra.value = row.modelValue;
						extra.textContent = row.modelValue + " (not in catalog)";
						msel.appendChild(extra);
					}
					msel.value = row.modelValue;

					// effort: select (levels or "type custom…") + hidden text input
					var effortCell = document.createElement("div");
					Object.assign(effortCell.style, {
						width: "250px", flex: "0 0 250px", display: "flex", gap: "6px", alignItems: "center"
					});
					var esel = document.createElement("select");
					Object.assign(esel.style, cssField(), { flex: "1", minWidth: "0" });
					var einput = document.createElement("input");
					einput.type = "text";
					einput.placeholder = "e.g. medium";
					einput.spellcheck = false;
					Object.assign(einput.style, cssField(), { flex: "0 0 130px", display: "none" });
					fillEffort(esel, einput, msel.value, row.effort, catalog);
					esel.onchange = function () {
						if (esel.value === CUSTOM_EFFORT) {
							einput.style.display = "";
							einput.focus();
						} else {
							einput.style.display = "none";
						}
					};
					msel.onchange = function () {
						fillEffort(esel, einput, msel.value, "", catalog);
					};

					modelSelects[preset.id] = msel;
					effortSelects[preset.id] = esel;
					effortCustomInputs[preset.id] = einput;
					effortCell.appendChild(esel);
					effortCell.appendChild(einput);
					line.appendChild(msel);
					line.appendChild(effortCell);
					rowsEl.appendChild(line);
				});
			}

			saveBtn.onclick = function () {
				var next = overrides() || {};
				rowPresets.forEach(function (preset) {
					var modelValue = modelSelects[preset.id].value;
					if (!modelValue) { delete next[preset.id]; return; }
					var raw = effortSelects[preset.id].value;
					var effort = raw === CUSTOM_EFFORT
						? String(effortCustomInputs[preset.id].value || "").trim()
						: raw;
					next[preset.id] = effort ? modelValue + "/" + effort : modelValue;
				});
				try {
					localStorage.setItem(LS_OVERRIDES, JSON.stringify(next));
					localStorage.setItem(LS_DEBUG, debugCheck.checked ? "1" : "0");
				} catch (e) {}
				state.forEach(function (rec, id) { if (!rec.closed) state.delete(id); });
				closeEditor();
				scan(ctx, sessionsApi);
			};

			// populate rows from the REAL preset roster + REAL model catalog
			var roster = await listPresets(rootApi);
			if (!overlayEl) return; // closed while loading
			if (!roster || roster.length === 0) {
				statusEl.textContent = "No presets returned by agentPreset.list — nothing to map.";
				return;
			}
			catalog = await listCatalog(rootApi);
			if (!overlayEl) return;
			rowPresets.length = 0;
			roster.forEach(function (p) { rowPresets.push({ id: p.id, name: p.name }); });
			rowPresets.push({ id: "*", name: "" });
			var failNote = catalog && catalog.failures && catalog.failures.length
				? " (" + catalog.failures.length + " provider(s) failed to load)"
				: "";
			statusEl.textContent = "Presets: " + rowPresets.length +
				(catalog ? " · models: " + catalog.options.length + failNote : " · model catalog unavailable");
			renderRows();
		}

		// ── plugin ─────────────────────────────────────────────────────────
		function apply(ctx) {
			var connection = ctx.get && ctx.get("connection");
			var sessions = ctx.get && ctx.get("sessions");
			var rootApi = connection && connection.api; // sessions + agentPresets + llm + ...
			var sessionsApi = rootApi && rootApi.sessions;
			if (!rootApi || !sessionsApi || !sessions || !sessions.list) {
				(ctx.logger || console).warn(
					"dsh-model-by-preset: missing connection.api(.sessions) or sessions.list; disabled"
				);
				return;
			}
			var dispose = sessions.list.subscribe(function () {
				rescanLeft = MAX_RESCAN;
				scan(ctx, sessionsApi);
			});
			scan(ctx, sessionsApi);
			if (dispose && typeof dispose === "function") ctx.on("dispose", dispose);

			ctx.inject(["commandUi"], function (scope) {
				var command = scope.get("commandUi");
				scope.effect(function () {
					return command.register({
						name: "model-by-preset",
						description: "Model & reasoning effort per preset",
						available: function () { return true; },
						ui: {
							kind: "popupSelect",
							options: async function () {
								return [{
									id: "open",
									label: "Open dsh-model-by-preset editor",
									detail: "model + reasoning effort per preset (empty = global default)"
								}];
							},
							onSelect: async function () {
								openEditor(ctx, rootApi, sessionsApi);
							}
						}
					});
				}, "dsh-model-by-preset: /model-by-preset contribution");
			});
		}

		exports.apply = apply;
		exports.inject = ["sessions", "connection", "commandUi"];
		return module.exports;
	}
});
