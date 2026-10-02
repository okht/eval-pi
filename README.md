<p align="center">
  <img src="public/evalpi.svg" width="128" alt="EvalPi logo" />
</p>

<h1 align="center">EvalPi</h1>

<p align="center">Evaluate and improve AI products with a single instruction.</p>

EvalPi evaluates AI products, including agents and workflows, through a desktop application or a local Codex plugin. Its goal is to turn natural-language requirements, product documents, and evaluation criteria into a complete cycle of evaluation, diagnosis, improvement, and verification.

## Current capabilities

The first local evaluation workflow is implemented: an Electron desktop app and React workspace, model connections through Pi, project inspection, plan confirmation, execution, batch review, and report delivery.

- **Model connections:** The Pi SDK provides ChatGPT OAuth sign-in and API key configuration, with model selection and OpenAI-compatible endpoints. On October 2, 2026, an authorized ChatGPT subscription was used to verify `gpt-6.1-sol` planning, a batch of eight independent Judge calls, and summaries grounded in saved execution evidence. Access and limits for other accounts and models require separate verification.
- **Conversation and planning:** The planning agent uses the project summary supplied by the app and the user's goal to propose an unconfirmed evaluation plan. The app controls execution, which starts only after the user confirms the current plan.
- **Local project execution:** The runner reads the project's `evalpi.json` and invokes an existing Node.js workflow entry point. Projects currently need an adapter and a declared entry point; automatic adaptation of arbitrary folders is not implemented.
- **Repetition and isolation:** Promptfoo schedules runs. Each attempt uses a separate child process, session ID, and temporary working directory, capturing output, traces, and optional business state. The project entry point manages any multi-turn context needed within a single case.
- **Judging and review:** Explicit rule checks and an independent LLM Judge are supported. An observed business-rule failure remains a failure. Execution evidence is saved before model grading; grading errors, cancellations, and business failures are recorded separately. Incomplete grading can be retried against saved evidence without executing the target again. Human batch decisions, grading retries, and automated reviews have separate records.
- **Reports:** Actual run records produce an HTML preview, PDF, CSV, JSONL, and a JSON snapshot. Reports distinguish rule results, model judgments, human decisions, and retry results. Report links appear in the conversation, and the current report preview can be restored after reopening the page. HTML and appendices remain available if PDF rendering fails.
- **Local persistence:** Projects, plans, runs, and review state are saved locally. Recovery loads the newer run snapshot and marks unfinished runs as interrupted while preserving their evidence. The planning agent and Judge support timeouts and cancellation. API keys stay in the current process's memory; OAuth credentials use a dedicated local directory for this app.

Automatic code modification, continuous optimization, independent blind testing of target improvements, and automatic adaptation of arbitrary agents are not yet implemented. Reports describe actual executions and do not invent improvement results or costs.

## Getting started

Requirements: Node.js 22.19 or later and npm. On Windows, use PowerShell 7 (`pwsh.exe`). Install dependencies:

```text
npm install
```

For browser development, start Vite and the local runtime service together:

```text
npm run dev:full
```

Open the [local workspace](http://127.0.0.1:5173/). Vite uses port 5173, and the runtime service uses port 4317. Desktop mode builds the frontend, then launches Electron and a separate backend process:

```text
npm run desktop
```

Run the checks:

```text
npm test
npm run build
```

As of October 3, 2026, all 138 automated tests and the frontend build pass. Coverage includes HTTP, models, reports, execution, runtime state, the open-source model adapter, Judge data provenance, reference-label isolation, metric denominators, repeat consistency, cancellation, validation-report boundaries, MCP protocol handling, plugin packaging, and evaluation-session isolation. `npm run dev` starts only the frontend for viewing static demos; live workspace operations require `dev:full` or desktop mode.

The current application interface and several linked project documents are in Chinese.

## Use EvalPi in Codex

The local plugin packages an evaluation skill and an MCP server. Codex reads the project and drafts the plan; EvalPi validates the plan, executes repeated trials, records independent judgments and batch reviews, and returns report files. Each evaluation session has separate state, and updated plans require confirmation again.

After installing this repository's dependencies, prepare the machine-local plugin:

```text
npm run plugin:prepare
```

Register the printed marketplace directory with `codex plugin marketplace add <absolute-path>`, then install **EvalPi** from **EvalPi Local** in the plugin directory. In clients supporting CLI installation, use `codex plugin add evalpi@evalpi-local`. Start a new chat and ask EvalPi to evaluate a local project.

Preparation records absolute paths to this checkout and its Node executable, so they must remain available after installation. The generated package stays under the ignored `output/` directory. Judge credentials are configured separately; the plugin does not automatically inherit the Codex conversation's model connection. A working `evalpi.json` adapter is still required. See the [Codex plugin setup and limits](docs/codex-plugin.md) for model setup, tools, and recovery.

## Try the built-in customer-service project

1. Select the built-in customer-service validation project in the live workspace, or select the `examples/customer-service` folder.
2. Review and confirm the plan, then start the evaluation. This deterministic project does not require a model account.
3. Run four cases three times each, for 12 executions. The expected results are six passes and six failures.
4. Review issues in a batch, then enter `/report` in chat to generate the HTML report, PDF, and appendices.

This project starts real processes and writes test business state. It deliberately includes false success claims and duplicate submissions to validate the evaluation workflow. Its results do not measure a real language model's quality. To connect your own project, see the [Node.js workflow adapter contract](examples/customer-service/README.md) and [example manifest](examples/customer-service/evalpi.json).

With a model connected, the same four cases were switched through conversation to LLM grading with two repeats per case, keeping their inputs, expected behavior, and criteria unchanged. The planning agent created an unconfirmed draft; after confirmation, the app completed eight target executions and eight `gpt-6.1-sol` judgments: four passes, four failures, no pending results, and no errors, across eight independent sessions. All pages of the resulting three-page PDF were visually checked. The target remained the deterministic fixture, while planning and judging used a real model. This run alone does not establish Judge accuracy or real customer-service model quality. Grading retries, cancellation, and recovery were tested with controlled mocks; real service failures were not deliberately induced.

The runner checks the entry file's fingerprint before each execution and stops remaining attempts if it changes. Process and working-directory isolation do not provide an operating-system sandbox. Adapters must isolate state in external databases, shared accounts, and remote services. Dependency files and external service versions are not yet frozen.

See the [product definition](docs/产品定义.md), [early technology choices](docs/技术选型建议.md), and [execution validation record](docs/真实评测链路验收.md) for the product direction, implementation details, and verification boundaries.

## Evaluate a real open-source agent

An [adapter for OpenAI's official customer-service multi-agent example](examples/openai-customer-service/README.md) is included. It pins the upstream commit and SDK version while preserving the prompts, tools, and handoffs of its three agents. Real model calls use the existing ChatGPT subscription connection; business tools retain the upstream mock implementation. Each case and repeat runs independently. See the example documentation for setup, coverage, and evidence limitations. Longer agent workflows can use a timeout of up to 180 seconds per case; the existing default is unchanged.

A formal batch completed through the app covered five scenarios with two repeats each: 10/10 passed, with 32 model calls inside the target and 10 additional independent Judge calls. The report has two pages. See the [open-source agent evaluation record](docs/开源客服Agent实测.md) for the complete results and coverage. This small baseline does not establish readiness for real airline operations or comprehensive model quality.

## Validate the Judge

The repository includes a pinned RAGTruth QA subset with human annotations from 48 distinct source groups, plus 12 constructed cases that test evidence-handling requirements. The benchmark uses the app's existing Judge and reports false positives, false negatives, pending judgments, errors, confusion matrices, and repeat consistency. Reference labels never enter the model context. Development, held-out, and constructed sets are reported separately; repeated calls do not increase the number of independent samples.

```text
npm run benchmark:judge
npm run benchmark:judge -- --run --output output/judge-benchmark/my-baseline
node scripts/report-judge-benchmark.mjs output/judge-benchmark/my-baseline output/pdf/my-judge-report --pdf
```

The first command only previews the call budget. Model calls require the explicit `--run` flag. The default is 60 cases with two repeats each, using the local EvalPi subscription connection without changing the current project batch. See the [Judge benchmark documentation](benchmarks/judge/README.md) for provenance, filtering, CLI options, and limitations. This capability currently uses a CLI and has not yet been integrated into the app's conversation or batch-review interface.

A total of 120 real Judge calls have been completed. First-repeat agreement with reference labels was 18/24 on the human-annotated development set, 22/24 on the held-out set, and 12/12 on the constructed cases. Eight disagreements were queued for human review. Agreement across the full human-annotated set was 40/48; the held-out result of 91.7% alone does not establish Judge reliability. See the [Judge validation record](docs/Judge可靠性验收.md) for measurement conditions, citation-checking gaps, and the final two-page report details.

## Live workspace and earlier visual demos

| Route | Purpose and data |
| --- | --- |
| `/` | Live workspace connected to the local service, showing actual projects, execution records, and reports. |
| `/demo` | Earlier frontend interaction demo with simulated customer-service data and optimization progress. It does not call the runtime service. |
| `/report-preview` | Standalone visual preview of a three-page customer-service report using fixed sample data. |

`/demo` preserves the early conversation, sidebar, batch review, pause, and optimization-progress design. Enter `PDF`, `HTML`, or `Markdown` in the demo chat to try its simulated report delivery. These interactions and simulated progress do not imply that the live workspace supports the same optimization or Markdown export capabilities. Demo state is stored in the browser and can be reset through the workspace menu.

## Report design preview

With the development server running, open the [report design preview](http://127.0.0.1:5173/report-preview) to inspect the fixed sample report inspired by Pi and generate a PDF from its file link. The `/demo` sidebar uses the same static report component.

Running `node scripts/export-report-preview.mjs` generates a three-page PDF, an offline HTML file with embedded fonts, and two matching appendices under `output/pdf`. These artifacts still use sample customer-service data.

Font sources and usage notes are documented in `public/fonts/SOURCES.md`. The static demo bundles its Chinese font subsets, so its browser preview and sample PDF do not depend on locally installed Chinese fonts.

The report design specification comes from the private [eval-pi-design-system](https://github.com/okht/eval-pi-design-system/tree/main/reports) repository and defines typography, colors, logos, and layout. Adapting report structure and length to each project's evidence remains a planned capability. Current live reports use a deterministic template populated from execution evidence; the three-page customer-service report is a visual demo.

If you have access to a local checkout of the design system, synchronize and validate the assets:

```text
node scripts/sync-report-design.mjs ../eval-pi-design-system
node scripts/sync-report-design.mjs ../eval-pi-design-system --check
```

The static web preview, offline HTML, and PDF use `src/design-system/reports/` and local fonts. The browser does not need access to the private repository. The bundled Chinese fonts currently cover the sample text and may not contain every character needed for arbitrary project reports.

Live workspace reports are generated as HTML by `server/reports.mjs` and rendered to PDF by Electron. They currently use available system fonts, such as Microsoft YaHei and SimSun, with fallbacks, following a similar paper background, color palette, and research-report hierarchy. This rendering path is separate from the static demo's bundled brand-font subsets. Fonts on different machines can affect pagination, and report length varies with the cases and evidence included.
