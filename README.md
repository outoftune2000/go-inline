# Go Inline

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

AI inline code completion for Go in desktop VS Code. Run a small code model locally with **llama.cpp**, or explicitly choose **OpenRouter free models** or **OpenCode Zen**. Go Inline runs alongside the official Go extension and `gopls`.

## Features

- Short ghost-text suggestions after a typing pause and a manual command for longer continuations.
- At most one new named function/method per suggestion; nested callbacks are preserved.
- Five-minute memory cache and shared in-flight requests to avoid duplicate generations.
- Context from nearby code, comments, imports, and relevant same-package declarations.
- Cancellation and stale-result protection when code, cursor, settings, or credentials change.
- Delimiter-aware cleanup for nested calls, indexing, and unambiguous map/slice literal typos.
- Windows menu to load, unload, and check local models.
- API keys in VS Code SecretStorage; no telemetry, prompt logging, or automatic provider fallback.

## Requirements

- Desktop VS Code 1.95 or newer and the [official Go extension](https://marketplace.visualstudio.com/items?itemName=golang.Go).
- Go installed for language services and validation tests; fixtures target Go 1.22 or newer.
- Node.js 22 or newer for development and packaging.
- A trusted Go workspace, plus a local llama.cpp server or an eligible hosted API key.

## Build and install

```sh
git clone https://github.com/outoftune2000/go-inline.git
cd go-inline
npm ci
npm run package
```

In VS Code, choose **Extensions → … → Install from VSIX…** and select the generated `go-inline-0.3.0.vsix`. This project is not published to the Marketplace.

To develop, run `npm run build`, open the repository in VS Code, and press **F5** to launch an Extension Development Host.

## Choose a model provider

### Local: llama.cpp

Start `llama-server` with a **Qwen2.5-Coder Base** GGUF model. Start with 1.5B Q4_K_M; a larger model can trade speed and memory for quality. The adapter uses Qwen2.5 fill-in-the-middle tokens, so arbitrary chat models are not interchangeable.

```sh
llama-server -m /path/to/qwen2.5-coder-1.5b-base-q4_k_m.gguf --host 127.0.0.1 --port 18080 -c 8192 -ngl 99 -np 1
```

Leave `goInline.provider` set to `llamacpp`, then run **Go Inline: Check Connection**. The default endpoint is `http://127.0.0.1:18080`. The extension does not download models or install the runtime.

On Windows, [local-model/Go-Inline-Model.cmd](local-model/Go-Inline-Model.cmd) provides a load/unload/status menu. Configure it using the [local model controls guide](local-model/README.md). Runtime binaries, weights, logs, and machine-specific paths stay outside Git.

### OpenRouter: free models

1. Run **Go Inline: Set OpenRouter API Key**.
2. Run **Go Inline: Choose Provider** → **OpenRouter — free models**.
3. Run **Go Inline: Check Connection**.

The preset is `cohere/north-mini-code:free`. The adapter accepts explicit `:free` model IDs or `openrouter/free` and enforces a zero-price provider ceiling. Free-model availability and quotas can change. Reasoning is disabled for responsive completions; models requiring reasoning are not supported by this adapter.

### OpenCode Zen

Set `goInline.zen.model` to an account-permitted Chat Completions model, run **Go Inline: Set Zen API Key**, and explicitly choose Zen. The default endpoint is `https://opencode.ai/zen/v1`; the Go subscription endpoint is not used. Direct free-model access is not guaranteed.

## Use it

Type Go code and pause for an inline suggestion. Accept or dismiss it using VS Code's normal controls, usually **Tab** and **Escape**. Enable `editor.inlineSuggest.enabled` if needed.

Command Palette actions:

- **Go Inline: Suggest Longer Continuation**
- **Go Inline: Enable / Disable Completion**
- **Go Inline: Choose Provider**
- **Go Inline: Check Connection**
- **Go Inline: Set OpenRouter API Key**
- **Go Inline: Set Zen API Key**

Successful nonempty answers are cached for five minutes from generation. Matching requests reuse the answer or share the active generation. Settings/API-key changes and restarting the extension clear the cache. Nothing is cached on disk.

Selecting a hosted provider sends bounded code context to that service. Local inference uses loopback only. Suggestions require acceptance and may still contain syntax or semantic errors; Go Inline does not execute or automatically apply them.

## Test

```sh
npm test
npm run fixtures:check
npm run test:host
```

The regression suite covers caching, concurrent cancellation, single-function output, delimiter handling, provider adapters, and Go compilation examples. Reference fixtures cover 32 Go completion cases. The extension-host tests use an isolated VS Code profile; see the [full guide](docs/USAGE.md) for `gopls` coexistence checks and live model evaluation.

Live model results are model- and hardware-dependent. The historical tests found useful suggestions alongside incorrect ones; this is an experimental coding aid, not a guarantee of correct Go.

## Documentation

- [Detailed setup, settings, troubleshooting, and historical evaluation](docs/USAGE.md)
- [Windows local model load/unload controls](local-model/README.md)
- [Changelog](CHANGELOG.md)

## License

Go Inline's project source is licensed under the **GNU General Public License, version 3 only** (`GPL-3.0-only`). See [LICENSE](LICENSE) and [NOTICE](NOTICE).

Bundled third-party code retains its own license and attribution; see [ThirdPartyNotices.txt](ThirdPartyNotices.txt). Model weights, llama.cpp binaries, and hosted services have their own licenses and terms and are not included in this repository.
