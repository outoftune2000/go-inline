# Go Inline

Local-first Go inline completion for desktop VS Code. Uses **llama.cpp**, **OpenRouter free models**, or an explicitly selected OpenCode Zen Chat Completions model. Runs alongside the official Go extension and `gopls`.

Short suggestions appear after a 350 ms pause. Use **Go Inline: Suggest Longer Continuation** from the Command Palette for a larger function-body suggestion. Accept and dismiss using VS Code's normal inline suggestion controls (usually Tab and Escape).

## Install

In VS Code, open Extensions, choose **… → Install from VSIX…**, and select `go-inline-0.3.0.vsix`. Keep the official Go extension enabled. Enable `editor.inlineSuggest.enabled` and open a trusted local Go workspace.

For a development checkout:

```powershell
npm ci
npm run build
```

Open this directory in VS Code and press F5 to launch an Extension Development Host. Node.js 22 or newer is recommended for the development and packaging tools.

## Run a local model with llama.cpp

On this machine, the ready-to-use load/unload menu is [local-model/Go-Inline-Model.cmd](local-model/Go-Inline-Model.cmd). See [local model controls](local-model/README.md) for the ignored runtime-location config and moving the downloaded models. The repository contains the control scripts; runtime binaries and model weights stay outside Git.

1. Get a Windows build of `llama-server` from the [official llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases). For an NVIDIA GPU use an appropriate CUDA build with its matching runtime dependencies, or use the Vulkan build. Keep the release's DLLs beside the executable.
2. Obtain a **Qwen2.5-Coder 1.5B Base** GGUF model quantized as **Q4_K_M**. Choose the base model, not an Instruct model: this adapter uses Qwen2.5's native fill-in-the-middle token format. The model's license is separate from this extension's MIT license. If a suitable trusted GGUF is unavailable, convert the [original Base model](https://huggingface.co/Qwen/Qwen2.5-Coder-1.5B) using llama.cpp's conversion and quantization tools.
3. Start the server in a terminal, adjusting these example paths:

```powershell
& 'C:\tools\llama.cpp\llama-server.exe' -m 'C:\models\qwen2.5-coder-1.5b-base-q4_k_m.gguf' --host 127.0.0.1 --port 18080 -c 8192 -ngl 99 -np 1
```

The server keeps the loaded model resident. The extension enables prompt caching and sends raw FIM prompts to `/completion`; it does not use chat templates for local inference. Leave automatic model sleeping disabled for responsive warm completions. See the [llama-server API and launch options](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).

4. Leave `goInline.provider` set to `llamacpp`. The default endpoint is `http://127.0.0.1:18080`. Run **Go Inline: Check Connection** and then type Go code. The model is selected when launching the server, not in VS Code settings. Use a single-model server with no API authentication bound to loopback; authenticated servers and model-router mode are outside v1.

For a 6 GB GPU and 32 GB system RAM, start with 1.5B Q4_K_M. Benchmark 7B Base Q4_K_M as a quality upgrade, using a different server port if comparing simultaneously. GPU fit depends on model weights, context cache, backend buffers, and other applications; if it does not fit, reduce GPU layers, use the smaller model, or lower context and the extension input budget together. Disk model size alone does not predict VRAM use.

The extension does not install llama.cpp or download model weights. It only contacts the local server when llama.cpp is selected. In SSH, WSL, or container workspaces, localhost refers to the **extension host**, so the server must be reachable there.

## Use OpenRouter free models

1. Run **Go Inline: Set OpenRouter API Key**. The key is stored separately from Zen in VS Code `SecretStorage`; it is not bundled with the extension.
2. Run **Go Inline: Choose Provider** and select **OpenRouter — free models**.
3. Leave `goInline.openrouter.model` set to `cohere/north-mini-code:free`, the selected model from the available-candidate screening, or choose another compatible free model explicitly.
4. Run **Go Inline: Check Connection**, then request an inline suggestion in a Go file.

The default base URL is `https://openrouter.ai/api/v1`. This adapter accepts only model IDs ending in `:free` or the `openrouter/free` router and sends a provider price ceiling of zero for input and output tokens. It never falls back to a paid model. Reasoning is disabled to keep short completions responsive; models that require reasoning are not suitable for this adapter.

Free models have account and provider capacity limits. The benchmark used only synthetic fixtures. Typing-triggered completions can consume a small free daily allowance quickly; disable automatic completion with **Go Inline: Enable / Disable Completion** when not using it. A rate-limit response pauses further completion requests for the server's `Retry-After` duration, or one minute when none is provided. Hosted code handling follows your [OpenRouter privacy settings](https://openrouter.ai/settings/privacy) and the selected model provider's policies.

To evaluate without putting a key in source files, set `GO_INLINE_PROVIDER=openrouter`, `GO_INLINE_MODEL=cohere/north-mini-code:free`, and `GO_INLINE_API_KEY` in the evaluation process environment, then run `npm run evaluate`. Saved outputs can be rechecked locally without API calls using `npx tsx scripts/evaluate.ts --replay evaluation/results/YOUR_REPORT.json`.

## Use OpenCode Zen

1. Obtain an eligible API key from OpenCode Console.
2. Run **Go Inline: Set Zen API Key**. The key goes into VS Code `SecretStorage`, never settings or logs. Run it with an empty value to delete the stored key.
3. Set `goInline.zen.model` to a model ID supported by your account and the **Chat Completions** API. The field is deliberately empty initially so no paid model is chosen for you.
4. Run **Go Inline: Choose Provider**, select **OpenCode Zen — hosted**, and run **Go Inline: Check Connection**. This check makes a tiny generation request and may incur a charge.

The default base URL is `https://opencode.ai/zen/v1`, separate from the Go subscription endpoint. A different compatible HTTPS endpoint can be configured. Model access and free offers change. Direct tests of ten free Zen models returned HTTP 429 with a free-usage-limit message. Models requiring Responses or Anthropic Messages are not supported by this adapter.

Selecting Zen explicitly permits sending the bounded active-file context and relevant declarations to that endpoint. The extension never automatically falls back between providers. A local failure stays local.

## Context and controls

Each suggestion finishes only the current function or contains at most one new named function/method. Extra functions are discarded, while callbacks inside that function are preserved. This applies to every model provider. The generator is instructed to stay within one function; any extra model output is filtered before display and caching.

Successful nonempty completions are hot-cached **in memory for five minutes from generation**. Identical concurrent requests share one generation, and repeated matching requests reuse its cleaned result. Hot hits and matching in-flight requests skip the typing debounce. The cache fingerprints the document URI and text, cursor, relevant declarations, provider endpoint/model, automatic/manual mode, output limit, and deadline. Go/context file changes invalidate the shortcut lookup so current declarations are collected again. Undoing to the same text can reuse an answer even when VS Code's document version changes. Settings or API-key changes clear the cache. Empty responses, errors, cancellations, and timeouts are not cached. It holds at most 128 answers / one million characters and never writes cached code or keys to disk; restarting the extension clears it.

Suffix deduplication tracks braces, parentheses, and brackets separately, preserving nested calls like `outer(inner(x))` and indexing like `values[indexes[0]]`. Structural cleanup can add missing call/index closers, remove excess generated closers, and fix unambiguous empty map/slice/array literal typos such as `map[string]Task[ ... }` to `map[string]Task{ ... }`. It preserves valid generics, strings, comments, and existing editor text. These targeted repairs do not guarantee that arbitrary model output compiles or behaves correctly.

- Uses nearby code on both sides of the cursor, surrounding comments, imports, and relevant same-package declarations. Intent is inferred in the generation request; there is no separate intent-classification request.
- Uses existing VS Code definition and symbol providers, usually `gopls`, with a 500 ms supplementary-context budget and a small cache. Missing providers fall back to active-file context.
- Supplementary declarations are limited to the same directory and package within the workspace. Generated files, `vendor`, Git-ignored paths, and symlinks resolving outside the workspace are excluded. Gitignore filtering is conservative and may exclude a re-included nested file.
- Generated active files are skipped. Other active-file content is eligible even if Git-ignored, because it is the file you are explicitly editing. Disable completion before editing a file you do not want supplied to the selected model.
- Input budget defaults to approximately 4,000 tokens, estimated using three characters per token with room reserved for prompt structure. This is a heuristic, not the model tokenizer, especially for non-ASCII text. Extremely large functions may be clipped to the cursor vicinity.
- Automatic/manual output limits default to 128/512 tokens. Deadlines default to 3/15 seconds after the automatic debounce. Superseded work is cancelled and stale document/cursor results are discarded.
- No telemetry, prompt logging, autonomous edits, import insertion, or repository index. The status bar shows the selected provider and last connection state; automatic failures do not open notifications.

Commands available in the Command Palette:

- **Go Inline: Enable / Disable Completion**
- **Go Inline: Choose Provider**
- **Go Inline: Set Zen API Key**
- **Go Inline: Set OpenRouter API Key**
- **Go Inline: Check Connection**
- **Go Inline: Suggest Longer Continuation**

Tune `goInline.debounceMs`, `goInline.contextTokens`, `goInline.supplementaryContext`, and the `automatic`/`manual` output limits and timeouts in Settings. Provider and endpoint settings are application-scoped, preventing a repository from silently redirecting requests.

## Test and evaluate

```powershell
npm test
npm run test:host
npm run fixtures:check
npm run package
```

`test:host` downloads an isolated VS Code build by default. Set `VSCODE_EXECUTABLE` to use an existing executable. The test uses a separate profile/workspace and does not modify your regular settings. The fixture check validates 32 reference completions with `gofmt` and `go test`; passing reference checks demonstrates fixture validity, **not model quality**.

To additionally validate coexistence with an installed official Go extension, set `GO_EXTENSION_PATH` to its extension directory (for example, the `golang.go-...` folder under your VS Code extensions directory) before running `npm run test:host`. That mode loads both extensions into the isolated profile and checks gopls diagnostics, definition navigation, formatting, and ordinary completion.

Run a warmed local-model benchmark after starting llama-server:

```powershell
$env:GO_INLINE_PROVIDER = 'llamacpp'
$env:GO_INLINE_MODEL = 'qwen2.5-coder-1.5b-base-q4_k_m'
npm run evaluate
```

`GO_INLINE_MODEL` labels the report for llama.cpp; it does not change the server's loaded model. For 7B, restart the server with that GGUF and change the label. For Zen, use a permitted Chat Completions model and pass the key via a process environment variable:

```powershell
$env:GO_INLINE_PROVIDER = 'zen'
$env:GO_INLINE_MODEL = 'YOUR_PERMITTED_MODEL_ID'
# Set GO_INLINE_API_KEY securely in this process; do not commit it.
npm run evaluate
```

Optional `GO_INLINE_ENDPOINT` overrides the endpoint. Evaluation sends only the bundled synthetic Go fixtures. Model inference uses the same 128-token limit and 3-second generation deadline as automatic completion. The report excludes the warm-up and measures generation latency, while VS Code's end-to-end latency also includes debounce and context collection. Reports are written locally to `evaluation/results/`; they include generated completions for manual usefulness review, and no API keys. Generated fixtures are formatted and behaviorally tested in a temporary directory with per-test timeouts. Run evaluation only against models you trust: generated Go test code is executed locally.

Review each successful completion for usefulness and set its report field to `useful`, `partially-useful`, or `not-useful`. The target is a warm automatic suggestion within 1.5 seconds median, including editor overhead; this must be measured on your actual model/backend configuration. An empty, syntactically valid, or compiling completion alone does not establish usefulness.

Before everyday use, try this manual editor check with the official Go extension enabled: type an `if err != nil` branch; complete a comment-described function; insert code before an existing closing brace; request a longer suggestion; edit/move the cursor while a request is running; verify normal gopls diagnostics, navigation, completion, and formatting still work. Other AI inline providers can compete for display; disable their inline completion for Go when evaluating this extension.

## Troubleshooting

- **No ghost text:** verify the file is Go, the workspace is trusted, the selection is empty, the feature is enabled, and `editor.inlineSuggest.enabled` is true. Hover over the status bar for the last error.
- **Cannot connect:** verify llama-server is running and its `/health` endpoint returns `{"status":"ok"}`. Only loopback local endpoints are accepted; hosted endpoints require HTTPS.
- **Timeouts:** warm the model, try a smaller model, or increase the automatic timeout. Increasing the timeout changes responsiveness; benchmark before choosing it.
- **Garbled output:** confirm the server loaded a Qwen2.5-Coder **Base** GGUF compatible with the FIM tokens. Arbitrary chat models are not interchangeable with this local adapter.
- **Zen 401/403/429:** check the key, external-client model permissions, or rate limit. No automatic retries or provider fallback are performed.
- **Long suggestion cuts off:** increase the manual output limit or request a smaller block. Output is a model prediction and may require editing; compilation is not run on every interactive suggestion.

The source is MIT-licensed. Model weights and external services retain their own licenses and terms. This package is for local VSIX installation; the publisher ID is a placeholder, not a Marketplace release.

## Verified implementation

Version 0.3.0 (November 5, 2026) passes 52 automated checks covering single-function output, five-minute TTL, concurrent request sharing, reference-counted cancellation, cache eviction, undo reuse, settings/credential isolation, and delimiter repair. Cache hits skip debounce, and a cancelled subscriber cannot cancel a matching request that is still needed. A Go integration fixture compiles repaired nested-call, indexing, map, slice, array, and generic examples with `gofmt` and `go test`. The model-quality measurements below are historical runs from version 0.2.0; no hosted API quota was consumed to test these changes.

On November 4, 2026, the TypeScript build, 25 automated unit/adapter/lifecycle tests, and all 32 reference Go fixtures passed on Windows. Isolated VS Code 1.145.0 host checks passed for activation, commands, cached context invalidation, generated/ignored/outside-workspace filtering, and fallback context. Version 0.2.0 also passed coexistence checks with the official Go extension 0.58.0, gopls 0.24.0, and Go 1.27.2, including diagnostics, navigation, formatting, and ordinary completion.

Live runs used an RTX 3060 Laptop GPU with 6 GB VRAM, llama.cpp b12110's Vulkan backend, an 8,192-token context, and one slot:

- **Qwen2.5-Coder 1.5B Base Q4_K_M:** 318 ms median generation; 25/32 behavioral fixtures passed.
- **Qwen2.5-Coder 7B Base Q4_K_M:** 543 ms median generation; 26/32 behavioral fixtures passed.

For OpenRouter, North Mini Code and Nemotron 3.5 Lightning returned zero-cost responses. North Mini Code handled more of the three screening cases correctly and was selected from the four candidate models probed. Flint rejected disabled reasoning, and Gemma 4 31B returned a provider rate limit. The selected `cohere/north-mini-code:free` model passed **18/32** Go fixtures with **590 ms** median generation-response latency. Saved API outputs were revalidated in the normal Go environment after correcting a child-process compiler-environment issue; no repeat API requests were needed for that validation. One generation returned no completion. This is a limited candidate comparison, not a claim that this is the best model in OpenRouter's entire free catalog.

These are synthetic cursor-insertion cases, including some whole function bodies. They are not broad coding benchmarks, and timings exclude editor debounce and context collection. The reviewed reports in `evaluation/results/` record incorrect suggestions and partial usefulness even where a fixture passed. The free hosted preset works but was less reliable than the local models on these cases. The local 1.5B model remains the recommended starting point for this machine. Direct Zen access checks were attempted separately and rejected; Zen code generation was not benchmarked.
