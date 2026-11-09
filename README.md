# pi-auto

### Selection diagnostics and reuse

`/auto status` summarizes up to 100 valid decisions on the current branch: selector/default/no-call outcomes, P50/P95 latency, effort transitions and reported catalog costs with coverage. Missing estimates are not treated as free usage; these are not invoice totals.

Classifier failures record the failing stage. Numeric HTTP status and allowlisted provider codes are saved only when exposed as structured error properties; Pi may normalize failures to a generic result, so those fields can remain unknown. Error messages, bodies, headers and credentials are never parsed or saved.

Step mode reuses unchanged clipboard attachments only within the current task, revalidating file identity before reuse. Overlapping unresolved failures reference their zero-based `recentToolIndex`; full tool text is transmitted once, not truncated. Steering still reselects before request reasoning is captured: skipping based on pending-message flags is unsafe because they include follow-ups.


English | [简体中文](./README.zh-CN.md)

A Pi extension that automatically selects the current model's thinking effort before each task. **It adjusts effort only—never switches your model.**

This is a compatibility-maintenance fork of [ekil1100/pi-auto](https://github.com/ekil1100/pi-auto). The npm package `pi-auto` still belongs to upstream; this fork does not publish it.

## Install and use

Requires Node.js **22.19.0 or later** and Pi **0.99.0 or later**. Older Pi versions are not supported: pi-auto disables selection and asks you to upgrade instead of using the old TypeSafe SDK.

For an npm-installed Pi, upgrade and restart before updating this extension:

```bash
npm install -g @earendil-works/pi-coding-agent@latest
```

```bash
pi install git:github.com/honbolau/pi-auto
```

If upstream `npm:pi-auto` is already installed, remove it with `pi remove npm:pi-auto` before installing this fork to avoid duplicate `/auto` registrations.

Choose your chat model with `/model`; no scoped-model configuration is needed. The extension starts enabled unless you save a different startup default. The footer shows only `auto` and the selected selector model, for example `auto · typesafe/jev-latest`.

## Selection modes

The default is **turn**: select once at the beginning of each user task. Existing configurations keep this behavior.

- `/auto mode step`: save experimental per-model-call selection; requires **Pi 0.99.0+** and a physical answering model.
- `/auto mode turn`: save the original once-per-user-task behavior.
- Mode changes preserve the selector and startup default; they do not enable a disabled instance. Switching modes discards pending selection; step selection starts with the next user task.

Step mode retains the full current user goal and adds the latest assistant text, up to four recent tool results and four unresolved failures, and an available active compaction summary. It bounds the number of results, not their text: retained results and the user goal are not clipped. Earlier task/compaction boundaries are not crossed. A successful rerun of the **same tool with the same arguments** resolves its prior failure; a successful edit or unrelated check does not. Different commands that happen to verify the same condition are not inferred equivalent.

The first call is selected in `before_agent_start`; later agent-loop calls are selected at `turn_start`, before Pi refreshes the physical request's thinking level. Steering inserted after that boundary is reselected before dispatch. Direct SDK calls and compaction summaries do not trigger this loop hook. Extension-authored custom runs keep their effort without selection. The physical model is never changed. Provider payloads are unchanged unless the optional Codex cache preservation below is enabled. Changing effort can affect prompt caching; cache savings are not guaranteed.

Step selection shares **one 4-second deadline**, including first-time backend discovery, availability, authentication and selection. Failure goes directly to Pi's configured default effort, without an answering-model selection retry. Cancellation retains the current effort. Existing turn-mode deadlines and fallback remain unchanged.

Manually changing effort pauses step selection for the current instance, including later user tasks. The footer shows `auto step paused`; `/auto on` or an explicit mode selection resumes it. For a fixed effort across restarts, use `/auto default off`. Pi versions below 0.99.0 are unsupported; step selection does not require Pi 1.5-specific APIs. Virtual answering models are not supported in step mode.

**Privacy:** enabling step mode sends tool-result text and intermediate assistant progress to the saved selector provider without redaction, in addition to the existing task context. Standalone tool-call arguments and thinking blocks are excluded, but tool output can itself contain secrets or echo arguments. No extra model is called to summarize history. Execution input is not copied into diagnostics, but selector reasons or debug responses may repeat it; step decisions record `mode: "step"`. Use a trusted selector or keep step mode disabled for sensitive work.

## Experimental Codex cache preservation

Enable with **`/auto cache on`**, disable with `/auto cache off`. The `codexCache` flag is saved in `pi-auto.json` and defaults to **false**. It is independent of turn/step mode and automatic selection: when enabled, manual effort changes are also adapted, even with `/auto off`.

- **Model eligibility:** GPT-6 and later reasoning models under `openai-codex` (including Astra, Luna, Sol, and Terra variants), using `openai-codex-responses` on the official HTTPS `chatgpt.com/backend-api` Codex endpoint. Other models, custom endpoints, API-key Responses requests, and virtual models are unchanged.
- The first eligible request pins its request-level `reasoning.effort`. Later changes append `configuration_update` items, including directly after tool results. Earlier updates replay in their original positions so the old input prefix remains unchanged. This changes wire formatting, not the selected effort or physical model.
- Session custom entries store effort levels, positions, and SHA-256 input/settings fingerprints, **not prompt text, tool results, credentials, or complete payloads**. Reload/resume/fork/tree navigation restore only the active branch. Identical retries do not duplicate entries; cancelled attempts may leave a checkpoint that is replayed consistently.
- Successful compaction, model selection, changed earlier input/request settings, or a cache-toggle transition establishes a new baseline. Failed/cancelled compaction does not reset it. Summary/selector requests are excluded by their routing key. Existing native configuration updates are left alone; do not stack competing payload adapters.
- This avoids effort-induced prefix changes; it does **not** guarantee cache hits, prevent expiry, or preserve a prefix that other extensions edit. A new baseline may cause a cold request. Unsupported/malformed payloads keep normal Pi behavior. If session metadata cannot be saved, Pi reports the extension error and retains the original request; the failed adaptation can miss cache.

Model eligibility follows the documented GPT-6+ family; it is not a per-model server capability probe. Unavailable models still fail through normal Pi/provider handling without changing endpoints or retrying another model. The full plugin path was live-tested on Pi 1.5.0 with the Codex login, a tool continuation, and a reopened session for `gpt-6-astra`, `gpt-6-luna`, `gpt-6-sol`, `gpt-6.1-sol`, and `gpt-6.1-terra`. Individual requests can still report zero cache reads; protocol acceptance and prefix preservation do not guarantee cache hits. Separate low/max controls provided behavioral evidence that updates affect reasoning; token counts are not a server-issued effective-effort receipt. No OpenAI API key or extra proxy is required for this tested path.

The descriptions below refer to default **turn** behavior unless step mode is explicitly mentioned.

## Choose the effort selector

Run **`/auto model`** to open a two-tab picker:

- **`chat model`** lists available chat models supported by Pi's `/model`.
- **`system one`** lists available classifiers, including Jev when configured.

Both tabs save an explicit **provider and model ID**. A chat selector is a fixed judge: switching the answering model with `/model` does **not** change it. There is no generic Current chat model row or Auto option.

The picker replaces the bottom input area, like Pi's `/model`; it is **not an overlay**. It opens the saved selector's tab. Use **Tab** to switch tabs, search by name/provider/ID, **↑↓** to navigate, **Enter** to save, and **Esc** to cancel. The search is retained across tabs. Pi's configurable selection keys and native theme apply. Rows follow Pi 0.99.1's format: `→ ✓ model-id [provider]`, with fixed cursor/checkmark columns; the display name appears only below the list as `Model Name:`. Unavailable saved models are reported, not silently replaced or marked as selected. RPC, JSON, and print modes explain that an interactive TUI is required.

**The answering model owns the effort options and receives the final effort.** The fixed chat judge uses the existing `streamSimple()` selection prompt, with its own supported reasoning effort and output-token limit; it never becomes the answering model.
When no backend has been saved, pi-auto asynchronously asks Pi for **available classifier models with configured credentials**, not just catalog entries:

1. Prefer `typesafe/jev-latest` if available.
2. Otherwise choose the first classifier in stable `provider/id` order.
3. If none are available, save the answering model as a fixed `chat` selector. Without an answering model, leave the selector explicitly unselected; `/auto model` remains usable.

The choice is saved in `<agent-dir>/pi-auto.json`. First-time classifier selection produces an English notice explaining that it will receive your current task and recent-turn selection context, and that `/auto model` changes the choice. A saved choice is respected even if classifiers become available later. If a saved classifier or chat selector becomes unavailable, only that attempt falls back to the answering model; the saved choice is not replaced. Discovery or persistence failures do not silently save a different default.

Authentication and availability belong to Pi, through `getAvailableOfType()` and `classify()`. Configure credentials with Pi's `/login`, `auth.json`, `models.json`, or supported provider environment variables. **Environment variables are not pi-auto backend switches.** Stored credentials alone can make a classifier available; setting or unsetting `TYPESAFE_API_KEY` does not override a saved choice. Arbitrary Pi classifier providers and IDs are supported, not just Jev.

**Choosing either a classifier or a chat selector sends the current task and recent-turn context to that selector's provider without automatic redaction.** Image-capable classifiers receive current-turn attachments and, in step mode, the latest current-task tool screenshots. Images are deduplicated and processed using Pi's public resize API (Jev: at most 1568 pixels per side, minimum 280 per side). Request budgets include text, base64, and a conservative processed-image allowance; provider count limits are respected when catalogued, not a universal four-image cap. Unsupported, invalid, too-small, or over-budget groups explicitly warn and use text-only selection without partial images. Small images are not automatically padded; formats Pi cannot normalize are rejected locally. Chat selectors and fallback remain text-only. Old user tasks and pre-compaction tool images are excluded. Raw tool results are not sent directly, but assistant replies may contain information obtained through tools. For sensitive tasks, explicitly select a model from a trusted provider or run `/auto off`. The answering provider receives the same selection context on fallback. For direct TypeSafe usage, see the [TypeSafe privacy policy](https://typesafe.ai/legal/privacy-policy).

### Proxy support

Classifier selection uses **Pi's shared HTTP runtime**, not an extension-owned connection pool. In the standard Pi CLI, **`NODE_USE_ENV_PROXY=1` is not required**.

- Pi reads `http_proxy`, `https_proxy`, and `no_proxy`, plus their uppercase variants; lowercase takes precedence. HTTPS falls back to `http_proxy` when `https_proxy` is not configured.
- Pi's global `httpProxy` setting can supply proxy defaults. `ALL_PROXY` / `all_proxy` alone is not supported by this HTTP path; also set `https_proxy`.
- These are Pi-wide settings, not settings isolated to the classifier. The extension does not replace `fetch`, install a dispatcher, or retry the classifier directly after a proxy failure. The current model takes over selection using its own Pi-managed connection.
- Embedded Pi hosts must configure their own HTTP runtime; the extension does not install a proxy layer for them.

Restart Pi after changing proxy variables in its launch terminal.

## Commands

| Command | Action |
| --- | --- |
| `/auto` or `/auto toggle` | Toggle automatic selection |
| `/auto on` | Enable automatic selection |
| `/auto off` | Disable automatic selection and cancel a pending selection |
| `/auto model` | Choose and save the selector backend in the bottom input area |
| `/auto status` | Inspect the backend, effort, and latest selection |
| `/auto mode turn` / `/auto mode step` | Save once-per-task or experimental per-model-call selection |
| `/auto default on` | Enable automatic selection now and save on as the startup default |
| `/auto default off` | Disable automatic selection now, cancel a pending selection, and save off as the startup default |
| `/auto cache on` / `/auto cache off` | Save the opt-in Codex cache-preserving effort adapter |

`/auto`, `/auto on`, and `/auto off` affect only the current extension instance. `/auto default on|off` saves a global startup default and immediately applies it to the current instance. `default off` also cancels a pending selection. Other running instances are unaffected; restarting or reloading uses the saved default.

The startup default and selector backend are saved in `<agent-dir>/pi-auto.json` (normally `~/.pi/agent/pi-auto.json`; respects `PI_CODING_AGENT_DIR`). Without this file, selection starts enabled and initializes a saved backend as described above. Invalid or unreadable settings disable selection with a warning; a failed save leaves the current state unchanged. Backend writes preserve `defaultEnabled` and other fields; startup-default writes preserve the backend. Repair invalid JSON before saving again. Pi's own `settings.json` is not modified.

The backend schema is `{ "type": "chat" | "classifier", "provider": "...", "id": "..." }`; omitting `backend` means no saved selection. For example:

```json
{
  "defaultEnabled": true,
  "backend": { "type": "chat", "provider": "openai", "id": "gpt-5" }
}
```

For a classifier, use `"type": "classifier"` with its Pi provider/ID, such as `typesafe/jev-latest`. An initial experimental `{ "type": "current-model" }` setting is rewritten once to the answering model's explicit chat identity during initialization. It is not a runtime backend. If no answering model exists, the file is left intact and the picker shows an unselected state until a model can be chosen. A failed rewrite or picker save leaves the original configuration intact.

To use a fixed effort, run `/auto off`, then choose a level with `/thinking`. Disabling automatic selection does **not** set effort to `off`.

### Inspect a selection

The footer shows `auto · provider/id` for the selected selector model, or `auto · Not selected` when none is selected. It does not show effort, `selector:`, `last:`, or fallback details; fallback does not replace the selected model in the footer. Use `/auto status` to inspect the actual backend and latest selection details. Disabling auto hides the footer.
Selection results appear in the conversation, collapsed by default, with the actual backend and total time, for example `auto · high · typesafe/jev-latest · 0.53s`. The total includes fallback attempts. IDs refer to Pi's configured catalog/request model, not a resolved server version. Use the default **Ctrl+O** shortcut to expand the effort change, reason, exact selector model, elapsed time, and context summary.

In an interactive terminal, `/auto status` opens a read-only overlay with three pages:

- **Overview:** configured backend, Pi-reported availability, latest actual backend, result and reason, with failure reasons shown first.
- **Context:** source IDs, roles, character ranges, history length, and omission indicators for the latest turn. Message text is not displayed; missing metadata in older records is marked as unrecorded.
- **Diagnostics:** per-attempt outcomes, deadlines and interruption sources; chat-selector stop reason, content types and response length; policy, effort probabilities, usage and request timing.

Default controls: **Tab** to change pages, **↑↓ / PageUp / PageDown** to scroll, **j / k** to scroll down/up, and **Esc** to close. Explicit custom keybindings take precedence over j/k aliases; follow the displayed hints.

The view is a snapshot taken when opened. Inspecting it does not call a model, rerun selection, or change effort. It shows selection metadata, not request payloads. RPC clients receive the same grouped information as a text notification.

### Debug selector responses

Chat-selector response metadata is saved in session JSONL entries of type `pi-auto-decision`, under `selectorResponses.effort`. It includes stop reasons, content block types, and text length, also visible on the Diagnostics page of `/auto status`. `selectorAttempts` records each backend's outcome, elapsed time, deadline and interruption source (`deadline`, `escape`, `runtime`, `auto-off`, `settings-changed`, `session-shutdown`, or `provider`). Older records without these fields are marked as unrecorded; a provider abort is not assumed to be a local timeout. Invalid decisions report `not_json_object`, `invalid_json`, `missing_effort`, `invalid_effort_type`, or `unsupported_effort`.

Classifiers save `classifierDiagnostics` with their last local stage (`request`, `validation`, or `complete`), an error code, and the native `stopReason` when a result is received. Local validation operates on Pi's normalized answers, not the original HTTP response. Diagnostics remain available after current-model fallback.

`classifierTiming` records the full `classify()` duration (including runtime authentication), local validation time, total adapter time, and runtime-reported input/output tokens and catalog cost when available. HTTP status, request size, header/body timings, socket reuse, connection time, and upload timing are no longer recorded. Missing data is not reconstructed from error text. Saved decisions remain readable; unsupported diagnostic fields are ignored without changing the session file.

| Classifier error codes | Meaning |
| --- | --- |
| `request_cancelled` | Caller signal aborted; `selectorAttempts.interruption` identifies the deadline or cancellation source |
| `request_failed` | Runtime authentication, HTTP, transport, decoding, or native parsing failure; provider error text is deliberately omitted |
| `provider_aborted` | Native result reported `aborted` without local cancellation |
| `model_unavailable` | The saved classifier is unavailable in Pi (model or credentials missing) |
| `invalid_envelope`, `invalid_model`, `invalid_answers`, `missing_effort`, `unexpected_answers` | Defensive validation of the normalized result or answers |
| `invalid_effort_answer`, `invalid_answer_type`, `unsupported_effort` | Invalid normalized effort answer or unsupported effort |
| `invalid_confidence`, `invalid_probabilities`, `probability_keys_mismatch`, `invalid_probability` | Invalid confidence, probability object, option keys, or probability values |
| `probability_sum`, `choice_not_max` | Probability sum outside rounding tolerance, or chosen effort is not a highest-probability option |

Pi rejects some malformed responses before returning answers; those failures appear as `request_failed`, not a local validation code. Extra wire-level answers and the server's model version are normalized away by Pi and cannot be inspected here. The authoritative deadline diagnosis is `selectorAttempts`; a result arriving after the deadline is ignored.

Run `PI_AUTO_DEBUG=1 pi` to also capture chat-selector text in `selectorResponses.effort.rawText` and a classifier's validated `{ model, answers }` in `classifierDiagnostics.rawText`. Classifier capture contains only the configured model ID, supported effort choice, confidence, and numeric probabilities, after successful validation. Unvalidated answer strings, original HTTP bodies, malformed JSON, native error results, and unknown fields are never captured. The extension does not read or log Pi's resolved credentials. Each capture is capped at **8,192 UTF-16 code units**, with `rawTextTruncated` indicating truncation. This response-log limit does not restrict selector input. Raw text is not displayed in the status UI or added to the main model's context. Requests, credential headers, thinking, tool arguments, and provider error messages/bodies are not recorded.

Classifier entries use `classifierTiming` and `classifierDiagnostics`. Attempt backends are `classifier` for native classification, `chat` for a fixed chat selector, and `current-model` for the answering-model fallback (also used temporarily if initialization fails). Existing session files are never rewritten; unsupported old diagnostic fields are ignored rather than interpreted as the new schema.

**Responses may repeat sensitive task information without redaction.** Review logs before sharing them. Restart without the variable to disable capture; existing records remain. Missing or late responses after cancellation or timeout cannot be captured.

## Failure handling

In default **turn** mode, for a saved classifier or chat selector, the fallback chain is:

```text
Saved selector unavailable or fails once → answering model selects effort → if that fails, restore Pi's configured default effort
```

Chat selection uses Pi's `streamSimple()` runtime to normalize system instructions and resolve authentication. Classifier and chat calls set `maxRetries: 0`; there are no request retries and no answering-model switch. Request failures, timeouts, and invalid decisions trigger fallback. **If the fixed chat selector is already the answering model (same provider/ID), failure goes directly to Pi's default effort, without calling the same backend again.**
Both backends use the same context strategy: the previous user input, that turn's final assistant text reply, and the current input (`user + assistant + user`). They make one effort-selection request each (a native choice classification for classifiers), with no separate history-classification call. Earlier history, summaries, and intermediate progress are excluded. The selected messages are sent in full without local character limits. Without a previous turn, only the current input is sent; an unanswered turn never borrows an older reply.

Each selection has a **10-second deadline**. Current-model fallback after a saved-selector failure gets a separate deadline, for about 20 seconds total across both attempts. Cancellation does not trigger fallback. The deadline covers Pi availability checks, runtime authentication, and the request, not just network I/O. Initial backend discovery has its own 10-second budget and makes no classification call.

Default effort is read from Pi's saved global and trusted-project `settings.json` files, in this order:

1. `modelThinkingLevels["provider/modelId"]` for the current model.
2. `defaultThinkingLevel`.
3. Pi's built-in default, `medium`, if neither is configured.

The level is adjusted to the model's capabilities using Pi's rules. The previous automatically selected effort is not treated as the default, and configuration files are not modified. If the relevant configuration is invalid or cannot be read, the current effort is kept and the status explains why.

In interactive terminals, press **Esc** during selection to cancel it, keep the current effort, and continue the main task without fallback or disabling automatic selection. Esc returns to its normal behavior afterward; non-interactive mode does not listen for Esc.

Runtime cancellation signals, `/auto off`, and changes to the selector backend, chat model, effort, or session invalidate pending results. Successful configuration changes discard the old in-flight decision, including late diagnostics; a failed save does not cancel it. They do not trigger fallback or overwrite the user's new settings. Pi may not expose a cancellation signal during `before_agent_start`; use `/auto off` to cancel selection in that case.

Both backends send the current input and the selected previous turn without local truncation. Even a single turn can be large, increasing cost and latency or exceeding provider limits.

## Costs and limits

- Only effort levels supported by the current model can be selected. A model with just one supported level uses it without an extra model call.
- Each backend makes one selection request; saved-selector failure followed by answering-model fallback makes at most **two calls**.
- **These extra calls add latency and may incur charges.** Direct extension calls to `classify()` do not automatically enter session cost totals. pi-auto records usage in its own diagnostics, not Pi's footer or `/session` totals; chat-selector calls are also excluded.
- Classifier cost comes from Pi's model catalog, not the provider's bill. The built-in direct `typesafe/jev-latest` currently has no catalog price and reports zero cost when usage is present; **zero does not mean free**. Pi may normalize absent or malformed token fields to zero when a usage object is present.
- Context filtering affects only the selector's input, not the main model's conversation context.
- Using only the latest turn can omit relevant history, and automatic selection is not guaranteed to be optimal. Classifier confidence is not a task-success probability and does not independently raise or lower effort.

### Selector input and data sent

Neither the current task nor the selected previous turn has a local character limit. Provider context-window and request-size limits still apply. This strategy affects only selector input, not the main model's conversation.

| Input | Maximum |
| --- | --- |
| Current task | No local character limit; sent in full |
| Previous user input and final assistant text reply | No local character limit; sent in full |

Both backends send only the current task and the previous turn's user input and final assistant text reply, without candidate selection or importance classification.

Instructions, model information, and effort options are additional input. The selection request sends its input to the saved classifier or chat provider without automatic redaction. On fallback, the current model's provider receives the same current task and previous-turn context.

## Pi compatibility

Development dependencies are pinned to Pi **1.5.0**. CI runs type checking and the full test suite against Pi **0.99.0**, **0.99.1**, and **1.5.0**, including step lifecycle and real AgentSession request-boundary tests on all three hosts.

In turn mode, only user-prompt runs trigger effort selection. Step mode additionally selects before later model calls within those user runs. Since Pi 1.2, extensions can start runs with custom messages (`sendMessage(..., { triggerTurn: true })`); those runs keep the current effort and latest selection diagnostics, without calling the selector or cancelling an in-flight user selection. The message itself is still processed normally. Legacy user events without `messageType` continue to select effort.

These checks do not establish full interactive TUI compatibility or optimal effort choices. CI uses fakes and does not require model credentials.

## Development

```bash
npm ci --ignore-scripts
npm run check
npm test
```
