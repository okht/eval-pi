export type Verdict = 'pass' | 'fail' | 'pending' | 'error';
export type HumanDecision = 'issue' | 'clear' | 'recheck';
export interface ModelSettings { provider: string; model: string; baseUrl?: string; apiKey?: string }
export interface ModelStatus { provider: string; model: string; baseUrl?: string; authenticated: boolean; authMode: 'none' | 'api-key' | 'subscription'; availableModels: string[] }
export interface ProjectInfo { path: string; name: string; files: string[]; summary: string; runnable: boolean; manifest?: Record<string, unknown> }
export interface EvalCase { id: string; name: string; input: Record<string, unknown>; expected: string }
export interface EvalPlan { id: string; title: string; goal: string; criteria: string[]; cases: EvalCase[]; repeats: number; timeoutMs: number; judge: 'rules' | 'llm'; entry: string; confirmed: boolean; source: 'fixture' | 'agent'; createdAt: string }
export interface RunJudge { provider: string; model: string; authMode: string }
export interface Trial { id: string; caseId: string; trial: number; status: 'completed' | 'error' | 'cancelled'; output?: Record<string, unknown>; trace: unknown[]; verdict: Verdict; reason: string; durationMs: number; error?: string; sessionId: string; judgeSource: 'rules' | 'llm' | 'none'; ruleResult?: { verdict: Verdict; reason: string }; grading?: { status: 'completed' | 'error' | 'cancelled' | 'not_run'; verdict?: Verdict; reason?: string; durationMs?: number; errorCode?: string } }
export interface Recheck { trialId: string; caseId: string; verdict: Verdict; reason: string; checkedAt: string; source?: 'judge-retry' | 'review'; gradingStatus?: 'completed' | 'error' | 'cancelled'; judge?: RunJudge }
export interface EvalRun { id: string; planId: string; projectPath: string; status: 'running' | 'completed' | 'cancelled' | 'interrupted' | 'failed'; startedAt: string; finishedAt?: string; planned: number; trials: Trial[]; reviews: Record<string, HumanDecision>; rechecks?: Recheck[]; directory: string; judge?: RunJudge }
export interface ChatMessage { id: string; role: 'user' | 'assistant'; text: string; createdAt: string; artifact?: 'plan' | 'report' }
export interface AppState { project: ProjectInfo | null; plan: EvalPlan | null; run: EvalRun | null; messages: ChatMessage[]; model: ModelStatus; busy: boolean; activity: string; error: string | null }
export interface RuntimeEvent { type: 'state' | 'delta'; state?: AppState; text?: string }
export interface DesktopBridge { chooseFolder(): Promise<string | null>; openExternal(url: string): Promise<void> }
declare global { interface Window { evalpi?: DesktopBridge } }
