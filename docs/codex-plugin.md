# EvalPi for Codex

The local Codex plugin brings EvalPi's evaluation engine into a Codex conversation. Codex understands the project and drafts the evaluation plan; EvalPi records confirmed plans, executes isolated trials, grades evidence, manages batch review, and produces report files. The Electron application remains available and shares the evaluation implementation.

This is a **local development package**. It requires an existing EvalPi checkout with installed dependencies. It has not been published to the public plugin directory, and the setup commands below do not publish it.

## Prepare the local package

From the EvalPi checkout, install dependencies with `npm ci`, then run:

```sh
node scripts/prepare-codex-plugin.mjs
```

The command writes `output/codex-plugin/`, including a marketplace catalog, the skill, portable plugin and MCP manifests, and compatibility manifests for older local Codex clients. It prints the absolute marketplace path. It does not change global Codex settings, install a plugin, authenticate a model, or run an evaluation.

The generated MCP configuration records the current Node executable and the engine entry point as **absolute paths**. Codex copies a local plugin into its own cache during installation. The cached plugin therefore continues to use the original engine checkout and its dependencies, even when the cache path contains spaces or non-ASCII characters. Keep that checkout and Node executable available; rerun preparation and refresh/reinstall the local plugin after moving either one. The generated package contains machine-specific paths and should stay out of Git.

Optional arguments:

```sh
node scripts/prepare-codex-plugin.mjs --data-dir "/absolute/private/evalpi-plugin" --models-dir "/absolute/existing/EvalPi/workspace/models"
node scripts/prepare-codex-plugin.mjs --check
```

Use the same options when running `--check` that you used for preparation. `--output` can choose another subdirectory within this checkout's `output/` directory. Preparation rejects unrelated nonempty directories and linked output paths. Repeating preparation updates its managed files and preserves unrelated files in a previously prepared directory.

## Model configuration and stored data

By default, the plugin stores its data in:

| Platform | Default directory |
| --- | --- |
| Windows | `%APPDATA%/EvalPi/plugin` |
| macOS | `~/Library/Application Support/EvalPi/plugin` |
| Linux | `${XDG_DATA_HOME:-~/.local/share}/EvalPi/plugin` |

The default model-data directory is a separate `models/` directory under the plugin data directory. Credentials are not copied from Codex or from the desktop application. To reuse an existing EvalPi connection, explicitly pass its **model-data root** with `--models-dir`. For the Windows desktop application this is normally `%APPDATA%/EvalPi/workspace/models`.

The model-data root is the directory passed to EvalPi's model runtime. That runtime stores its files in a further `models/` subdirectory, so an existing desktop credential file may be at `workspace/models/models/auth.json`. Pass `workspace/models`, not the credential file or its immediate parent. Never paste credential contents into chat or add them to the plugin package.

Rule-based fixture evaluations need no model connection. LLM grading and model-backed targets still need their configured provider connection. Installing the plugin does not grant arbitrary API access to the Codex conversation's subscription.

Each installation uses that user's own model connection and usage allowance. The generated plugin contains directory paths, never credential files or API keys. Reusing a desktop connection applies to persisted credentials such as an EvalPi OAuth login; API keys held only in a running desktop process are not shared with the plugin process. Machine-local generated packages and evaluation outputs are excluded from Git. Publish the source and let each user prepare their own local configuration.

## Add and enable the plugin

After preparing the package, register its printed marketplace root with a local Codex client that supports plugins:

```sh
codex plugin marketplace add "/absolute/path/to/eval-pi/output/codex-plugin"
codex plugin marketplace list
```

Open the plugin directory in the desktop app, select **EvalPi Local**, and install or enable **EvalPi**. Refresh or restart the app if the new local catalog is not visible, then use a new chat. Some current CLI versions also support:

```sh
codex plugin add evalpi@evalpi-local
codex plugin list --json
```

Local marketplace and CLI support depend on the installed Codex client. Follow its available plugin interface; avoid hand-editing global settings as an installation workaround. Updating files in the source checkout does not itself prove that the installed cache has refreshed. Repeat preparation, refresh or reinstall the local plugin, and verify the tools in a new chat.

See the official [plugin packaging and local installation guide](https://developers.openai.com/plugins/build/plugins) and [Codex developer commands](https://learn.chatgpt.com/docs/developer-commands#codex-plugin).

## Use it in a conversation

For example:

> Use EvalPi to evaluate the customer-service agent in this folder. Check whether failed refund requests are reported accurately. Show me the plan before starting, and let me review failures in one batch.

The evaluation skill guides Codex through project inspection, a saved plan, user confirmation, execution, batch review, and report links. A PRD is optional. Case details and traces remain available through files and paginated tool results.

| Tool | Purpose |
| --- | --- |
| `evalpi_open` | Open a local project in an evaluation session |
| `evalpi_status` | Read the session, progress, plan, and artifact paths |
| `evalpi_submit_plan` | Validate and save a draft plan |
| `evalpi_confirm` | Confirm the identified saved plan after user agreement |
| `evalpi_start` | Start the confirmed plan in the background |
| `evalpi_results` | Read paginated saved trial results |
| `evalpi_review` | Submit a batch of review decisions and recheck unresolved items |
| `evalpi_retry_grading` | Retry grading from saved execution evidence |
| `evalpi_cancel` | Request cancellation of active work |
| `evalpi_report` | Generate artifacts for the identified saved run |
| `evalpi_close` | Release the session while retaining saved artifacts |

The exact required fields are provided by each MCP tool schema. Retain returned session, plan, and run IDs rather than guessing them. Confirmation applies to the saved plan version. Successful scheduling of a run or report does not mean that work has completed: check its status and returned artifacts.

## Current boundaries

- Projects require a working `evalpi.json` adapter. General project discovery and adapter generation still require Codex's assistance and verification.
- Each trial has isolated execution state, but this is not an operating-system security sandbox. Use trusted target code and test services; external databases and live business APIs require appropriate test isolation.
- The skill guides investigation and authorized code changes. Automatic optimization and fresh blind-set enforcement are not yet a complete engine capability. Keep original evidence and agreed criteria fixed, then distinguish regression coverage from unseen validation.
- Human judgments, original grader results, and agent rechecks remain separate. Review rechecks all cases in the run without an existing explicit human decision, including initial passes; it does not limit rechecks to the displayed page. An empty decisions object delegates that whole scope, potentially making additional model calls. Keep this scope within the agreed budget. Unresolved evidence remains pending.
- PDF export uses the installed Electron runtime without opening the full desktop application. If export fails, report the failure and retain the other available artifacts.
- Sessions use an exclusive process lock. Close a session normally before reopening it elsewhere. After a crash, first confirm the original process has exited before manually removing that session's `.plugin-lock`; do not automatically delete a lock that might belong to a running evaluation.

## Development checks

```sh
node --test tests/plugin-package.test.mjs
node scripts/prepare-codex-plugin.mjs --check
```

The package test copies the plugin to a different cache directory with spaces and Chinese characters, starts its actual MCP command there, and checks tool discovery. It also checks repeatable preparation and rejection of unrelated output directories. These checks do not install a global plugin or make paid model calls; installation in the desktop app remains a separate verification step.

On October 3, 2026, the local package was installed and enabled through the Codex CLI. An MCP client launched its installed cache configuration, discovered all 11 tools, and verified that execution before plan confirmation was rejected. Two deterministic customer-service cases were each executed twice and graded by the explicitly configured `gpt-6.1-sol` connection: two passes, two failures, and no execution or grading errors. Delegated batch review completed, and PDF, HTML, CSV, JSONL, and JSON snapshot files were generated. This verifies the installed transport and evaluation workflow; it does not measure the quality of a model-backed customer-service agent or certify general evaluation reliability. The local verification record is saved under the ignored `output/codex-plugin-verification/` directory.
