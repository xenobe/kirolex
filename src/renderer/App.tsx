import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { type SubagentRow } from '../main/subagents.ts';
import { uiGet, uiSet, uiRemove } from './uiStore';
import { normalizeLang, type Lang } from './i18n';
import { LangProvider, useT } from './hooks/useLang';
import { carrySplitSizes, computePaneFlex, SplitSizes } from './splitLayout';
// A scheduled chat must SAY it is scheduled, in the transcript header and on its sidebar row.
// Both lines come from this one pure module so they cannot word the same job differently.
import { schedulesBySession, sessionScheduleSummary, type ScheduleSummary } from './scheduleView';
// 给主会话的交底 —— 它原本对流程一无所知，连执行会话都不知道
import { consumeHandoff } from './handoffDraft';
// 哪几步共用一条会话 —— 和画布同源（草稿声明的泳道），驱动器不再各算一套
// 复用来的会话该不该清掉累积的往返
import { extractJson } from './jsonFromReply';

import { Sidebar } from './components/Sidebar';
import { ChatArea, MarkdownView, expandPastes } from './components/ChatArea';
import type { PastedBlock } from './components/ChatArea';
import hljs from 'highlight.js';
import { SettingsDialog } from './components/SettingsDialog';
import { MemoryDialog } from './components/MemoryDialog';
import { compactMemoryPrompt, memoryWarnings, type MemoryScope } from '../main/memoryPolicy';
import { MODEL_LIST_WARMUP_DELAY_MS, AGENTS_CACHE_KEY, shouldReplaceModelCache } from './modelList';
import { SkillDialog } from './components/SkillDialog';
import { WorkspacePanel } from './components/WorkspacePanel';
import { IconClose, IconLogs } from './components/Icons';
import { useAcp, isBackendOccupied, APP_ERROR_KEY } from './hooks/useAcp';
import { useFeatureFlags } from './hooks/useFeatureFlags';

/** 已经推过收尾卡的运行（`project\u0000runId`）。落盘去重 —— ref 只管到下次刷新。 */
const RUN_DONE_CARD_KEY = 'kirolex-run-done-card';

declare global {
  interface Window {
    kiroApi: {
      connect: (options: { model?: string }) => Promise<any>;
      disconnect: () => Promise<void>;
      newSession: (
        kiroLexId: string,
        cwd: string,
        model: string,
        projectId?: string,
        kiroAgent?: string,
        permissionMode?: 'auto-approve' | 'ask',
      ) => Promise<{ sessionId: string }>;
      loadSession: (sessionId: string, cwd: string, model: string) => Promise<any>;
      primeHistory: (sessionId: string, force?: boolean) => Promise<any>;
      persistNote?: (sessionId: string, text: string) => Promise<{ ok: boolean; error?: string }>;
      readEvents?: (sessionId: string, limit?: number) => Promise<{ events: any[]; path: string; truncated: boolean }>;
      loopRegisterVerifier?: (sessionId: string, command: string, timeoutSec: number) => Promise<{ ok: boolean; registered?: boolean; error?: string }>;
      loopVerify?: (sessionId: string, command: string, timeoutSec: number) => Promise<{
        ran: boolean; exitCode: number | null; output: string;
        host: 'local' | 'remote'; durationMs: number; timedOut: boolean; error?: string;
      }>;
      /** DURABLE LOOP COUNTER, owned by main. The count used to live in this window, so
       *  a reload reset it and a declared round cap became a fresh budget every time. */
      loopPersist?: (sessionId: string, run: any) => Promise<{ ok: boolean; error?: string }>;
      loopBeginRound?: (sessionId: string) => Promise<{ run: any | null; terminal: string | null; error?: string }>;
      loopRead?: (sessionId: string) => Promise<any | null>;
      loopListLive?: () => Promise<any[]>;
      loopClear?: (sessionId: string) => Promise<{ ok: boolean }>;
      /** SCHEDULED TASKS. The ticker is in main, so a job fires with no window open. */
      scheduleCreate?: (sessionId: string, spec: any) => Promise<{ ok: boolean; id?: string; error?: string; nextRunAt?: number | null; describe?: string }>;
      scheduleList?: () => Promise<Array<{ id: string; sessionId: string; prompt: string; describe: string; runs: number; maxRuns: number; paused: boolean; terminal?: string | null; lastRunAt: number | null; lastError: string | null; nextRunAt: number | null }>>;
      schedulePause?: (id: string, paused: boolean) => Promise<{ ok: boolean; error?: string }>;
      scheduleRemove?: (id: string) => Promise<{ ok: boolean }>;
      onScheduleChanged?: (cb: (payload: any) => void) => () => void;
      /** The skills kiro actually has, parsed from ~/.kiro/skills. Read-only. */
      skillList?: () => Promise<{ dir: string; skills: Array<{ folder: string; path: string; ok: boolean; doc?: any; summary?: string; error?: string }> }>;
      skillRead?: (filePath: string) => Promise<{ ok: boolean; path?: string; raw?: string; doc?: any; error?: string }>;
      skillWrite?: (filePath: string, text: string) => Promise<{ ok: boolean; path?: string; doc?: any; error?: string }>;
      /* ── RUNS：project 拥有的那些「正在跑的 skill」 ── */
      /** `name` 是你给这次运行起的名字（可省）—— 见 `StoredRun.name`。 */
      runCreate?: (project: string, skillName: string, name?: string) => Promise<{ ok: boolean; run?: any; error?: string }>;
      /** 给一次运行改名。空字符串 = 清掉名字，回到显示 `#N`。 */
      runRename?: (project: string, id: string, name: string) => Promise<{ ok: boolean; name?: string; error?: string }>;
      runList?: (project: string) => Promise<any[]>;
      runGet?: (project: string, id: string) => Promise<any | null>;
      /** `prompt`/`output` 是这一步的留档（实际发出去的原文、产出的正文）—— 「从每个节点重跑，
       *  不依赖会话和会话历史」靠的就是它们，见 `rerunReadiness.ts`。主进程 `patchRunNode` 是合并写入。 */
      runSetNode?: (project: string, id: string, nodeId: string, patch: {
        status?: string; sessionId?: string; error?: string; prompt?: string; output?: string;
        /* 这一步的账 —— 见 `flowRun.RunNode` 上 `credits` / `carryChars` / `attempts` 那几段 */
        contextPct?: number; credits?: number; carryChars?: number; attempts?: number;
      }) => Promise<{ ok: boolean; run?: any; error?: string }>;
      runRemove?: (project: string, id: string) => Promise<{ ok: boolean }>;
      /** 移出一个 flow（配置动作，历史不动）/ 名单 / 删某个 flow 的全部历史（进回收站） */
      runSetFlowDetached?: (project: string, flow: string, detached: boolean) => Promise<{ ok: boolean; detached: string[] }>;
      runDetachedFlows?: (project: string) => Promise<string[]>;
      /** project 的工作目录 —— 它的会话都在这儿干活（空 = 家目录） */
      projectGetWorkspace?: (project: string) => Promise<{ workspace: string }>;
      projectSetWorkspace?: (project: string, workspace: string) => Promise<{ ok: boolean; error?: string }>;
      /** `sessions` 是级联删掉的会话数，`cascaded` 是它们的 id（渲染层要按 id 从侧栏摘掉）。
       *  声明按主进程 `run:remove-flow-runs` 的实际返回值写 —— 它早就返回这四个字段了，只有这里没跟上。 */
      runRemoveFlowRuns?: (project: string, flow: string) => Promise<{ ok: boolean; removed: number; sessions?: number; cascaded?: string[] }>;
      runAttachSession?: (project: string, id: string, nodeId: string, sessionId: string) => Promise<{ ok: boolean; run?: any; error?: string }>;
      runRenameProject?: (from: string, to: string) => Promise<{ ok: boolean; moved?: number }>;
      /** 第 4 个参数是「这次退回由哪道门引起」—— 次数记在那道门上（main 在重置之后加） */
      runReset?: (project: string, id: string, nodeIds: string[], rewindGate?: string, opts?: { cascade?: boolean }) => Promise<{ ok: boolean; reset?: string[]; closeSessions?: string[]; error?: string }>;
      runReconcile?: (project: string, id: string) => Promise<{ ok: boolean; changed?: number; error?: string }>;
      clearContext?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
      /**
       * 一个 `file:` 产出的正文 —— 门上要能逐段 comment 它（`file:` 的产出不进 run values）。
       * 路径的算法和 `fileOutputs` 那条检查同一套：占位符按起跑输入替换、相对路径相对 run 冻结的工作目录。
       */
      runReadFile?: (project: string, id: string, ref: string) => Promise<{
        ok: boolean; path?: string; text?: string; truncated?: boolean; bytes?: number; error?: string;
      }>;
      runSetValue?: (project: string, id: string, ref: string, value: string) => Promise<{ ok: boolean }>;
      runSpillCarry?: (project: string, id: string, ref: string, value: string)
        => Promise<{ ok: boolean; path?: string; error?: string }>;
      runSetInput?: (project: string, id: string, key: string, value: string) => Promise<{ ok: boolean }>;
      runAddNode?: (project: string, id: string, node: unknown) => Promise<{ ok: boolean; error?: string; nodeId?: string }>;
      markSessionPurpose?: (sessionId: string, purpose: string, flow?: string) => Promise<{ ok: boolean; error?: string }>;
      /** 会话标题落盘 —— 不落盘的话一刷新就退回 `New Chat`（flow 起的会话全靠现取的名字） */
      renameSessionOnDisk?: (sessionId: string, title: string) => Promise<{ ok: boolean; deferred?: boolean; error?: string }>;
      openRunWindow?: (project: string, id: string) => Promise<{ ok: boolean; focused?: boolean }>;
      onRunChanged?: (handler: (payload: { project: string; id: string }) => void) => (() => void);
      focusSession?: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
      onFocusSessionRequest?: (handler: (payload: { sessionId: string }) => void) => (() => void);
      /** SKILL FLOWS. The run lives in main and on disk: an approval gate has to
       *  survive this window closing, which a renderer-owned run cannot do. */
      legacyFlowLoad?: (filePath: string) => Promise<{ ok: boolean; flow?: any; path?: string; errors?: Array<{ path: string; message: string }> }>;
      legacyFlowStart?: (sessionId: string, filePath: string, inputs: Record<string, unknown>) =>
        Promise<{ ok: boolean; runId?: string; status?: string; question?: string; reason?: string; error?: string; errors?: Array<{ path: string; message: string }> }>;
      legacyFlowApprove?: (runId: string, approved: boolean, note?: string) =>
        Promise<{ ok: boolean; runId?: string; status?: string; question?: string; reason?: string; error?: string }>;
      legacyFlowList?: () => Promise<Array<{
        runId: string; sessionId: string; flowName: string; flowVersion: number;
        startedAt: number; updatedAt: number; terminal?: string; summary: string;
        awaitingApproval: boolean; question?: string;
      }>>;
      legacyFlowGet?: (runId: string) => Promise<{ state: any; sessionId: string; flowPath?: string; updatedAt: number } | null>;
      legacyFlowDiscard?: (runId: string) => Promise<{ ok: boolean }>;
      onFlowUpdate?: (cb: (payload: any) => void) => () => void;
      onFlowNote?: (cb: (payload: any) => void) => () => void;
      ensureContext?: (sessionId: string) => Promise<{ ok: boolean; skipped?: boolean; rebuilding?: boolean; error?: string }>;
      setPrimeMode?: (sessionId: string, primeMode: 'snapshot' | 'full') => Promise<{ ok: boolean; primeMode?: 'snapshot' | 'full'; error?: string }>;
      readTranscript: (sessionId: string) => Promise<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[] }[]>;
      truncateTranscriptBefore: (sessionId: string, messageId: string) => Promise<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[] }[]>;
      rewriteTranscript: (sessionId: string, messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; ts: number; toolCalls?: ToolCall[] }>) => Promise<{ ok: boolean }>;
      listDurableSessions: () => Promise<{ id: string; title: string; projectId?: string; model?: string; createdAt: number; updatedAt: number; archived: boolean; pinned?: boolean }[]>;
      listSessions: () => Promise<any>;
      listKiroAgents: () => Promise<{ agents: Array<{ name: string; isDefault: boolean; source: 'built-in' | 'global' | 'local' }>; error?: string }>;
      openKiroAgentConfig: (sessionId: string, agentName: string, source?: 'built-in' | 'global' | 'local') => Promise<{ opened: boolean; path?: string; content?: string; error?: string }>;
      saveKiroAgentConfig: (sessionId: string, agentName: string, source: 'built-in' | 'global' | 'local' | undefined, content: string) => Promise<{ saved: boolean; path?: string; error?: string }>;
      switchKiroAgent: (sessionId: string, agentName: string) => Promise<{ ok: boolean; kiroAgent: string }>;
      switchModel: (sessionId: string, model: string) => Promise<{ ok: boolean; model: string }>;
      switchPermissionMode: (sessionId: string, permissionMode: 'auto-approve' | 'ask') => Promise<{ ok: boolean; permissionMode: 'auto-approve' | 'ask' }>;
      deleteSession: (sessionId: string) => Promise<{ ok: boolean; tombstoned?: boolean; error?: string }>;
      assignProject: (sessionId: string, projectId: string) => Promise<{ sessionId: string; projectId: string }>;
      setProject: (sessionId: string, projectId: string | null) => Promise<{ sessionId: string; projectId: string | null }>;
      moveSession: (sessionId: string, projectId: string | null) => Promise<{ sessionId: string; projectId: string | null }>;
      archiveSession: (sessionId: string, archived: boolean) => Promise<{ sessionId: string; archived: boolean }>;
      getExecutorCap: () => Promise<number>;
      getExecutorCapInfo: () => Promise<{ cap: number; auto: number; overridden: boolean }>;
      prepareImageAttachment?: (filePath: string) => Promise<{ path: string; downscaled?: boolean; from?: string; to?: string }>;
      getFeatures?: () => Promise<{ flags: Record<string, boolean>; defaults: Record<string, boolean> }>;
      setFeature?: (key: string, enabled: boolean) => Promise<{ ok: boolean; flags?: Record<string, boolean>; error?: string }>;
      setExecutorCap: (n: number) => Promise<{ ok: boolean; cap: number }>;
      getWedgeTimeout: () => Promise<{ seconds: number; default: number; min: number; max: number }>;
      setWedgeTimeout: (n: number) => Promise<{ ok: boolean; seconds: number }>;
      getToolStallTimeout: () => Promise<{ seconds: number; default: number; min: number; max: number }>;
      setToolStallTimeout: (n: number) => Promise<{ ok: boolean; seconds: number }>;
      getWorkspaceDir: () => Promise<string | null>;
      setWorkspaceDir: (dir: string) => Promise<{ ok: boolean; error?: string }>;
      getHelperModels: () => Promise<{ model: string; fallback: string; defaults: { model: string; fallback: string } }>;
      setHelperModels: (model: string, fallback: string) => Promise<{ model: string; fallback: string }>;
      reveal: () => Promise<{ revealed: boolean }>;
      splashStatus: (text: string) => Promise<{ ok: boolean }>;
      deleteProjectMemory: (projectId: string) => Promise<{ projectId: string }>;
      readMemory: (projectId?: string, sessionId?: string) => Promise<{ global: string; project: string; session: string; projectId: string | null; sessionId: string | null; globalPath: string; projectPath: string | null; sessionPath: string | null }>;
      readLastInjection: (sessionId?: string) => Promise<{
        text: string; at: number | null; path: string | null;
        /** A hand-edited block is pinned: `text` is that block, not the archive. */
        override?: boolean; overrideAt?: number | null; overridePath?: string | null;
        /** The archive, regardless of the override, so the UI can show what reverting goes back to. */
        sentText?: string;
      }>;
      writeContextOverride?: (sessionId: string, text: string) => Promise<{ ok: boolean; override?: boolean; path?: string; error?: string }>;
      clearContextOverride?: (sessionId: string) => Promise<{ ok: boolean; existed?: boolean; error?: string }>;
      writeMemory: (scope: 'global' | 'project' | 'session', projectId: string | undefined, sessionId: string | undefined, content: string) => Promise<{ ok: boolean }>;
      onSessionsPurged?: (callback: (data: { sessionIds: string[] }) => void) => () => void;
      /** 主进程记完账之后推一把 —— run 可能有新的一波能跑了（见 `run:advance`） */
      onRunAdvance?: (callback: (data: { project: string; id: string }) => void) => () => void;
      memoryBytes: (projectId?: string, sessionId?: string) => Promise<{ global: number; project: number; session: number }>;
      backupMemory: (scope: 'global' | 'project' | 'session', projectId?: string, sessionId?: string) => Promise<{ ok: boolean; at: string | null }>;
      onMemoryBytes: (callback: (data: { sessionId: string; projectId: string | null; global: number; project: number; session: number }) => void) => () => void;
      prompt: (sessionId: string, prompt: any[], model: string, projectId?: string, display?: { messageId?: string; displayText?: string; mergeIntoMessageId?: string; attachments?: any[]; pastes?: any[] }) => Promise<any>;
      cancel: (sessionId: string, model: string, suppressInterruptionNotice?: boolean) => Promise<void>;
      steer: (sessionId: string, message: string) => Promise<{ steered: boolean; reason?: string }>;
      /** Persist a CONSUMED steer into the durable transcript (its only writer:
       *  steers never go through `prompt`). Merges into the turn's base user
       *  message, which is also how it is rendered. */
      persistSteer?: (sessionId: string, text: string, messageId?: string) => Promise<{ ok: boolean; merged?: boolean; error?: string }>;
      respondPermission: (requestId: number | string, optionId: string, sessionId: string) => Promise<void>;
      listModels: () => Promise<any>;
      getUsage: () => Promise<{ text: string }>;
      generateTitle: (firstUser: string, firstAssistant?: string) => Promise<{ title?: string; error?: string }>;
      generateSuggestions: (recentConvo: string) => Promise<{ suggestions: string[]; error?: string }>;
      setSessionPinned: (id: string, pinned: boolean) => Promise<{ sessionId: string; pinned: boolean }>;
      getHomeDir: () => Promise<string>;
      getLogs: (maxLines?: number) => Promise<{ text: string; path: string }>;
      openLogs: () => Promise<{ ok: boolean; error?: string }>;
      openExternal: (target: string, sessionId?: string) => Promise<{ ok: boolean; error?: string }>;
      savePasteText: (text: string) => Promise<{ path: string; lines: number; chars: number; preview: string } | null>;
      readPaste: (filePath: string) => Promise<string | null>;
      getAutoResent: () => Promise<Record<string, string>>;
      setAutoResent: (sessionId: string, key: string) => Promise<{ ok: boolean }>;
      getDraftPastes: () => Promise<Record<string, any[]>>;
      setDraftPastes: (sessionId: string, blocks: any[]) => Promise<{ ok: boolean }>;
      pickFiles: () => Promise<Array<{ path: string; name: string; isImage: boolean }>>;
      saveClipboardImage: () => Promise<{ path: string; name: string; thumbnail: string } | null>;
      /** Registered flows (KiroLex's own registry, ~/.kirolex/flows). A project may only pick a
       *  CONFIRMED one — a draft nobody checked must not be drawn as if it were the skill. */
      flowRegList?: () => Promise<any[]>;
      flowRegGet?: (name: string) => Promise<any | null>;
      flowRegSetAgent?: (name: string, agent: string) => Promise<{ ok: boolean; error?: string }>;
      flowRegSetModel?: (name: string, model: string) => Promise<{ ok: boolean; error?: string }>;
      onFlowRegChanged?: (callback: (data: { name: string }) => void) => () => void;
      flowRegSave?: (entry: any) => Promise<{ ok: boolean; error?: string }>;
      flowRegConfirm?: (name: string, fingerprint: string) => Promise<{ ok: boolean; error?: string }>;
      flowRegRename?: (from: string, to: string) => Promise<{ ok: boolean; error?: string; runs?: number; sessions?: number }>;
      flowRegRemove?: (name: string) => Promise<{ ok: boolean }>;
      /** sessionId is optional everywhere below: it only picks the default
       *  directory / relative base. These are local disk reads and must never
       *  require a connected chat. */
      workspaceList: (sessionId?: string | null, directory?: string) => Promise<{
        path: string;
        parent: string;
        entries: Array<{ name: string; isDir: boolean }>;
      }>;
      workspaceRead: (sessionId: string | null | undefined, filePath: string) => Promise<{
        path: string;
        content: string;
        truncated?: boolean;
        binary?: boolean;
        /** Images come back as a base64 data URL for inline display. */
        image?: boolean;
        dataUrl?: string;
      }>;
      /** Watch exactly these files for on-disk edits, replacing the previous set. */
      workspaceWatchFiles?: (sessionId: string | null | undefined, paths: string[]) => Promise<{ ok: boolean; watching: number; dirs: number }>;
      onWorkspaceFileChanged?: (callback: (data: { path: string; exists: boolean; mtimeMs: number }) => void) => () => void;
      pathExists: (filePath: string, sessionId?: string) => Promise<boolean>;
      /** Session-independent image read for attachment thumbnails; null when the
       *  path is missing, unreadable, oversized, or not an image. */
      readImageDataUrl?: (filePath: string) => Promise<{ path: string; dataUrl: string } | null>;
      workspaceDownload: (sessionId: string | null | undefined, filePath: string) => Promise<{
        ok: boolean;
        path?: string;
        canceled?: boolean;
        error?: string;
      }>;
      onUpdate: (callback: (data: any) => void) => () => void;
      onError: (callback: (error: any) => void) => () => void;
      onAssistantFinal: (callback: (data: { sessionId: string; messageId: string; text: string }) => void) => () => void;
      onSessionBusy: (callback: (data: { sessionId: string; reason: string | null; detail?: string }) => void) => () => void;
      /** kiro 原生子代理名单（整份替换）—— 左栏那面 tag 靠它，直到全部 terminated */
      onSubagents?: (callback: (data: { sessionId: string; subagents: SubagentRow[] }) => void) => () => void;
      onSessionModel: (callback: (data: { sessionId: string; model: string }) => void) => () => void;
      onTurnRestart: (callback: (data: { sessionId: string }) => void) => () => void;
      onTurnQuiet: (callback: (data: { sessionId: string; quietSeconds: number; openTools?: number; toolIdleSeconds?: number; interruptInSeconds?: number | null; boundBy?: 'tool' | 'quiet'; boundSeconds?: number }) => void) => () => void;
      onTurnWedged: (callback: (data: { sessionId: string; produced: boolean }) => void) => () => void;
      getBusyMap: () => Promise<Record<string, string>>;
      /** Is a turn running for this chat right now, and what has it produced? Lets a reloaded
       *  window adopt a turn that never stopped instead of resending the question. */
      peekTurn?: (sessionId: string) => Promise<{ live: boolean; messageId: string | null; text: string; startedAt: number | null }>;
      onDisconnected: (callback: (data?: any) => void) => () => void;
      onSessionReady: (callback: (data: { sessionId: string; projectId?: string }) => void) => () => void;
    };
  }
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  attachments?: AttachedFile[];
  toolCalls?: ToolCall[];
  /** Present on a user message injected mid-turn via _session/steer:
   *  'pending' = written, awaiting the agent's next tool boundary;
   *  'consumed' = the agent folded it into the running turn. */
  steer?: 'pending' | 'consumed';
  timestamp: number;
  /** Pasted blobs referenced by `[ 粘贴 #N · M 行 ]` placeholders in content. */
  pastes?: { seq: number; lines: number; chars: number; path: string }[];
}

export interface ToolCall {
  toolCallId: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content?: string;
  /** ACP tool kind (read/edit/execute/search/...) — drives the icon. */
  kind?: string;
  /** Absolute file paths this tool touched (ACP tool_call.locations[].path). */
  locations?: string[];
  /** File diffs carried by the tool call (ACP content blocks of type 'diff'). */
  diffs?: FileDiff[];
}

export interface FileDiff {
  path: string;
  oldText?: string;
  newText: string;
}

/** A single entry of the agent's execution plan (ACP `plan` update). */
export interface PlanEntry {
  content: string;
  priority?: 'high' | 'medium' | 'low';
  status?: 'pending' | 'in_progress' | 'completed';
  /** Current task in the persisted checklist; normally the in_progress entry. */
  current?: boolean;
}

export interface AttachedFile {
  id: string;
  name: string;
  path: string;
  isImage?: boolean;
  preview?: string; // thumbnail data URL for image attachments
}

export interface QueuedMessage {
  id: string;
  /** DISPLAY text: keeps `[ 粘贴 #N · M 行 ]` placeholders so the queue card stays
   *  readable. `pastes` carries the real content for delivery. */
  content: string;
  attachments: AttachedFile[];
  pastes?: PastedBlock[];
  createdAt: number;
  /**
   * 这一条是**从磁盘恢复**的（上一次窗口关掉/刷新时它还在排队）。
   *
   * 标记的用处是不让它抢跑:重启之后所有会话都是空闲的,而排空规则「空闲就发」原本假设你正坐在这儿 ——
   * 那会变成一次无人看着的发送。带标记的条目只在两种情况下发:那个会话的回合还在跑(队列本来就在等它),
   * 或者你把那个会话打开了(你在看着)。发出去或者被你编辑过之后,这个标记就没有意义了。
   */
  restored?: boolean;
}

export interface Session {
  id: string;
  title: string;
  model: string;
  /** Named kiro-cli agent for this session. Undefined = kiro_default. */
  kiroAgent?: string;
  /** Tool approvals for this session. Undefined legacy sessions default to Bypass. */
  permissionMode?: 'auto-approve' | 'ask';
  /** Write-once memory-scoping label (design §4/§6.4). Undefined = unassigned. */
  projectId?: string;
  /** Pinned sessions sort to the top of their group. */
  pinned?: boolean;
  /**
   * WHAT THIS CHAT IS FOR, when it is not a conversation the user started.
   *
   * `'skill'` marks the transient sessions a skill canvas brings with it (注册 / 改结构): they exist to argue
   * about one structure and are closed when it is registered or the canvas is shut. The marker is what makes
   * that closing safe — without it the rule would reap whichever chat happened to be underneath.
   * Persisted with the rest of the index in `ui-state.json`, so no new file.
   */
  /**
   * 这个会话是干什么的 —— **持久化在记录里**(`SessionRecord.purpose`),不再只活在内存。
   *
   * `skill`      注册/修改 flow 时那个临时画布会话
   * `flow-main`  某个 flow 的主会话:删不掉、不回收、不干业务
   * `main`       旧的 project 级主会话,只为识别并降级它而保留
   */
  purpose?: 'skill' | 'main' | 'flow-main' | 'flow-worker';
  /** `flow-main` 属于哪个 flow。标题是给人看的,这个才是身份 */
  flow?: string;
  /** User-archived: hidden from the main list into a collapsible Archived group. */
  archived?: boolean;
  folderId?: string | null; // legacy — retained for back-compat, no longer surfaced
  lastMessage?: string;
  timestamp: number;
}

export interface SessionFolder {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface Settings {
  fontSize: number;
  /** Font stack for all UI/chat text. Empty = system default. */
  fontFamily: string;
  /** Font stack for code blocks and file paths. Empty = built-in mono stack. */
  monoFontFamily: string;
  mergeQueuedMessages: boolean;
  /** After a restart, automatically RESEND an unanswered prompt when its chat is opened. */
  recoverInterruptedTurns: boolean;
  /** Auto-fold 💭 thinking segments once thinking finishes (default on). */
  autoFoldThinking: boolean;
  /** Auto-fold 🔧 tool segments once the tool call finishes (default on). */
  autoFoldTools: boolean;
  /** Split-view grid, "<rows>x<cols>". Caps how many chats can be shown at once. */
  splitGrid: SplitGrid;
  /**
   * 界面语言。放在 `Settings` 里而不是单独一个 ui-state 键：持久化和「改了立刻生效」都是
   * 现成的（settings 是 React state，一变整棵树重渲染），而语言正是渲染输入。
   */
  language: Lang;
}

export type SplitGrid = '1x1' | '1x2' | '2x1' | '2x2';

export const SPLIT_GRIDS: Record<SplitGrid, { rows: number; cols: number; capacity: number }> = {
  '1x1': { rows: 1, cols: 1, capacity: 1 },
  '1x2': { rows: 1, cols: 2, capacity: 2 },
  // Two stacked full-width chats: better than 1x2 for long transcripts and wide
  // diffs, where horizontal room matters more than vertical.
  '2x1': { rows: 2, cols: 1, capacity: 2 },
  '2x2': { rows: 2, cols: 2, capacity: 4 },
  // 1x3 / 2x3 removed: three columns leave each pane too narrow to be usable at
  // this window size, so 2x2 is the real maximum. Saved values of the retired
  // grids fall back to 2x2 (see loadSettings).
};

const DEFAULT_SETTINGS: Settings = { fontSize: 14, fontFamily: '', monoFontFamily: '', mergeQueuedMessages: false, autoFoldThinking: true, autoFoldTools: true, recoverInterruptedTurns: true, splitGrid: '1x2', language: 'zh' };

/** One open file in the viewer. Content and view state live PER TAB so switching
 *  back restores exactly what you were looking at. */
export interface FileTab {
  id: string;
  path: string;
  content: string;
  truncated?: boolean;
  binary?: boolean;
  image?: boolean;
  dataUrl?: string;
  /** Show raw source instead of rendered markdown / highlighted code. */
  raw?: boolean;
  /** The file changed on disk while this tab was in the BACKGROUND. Re-read when it
   *  is next activated, rather than re-reading every open tab on every save: a build
   *  can rewrite a dozen files a second, and only the visible one is being looked at. */
  stale?: boolean;
  /** The file is no longer on disk (deleted or renamed away). Kept as a tab so the
   *  content stays readable, but labelled -- silently showing a stale copy of a file
   *  that no longer exists is worse than saying so. */
  gone?: boolean;
}
/** Cap: an image tab holds a base64 data URL (up to 25 MB each), so unbounded tabs
 *  would balloon renderer memory. Oldest non-active tab is evicted first. */
const MAX_FILE_TABS = 12;
const OPEN_TABS_KEY = 'kirolex-open-file-tabs';
const SPLIT_SESSION_KEY = 'kirolex-split-session';
/** 每个会话排着的后续消息 —— 落盘，因为它们是你已经按过回车的东西（见 `queuesBySession`） */
const QUEUES_KEY = 'kirolex-queues';
/** Dragged split-pane proportions. Shape-keyed inside the value, see `splitShape`. */
const SPLIT_SIZES_KEY = 'kirolex-split-sizes';
/** Stable empty collections: a pane with none of these keeps referential
 *  identity across renders, so React can skip re-rendering it. */
const EMPTY_FILES: AttachedFile[] = [];
const EMPTY_QUEUE: QueuedMessage[] = [];
/** Shared, so a pane with nothing to show does not get a NEW array every render --
 *  which would look like new content to every memo below it. */
const EMPTY_MESSAGES: Message[] = [];
const EMPTY_PLAN: any[] = [];
const EMPTY_COMMANDS: any[] = [];
const EMPTY_LINKS: any[] = [];
/** Stable no-op for the monitor pane's inert handlers (a fresh arrow function
 *  per render would defeat any memoisation of the pane). */
const NOOP: any = () => {};

/** File types the in-app viewer can never render usefully — hand these straight
 *  to the OS default application instead of opening a dead "cannot preview" tab.
 *  Images are deliberately absent: the viewer shows them inline. */
const SYSTEM_APP_EXTS = new Set([
  // documents
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'xlsm', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'rtf', 'pages', 'numbers', 'epub', 'mobi',
  // archives / disk images
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'dmg', 'pkg', 'iso',
  // audio / video
  'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus',
  'mp4', 'mov', 'm4v', 'avi', 'mkv', 'webm', 'wmv', 'flv',
  // design / binary assets
  'psd', 'ai', 'sketch', 'fig', 'xd', 'blend', 'heic', 'tiff', 'tif', 'raw',
  'ttf', 'otf', 'woff', 'woff2', 'eot',
  // executables / stores
  'app', 'exe', 'msi', 'deb', 'rpm', 'so', 'dylib', 'dll', 'class', 'jar',
  'sqlite', 'sqlite3', 'db', 'parquet', 'xlsb', 'pyc', 'wasm',
]);

function needsSystemApp(p: string): boolean {
  const name = p.split('/').pop() || p;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return false;
  return SYSTEM_APP_EXTS.has(name.slice(dot + 1).toLowerCase());
}

/** Files whose preview should be RENDERED markdown rather than raw source. */
function isMarkdownPath(p: string): boolean {
  return /\.(md|markdown|mdown|mkd|mdx)$/i.test(String(p || '').trim());
}

// Syntax highlighting for the file/report viewer. Extension -> highlight.js
// language. Anything not listed falls back to plain text (never a wrong grammar,
// which mangles the output worse than no highlighting).
const VIEWER_LANGS: Record<string, string> = {
  json: 'json', jsonc: 'json', json5: 'json', map: 'json',
  yaml: 'yaml', yml: 'yaml',
  toml: 'ini', ini: 'ini', cfg: 'ini', conf: 'ini', properties: 'ini', env: 'ini',
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', php: 'php', swift: 'swift',
  sh: 'bash', bash: 'bash', zsh: 'bash', fish: 'bash',
  sql: 'sql', graphql: 'graphql', gql: 'graphql',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml', plist: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  diff: 'diff', patch: 'diff',
  dockerfile: 'dockerfile', tf: 'hcl', hcl: 'hcl',
  csv: 'plaintext', tsv: 'plaintext', log: 'plaintext', txt: 'plaintext',
};

function viewerLangFor(p: string): string | null {
  const name = String(p || '').trim().split('/').pop() || '';
  if (/^dockerfile$/i.test(name)) return 'dockerfile';
  if (/^(makefile)$/i.test(name)) return 'makefile';
  const ext = (name.includes('.') ? name.split('.').pop() || '' : '').toLowerCase();
  const lang = VIEWER_LANGS[ext];
  return lang && lang !== 'plaintext' ? lang : null;
}

/** Pretty-print JSON so a minified config/report is actually readable. Returns
 *  null when the text isn't valid JSON (partial preview, JSONL, trailing commas),
 *  in which case the original text is shown untouched. */
function prettyJson(text: string): string | null {
  const t = (text || '').trim();
  if (!t || !/^[[{]/.test(t)) return null;
  try {
    const formatted = JSON.stringify(JSON.parse(t), null, 2);
    return formatted && formatted !== t ? formatted : null;
  } catch {
    return null;
  }
}

/** Highlighted HTML for a file preview, or null to fall back to plain text. */
function highlightForViewer(path: string, text: string): { html: string; lang: string; prettified: boolean } | null {
  const lang = viewerLangFor(path);
  if (!lang) return null;
  // 512 KB previews would make highlight.js chew for seconds; keep the UI snappy.
  if (text.length > 200_000) return null;
  const pretty = lang === 'json' ? prettyJson(text) : null;
  const source = pretty ?? text;
  try {
    const { value } = hljs.highlight(source, { language: lang, ignoreIllegals: true });
    return { html: value, lang, prettified: !!pretty };
  } catch {
    return null;
  }
}

function loadSettings(): Settings {
  try {
    const saved = uiGet('kirolex-settings');
    if (saved) {
      const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } as Settings;
      // A previously-saved grid that no longer exists (e.g. 3x3) must not leave
      // the app with an undefined capacity.
      // A saved 1x3 / 2x3 (both retired) lands here and becomes 2x2, the new maximum.
      if (!SPLIT_GRIDS[merged.splitGrid]) merged.splitGrid = '2x2';
      // 存量 settings 里没有 language；坏值也一律退回中文（见 normalizeLang）
      merged.language = normalizeLang(merged.language);
      return merged;
    }
  } catch {}
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings) {
  try {
    uiSet('kirolex-settings', JSON.stringify(settings));
  } catch {}
}

const isMac =
  typeof navigator !== 'undefined' &&
  navigator.platform.toUpperCase().includes('MAC');

const App: React.FC = () => {
  const t = useT();
  const {
    status,
    errorBySession,
    clearSessionError,
    sessions,
    currentSessionId,
    messages,
    isStreaming,
    streamingIds,
    attachedSessionIds,
    busyBySession,
    usageBySession,
    usageOf,
    rebuildContext,
    cancelAutoResend,
    interruptedSessionIds,
    connectingSessionIds,
    historyLoadingIds,
    paneViews,
    paneFallback,
    setPaneSessions,
    activeToolCall,
    subagents,
    activityStatus,
    turnStall,
    usage,
    plan,
    commands,
    permissionRequest,
    permissionRequests,
    connect,
    disconnect,
    forceStop,
    newSession,
    duplicateSession,
    rerunFromMessage,
    switchSession,
    taskListFor,
    taskListTick,
    warmSession,
    unfocusSession,
    deleteSession,
    forgetSessions,
    renameSession,
    markSessionPurpose,
    changeSessionModel,
    changeSessionAgent,
    changeSessionPermissionMode,
    assignProject,
    moveSession,
    archiveSession,
    projects,
    createProject,
    reorderProjects,
    renameProject,
    deleteProject,
    togglePin,
    clearConversation,
    resetSessionCredits,
    sendMessage,
    sendQueuedMessage,
    steerMessage,
    takeUnconsumedSteers,
    discardUnconsumedSteers,
    cancelStream,
    respondPermission,
    contextLinks,
    toggleContextSource,
    loopingIds,
    createSchedule,
    schedules,
    scheduleNow,
    pauseSchedule,
    cancelSchedule,
    stopLoop,
    restoredInputDraft,
    consumeRestoredInputDraft,
  } = useAcp();

  /**
   * ONE summary per chat, computed HERE and handed to both surfaces.
   *
   * The banner above a transcript and the next-run time on a sidebar row are the same fact seen
   * from two places, so they must not each format it: two formatters is how a row and a banner
   * end up naming different times for one job. `sessionScheduleSummary` also decides what counts
   * as live (finished and cancelled jobs are not pending), so neither component filters jobs.
   *
   * Memoised on the job list plus the coarse clock -- the countdown text only changes when one
   * of those does.
   */
  const scheduleSummaryFor = useMemo(() => {
    const byId = schedulesBySession(schedules);
    const cache = new Map<string, ScheduleSummary | null>();
    return (sid: string | null): ScheduleSummary | null => {
      if (!sid) return null;
      if (!cache.has(sid)) cache.set(sid, sessionScheduleSummary(byId.get(sid) || [], scheduleNow));
      return cache.get(sid) ?? null;
    };
  }, [schedules, scheduleNow]);

  // Attachments are PER SESSION: with several composers on screen at once, one
  // shared list would let a file dropped on pane A be sent from pane B.
  const [attachedBySession, setAttachedBySession] = useState<Record<string, AttachedFile[]>>({});
  const attachedFor = useCallback(
    (sid: string | null) => (sid ? attachedBySession[sid] || EMPTY_FILES : EMPTY_FILES),
    [attachedBySession],
  );
  const addAttachments = useCallback((sid: string | null, files: AttachedFile[]) => {
    if (!sid) return;
    setAttachedBySession((prev) => ({ ...prev, [sid]: [...(prev[sid] || []), ...files] }));
  }, []);
  const clearAttachments = useCallback((sid: string | null) => {
    if (!sid) return;
    setAttachedBySession((prev) => (prev[sid]?.length ? { ...prev, [sid]: [] } : prev));
  }, []);
  const attachedFiles = attachedFor(currentSessionId);
  // The user's last explicitly-chosen model, persisted so it survives restart
  // and is the fallback for new chats and 'auto'/legacy sessions -- instead of
  // always snapping back to the hardcoded default.
  // The literal must equal main's DEFAULT_MODEL (pinned by
  // tests/modelFallback.test.ts); it used to say 'claude-opus-4.6' while main
  // created sessions on 'claude-opus-5'.
  const [selectedModel, setSelectedModel] = useState(() => {
    try { return uiGet('kirolex-last-model') || 'claude-opus-5'; }
    catch { return 'claude-opus-5'; }
  });
  const [models, setModels] = useState<any[]>([]);
  /** 型号清单（字符串）—— 注册对话框、Flow 面板、画布的节点详情共用同一份，都是下拉 */
  const modelNames = useMemo(
    () => models.map((model: any) => String(model.model_id || model.id || model)).filter(Boolean),
    [models],
  );
  const [kiroAgents, setKiroAgents] = useState<Array<{ name: string; isDefault: boolean; source: 'built-in' | 'global' | 'local' }>>(() => {
    try {
      const cached = JSON.parse(uiGet(AGENTS_CACHE_KEY) || '[]');
      return Array.isArray(cached) ? cached : [];
    } catch { return []; }
  });
  const refreshAgents = useCallback(async () => {
    try {
      const data = await window.kiroApi.listKiroAgents();
      if (!data?.agents?.length) return;
      setKiroAgents(data.agents);
      try { uiSet(AGENTS_CACHE_KEY, JSON.stringify(data.agents)); } catch {}
    } catch { /* 保留现有那份（内存里的或缓存里的） */ }
  }, []);

  /**
   * **空了就自己再去拉** —— 那次超时之后原来没有任何东西会重试。
   *
   * 只在**列表是空的**时候拉：那正是坏掉的那个状态（缓存也没有 = 第一次启动就撞上超时）。
   * 不无条件跟着 focus 拉是因为每次都要 spawn 一个 kiro-cli，而模型列表已经占了那一次 ——
   * 两个都跟着 focus 走，等于把启动风暴搬到每次切窗口。
   */
  useEffect(() => {
    if (kiroAgents.length) return;
    const again = () => { void refreshAgents(); };
    window.addEventListener('focus', again);
    window.addEventListener('online', again);
    return () => {
      window.removeEventListener('focus', again);
      window.removeEventListener('online', again);
    };
  }, [kiroAgents.length, refreshAgents]);
  // Per-session, NOT global: switching the model/Agent on one chat must never
  // grey out the selectors of another chat you switch to.
  const [switchingAgentIds, setSwitchingAgentIds] = useState<string[]>([]);
  const [switchingModelIds, setSwitchingModelIds] = useState<string[]>([]);
  const switchingAgent = !!currentSessionId && switchingAgentIds.includes(currentSessionId);
  const switchingModel = !!currentSessionId && switchingModelIds.includes(currentSessionId);
  const [showSettings, setShowSettings] = useState(false);
  const [executorCap, setExecutorCap] = useState<number>(0);
  useEffect(() => {
    window.kiroApi.getExecutorCap?.().then((n) => { if (n) setExecutorCap(n); }).catch(() => {});
  }, []);
  // Settings changes the cap live; reflect the new value in the sidebar N/cap
  // display without an app reload.
  useEffect(() => {
    const h = (e: Event) => {
      const c = (e as CustomEvent).detail?.cap;
      if (typeof c === 'number' && c > 0) setExecutorCap(c);
    };
    window.addEventListener('kirolex:executor-cap-changed', h as EventListener);
    return () => window.removeEventListener('kirolex:executor-cap-changed', h as EventListener);
  }, []);
  // Keep the Settings "confirm before delete" toggle in lockstep with the value
  // delete actually uses (persisted flag). handleDeleteSession reads the flag live
  // from localStorage, so re-hydrate the state whenever Settings opens to avoid the
  // toggle showing a stale value that disagrees with the real delete behavior.
  useEffect(() => {
    if (!showSettings) return;
    try { setSkipDeleteConfirm(uiGet('kirolex-skip-delete-confirm') === 'true'); } catch {}
  }, [showSettings]);
  const [showWorkspace, setShowWorkspace] = useState(false);

  const [showMemory, setShowMemory] = useState(false);
  /**
   * 会话内搜索（Cmd+F）**已经搬到每一格自己身上** —— 「哪个分屏的搜索应该显示在那个分屏中」。
   * 状态、命中计数、高亮都在 `ChatArea` 里（见那里的 `findOpen` 那一段），App 不再持有全局搜索状态：
   * 一个属于整个窗口的搜索条在分屏时说不清它在搜哪一格，而 `findInPage` 也确实在搜全部。
   */
  /**
   * 三层记忆的体积（字节），横幅的唯一依据。
   *
   * 全局层只有一份，所以按 `''` 这个空 key 存；项目层按 projectId（同项目下每条会话付的是同一笔
   * 钱，压一次全都受益）；会话层按 sessionId。三个写入时机 —— 每轮注入后主进程推送、切会话时按需
   * 取一次、MemoryDialog 关闭后重取 —— 合起来保证「你自己清理完横幅就消失」，不用等下一轮对话。
   */
  const [memoryBytes, setMemoryBytes] = useState<{
    global: number;
    project: Record<string, number>;
    session: Record<string, number>;
  }>({ global: 0, project: {}, session: {} });
  /** 正在压缩的层（`scope:id`），避免连点发出两条一样的提示词。 */
  const [compactingMemory, setCompactingMemory] = useState<string | null>(null);
  /**
   * A FIX ROUND IN FLIGHT: which session to watch for the corrected structure.
   *
   * Only watched after asking, never continuously — a canvas opened from the browser must not silently
   * adopt whatever JSON happens to be further up that conversation. `seen` is the reply text already
   * consumed, so one answer is applied once.
   */
  const fixWatch = useRef<{ sessionId: string; seen: string } | null>(null);
  const [fixNote, setFixNote] = useState<string | null>(null);

  /**
   * THE RUN WINDOW ASKS FOR A CHAT — 「执行状态要在普通对话 UI 里看得见」.
   *
   * A run has no conversation of its own; each step runs in one. Clicking a step over there brings this
   * window forward on that chat, which is where what it actually said can be read.
   */
  useEffect(() => {
    const off = window.kiroApi.onFocusSessionRequest?.((payload: { sessionId: string }) => {
      if (!payload?.sessionId) return;
      void switchSession(payload.sessionId);
    });
    return () => { if (typeof off === 'function') off(); };
  }, [switchSession]);

  /**
   * 两件事一次算完：每个 project 有多少次运行（拖拽规则用），以及**哪个会话在为哪个 flow 的哪一步干活**。
   *
   * 后者是 tag 的新位置 —— project 不拥有 flow，worker 会话才真的属于某个 flow（「flow的tag就应该落在会话上」）。
   */
  /* 各 project 的工作目录：菜单要显示当前值，起会话要用它当 cwd（`cwdFor` 另有缓存） */
  useEffect(() => {
    void (async () => {
      const names = Array.from(new Set(sessions.map((s) => (s.projectId || '').trim()).filter(Boolean)));
      const out: Record<string, string> = {};
      for (const name of names) {
        const res = await window.kiroApi.projectGetWorkspace?.(name);
        const dir = String(res?.workspace || '').trim();
        if (dir) out[name] = dir;
      }
      setProjectWorkspaces(out);
    })();
  }, [sessions]);
  /**
   * 每条 flow 会话自己那块画布 —— 「两个 flow 会话当然是两个不同的画布」/「这俩不应该是分开的画布吗」。
   *
   * 状态本身仍然只有一份（`studioDraft`/`studioStandalone`），这张表补的是「各自记着自己那份」：切到哪条会话
   * 就同步把它那份放回状态里，切走时它留在表里不受影响。写入点 = 所有装载入口 + 画布上的手改 + 会话吐出新
   * 结构；读取点 = 「聚焦即装载」那条 effect。
   */

  /**
   * 焦点指着一个已经不存在的会话时,回到新会话那一页 —— 而不是渲染一个空壳。
   *
   * 「没有任何页面被选中的情况下到了一个不知道是啥会话」的另一半:画布那条会话在关闭时会自己被回收
   * (`closeSkillSession`),而焦点还指着它 —— 于是聊天区拿一个已经没有记录的 id 去渲染,标题、模型、历史
   * 全是空的,看着就像「一个不知道是啥的会话」。pending_ 不算不存在:那是刚建、记录还没落地的一瞬间。
   */
  useEffect(() => {
    const id = currentSessionId;
    if (!id || String(id).startsWith('pending_')) return;
    if (sessions.some((s) => s.id === id)) return;
    setLastActiveSessionId(null);
    unfocusSession();
  }, [currentSessionId, sessions, unfocusSession]);
  /**
   * AUTO-PARSE the rewrite into the studio.
   *
   * There used to be a 360px rail beside the transcript whose only job was a 「解析最新回复」 button.
   * The canvas is the review surface, so the parse happens on its own the moment the turn produces
   * something parseable, and the studio opens — one fewer panel, and no step whose only purpose is to
   * ask permission to look at what just arrived.
   */
  const parsedRegRef = useRef<string>('');
  /**
   * Via a ref, like `focusSessionRef` and `queueMessageRef` above it: `handleSendMessage` is declared
   * several hundred lines below, and naming it here evaluates a const in TDZ during render — which has
   * blanked this renderer once already.
   */
  const sendMessageRef = useRef<((text: string, pastes?: PastedBlock[], sid?: string) => Promise<void>) | null>(null);
  /** The verdict of the 「导入的东西是否包含了原版全部信息」 turn, keyed by the fingerprint it judged. */
  /**
   * THE AUDIT VERDICT SURVIVES A RELOAD, and that is not a nicety.
   *
   * Both the verdict and the 「已经问过了」 guard lived in memory only, so every reload re-sent the comparison:
   * observed in one registration session — the same 30,093-character prompt four times, four model turns spent
   * re-deriving an answer already given. Keyed by fingerprint, so editing the structure still re-asks.
   */
  /*
    画布上那套「对比原文」已整体撤掉 —— 「为什么画布上面还有对比原文的字样，都说了放到提示词」。
    它原来是第二条对照实现（`flowAudit`）：结构校验一通过就**自动再往那条注册会话发一条核对提示词**，
    把回复里的 verdict 解析出来显示成「对过原文 / 对原文丢了 N 处」。现在这件事由改写那一轮的提示词
    自己负责（`buildRewritePrompt` 里的 CHECKING AGAINST THE PROSE IS YOUR JOB 段），所以这里不再
    发那一轮、不再解析、也不在画布上显示。`flowAudit.ts` 模块与它的测试保留，画布不再使用。
  */
  /** 上一次把校验报错发给会话时,结构是哪一版 —— 同一版只说一次(`shouldSendFix`) */
  const fixSentRef = useRef<string>('');
  /**
   * Why nothing appeared. A reply whose JSON is cut off (the real from-scratch reply came back at 38k
   * characters with a string left unterminated) used to be swallowed by a bare `catch` — the studio simply
   * never opened and there was nothing to read. Silence is the one unacceptable outcome.
   */
  const [regNote, setRegNote] = useState<string | null>(null);
  /** Phase 2 of from-scratch: extract the structure from the prose just written. Sent once per prose. */
  const extractSentRef = useRef<string>('');

  /** 这次运行里刚发出、可能还没落盘的那一条 —— 只防并发重发（判据在历史里，见 `shouldBrief`） */
  const briefingRef = useRef(new Map<string, string>());
  /**
   * 交底 —— 一个「改 flow」的会话在收到任何别的东西之前，先知道自己在改哪个 flow、当前结构长什么样、
   * 以及不要干别的。
   *
   * 三个入口共用一个:注册对话框现起的那个、从 Flow 面板打开已注册的、以及重启后恢复画布时复用/新起的。
   * 「这个应该和 flow 是不是创建了没关系」—— 所以这里不看注册状态,只看「这条对话是不是在服务某个 flow」。
   *
   * **只发一次,靠历史带回来** —— 「你直接嵌入到它的会话历史在第一个消息的时候发送不行吗」。这条消息就是这个
   * 会话的第一条,所以判据是它自己的 transcript(`shouldBrief`),不是内存记账:重启之后历史里已经有了,就不再发。
   * 为了让那份历史真的回到上下文里,这类会话显式走 `primeMode: 'full'` —— 默认的 snapshot 恢复只逐字带回
   * 最近 18000 字(`main/index.ts` 的 `SNAPSHOT_RECENT_CHARS`),第一条消息在长对话里会掉出去,那样「只发一次」
   * 就变成了「静默失效」。flow 编辑会话本来短,全量重放的代价可以接受。
   *
   * 走 `sendMessageRef`(即 `handleSendMessage`)而不是裸 IPC:新起的会话此刻可能还没 attach,那条路会排队并在
   * 接上时排空 —— 注册那一处的注释里已经因为这个踩过一次。
   *
   * **`mode: 'text'` 是给注册路径的**,它必须把交底和改写提示词**合成一条**发出去 —— 「我新注册的一个 flow
   * 附加了一个 pdf,但 flow 会话里却找不到这个 pdf」。分两条发的实测后果(会话 `s_1786944564517_j0xa91`):
   *   05:29:31.804 `prompt received busy=undefined`  ← 交底
   *   05:29:31.813 `prompt received busy=true`       ← 改写提示词,9ms 后到,会话已占用
   *   05:29:35.194 `prompt done`（**只有一次**）
   * 第二条被当成 steer 吞掉,模型只看到交底,回的是「等你把原文发给我后再提取」—— 而附件路径就写在那条改写
   * 提示词里。所以注册路径拿文本自己拼,一条消息只产生一次 prompt。
   */

  /**
   * 启动清扫收掉的无主 worker 会话 —— 从侧栏摘掉。
   *
   * 不接这个事件的话，磁盘上已经进回收站的会话还会留在列表里，点进去是空的，要到下次启动才消失。
   * 复用 `forgetSessions`（删 flow run 的级联也是用它）。
   */
  useEffect(() => {
    const off = window.kiroApi.onSessionsPurged?.(({ sessionIds }) => {
      if (Array.isArray(sessionIds) && sessionIds.length) forgetSessions(sessionIds);
    });
    return () => { off?.(); };
  }, [forgetSessions]);

  /** 主进程每轮注入后播报的体积。压缩那一轮结束，下一轮就带回新数字，横幅随之消失。 */
  useEffect(() => {
    const off = window.kiroApi.onMemoryBytes?.((b) => {
      setMemoryBytes((prev) => ({
        global: b.global,
        project: b.projectId && prev.project[b.projectId] !== b.project
          ? { ...prev.project, [b.projectId]: b.project }
          : prev.project,
        session: b.sessionId && prev.session[b.sessionId] !== b.session
          ? { ...prev.session, [b.sessionId]: b.session }
          : prev.session,
      }));
    });
    return () => { off?.(); };
  }, []);

  /**
   * 打开就能看到 —— 只靠上面那条推送的话，横幅要等你先发一轮对话才出现，而那一轮已经付过钱了。
   *
   * 依赖的是**当前会话所属的 project**：切到别的项目就取那个项目的数。MemoryDialog 关闭时也重取
   * 一次，这样你在里面手动删完内容，回来横幅立刻就没了，不用等下一轮。
   */
  const currentProjectId = sessions.find((s) => s.id === currentSessionId)?.projectId;
  useEffect(() => {
    let alive = true;
    void window.kiroApi.memoryBytes?.(currentProjectId || undefined, currentSessionId || undefined)
      .then((b) => {
        if (!alive || !b) return;
        setMemoryBytes((prev) => ({
          global: b.global,
          project: currentProjectId ? { ...prev.project, [currentProjectId]: b.project } : prev.project,
          session: currentSessionId ? { ...prev.session, [currentSessionId]: b.session } : prev.session,
        }));
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [currentProjectId, currentSessionId, showMemory]);

  /**
   * 点【压缩】：先备份，再把那句固定提示词当成**可见的用户消息**发出去。
   *
   * 可见而不是隐藏注入 —— 压缩是破坏性操作，你得能看到它在做什么、能中途打断、transcript 里有痕迹。
   * 走 `sendMessageRef` 而不是裸 IPC，理由和上面那几处一样：会话此刻可能还没 attach，那条路会排队。
   */
  const compactMemory = useCallback(async (
    scope: MemoryScope, sid: string, projectId?: string,
  ) => {
    const key = `${scope}:${scope === 'project' ? projectId : scope === 'session' ? sid : ''}`;
    if (!sid || compactingMemory) return;
    setCompactingMemory(key);
    try {
      // 备份失败就不发提示词：宁可什么都不做，也不要在没有退路的情况下让模型重写这个文件。
      const backup = await window.kiroApi.backupMemory?.(scope, projectId, sid);
      if (!backup?.ok) { console.warn(`[kirolex] ${scope} 记忆备份失败，压缩已取消`); return; }
      const mem = await window.kiroApi.readMemory?.(projectId, sid);
      const filePath = scope === 'global' ? mem?.globalPath
        : scope === 'project' ? mem?.projectPath
        : mem?.sessionPath;
      if (!filePath) return;
      // 字节数从 `memoryBytes` 取，不用字符串 `.length` —— 那是**字符**数，中文会低估三倍，而提示词
      // 里报的体积和横幅上显示的必须是同一个数。
      const b = await window.kiroApi.memoryBytes?.(projectId, sid);
      await sendMessageRef.current?.(
        compactMemoryPrompt({ scope, filePath, bytes: b ? b[scope] : 0 }),
        undefined,
        sid,
      );
    } finally {
      setCompactingMemory(null);
    }
  }, [compactingMemory]);
  const [showSkill, setShowSkill] = useState(false);
  const [showLogs, setShowLogs] = useState(false);
  const [logsText, setLogsText] = useState('');
  // Log viewer opens at the newest tail; older lines load on scroll-up.
  const [logsLimit, setLogsLimit] = useState(500);
  const [logsLoadingOlder, setLogsLoadingOlder] = useState(false);
  const logsPreRef = useRef<HTMLPreElement>(null);
  const logsHasMoreRef = useRef(true);
  const LOGS_CHUNK = 500;
  // In-app file viewer (internal "browser"): file links/paths open here, not the OS.
  // File viewer TABS. Was a single object, so every click replaced the open file —
  // losing scroll position, the rendered/raw choice, and any way back without
  // re-finding the link in chat. Each tab now owns its own content and view state.
  const [fileTabs, setFileTabs] = useState<FileTab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const fileScrollRef = useRef<Record<string, number>>({});   // tabId -> scrollTop
  /** Mirrors of the tab state, so the disk-change listener does not have to be torn
   *  down and re-registered on every tab edit (which would drop events mid-save). */
  const fileTabsRef = useRef<FileTab[]>([]);
  fileTabsRef.current = fileTabs;
  const activeFileTabIdRef = useRef<string | null>(null);
  activeFileTabIdRef.current = activeFileTabId;
  const fileBodyRef = useRef<HTMLDivElement | null>(null);
  const fileViewer = fileTabs.find((t) => t.id === activeFileTabId) || null;
  const [fileViewerLoading, setFileViewerLoading] = useState(false);
  // Markdown files render formatted by default; the toggle shows the raw source.
  const fileViewerRaw = !!fileViewer?.raw;
  const [settings, setSettings] = useState<Settings>(loadSettings);

  // --- Split view (1x1 … 3x3) -----------------------------------------------
  // The user CHECKS sessions in the sidebar; every checked session gets its own
  // fully interactive pane (own composer, queue, attachments, model). The
  // focused session is always shown, so unchecking everything returns to the
  // exact single-chat layout. Each pane stays live because useAcp mirrors those
  // sessions' streams into pane state.
  // focusSession is defined much further down; a dep on it here would be
  // evaluated during render and hit TDZ. Route through a ref instead.
  const focusSessionRef = useRef<(sid: string | null) => Promise<void>>(async () => {});
  /** Forward reference to handleQueueMessage, which is declared further down. Used
   *  so handleSendMessage can divert into the queue while a history rebuild owns
   *  the backend, without putting a later-declared const in a dependency array. */
  const queueMessageRef = useRef<((text: string, pastes?: PastedBlock[], paneSid?: string) => void) | null>(null);
  /** Same forward-reference pattern as queueMessageRef: handleSteerMessage is
   *  declared further down, and naming it in a dependency array up here would be
   *  evaluated during render and hit TDZ. */
  const handleSteerMessageRef = useRef<((text: string, pastes?: PastedBlock[], paneSid?: string) => Promise<void> | void) | null>(null);
  // The layout (which chat sits in which slot) IS remembered across restarts, so
  // reopening the app puts you back where you were. What must NOT happen is
  // re-filling slots when you merely switch the grid size on -- that is why the
  // grid-change effect below seeds only the current chat and leaves the rest
  // empty, while a restart restores the saved list verbatim.
  const [splitSessionIds, setSplitSessionIds] = useState<string[]>(() => {
    try {
      // Shared store, not origin-scoped localStorage: which chats sit in which pane
      // is layout state and was being lost on every dev/prod origin switch. The key
      // already existed in ui-state.json as a migration leftover that nothing read.
      const saved = JSON.parse(uiGet(SPLIT_SESSION_KEY) || '[]');
      return Array.isArray(saved) ? saved.filter((id) => typeof id === 'string') : [];
    } catch { return []; }
  });
  /** 每个 project 挂着哪些 flow（从它的 run 推出来的）—— project 菜单里那一节 */
  const [projectFlowsMap, setProjectFlowsMap] = useState<Record<string, Array<{ flow: string; status: string; runId?: string }>>>({});
  /** 每个 project 已经移出的 flow —— 「不再使用」写在这里，它决定主会话能不能删 */
  const [detachedFlowsMap, setDetachedFlowsMap] = useState<Record<string, string[]>>({});
  /** 会话 → 它在为哪个 flow 的哪一步干活。左栏那面 flow tag 就是它 */
  /*
    聚焦一个 flow 的**主会话**就把这个 flow 的运行页摆出来 —— 「这个 run 的功能和修改或创建 flow 是不一样的，
    我需要有一些 run 的按钮」。主会话的职责是「这个 flow 在这个 project 的运行现场」，所以它下面该是运行页
    那套动作（开始运行 / 加 flow / 按新定义重开一次 / 打回 / 删这个 flow 的运行），而不是定义画布那套
    （指纹 / 校验通过 / 保存）。上面那条装载 effect 已经不再给它装画布，这条负责把该显示的东西摆上。

    **每次聚焦只摆一次，之后不再管这一页看的是哪个 run** —— 「切换不同的 flow 有问题哦，切换不过去」。
    第一版把 `runView` 放进依赖、又要求「这一页必须在看这个 flow 的运行」，于是它变成一条持续纠正的规则：
    你在带状上点另一个 flow（`onSwitchRun` → `setRunView`），焦点还在这条主会话上，它立刻判定「看错了」
    并拽回来 —— 表现就是切不过去。运行页看哪个 run 是**人的选择**，这条 effect 只负责「刚点进主会话时
    别让它空着」。

    不新建任何东西：这个 flow 在这个 project 一次运行都没有时什么都不做，那条会话走 `flowChatAlone`，
    把对话本身显示出来。
  */
  const mainRunOpenedRef = useRef<string>('');

  /**
   * 这条会话有没有**它自己那块**画布。判据是归属（`draftOwner`），不是「状态里有没有结构」——
   * 状态里那份可能是别的会话的。
   */
  const { rows: splitRows, cols: splitCols, capacity: splitCapacity } = SPLIT_GRIDS[settings.splitGrid] || SPLIT_GRIDS['1x2'];
  // The highlighted set IS the grid, in selection order. Empty set = classic
  // single-chat layout. Deriving panes from the focused chat instead was wrong:
  // focusing a highlighted chat then collapsed the grid back to one pane.
  const panes = useMemo(() => {
    const known = new Set(sessions.map((s) => s.id));
    const list = splitSessionIds.filter((id) => known.has(id)).slice(0, Math.max(1, splitCapacity));
    if (list.length) return list;
    return currentSessionId ? [currentSessionId] : [];
  }, [splitSessionIds, sessions, splitCapacity, currentSessionId]);
  /** The chat that was on screen when the split was emptied.
   *
   *  Closing the last pane drops the FOCUS (see toggleSplitSession: keeping it would
   *  refill the grid and render that chat full screen again), but the sidebar should
   *  still show where you were -- so the highlight is driven by this instead. It is
   *  only ever set by that one action and cleared the moment any chat is focused. */
  const [lastActiveSessionId, setLastActiveSessionId] = useState<string | null>(null);
  /** What the sidebar highlights: the focused chat, or the one we just left. Passed
   *  in place of `currentSessionId` so no new prop has to be threaded through the
   *  three sidebar components -- the row is genuinely "where you are", it just is not
   *  rendered in a pane right now. */
  const highlightSessionId = currentSessionId || lastActiveSessionId;
  useEffect(() => {
    if (currentSessionId && lastActiveSessionId) setLastActiveSessionId(null);
  }, [currentSessionId, lastActiveSessionId]);

  /** Split layout is driven by the setting, so a single chosen chat still renders
   *  as a grid (with the "add" strip) rather than silently collapsing to one chat.
   *
   *  With NOTHING assigned there is no grid to draw: closing the last pane lands on
   *  the ordinary opening screen (see the `panes[0] || currentSessionId` fallback in
   *  the render, which resolves to null once the focus is dropped too). The grid
   *  SETTING survives, so putting any chat back re-splits immediately -- that is the
   *  part that used to be destroyed, by rewriting splitGrid to '1x1'. */
  const splitActive = splitCapacity > 1 && splitSessionIds.length > 0;
  // Assigned chats share the space; unused capacity is just the slim strip.
  const paneCols = Math.max(1, Math.min(splitCols, panes.length));
  const paneRows = Math.max(1, Math.ceil(panes.length / paneCols));
  // Where the free slots actually are decides the strip's orientation: a partly
  // filled row means "to the right", a full row with rows to spare means "below".
  const hasRoom = panes.length < splitCapacity;
  const rowComplete = panes.length % splitCols === 0;
  const stripBelow = hasRoom && rowComplete && paneRows < splitRows;
  const stripRight = hasRoom && !stripBelow;
  /** Panes grouped into rows. The layout is nested flex (rows of panes), not one
   *  CSS grid: a grid forces every row to share the same column tracks, so the
   *  "add" strip had to become a full-height column down the whole right edge
   *  even when the only free cell was the bottom-right one. Rows own their own
   *  splits, which also makes each divider independently draggable. */
  const paneRowsOfPanes = useMemo(() => {
    const out: (string | null)[][] = [];
    for (let i = 0; i < panes.length; i += paneCols) out.push(panes.slice(i, i + paneCols));
    return out.length ? out : [[null]];
  }, [panes, paneCols]);
  /** Dragged sizes are keyed by layout shape: restoring fractions that belonged to
   *  a different pane count would silently mis-size the new arrangement. */
  const splitShape = `${paneRowsOfPanes.length}x${paneCols}:${panes.length}:${stripBelow ? 'b' : stripRight ? 'r' : '-'}`;
  const [splitSizes, setSplitSizes] = useState<SplitSizes | null>(() => {
    try {
      // Shared store, NOT localStorage. localStorage is origin-scoped and this app
      // has two renderer origins (file:// for a normal start, http://localhost:5173
      // in dev), so dragged pane proportions silently reset every time you switched
      // between `npm start` and `npm run dev:hot` -- the same class of loss that
      // already cost project groups, pins and archive flags.
      const saved = uiGet(SPLIT_SIZES_KEY);
      return saved ? JSON.parse(saved) : null;
    } catch { return null; }
  });
  // Live feature switches (main owns them; a Settings toggle re-renders here).
  const featureFlags = useFeatureFlags();
  const dragSplits = featureFlags.splitDragResize !== false;
  // Carried, not exact-matched: adding a pane must not move the dividers that
  // still describe the same structure. See carrySplitSizes.
  const activeSizes = useMemo(
    () => carrySplitSizes(splitSizes, splitShape, paneRowsOfPanes),
    [splitSizes, splitShape, paneRowsOfPanes],
  );
  const rowFlex = (r: number) => activeSizes?.rows?.[r] ?? 1;
  /** Flex per pane, per row. Panes divide their row between them: free capacity to the
   *  RIGHT of a row is a slim strip, while a fully free ROW reserves a real row's
   *  height. Both rules and their consequences live in splitLayout.ts, which is pure
   *  and covered by tests. */
  const paneFlexByRow = useMemo(() => computePaneFlex(paneRowsOfPanes, activeSizes), [paneRowsOfPanes, activeSizes]);
  const colFlex = (r: number, c: number) => paneFlexByRow[r]?.[c] ?? 1;
  /** Drag a divider: the two neighbours trade space, everything else holds still.
   *  Sizes are read from the DOM rather than from state so a fresh (all-equal)
   *  layout and an already-dragged one behave identically. */
  const handlePaneResizeStart = useCallback((
    e: React.MouseEvent,
    axis: 'col' | 'row',
    rowIndex: number,
    dividerIndex: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.currentTarget as HTMLElement;
    const prev = handle.previousElementSibling as HTMLElement | null;
    const next = handle.nextElementSibling as HTMLElement | null;
    if (!prev || !next) return;
    const horizontal = axis === 'col';
    const startPos = horizontal ? e.clientX : e.clientY;
    const prevBox = prev.getBoundingClientRect();
    const nextBox = next.getBoundingClientRect();
    const prevSize = horizontal ? prevBox.width : prevBox.height;
    const nextSize = horizontal ? nextBox.width : nextBox.height;
    const total = prevSize + nextSize;
    // A pane narrower than this cannot show its composer controls.
    const MIN = horizontal ? 320 : 180;
    if (total < MIN * 2) return;
    let dragging = true;
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) return;
      const delta = (horizontal ? ev.clientX : ev.clientY) - startPos;
      const newPrev = Math.max(MIN, Math.min(total - MIN, prevSize + delta));
      setSplitSizes((cur) => {
        // Build on the CARRIED sizes, not on an exact shape match: otherwise the
        // first drag after adding a pane would discard the proportions that were
        // just carried over and snap everything back to equal.
        const carried = carrySplitSizes(cur, splitShape, paneRowsOfPanes);
        const base = carried
          ? { shape: splitShape, rows: [...carried.rows], cols: carried.cols.map((row) => [...row]) }
          : {
            shape: splitShape,
            rows: paneRowsOfPanes.map(() => 1),
            cols: paneRowsOfPanes.map((row) => row.map(() => 1)),
          };
        while (base.rows.length < paneRowsOfPanes.length) base.rows.push(1);
        paneRowsOfPanes.forEach((row, r) => {
          if (!base.cols[r]) base.cols[r] = row.map(() => 1);
          while (base.cols[r].length < row.length) base.cols[r].push(1);
        });
        // Preserve the pair's combined share so untouched neighbours never move.
        const target = horizontal ? base.cols[rowIndex] : base.rows;
        const pairSum = (target[dividerIndex] ?? 1) + (target[dividerIndex + 1] ?? 1);
        const share = pairSum * (newPrev / total);
        target[dividerIndex] = share;
        target[dividerIndex + 1] = pairSum - share;
        return base;
      });
    };
    const onMouseUp = () => {
      dragging = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = horizontal ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [splitShape, paneRowsOfPanes]);
  useEffect(() => {
    try {
      // Reset (null) must also clear storage, otherwise a reload restores the
      // proportions the user just discarded.
      if (splitSizes) uiSet(SPLIT_SIZES_KEY, JSON.stringify(splitSizes));
      else uiRemove(SPLIT_SIZES_KEY);
    } catch {}
  }, [splitSizes]);


  /**
   * 哪些会话**不该占分屏格子** —— 判据只有一处，因为下面那条清理 effect 是按它摘人的。
   *
   * 入口有四个（手动切换、网格播种、领养、启动重建），每加一条路径就得记着再拦一遍；而「格子里不该有它」
   * 是个随时能检查的状态。所以这里不问它是怎么进来的：包括从 ui-state 恢复出来的存量，一律剔除。
   */
  const notForSplit = useCallback((id: string) => {
    if (!id) return true;
    const session = sessions.find((s) => s.id === id);
    /*
      归档的会话不进分屏 —— 「本来它应该在 archive 的时候被关掉，不知道为什么它又回到分屏了」。
      归档只是把 `archived: true` 写进记录，会话仍然留在 `sessions` 里，而 `panes` 只过滤「这条会话
      还存在吗」（known），所以归档过的那一格照旧渲染。加在这里而不是改 `panes`：下面那个清理 effect
      已经在按 `notForSplit` 摘人了，归档属于同一类「不该占格子」的会话，判据放在一处才不会再漏。
    */
    if (session?.archived) return true;
    /*
      **列表里没有这条会话 → 它不该占格子** —— 「为什么现在分屏选不了第二个会话了」。

      实测那次：`splitSessionIds` 里有一条 `s_…s1xgc0`，磁盘上有 record、`projectId` 是「周报」，
      但 transcript 是 **0 字节**（在 project 里点了 New Chat 没发过消息），所以它不进侧栏列表。
      于是那一格渲染不出任何东西、却照样占着容量：看起来只有一格，再点别的会话就把可见那一格顶掉。

      判据放在这里而不是 `panes`：`panes` 只管"渲染谁"，而容量是 `splitSessionIds` 算的 ——
      只改渲染的话那一格永远是空的。下面那条清理 effect 会按这个判据把存量剔掉。

      判据前面那个 `sessions.length` 是必须的：hydrate 完成之前 `sessions` 是空的，那时候"不在列表里"
      对**每一条**都成立，会把从 ui-state 恢复出来的分屏整个清空。
    */
    if (sessions.length > 0 && !session) return true;
    return false;
  }, [sessions]);

  /** 不该占格子的一律剔掉 —— 包括从 ui-state 恢复出来的存量（判据见 `notForSplit`）。 */
  useEffect(() => {
    if (!splitSessionIds.length) return;
    const keep = splitSessionIds.filter((id) => !notForSplit(id));
    if (keep.length !== splitSessionIds.length) setSplitSessionIds(keep);
  }, [splitSessionIds, notForSplit]);

  const toggleSplitSession = useCallback((id: string) => {
    if (notForSplit(id)) return;
    // Everything here runs in an event handler and reads state directly. Do NOT
    // move the setSettings call into a setSplitSessionIds updater: React can
    // replay updaters, and scheduling another update from inside one froze the
    // renderer and lost the selection.
    if (splitSessionIds.includes(id)) {
      const next = splitSessionIds.filter((x) => x !== id);
      if (next.length === 0) {
        // Closing the LAST pane empties the grid; it does not turn split off.
        // It used to set splitGrid '1x1', i.e. one action ("remove this pane")
        // silently changed the layout setting as well -- and getting back meant
        // re-picking the grid AND re-picking chats.
        //
        // The focus has to go with it: a chat that stays focused while no longer
        // assigned is immediately adopted back into a slot by the layout effects
        // below, AND the single-pane fallback would render it full screen -- which is
        // the collapse this was reported as. Remembering it separately keeps its
        // sidebar row highlighted (see `highlightSessionId`) without either effect.
        setSplitSessionIds([]);
        setLastActiveSessionId(currentSessionId);
        unfocusSession();
        return;
      }
      setSplitSessionIds(next);
      // Removing the chat you were in: move focus to the first survivor.
      if (id === currentSessionId) void focusSessionRef.current(next[0]);
      return;
    }
    // First selection seeds the grid with the chat you are already in, so one
    // ⌘-click gives a side-by-side instead of a single unrelated pane.
    const seeded = splitSessionIds.length === 0 && currentSessionId && currentSessionId !== id
      ? [currentSessionId, id]
      : [...splitSessionIds, id];
    let cap = Math.max(1, splitCapacity);
    // A 1x1 grid means "no split". Explicitly picking a second chat is a clear
    // intent to split, so raise the grid rather than ignore the click.
    if (cap < 2 && seeded.length > 1) {
      setSettings((cur) => (SPLIT_GRIDS[cur.splitGrid].capacity < 2 ? { ...cur, splitGrid: '1x2' } : cur));
      cap = 2;
    }
    setSplitSessionIds(seeded.length > cap ? seeded.slice(seeded.length - cap) : seeded);
  }, [splitSessionIds, currentSessionId, splitCapacity, unfocusSession]);

  // The grid setting IS the on/off switch.
  //   * 1x1            -> leave split mode (assignments dropped)
  //   * turned ON empty -> seed with ONLY the chat you are in; other slots stay
  //                        empty (never pre-filled with recent chats)
  //   * made SMALLER   -> discard the assignments that no longer fit
  //   * made BIGGER    -> keep everything, new slots are empty
  const appliedGridRef = useRef<SplitGrid | null>(null);
  useEffect(() => {
    const cap = SPLIT_GRIDS[settings.splitGrid]?.capacity ?? 1;
    const gridChanged = appliedGridRef.current !== null && appliedGridRef.current !== settings.splitGrid;
    appliedGridRef.current = settings.splitGrid;
    if (cap <= 1) {
      if (splitSessionIds.length) setSplitSessionIds([]);
      return;
    }
    if (splitSessionIds.length > cap) {
      // Shrunk: keep the first `cap` slots, drop the rest.
      setSplitSessionIds(splitSessionIds.slice(0, cap));
      return;
    }
    // flow 的会话不播种（见 `notForSplit`）—— 否则一进画布，分屏第一格就被它占了
    if (splitSessionIds.length === 0 && currentSessionId && !currentSessionId.startsWith('pending_')
      ) {
      setSplitSessionIds([currentSessionId]);
    }
    void gridChanged;
  }, [settings.splitGrid, currentSessionId, splitSessionIds]);

  /**
   * 点开一个不在格子里的对话:它进**你刚在看的那一格**,别的格不动 —— 「第二个分屏经常被顶掉，看看是谁干的」。
   *
   * 就是这个效果干的。它原来是「追加到末尾,再 slice 掉最旧的一格」:格子满了的时候,你每点一个侧栏里的
   * 对话,都会顶掉一格 —— 而顶掉哪一格取决于它们的**加入顺序**,和你正在看哪一格无关。于是「我特意摆在
   * 第二格的那个」时不时就没了,而你什么都没动过它。
   *
   * 现在替换的是你最后停留过的那一格(`lastPaneRef`):意思变成「在我这一格里打开它」—— 另一格是你摆在那儿
   * 对着看的东西,不该因为你点了别的而消失。格子没满时照旧是补一格,不动任何人。
   */
  const lastPaneRef = useRef<string | null>(null);
  useEffect(() => {
    if (currentSessionId && splitSessionIds.includes(currentSessionId)) lastPaneRef.current = currentSessionId;
  }, [currentSessionId, splitSessionIds]);
  useEffect(() => {
    if (!currentSessionId || splitSessionIds.length === 0) return;
    if (splitSessionIds.includes(currentSessionId)) return;
    /**
     * 晚一拍再领养,而且再判一次 —— 「我创建注册会话的时候还是会扰乱分屏」。
     *
     * `newSession` 在**返回 id 之前**就把焦点切过去了,所以「这是一条 flow 会话」这件事(登记进
     * `flowSessionIds`、markSkillSession、setRegistration)全都发生在焦点变化**之后**的那几行。
     * 立即领养就正好挤在那个窗口期里:格子被新会话抢走,随后身份才姗姗来迟 —— 而领养是不可逆的,
     * 你摆好的布局已经变了。
     *
     * 60ms 之后再看:那时身份已经落地,`notForSplit` 会拦住它。对真正需要领养的普通对话,这点延迟看不出来
     * (它本来就是「你点了一个不在格子里的对话」之后的一次布局调整)。
     */
    const timer = setTimeout(() => {
      if (splitSessionIds.includes(currentSessionId)) return;
      setSplitSessionIds((prev) => {
      if (prev.includes(currentSessionId)) return prev;
      const cap = Math.max(1, splitCapacity);
      if (prev.length < cap) return [...prev, currentSessionId];
      // 满了：换掉「我刚在看的那一格」，位置不变；不知道是哪一格时才退回换最后一格
      const at = lastPaneRef.current ? prev.indexOf(lastPaneRef.current) : -1;
      const slot = at >= 0 ? at : prev.length - 1;
      const next = [...prev];
      next[slot] = currentSessionId;
      return next;
      });
    }, 60);
    return () => clearTimeout(timer);
  }, [currentSessionId, splitSessionIds, splitCapacity]);

  // Every pane except the focused one needs its stream mirrored into state.
  useEffect(() => {
    void setPaneSessions(panes.filter((id) => id !== currentSessionId));
  }, [panes, currentSessionId, setPaneSessions]);

  useEffect(() => {
    /* 分屏布局照常持久化 —— 全页视图不再改它，所以这里不需要再为它设防（见 `fullPageVisible` 那段注释） */
    try {
      if (splitSessionIds.length) uiSet(SPLIT_SESSION_KEY, JSON.stringify(splitSessionIds));
      else uiRemove(SPLIT_SESSION_KEY);
    } catch {}
  }, [splitSessionIds]);

  /** 启动时的布局恢复只做一次 —— 之后「领养当前会话」那条规则才不会把刚恢复的布局改写掉。 */
  const layoutRestoredRef = useRef(false);

  // Startup reconciliation, once the session list exists: drop chats that no
  // longer exist, and focus a restored pane instead of letting the "adopt the
  // focused chat" rule below rewrite the layout we just restored.
  useEffect(() => {
    if (layoutRestoredRef.current || sessions.length === 0) return;
    layoutRestoredRef.current = true;
    if (splitSessionIds.length === 0) return;
    const known = new Set(sessions.map((x) => x.id));
    // 存量里可能就有一条 flow 会话（上一版把它写进了 ui-state）：恢复的时候一起剔掉
    const alive = splitSessionIds.filter((id) => known.has(id));
    if (alive.length !== splitSessionIds.length) setSplitSessionIds(alive);
    if (alive.length && currentSessionId && !alive.includes(currentSessionId)) {
      void focusSessionRef.current(alive[0]);
    }
  }, [sessions, splitSessionIds, currentSessionId]);
  const [homeDir, setHomeDir] = useState('~');

  /**
   * 这个 project 的会话该在哪儿起 —— 「加到 project 里面不就好了」。
   *
   * 所有会话原来一律 `newSession(homeDir, …)`:不只是 flow 的 worker,你在 project「kirolex」里开的普通对话
   * cwd 也是家目录,于是每次都得跟它说一遍源码在哪。目录是 project 的属性,所以这里按 project 取一次。
   * 取不到就回家目录 —— 没配过的 project 行为完全不变。
   */
  const projectCwdCache = useRef<Map<string, string>>(new Map());
  /** 各 project 的工作目录（显示用；权威值在磁盘上的 project.json） */
  const [projectWorkspaces, setProjectWorkspaces] = useState<Record<string, string>>({});
  const cwdFor = useCallback(async (project?: string | null): Promise<string> => {
    const name = (project || '').trim();
    if (!name) return homeDir || '~';
    const cached = projectCwdCache.current.get(name);
    if (cached) return cached;
    const res = await window.kiroApi.projectGetWorkspace?.(name);
    const dir = String(res?.workspace || '').trim() || homeDir || '~';
    projectCwdCache.current.set(name, dir);
    return dir;
  }, [homeDir]);


  /**
   * ADVANCE A RUN BY ONE WAVE — the loop, and it is deliberately one wave per press.
   *
   * `planNext` says what may start; each step goes into a chat of its OWN (created in this project, under the
   * skill's agent — its tools live in that agent's MCP servers). Statuses are written through main, so the graph
   * and any other window follow by broadcast. Gates are NOT passed here: they are the point at which a person
   * looks, so the loop stops and the left column says 「等你过门」.
   *
   * Every tool call still goes through the gate in main: outside a step's declared tools, or a write from a step
   * that declared none, is refused before it reaches you.
   */
  /**
   * 一次运行结束就把它起的执行会话归档 —— 「生出来的新会话不会被回收」。
   *
   * 每一步都是一条新会话（会话之间什么都不共享，run 才是携带者），所以跑一遍二十几步的 flow 就往侧栏里
   * 塞二十几条，而它们在运行结束之后已经没有人会再对它们说话。原来唯一会关掉 worker 会话的地方是
   * 「打回 / 重跑」（`run:reset` 回的 `closeSessions`），也就是只有出错那条路会收拾。
   *
   * **归档而不是删**：那条会话的 transcript 就是这一步真正做了什么的记录，run 里只有状态和产出值。
   * 归档把它从侧栏拿走、随时能翻回来，属于可逆动作。正在被你看着的那条不动（否则界面当场被抽走），
   * 下次到达这里再收。
   */

  /**
   * @param only 只允许这些节点起跑。不给 = 所有就绪的都跑（一直以来的行为）。
   *
   *   给了，是因为节点上那两个按钮问的是**这一个**分支：「只跑这个分支和它之前的所有依赖节点」。
   *   没有它，点任何一个节点都会把当时所有 ready 的节点一起带跑 —— 包括你没点的那条平行支线。
   *   名单要一路传进递归：分支里的后续节点是在上游跑完之后才 ready 的，下一波仍然只能在名单里挑。
   */
  /**
   * 驱动锁多久算卡住。一波的**派发**（起会话 + attach + 发送）实测十几秒够了，60 秒只可能是卡死。
   */
  const DRIVE_LOCK_STALE_MS = 60_000;

  /** 正在被驱动的 run（`project\0runId`）→ 拿到锁的时刻。见 `advanceRun` 里那把会过期的锁。 */
  const drivingRef = useRef<Map<string, number>>(new Map());
  const doneCardSent = useCallback((mark: string): boolean => {
    try { return (JSON.parse(uiGet(RUN_DONE_CARD_KEY) || '[]') as string[]).includes(mark); }
    catch { return false; }
  }, []);
  const markDoneCardSent = useCallback((mark: string) => {
    try {
      const seen = JSON.parse(uiGet(RUN_DONE_CARD_KEY) || '[]') as string[];
      /** 只留最近 200 条 —— 这是个去重集合，不是历史记录；无界增长会把 ui-state 撑大。 */
      uiSet(RUN_DONE_CARD_KEY, JSON.stringify([...seen.filter((x) => x !== mark), mark].slice(-200)));
    } catch { /* 记不上就可能重发一张，比不发好 */ }
  }, []);

  /**
   * 用量读数走 `usageOf`（一个稳定的 getter），**不读 `usageBySession` 这个 state**。
   *
   * 两条理由，都是实测逼出来的：
   *
   *   ① **不能慢一轮。** 原来这里镜像了一个 ref（`usageBySessionRef.current = usageBySession`，渲染期赋值），
   *      而驱动器在 `sendMessage().then(...)` 里读它 —— 那一刻 React 往往还没为这一轮的 metadata 重渲染。
   *      于是 credits 的前后两次读到同一个数、算出来的花费是 **0**；`contextPct` 也一直慢一轮
   *      （实测钉下 8.179，而权威表里当时已经是 8.3）。`usageOf` 读的是收到 metadata 时就同步写好的那份 Map。
   *   ② **不能进 `advanceRun` 的依赖。** `usageBySession` 每一轮都会变（那正是它的用途），进了依赖就会
   *      每跑完一步重建一次驱动器和它下面那条递归链，而链上还挂着在飞的 `.then(...)`。
   *      `usageOf` 是 `useCallback(…, [])`，身份永不变，所以读它不付这个代价 ——
   *      和 `sendMessageRef` / `driveRunRef` 同一条理由，只是这次不需要 ref 了。
   */

  /**
   * 主进程记完一步的账之后推一把 —— **接住它，把 run 继续往下跑**。
   *
   * 「既然没有门为什么中间总是停下来」：驱动器活在渲染层，靠 `sendMessage(...).then(...)` 一波接一波
   * 递归。渲染层每重载一次（`Cmd+R`、dev-hot、崩一次），那条链连同整个 JS 堆消失 —— 对账会把在跑的
   * 那步补记成 `done`，但**没有任何东西再调 `advanceRun`**，run 就停在"该跑的都就绪、没人跑"。
   * 实测那个日志窗口里渲染层重载了 15 次。
   *
   * 只在**当前打开的那个 run** 上接：别的 run 不该被一条后台事件悄悄推着跑起来（它可能是你故意停下的）。
   * `advanceRun` 自己带锁，所以这一推和渲染层还活着的那条链不会打架。
   */
  const [deleteConfirm, setDeleteConfirm] = useState<{ sessionId: string; title: string } | null>(null);
  /** 被拒绝的删除请求的理由。必须说出来 —— 一个点了没反应的按钮会让人以为程序坏了，然后再点五次。 */
  const [deleteRefusal, setDeleteRefusal] = useState<string | null>(null);
  const [rerunConfirm, setRerunConfirm] = useState<{
    messageId: string;
    editedText: string;
    deleteCount: number;
    /** The chat the rerun belongs to — a split pane is not necessarily focused. */
    sessionId?: string;
  } | null>(null);
  const [deleteProjectConfirm, setDeleteProjectConfirm] = useState<{ name: string; memberCount: number } | null>(null);
  const [usageActionConfirm, setUsageActionConfirm] = useState<
    'contextMenu' | 'compact' | 'clear' | 'resetCredits' | null
  >(null);
  const [unreadSessionIds, setUnreadSessionIds] = useState<string[]>([]);
  // "Don't ask again" for delete confirmation (persisted).
  const [skipDeleteConfirm, setSkipDeleteConfirm] = useState<boolean>(() => {
    try { return uiGet('kirolex-skip-delete-confirm') === 'true'; } catch { return false; }
  });
  const [dontAskDelete, setDontAskDelete] = useState(false);
  // New Chat dialog: choose project at creation.
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatProject, setNewChatProject] = useState<string>(''); // '' = none, '__new__' = create
  const [newChatNewProjectName, setNewChatNewProjectName] = useState('');

  // Mark sessions as unread when they finish streaming and the user isn't viewing them
  const prevStreamingIdsRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevStreamingIdsRef.current;
    // Sessions that were streaming before but aren't now = just finished
    const finished = prev.filter((id) => !streamingIds.includes(id));
    for (const fid of finished) {
      if (fid !== currentSessionId && !loopingIds.includes(fid)) {
        setUnreadSessionIds((u) => (u.includes(fid) ? u : [...u, fid]));
      }
    }
    prevStreamingIdsRef.current = streamingIds;
  }, [streamingIds, currentSessionId, loopingIds]);

  // Clear unread when user switches to a session
  const handleSwitchSession = useCallback((sessionId: string) => {
    setUnreadSessionIds((prev) => prev.filter((id) => id !== sessionId));
    switchSession(sessionId);
  }, [switchSession]);

  /**
   * EXPLICITLY OPEN A PROJECT RUN — the user's navigation wins over the chat that happened to be focused.
   *
   * `runViewVisible` correctly hides P's graph after the user switches to a chat in Q. But the project menu can
   * be opened while Q is focused too. Merely setting `runView` there creates the run and then immediately hides
   * it behind Q, which makes 「启用 / 加 flow」 look like a no-op. Enter one chat of P so the normal visibility
   * rule admits the page; if P has no chat yet, clear the unrelated focus and show the project page by itself.
   */
  /**
   * 这个 project 里这个 flow 的主会话，没有就建一个 —— 返回它的 id。
   *
   * 「我都添加了两个flow为什么一个主会话也没建出来？」：`flowMainSessionFor` 原来**只有一个调用点**
   * （`onOpenProjectWorkspace` 里那段循环），而那个 handler 在界面上没有任何触发点 —— 实测 `flow-main`
   * 会话在整个历史里一次都没被创建过。而「加 flow」这两条真正会被点的路径只调 `runCreate`。
   *
   * 主会话是这个 flow 在这个 project 里的**状态锚**：`flowMainDeletion` 用它决定历史能不能删，侧栏用它显示
   * 「🧩 X · 主」。所以它必须跟着「开始用这个 flow」诞生，而不是等谁恰好点到某个入口。
   */
  /**
   * 把一条结果卡写进这个 flow 的主会话。
   *
   * **只查，不建**：只为写一条进度而创建一条会话是不对的（主会话该由"开始用这个 flow"创建）。
   * 查不到就静默跳过 —— 回报是锦上添花，不能因为它失败而影响这次运行。
   *
   * 用 `mainSessionFlow` 而不是再调一次 `flowMainSessionFor`：后者全仓库只该有一个调用点
   * （就在 `ensureFlowMainSession` 里），那条不变量的用意是"只有一处决定谁是主会话"，有测试钉着。
   * 这里要的只是"查出来"，`mainSessionFlow` 正是现成的那个判据（它也在上面那个自动开 run 的
   * effect 里用着）。
   *
   * 走 `persistNote` 落盘（渲染层产生的 assistant 消息，已有的通道），不是只塞进内存：主会话下一轮
   * 要把它当上下文发出去，只在内存里的话刷新一次就没了。
   */

  /** 已经应用过的计划文本，按主会话记 —— 同一段回复不许被应用两次（流式过程中它会反复到达）。 */
  const planSeenRef = useRef<{ sessionId: string; seen: string }>({ sessionId: '', seen: '' });

  /**
   * 主会话（规划者）→ run：把它回复里的计划块落成 run draft 上的步骤。
   *
   * **和画布是同一份东西**：`run:add-node` 写进这个 run 的 draft 副本，而画布渲染的就是 run draft，
   * 所以加完立刻显示出来（主进程那边 `broadcastRun` 会推 `run:changed`）。冻结的定义和它的指纹不动 ——
   * `run:add-node` 只接受 `origin: 'added'`。
   *
   * 手法和画布那条一样（`applyCanvasStructure` 从 assistant 回复里抽 JSON），只是目标不同。
   * 落盘之前先用 `planRejection` 整体判一次：`run:add-node` 是**逐个**返回错误的，一次加五步而第三步
   * 依赖写错的话，前两步已经落盘了。
   */

  /**
   * 盯主会话的最新回复，抽出计划块应用到 run（→ 画布）。
   *
   * 吃的是**实时消息流**（`messages` / `paneViews`），和画布那条 effect 同一个来源、同一个理由：
   * 等落盘再读会晚一拍，而且依赖数组不再变化就不会重试。JSON 没闭合时 `extractFlowPlan` 返回 null，
   * 所以流式过程中它自然什么都不做，闭合的那一刻才应用。
   */

  /**
   * 泳道 → 它现在挂在哪条会话上。`run` 为空时只讲结构（还没起跑）。
   *
   * 泳道成员取自 `sessionLanes`（和画布同源），会话取自 run 里那些节点实际 attach 到的 id ——
   * 一条泳道理论上只有一条会话，取第一个非空的就够；不一致的话说明有一步被单独重跑过，那也是事实。
   */
  /** 上一次推给主会话的那份交底，按 `project\0flow` 记 —— 一样就不再推（见 `openProjectRun`）。 */
  const briefSentRef = useRef<Map<string, string>>(new Map());



  /**
   * 建一次运行并进入它 —— 三条创建路径（侧栏「开始用它」/ 运行页「加 flow」/「重开一次」）共用。
   *
   * 收敛成一个函数是因为它有三步且顺序有讲究：建 run → 补主会话 → 进运行页。原来这三步在两处各写一遍，
   * 而「只 setRunView 会被当前其它 project 的会话挡住」这个坑只在其中一处有注释。
   */

  /**
   * 重开上次开着的那块画布 —— 「重启之后这个画布怎么就没了」。
   *
   * 结构本来就在注册表里，会话本来就是现起的（「不必持久化」是对的）；真正丢掉的只是「你正在看哪一个」。
   * 所以恢复的也只有这一件事：读回名字，从注册表拿结构和原文，会话按需新建。跑一次就够，之后由你操作决定。
   */
  const studioRestored = useRef(false);


  const handleOpenLogs = useCallback(async () => {
    const result = await window.kiroApi.getLogs(LOGS_CHUNK).catch(() => ({
      text: '(failed to read logs)',
      path: '',
    }));
    logsHasMoreRef.current = result.text.split('\n').length >= LOGS_CHUNK;
    setLogsLimit(LOGS_CHUNK);
    setLogsText(result.text);
    setShowLogs(true);
  }, []);

  // Older logs load when the user scrolls to the top; scroll position is
  // preserved so the view doesn't jump.
  const loadOlderLogs = useCallback(async () => {
    if (!logsHasMoreRef.current || logsLoadingOlder) return;
    const el = logsPreRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    setLogsLoadingOlder(true);
    const nextLimit = logsLimit + LOGS_CHUNK;
    const result = await window.kiroApi.getLogs(nextLimit).catch(() => ({ text: logsText, path: '' }));
    const newCount = result.text.split('\n').length;
    if (newCount <= logsText.split('\n').length) {
      logsHasMoreRef.current = false; // reached the top of the file
    } else {
      setLogsText(result.text);
      setLogsLimit(nextLimit);
      requestAnimationFrame(() => {
        if (logsPreRef.current) logsPreRef.current.scrollTop += logsPreRef.current.scrollHeight - prevHeight;
      });
    }
    setLogsLoadingOlder(false);
  }, [logsLimit, logsLoadingOlder, logsText]);

  // On open, jump to the newest entries (bottom).
  useEffect(() => {
    if (showLogs && logsPreRef.current) {
      logsPreRef.current.scrollTop = logsPreRef.current.scrollHeight;
    }
  }, [showLogs]);

  /** Close one tab; activate a sensible neighbour so the panel never goes blank
   *  while other files are still open.
   *  NOTE: declared BEFORE openFileInApp on purpose — it appears in that
   *  callback's dependency array, which is evaluated during render (a const
   *  declared later would hit TDZ and crash the whole tree). */
  const closeFileTab = useCallback((tabId: string) => {
    setFileTabs((prev) => {
      const idx = prev.findIndex((t) => t.id === tabId);
      if (idx < 0) return prev;
      const next = prev.filter((t) => t.id !== tabId);
      setActiveFileTabId((current) => {
        if (current !== tabId) return current;
        const neighbour = next[idx] || next[idx - 1] || null;
        return neighbour ? neighbour.id : null;
      });
      return next;
    });
    delete fileScrollRef.current[tabId];
  }, []);

  // Open a file inside KiroLex's own viewer (internal "browser") rather than the
  // OS default app. Reads via the connected session's workspace:read.
  // Exception: file types the viewer cannot render (PDF/Office/media/archives…)
  // are handed to the OS default application instead of opening a dead tab.
  const openFileInApp = useCallback(async (rawPath: string) => {
    const p = rawPath.replace(/^file:\/\//, '');
    // Already open -> just focus that tab. Re-reading would throw away the scroll
    // position and the rendered/raw choice the user had set.
    const existing = fileTabs.find((t) => t.path === p);
    if (existing) { setActiveFileTabId(existing.id); return; }

    // Known non-previewable type: go straight to the system app, no tab flash.
    if (needsSystemApp(p)) {
      const res = await window.kiroApi.openExternal?.(p, currentSessionId || undefined);
      if (res?.ok !== false) return;
      // Fall through to the in-app tab so the failure is visible (and the tab
      // still offers Download).
    }

    const id = `ft_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setFileTabs((prev) => {
      const next = [...prev, { id, path: p, content: '' }];
      // Evict the oldest tab that is not the one we just opened.
      return next.length > MAX_FILE_TABS ? next.slice(next.length - MAX_FILE_TABS) : next;
    });
    setActiveFileTabId(id);
    setFileViewerLoading(true);
    try {
      // No connected chat required: the file viewer reads local disk, and gating it
      // on a session made the viewer (and the Workspace panel that feeds it) fail
      // with "打开一个已连接的会话后才能..." for any dormant chat. currentSessionId is
      // passed only so a RELATIVE path resolves against that chat's cwd.
      const result = await window.kiroApi.workspaceRead(currentSessionId, p);
      // Detected binary (NUL bytes / oversized image) with no useful preview:
      // hand it to the system app and drop the tab we just opened.
      if (result.binary && !result.image) {
        const res = await window.kiroApi.openExternal?.(p, currentSessionId || undefined);
        if (res?.ok !== false) { closeFileTab(id); return; }
      }
      setFileTabs((prev) => prev.map((t) => (t.id === id ? { ...t, ...result } : t)));
    } catch (err: any) {
      const message = `⚠️ ${err?.message || t('Could not read the file.')}`;
      setFileTabs((prev) => prev.map((t) => (t.id === id ? { ...t, content: message } : t)));
    } finally {
      setFileViewerLoading(false);
    }
  }, [currentSessionId, fileTabs, closeFileTab]);

  const setActiveTabRaw = useCallback((raw: boolean) => {
    setFileTabs((prev) => prev.map((t) => (t.id === activeFileTabId ? { ...t, raw } : t)));
  }, [activeFileTabId]);

  /** Re-read one open tab from disk, keeping everything the user chose about it.
   *
   *  The viewer used to be a one-shot snapshot: `openFileInApp` read the file once and
   *  re-opening an already-open path only focused its tab, so a file edited afterwards
   *  (by the agent, or in an editor) kept showing the old text with nothing to say it
   *  was out of date. `raw` and the scroll position are preserved deliberately -- a
   *  refresh must not throw away the rendered/source choice or jump to the top. */
  const refreshFileTab = useCallback(async (tabId: string, filePath: string) => {
    try {
      const result = await window.kiroApi.workspaceRead(currentSessionId, filePath);
      setFileTabs((prev) => prev.map((t) => (t.id === tabId
        ? { ...t, ...result, raw: t.raw, stale: false, gone: false }
        : t)));
    } catch (err: any) {
      // Do NOT wipe the content: an unreadable file (mid-write, permissions) is a
      // reason to flag the tab, not to lose what the user was reading.
      setFileTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, stale: false, gone: true } : t)));
    }
  }, [currentSessionId]);

  // Tell main which files to watch. Runs whenever the open set changes, and clears the
  // watchers when the panel is closed (an empty list stops everything).
  useEffect(() => {
    const paths = fileTabs.map((t) => t.path);
    void window.kiroApi.workspaceWatchFiles?.(currentSessionId, paths).catch(() => {});
  }, [fileTabs.map((t) => t.path).join('\n'), currentSessionId]);

  // Apply a disk change: refresh the visible tab immediately, mark the others stale.
  useEffect(() => {
    const off = window.kiroApi.onWorkspaceFileChanged?.(({ path: changed, exists }) => {
      const tabs = fileTabsRef.current;
      const hit = tabs.find((t) => t.path === changed);
      if (!hit) return;
      if (!exists) {
        setFileTabs((prev) => prev.map((t) => (t.id === hit.id ? { ...t, gone: true } : t)));
        return;
      }
      if (hit.id === activeFileTabIdRef.current) void refreshFileTab(hit.id, hit.path);
      else setFileTabs((prev) => prev.map((t) => (t.id === hit.id ? { ...t, stale: true } : t)));
    });
    return () => { off?.(); };
  }, [refreshFileTab]);

  // A tab that changed while hidden is re-read the moment it becomes visible.
  useEffect(() => {
    if (!activeFileTabId) return;
    const tab = fileTabsRef.current.find((t) => t.id === activeFileTabId);
    if (tab?.stale) void refreshFileTab(tab.id, tab.path);
  }, [activeFileTabId, refreshFileTab]);

  // Restore this tab's scroll position after it becomes active (and after its
  // content lands, which is why `fileViewer?.content` is a dependency).
  useEffect(() => {
    if (!activeFileTabId) return;
    const node = fileBodyRef.current;
    if (!node) return;
    const target = fileScrollRef.current[activeFileTabId] ?? 0;
    requestAnimationFrame(() => { try { node.scrollTop = target; } catch {} });
  }, [activeFileTabId, fileViewer?.content]);

  // Persist WHICH files are open (paths only, plus the raw/rendered choice) so the
  // set survives a restart; content is re-read lazily on first activation.
  useEffect(() => {
    try {
      // Shared store, not origin-scoped localStorage -- same reason as the drafts and
      // split sizes: the set of open files was reset on every dev/prod origin switch.
      if (fileTabs.length === 0) { uiRemove(OPEN_TABS_KEY); return; }
      uiSet(OPEN_TABS_KEY, JSON.stringify({
        tabs: fileTabs.map((t) => ({ path: t.path, raw: !!t.raw })),
        activePath: fileViewer?.path || null,
      }));
    } catch {}
  }, [fileTabs, fileViewer?.path]);

  // Re-open last session's tabs on mount. This used to wait for `currentSessionId`
  // because workspaceRead demanded a connected chat; it no longer does, so the tabs
  // come back immediately instead of only after a backend happens to attach.
  const tabsRestoredRef = useRef(false);
  useEffect(() => {
    if (tabsRestoredRef.current) return;
    tabsRestoredRef.current = true;
    let saved: { tabs?: { path: string; raw?: boolean }[]; activePath?: string | null } | null = null;
    try { saved = JSON.parse(uiGet(OPEN_TABS_KEY) || 'null'); } catch {}
    const paths = (saved?.tabs || []).map((t) => t.path).filter(Boolean);
    if (!paths.length) return;
    (async () => {
      for (const path of paths.slice(0, MAX_FILE_TABS)) await openFileInApp(path);
      const active = saved?.activePath;
      if (active) {
        setFileTabs((prev) => {
          const hit = prev.find((t) => t.path === active);
          if (hit) setActiveFileTabId(hit.id);
          return prev.map((t) => {
            const savedTab = (saved?.tabs || []).find((x) => x.path === t.path);
            return savedTab?.raw ? { ...t, raw: true } : t;
          });
        });
      }
    })();
  }, [currentSessionId, openFileInApp]);

  // ⌘/Ctrl+W closes the active file tab, ⌘/Ctrl+1..9 jumps to the Nth. Only while
  // the panel is open, so these never steal the shortcut from the rest of the app.
  useEffect(() => {
    if (fileTabs.length === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault();
        if (activeFileTabId) closeFileTab(activeFileTabId);
        return;
      }
      const n = Number(event.key);
      if (Number.isInteger(n) && n >= 1 && n <= 9 && fileTabs[n - 1]) {
        event.preventDefault();
        setActiveFileTabId(fileTabs[n - 1].id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fileTabs, activeFileTabId, closeFileTab]);

  // File links/paths rendered in chat dispatch this event; open them in-app.
  useEffect(() => {
    const handler = (e: Event) => {
      const path = (e as CustomEvent).detail?.path;
      if (typeof path === 'string' && path) void openFileInApp(path);
    };
    window.addEventListener('kirolex:open-file', handler as EventListener);
    return () => window.removeEventListener('kirolex:open-file', handler as EventListener);
  }, [openFileInApp]);

  const handleForkMessage = useCallback((messageId: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    if (loopingIds.includes(sid)) return;   // loop owns the session
    const forkedSessionId = duplicateSession(sid, messageId);
    if (forkedSessionId) handleSwitchSession(forkedSessionId);
  }, [currentSessionId, duplicateSession, handleSwitchSession, loopingIds]);

  // Rerun must resolve the turn inside the SESSION THE MESSAGE BELONGS TO. It
  // used to scan the focused chat's `messages`, so a rerun issued from a split
  // pane looked up the id in the wrong conversation (and could truncate it).
  const handleRerunMessage = useCallback((messageId: string, editedText: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (sid && loopingIds.includes(sid)) return;   // loop owns the session
    const list = (sid && sid !== currentSessionId ? paneViews[sid]?.messages : messages) || [];
    const baseIndex = list.findIndex((message) => message.id === messageId);
    if (baseIndex < 0) return;
    let turnEnd = baseIndex;
    while (
      turnEnd + 1 < list.length
      && list[turnEnd + 1].role === 'user'
      && !!list[turnEnd + 1].steer
    ) {
      turnEnd++;
    }
    const laterRecords = list.slice(turnEnd + 1);
    const hasLaterUserTurn = laterRecords.some((message) => message.role === 'user');
    if (hasLaterUserTurn) {
      setRerunConfirm({ messageId, editedText, deleteCount: laterRecords.length, sessionId: sid || undefined });
      return;
    }
    void rerunFromMessage(messageId, editedText, undefined, sid || undefined);
  }, [messages, paneViews, currentSessionId, rerunFromMessage, loopingIds]);

  const confirmRerun = useCallback(() => {
    if (!rerunConfirm) return;
    const pending = rerunConfirm;
    setRerunConfirm(null);
    void rerunFromMessage(pending.messageId, pending.editedText, undefined, pending.sessionId);
  }, [rerunConfirm, rerunFromMessage]);

  /**
   * 这个 project 还在用这个 flow 吗 —— 提成一个具名回调，因为现在有两个消费者：侧栏那个属性，
   * 以及下面 `handleDeleteSession` 里的删除守卫。原来它只是 Sidebar 的一个内联箭头函数，
   * 删除守卫拿不到它，也就无从判断主会话是否已经「不再被使用」。
   */

  const handleDeleteSession = useCallback((sessionId: string) => {
    // Drop it from the split layout too, otherwise the saved list keeps growing
    // with ids of chats that no longer exist (rendering already filters them,
    // but the persisted layout should stay clean).
    setSplitSessionIds((prev) => (prev.includes(sessionId) ? prev.filter((id) => id !== sessionId) : prev));
    // Read the persisted flag live (single source of truth, written by both the
    // Settings toggle and the dialog's "Don't ask again") to avoid any stale
    // closure of skipDeleteConfirm.
    let skip = skipDeleteConfirm;
    try { skip = uiGet('kirolex-skip-delete-confirm') === 'true'; } catch {}
    if (skip) { deleteSession(sessionId); return; }
    const session = sessions.find((s) => s.id === sessionId);
    setDeleteConfirm({ sessionId, title: session?.title || 'this session' });
  }, [sessions, skipDeleteConfirm, deleteSession]);

  // Create a new chat directly inside a project (created already assigned).
  const handleNewSessionInProject = useCallback((project: string) => {
    void cwdFor(project).then((cwd) => newSession(cwd, selectedModel, project));
  }, [newSession, homeDir, selectedModel]);

  // Create a chat from the New Chat dialog, assigning the chosen project (if any)
  // at creation.
  const handleCreateChat = useCallback(() => {
    const proj = newChatProject === '__new__'
      ? (newChatNewProjectName.trim() || undefined)
      : (newChatProject || undefined);
    void cwdFor(proj).then((cwd) => newSession(cwd, selectedModel, proj));
    setShowNewChat(false);
    setNewChatProject('');
    setNewChatNewProjectName('');
  }, [newChatProject, newChatNewProjectName, newSession, homeDir, selectedModel]);

  const confirmDelete = useCallback(() => {
    if (deleteConfirm) {
      if (dontAskDelete) {
        setSkipDeleteConfirm(true);
        try { uiSet('kirolex-skip-delete-confirm', 'true'); } catch {}
      }
      deleteSession(deleteConfirm.sessionId);
      setDeleteConfirm(null);
      setDontAskDelete(false);
    }
  }, [deleteConfirm, deleteSession, dontAskDelete]);

  // Project deletion is destructive (removes every member chat + the project's
  // memory) and ALWAYS confirms — deliberately independent of the chat-delete
  // "Don't ask again" / Settings toggle.
  const handleDeleteProject = useCallback((name: string) => {
    const memberCount = sessions.filter((s) => s.projectId === name).length;
    setDeleteProjectConfirm({ name, memberCount });
  }, [sessions]);

  const confirmDeleteProject = useCallback(() => {
    if (deleteProjectConfirm) {
      deleteProject(deleteProjectConfirm.name);
      setDeleteProjectConfirm(null);
    }
  }, [deleteProjectConfirm, deleteProject]);

  /**
   * 拉取模型列表。两条规则，都是那次「网恢复了还是显示模型都不可用」逼出来的：
   *
   *   ① 拿不到就用缓存显示，但**绝不**用更差的结果覆盖缓存（`shouldReplaceModelCache`）。
   *      原来是无条件 `uiSet`，一次退化结果（只剩 `auto`）就把唯一的回退来源写坏了。
   *   ② 失败不是终点。原来这段只在挂载时跑一次，所以「网恢复」应用根本不知道，只能等下次刷新。
   *      下面的 effect 会在 `online` 和窗口重新聚焦时再调一次。
   */
  const refreshModels = useCallback(async () => {
    let cached: any[] = [];
    try { cached = JSON.parse(uiGet('kirolex-models') || '[]'); } catch {}
    try {
      const data = await window.kiroApi.listModels();
      const next = data?.models || [];
      if (shouldReplaceModelCache(next, cached)) {
        setModels(next);
        try { uiSet('kirolex-models', JSON.stringify(next)); } catch {}
      } else if (cached.length) {
        // 新结果不可信：继续显示缓存，并且把缓存留在盘上等下一次重试。
        setModels(cached);
      }
    } catch {
      if (cached.length) setModels(cached);
    }
  }, []);

  /*
    Cmd+F、命中计数、高亮、以及「搜索时把渲染窗口整开」这一整套都搬进 `ChatArea` 了 ——
    一格一份。App 这里原来那几个 effect（发 `findInPage`、收 `found-in-page`、全局 Esc）
    全部删掉:留着它们就等于两套搜索同时在跑,而窗口级那一套在分屏时必然说谎。
  */

  /** 网络/窗口恢复后重新校验 —— 没有这个，一次超时会一直显示到下次刷新为止。 */
  useEffect(() => {
    const again = () => { void refreshModels(); };
    window.addEventListener('online', again);
    window.addEventListener('focus', again);
    return () => {
      window.removeEventListener('online', again);
      window.removeEventListener('focus', again);
    };
  }, [refreshModels]);

  useEffect(() => {
    if (window.kiroApi) {
      window.kiroApi.getHomeDir().then(setHomeDir).catch(() => {});

      /**
       * 模型和 agent 列表**推迟到启动风暴之后**再拉。
       *
       * 这两条命令各要 spawn 一个新的 kiro-cli，而 kiro-cli 冷启动要加载全部 MCP server —— 实测空闲时
       * 一次 `--list-models` 稳定 3.4 秒。启动瞬间 eager-attach 正在同时拉起多条会话的执行器，这时候
       * 再插两个冷启动就双双超时：日志里 13 次 `timed out after 10000ms`，把超时提到 30s 之后照样超
       * （06:34:48 两条）。所以这不是超时不够，是**时机不对**。
       *
       * 界面在这段时间里不是空的：`refreshModels` 拿不到就显示 `kirolex-models` 缓存（而缓存现在
       * 受 `shouldReplaceModelCache` 保护，不会再被退化结果写坏）；agent 列表同理保留上一次的。
       * 最坏情况从「显示模型都不可用」变成「晚几秒刷新」。
       *
       * 4 秒是给 eager-attach 让路，不是魔法数字：日志里 `reveal: window shown` 通常落在 +2～4s。
       */
      const warmupDelay = setTimeout(() => {
        void refreshModels();
        /* agent 列表走同一条路（`refreshAgents`：空列表不收 + 落盘）—— 不再各写一遍 */
        void refreshAgents();
      }, MODEL_LIST_WARMUP_DELAY_MS);

      // Auto-connect
      const autoConnect = setTimeout(() => {
        connect(selectedModel);
      }, 300);
      return () => { clearTimeout(warmupDelay); clearTimeout(autoConnect); };
    }
  }, []);

  // Apply font size to document
  useEffect(() => {
    document.documentElement.style.setProperty('--chat-font-size', `${settings.fontSize}px`);
  }, [settings.fontSize]);

  // Font families are applied as CSS variables so every surface (chat, sidebar,
  // dialogs, code blocks) follows the setting without per-component overrides.
  useEffect(() => {
    const root = document.documentElement.style;
    if (settings.fontFamily.trim()) root.setProperty('--app-font', settings.fontFamily);
    else root.removeProperty('--app-font');
    if (settings.monoFontFamily.trim()) root.setProperty('--mono-font', settings.monoFontFamily);
    else root.removeProperty('--mono-font');
  }, [settings.fontFamily, settings.monoFontFamily]);

  // Persist from EVERY path, not just the dialog. Split view raises/clears
  // splitGrid internally (entering and leaving split mode), and those changes
  // were silently lost because only the dialog handler called saveSettings.
  useEffect(() => { saveSettings(settings); }, [settings]);

  const handleSettingsChange = useCallback((newSettings: Settings) => {
    setSettings(newSettings);
  }, []);

  const handleModelChange = useCallback(async (model: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (
      !sid ||
      streamingIds.includes(sid) ||
      loopingIds.includes(sid) ||
      switchingModelIds.includes(sid)
    ) return;

    setSwitchingModelIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
    try {
      const effective = (await changeSessionModel(sid, model)) || model;
      // Reflect what the BACKEND confirmed. Setting the requested model here
      // unconditionally is what let the selector drift away from the executor.
      setSelectedModel(effective);
      try { uiSet('kirolex-last-model', effective); } catch {}
    } finally {
      setSwitchingModelIds((prev) => prev.filter((id) => id !== sid));
    }
  }, [currentSessionId, streamingIds, loopingIds, switchingModelIds, changeSessionModel]);

  // Keep the model dropdown in sync with the current session's model.
  // A session with its own explicit model shows it; 'auto'/legacy sessions fall
  // back to the user's last-chosen model (persisted) rather than a hardcoded one.
  useEffect(() => {
    if (!currentSessionId) return;
    const s = sessions.find((x) => x.id === currentSessionId);
    let lastModel = 'claude-opus-5';   // must equal main's DEFAULT_MODEL
    try { lastModel = uiGet('kirolex-last-model') || lastModel; } catch {}
    const effective = (s?.model && s.model !== 'auto') ? s.model : lastModel;
    setSelectedModel(effective);
  }, [currentSessionId, sessions]);

  const currentSession = sessions.find((session) => session.id === currentSessionId) || null;
  const selectedKiroAgent = currentSession?.kiroAgent
    || kiroAgents.find((agent) => agent.isDefault)?.name
    || 'kiro_default';

  const handleKiroAgentChange = useCallback(async (agentName: string, paneSid?: string) => {
    // `paneSid` was accepted and then ignored, so changing the Agent in a split
    // pane reconfigured the FOCUSED pane's session instead — a wrong-target write,
    // not just a display glitch. Every guard below is likewise per-session; the
    // focused-pane values (isStreaming / switchingAgent / selectedKiroAgent) let a
    // switch through while the target pane was busy and compared against the wrong
    // Agent. Mirrors handleModelChange.
    const sid = paneSid || currentSessionId;
    const currentAgent = sessions.find((session) => session.id === sid)?.kiroAgent
      || kiroAgents.find((agent) => agent.isDefault)?.name
      || 'kiro_default';
    if (
      !sid ||
      streamingIds.includes(sid) ||
      loopingIds.includes(sid) ||
      switchingAgentIds.includes(sid) ||
      agentName === currentAgent
    ) return;

    setSwitchingAgentIds((prev) => (prev.includes(sid) ? prev : [...prev, sid]));
    try {
      await changeSessionAgent(sid, agentName);
    } finally {
      setSwitchingAgentIds((prev) => prev.filter((id) => id !== sid));
    }
  }, [currentSessionId, sessions, kiroAgents, streamingIds, loopingIds, switchingAgentIds, changeSessionAgent]);


  const permissionMode = currentSession?.permissionMode || 'auto-approve';
  const handlePermissionModeChange = useCallback(async (
    mode: 'auto-approve' | 'ask',
    paneSid?: string,
  ) => {
    const sid = paneSid || currentSessionId;
    const sessionForMode = sid ? sessions.find((s) => s.id === sid) : null;
    if (
      !sid
      || streamingIds.includes(sid)
      || loopingIds.includes(sid)
      || mode === (sessionForMode?.permissionMode || 'auto-approve')
    ) return;
    await changeSessionPermissionMode(sid, mode);
  }, [
    currentSessionId,
    sessions,
    streamingIds,
    loopingIds,
    changeSessionPermissionMode,
  ]);

  const handleDropFiles = useCallback((files: AttachedFile[], sid?: string) => {
    addAttachments(sid || currentSessionId, files);
  }, [addAttachments, currentSessionId]);

  const handleRemoveFile = useCallback((id: string, sid?: string) => {
    const target = sid || currentSessionId;
    if (!target) return;
    setAttachedBySession((prev) => ({ ...prev, [target]: (prev[target] || []).filter((f) => f.id !== id) }));
  }, [currentSessionId]);

  /** Make `sid` the focused session before acting on it. switchSession sets the
   *  hook's currentSessionRef SYNCHRONOUSLY, so a send issued right after this
   *  lands in `sid` even before React re-renders. This is what lets every split
   *  pane have a working composer without duplicating the send pipeline. */
  const focusSession = useCallback(async (sid: string | null) => {
    if (!sid || sid === currentSessionId) return;
    await handleSwitchSession(sid);
  }, [currentSessionId, handleSwitchSession]);

  focusSessionRef.current = focusSession;

  const handleSendMessage = useCallback(async (text: string, pastes?: PastedBlock[], paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    // A loop OWNS its session: it is already resending on a timer, so anything else
    // sent into it interleaves with those turns. Stop is the only way out, and it
    // clears the loop (see cancelStream). Disabling the buttons was not enough —
    // Enter and Ctrl+Enter reach these handlers directly.
    if (sid && loopingIds.includes(sid)) return;
    await focusSession(sid);
    // Clear unread status when user interacts
    if (sid) {
      setUnreadSessionIds((prev) => prev.filter((id) => id !== sid));
    }

    // History rebuild in progress / owed: the backend cannot answer this yet, so
    // QUEUE it rather than firing it into a context-less session. The queue drains
    // automatically once the rebuild finishes, preserving order. Slash commands are
    // handled locally below and are exempt.
    //
    //
    // This used to list only the two rebuild states, so 'reconfiguring' (a model /
    // Agent switch) and 'attaching' fell through -- and because sending attaches on
    // demand, the message hit `acp:load-session` mid-switch and came back as a raw
    // `Error invoking remote method 'acp:load-session'` on the user's own message.
    // A switch takes seconds and ends with the chat ready, so the message simply
    // waits: the drain effect below already waits on `isBackendOccupied`, so it
    // leaves on its own the moment the switch completes.
    if (sid && !text.trim().startsWith('/') && isBackendOccupied(busyBySession[sid])
        && busyBySession[sid] !== 'turn') {
      // Via ref: handleQueueMessage is declared BELOW this callback, and a
      // later-declared const in a dependency array is evaluated during render and
      // would hit TDZ, crashing the whole tree.
      queueMessageRef.current?.(text, pastes, sid);
      return;
    }

    // A TURN is still running on this chat. Reaching here means the composer thought
    // otherwise -- e.g. this window reloaded mid-turn and lost `streamingIds`, so
    // Enter sent instead of steering. Main would reject it ("wait for the active
    // turn") AFTER the bubble is already on screen, i.e. the message silently never
    // arrives. Steer it into the running turn instead, which is what Enter during a
    // turn means anyway.
    if (sid && !text.trim().startsWith('/') && busyBySession[sid] === 'turn') {
      void handleSteerMessageRef.current?.(text, pastes, sid);
      return;
    }

    // Handle /stop locally - force interrupt and reconnect
    if (text.trim() === '/stop') {
      // Hard stop is an explicit user cancel: clear every session's un-consumed
      // pending steers so the turn-end reconcile can't re-queue a phantom
      // follow-up after the reconnect. Ordinary queues are preserved (KiroLex
      // "Stop keeps the queue" rule) — we only drop un-consumed steers.
      discardUnconsumedSteers();
      await forceStop(selectedModel);
      sendMessage([{ type: 'text', text: '/stop' }], '🔄 Force interrupted and reconnected.');
      return;
    }

    // Handle /clear: wipe the visible history + cache, then forward /clear so
    // the backend also resets its context. KiroLex's own stored transcript is
    // deliberately left alone -- see the note on clearConversation.
    if (text.trim() === '/clear') {
      clearConversation(sid);
      await sendMessage([{ type: 'text', text: '/clear' }]);
      return;
    }

    // Handle /usage locally
    if (text.trim() === '/usage') {
      try {
        const result = await window.kiroApi.getUsage();
        // Add as a fake assistant message
        sendMessage([{ type: 'text', text: '/usage' }], result.text);
      } catch (err) {
        sendMessage([{ type: 'text', text: '/usage' }], 'Failed to fetch usage info');
      }
      return;
    }

    const prompt: any[] = [];
    const currentAttachments = [...attachedFor(sid)];

    if (currentAttachments.length > 0) {
      const fileRefs = currentAttachments
        .map((f) => `file:${f.path}`)
        .join('\n');
      prompt.push({
        type: 'text',
        text: `<hidden>${fileRefs}\n请读取这些文件内容</hidden>`,
      });
    }

    // With attachments and no typed text, the hidden file-ref block already
    // carries the instruction -- don't append an empty text part.
    // The MODEL must see the real pasted content; the bubble and the transcript
    // keep the short `[ 粘贴 #N · M 行 ]` placeholders. KiroLex already separates
    // prompt from displayText, so this needs no extra storage.
    const expanded = pastes?.length ? expandPastes(text, pastes) : text;
    if (text.trim() || currentAttachments.length === 0) prompt.push({ type: 'text', text: expanded });
    clearAttachments(sid);
    await sendMessage(
      prompt,
      undefined,
      currentAttachments.length > 0 ? currentAttachments : undefined,
      selectedModel,
      pastes?.length
        ? { text, pastes: pastes.map(({ seq, lines, chars, path }) => ({ seq, lines, chars, path })) }
        : undefined,
      // TARGET-ADDRESSED. This was the one caller that computed `sid` (from paneSid)
      // and then dropped it, leaving sendMessage to fall back to whatever chat was
      // focused -- see its own comment on why that is wrong in split view.
      sid || undefined,
    );
  }, [attachedFor, clearAttachments, focusSession, sendMessage, currentSessionId, forceStop, selectedModel, discardUnconsumedSteers, clearConversation, busyBySession, loopingIds]);

  // Explicit user Stop (composer stop button). Discard this session's un-consumed
  // steers FIRST so the turn-end reconcile finds nothing to re-queue (no phantom
  // follow-up turn), THEN cancel the running prompt. Already-consumed steers are
  // not pending, so they remain in the message group; only the current turn ends.
  const handleStopStream = useCallback(async (paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    // Stop must ALWAYS do something. Previously it returned early during a history
    // rebuild, which left no way to call off even a pending auto-resend.
    if (sid) {
      cancelAutoResend(sid);          // stop a queued/pending auto-resend first
      discardUnconsumedSteers(sid);
    }
    await cancelStream(sid);          // main turns this into "abandon rebuild" when priming
  }, [currentSessionId, discardUnconsumedSteers, cancelStream, cancelAutoResend]);

  const handleConfirmUsageAction = useCallback(async () => {
    const action = usageActionConfirm;
    setUsageActionConfirm(null);
    if (
      !action
      || action === 'contextMenu'
      || !currentSessionId
      || isStreaming
    ) return;
    if (action === 'compact') {
      await handleSendMessage('/compact');
    } else if (action === 'clear') {
      await handleSendMessage('/clear');
    } else {
      resetSessionCredits(currentSessionId);
    }
  }, [usageActionConfirm, currentSessionId, isStreaming, handleSendMessage, resetSessionCredits]);

  /**
   * MeshClaw-style per-session follow-up queues. A message submitted while its session is busy is queued;
   * idle submissions bypass the queue and run now. Each queue is FIFO, drains independently in the
   * background, and supports edit/cancel/reorder before execution.
   *
   * **落盘** —— 「会话被重新渲染了 queue 就会丢失」。
   *
   * 它原来是「故意只活在运行时」的。可这里的运行时是**渲染进程**,而排队的东西是你已经打完字、按过回车的
   * 内容:一次刷新、一次热替换、开发时改一行代码,它们就没了,而你以为它们在等着发。执行器活在主进程里,
   * 那一轮根本没停 —— 只有队列跟着窗口一起消失,这是最容易让人白等的一种不一致。
   *
   * 恢复之后照旧由那条排空逻辑接管:它本来就只在会话空闲时才发,和刷新前是同一条规则,所以不会因为
   * 「重启了」而抢跑。
   */
  const [queuesBySession, setQueuesBySession] = useState<Record<string, QueuedMessage[]>>(() => {
    try {
      const raw = JSON.parse(uiGet(QUEUES_KEY) || '{}');
      if (!raw || typeof raw !== 'object') return {};
      const out: Record<string, QueuedMessage[]> = {};
      for (const [sid, items] of Object.entries(raw as Record<string, unknown>)) {
        if (!Array.isArray(items)) continue;
        const kept = items.filter((item: any) => item && typeof item.id === 'string' && typeof item.content === 'string')
          .map((item: any) => ({
            id: item.id,
            content: item.content,
            attachments: Array.isArray(item.attachments) ? item.attachments : [],
            ...(Array.isArray(item.pastes) ? { pastes: item.pastes } : null),
            createdAt: Number(item.createdAt) || Date.now(),
            restored: true,
          })) as QueuedMessage[];
        if (kept.length) out[sid] = kept;
      }
      return out;
    } catch { return {}; }
  });
  // Mirror so a pane's queue action can read ITS queue without depending on the
  // focused session's snapshot.
  const queuesBySessionRef = useRef<Record<string, QueuedMessage[]>>({});
  queuesBySessionRef.current = queuesBySession;
  /* 队列一变就落盘。空队列删掉键，免得 ui-state 里留一堆 `sid: []` */
  useEffect(() => {
    try {
      const alive = Object.fromEntries(Object.entries(queuesBySession).filter(([, items]) => items.length));
      if (Object.keys(alive).length) uiSet(QUEUES_KEY, JSON.stringify(alive));
      else uiRemove(QUEUES_KEY);
    } catch {}
  }, [queuesBySession]);
  const queueSendingRef = useRef<Set<string>>(new Set());
  const [restoredQueueDraft, setRestoredQueueDraft] = useState<{ id: number; text: string; sessionId?: string } | null>(null);

  /*
    `currentQueue` 已删 —— 它按**焦点会话**算队列，而唯一的消费者 `handleSteerMessage` 操作的是
    **格子的会话**（`paneSid || currentSessionId`）。分屏时两者常常不同，那次不一致会让消息静默消失
    （详见 handleSteerMessage 里 (4) 那段）。现在那里读 `queuesBySessionRef.current[sessionId]`，
    这个变量就没有正确的用处了：任何按焦点会话算的队列都会重新引入同一个 bug。
  */

  // Reconcile un-consumed mid-turn steers into the queue head (order preserved)
  // once a turn finishes, so a steer written too late to be consumed is never
  // lost — it becomes a normal queued item that drains next on the idle session.
  // Kept separate from the unread effect so it can reference the queue state
  // declared just above (no forward reference), and uses its own transition ref.
  const prevSteerStreamingRef = useRef<string[]>([]);
  useEffect(() => {
    const prev = prevSteerStreamingRef.current;
    const finished = prev.filter((id) => !streamingIds.includes(id));
    for (const fid of finished) {
      const leftover = takeUnconsumedSteers(fid);
      if (leftover.length === 0) continue;
      setQueuesBySession((current) => ({
        ...current,
        [fid]: [
          ...leftover.map((s) => ({
            id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content: s.content,
            attachments: s.attachments,
            createdAt: Date.now(),
          })),
          ...(current[fid] || []),
        ],
      }));
    }
    prevSteerStreamingRef.current = streamingIds;
  }, [streamingIds, takeUnconsumedSteers]);

  // Ordinary Enter while a turn is running. Precedence:
  //   (4) queue non-empty  -> extend the queue tail (never steer/interrupt);
  //   (7) has attachments  -> queue it (steer is text-only; never drop files);
  //   (3) else             -> steer the running turn via _session/steer.
  // Ctrl/⌘+Enter (handleQueueMessage) always adds a separate FIFO item instead.
  const handleSteerMessage = useCallback(async (text: string, pastes?: PastedBlock[], paneSid?: string) => {
    const steerSid = paneSid || currentSessionId;
    if (steerSid && loopingIds.includes(steerSid)) return;   // loop owns the session
    await focusSession(steerSid);
    // Steering carries text only, so a paste must be expanded before it goes out —
    // the placeholder would otherwise reach the model as literal noise.
    if (pastes?.length) text = expandPastes(text, pastes);
    const content = text.trim();
    const sessionId = paneSid || currentSessionId;
    const attachments = [...attachedFor(sessionId)];
    if ((!content && attachments.length === 0) || !sessionId) return;

    // A history rebuild is a LOCKED task: it is a hidden turn whose whole purpose
    // is to restore the context, so steering into it would be answered without
    // that context and would never be visible. Park the message in the queue; it
    // drains in order the moment the rebuild finishes.
    const reason = busyBySession[sessionId];
    if (reason === 'priming' || reason === 'prime-pending') {
      queueMessageRef.current?.(content, pastes, sessionId);
      return;
    }

    /**
     * (4) 这条会话的队列非空：普通 Enter 并进最后一张卡片（正文空行相连，附件合并），永不 steer。
     *
     * 队列必须读**这一格自己的**（`queuesBySessionRef.current[sessionId]`），不能读 `currentQueue`
     * —— 后者是按 `currentSessionId`（焦点会话）算的，而这里操作的是 `paneSid || currentSessionId`。
     * 分屏时两者常常不是同一条会话，于是会发生消息静默消失：
     *
     *   焦点会话队列非空 → 这个分支成立 → tailId 取的是**焦点会话**最后一张卡片的 id
     *   → `.map` 在**这一格**的队列里找不到那个 id → 什么都没改
     *   → `clearAttachments(sessionId)` 把附件清掉 → `return`
     *
     * 结果就是你打的字和附件一起没了，界面上什么都不发生。反向也坏：焦点会话队列为空而这一格有队列
     * 时，会掉到下面的 steer 分支，追问变成打断正在跑的那一轮。
     *
     * 用 ref 而不是闭包里捕获的值：`currentQueue` 是 useCallback 创建时捕获的，两次渲染之间会过期；
     * ref 读的永远是最近一次渲染的值。取消/编辑/移动那几个处理函数早就是这么读的（见下面几个）。
     */
    const paneQueue = queuesBySessionRef.current[sessionId] || [];
    if (paneQueue.length > 0) {
      const tailId = paneQueue[paneQueue.length - 1].id;
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: (prev[sessionId] || []).map((item) => (
          item.id === tailId
            ? {
                ...item,
                // Skip empty sides: a pure-attachment item (or an empty tail)
                // would otherwise leave blank paragraphs in the queued text.
                content: [item.content, content].map((s) => (s || '').trim()).filter(Boolean).join('\n\n'),
                attachments: [...item.attachments, ...attachments],
              }
            : item
        )),
      }));
      clearAttachments(sessionId);
      return;
    }

    // (7) _session/steer carries text only. A busy message with attachments
    // cannot be steered without silently dropping them — safe-degrade to a
    // normal queued item (drains after the turn); the UI shows it as queued.
    if (attachments.length > 0) {
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: [
          ...(prev[sessionId] || []),
          {
            id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            content,
            attachments,
            createdAt: Date.now(),
          },
        ],
      }));
      clearAttachments(sessionId);
      return;
    }

    // (3) Busy + empty queue + no attachments: steer the running turn. The
    // helper shows it optimistically and returns { steered }.
    clearAttachments(sessionId);
    const res = await steerMessage(content, sessionId);
    if (!res.steered) {
      // Reliable fallback (steer unsupported / turn already idle / write failed):
      // never drop the message — put it at the queue head so it delivers next.
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: [
          { id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, content, attachments: [], createdAt: Date.now() },
          ...(prev[sessionId] || []),
        ],
      }));
    }
    // `currentQueue` 不在依赖里：队列现在从 ref 读，而把它列进来会让这个回调每次队列变化都重建。
  }, [currentSessionId, attachedFor, clearAttachments, focusSession, steerMessage, loopingIds]);

  const handleQueueMessage = useCallback((text: string, pastes?: PastedBlock[], paneSid?: string) => {
    const content = text.trim();
    const sessionId = paneSid || currentSessionId;
    if (!content || !sessionId) return;
    if (loopingIds.includes(sessionId)) return;   // loop owns the session
    const item: QueuedMessage = {
      id: `queue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      content,
      attachments: [...attachedFor(sessionId)],
      ...(pastes?.length ? { pastes } : {}),
      createdAt: Date.now(),
    };
    clearAttachments(sessionId);
    setQueuesBySession((prev) => ({
      ...prev,
      [sessionId]: [...(prev[sessionId] || []), item],
    }));
  }, [currentSessionId, attachedFor, clearAttachments, loopingIds]);
  // Publish it for handleSendMessage's rebuild diversion (declared above).
  queueMessageRef.current = handleQueueMessage;
  sendMessageRef.current = handleSendMessage;
  handleSteerMessageRef.current = handleSteerMessage;

  // Queue actions carry their own session: in split view the pane you clicked in
  // is NOT necessarily the focused chat, and using currentSessionId moved queue
  // items (and their text) into a different conversation.
  const handleCancelQueuedMessage = useCallback((queueId: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    const item = (queuesBySessionRef.current[sid] || []).find((candidate) => candidate.id === queueId);
    if (item) {
      addAttachments(sid, item.attachments);
      setRestoredQueueDraft({ id: Date.now(), text: item.content, sessionId: sid });
    }
    setQueuesBySession((prev) => ({
      ...prev,
      [sid]: (prev[sid] || []).filter((candidate) => candidate.id !== queueId),
    }));
  }, [currentSessionId, addAttachments]);

  const handleEditQueuedMessage = useCallback((queueId: string, content: string, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid || !content.trim()) return;
    setQueuesBySession((prev) => ({
      ...prev,
      [sid]: (prev[sid] || []).map((item) => (
        item.id === queueId ? { ...item, content: content.trim() } : item
      )),
    }));
  }, [currentSessionId]);

  const handleMoveQueuedMessage = useCallback((queueId: string, direction: -1 | 1, paneSid?: string) => {
    const sid = paneSid || currentSessionId;
    if (!sid) return;
    setQueuesBySession((prev) => {
      const queue = [...(prev[sid] || [])];
      const from = queue.findIndex((item) => item.id === queueId);
      const to = from + direction;
      if (from < 0 || to < 0 || to >= queue.length) return prev;
      const [item] = queue.splice(from, 1);
      queue.splice(to, 0, item);
      return { ...prev, [sid]: queue };
    });
  }, [currentSessionId]);

  // Drain every session independently when it becomes idle. This continues in
  // the background after the user switches chats, matching MeshClaw slots.
  useEffect(() => {
    for (const [sessionId, queue] of Object.entries(queuesBySession)) {
      if (
        queue.length === 0 ||
        streamingIds.includes(sessionId) ||
        // Backend occupied (turn / attaching / model swap / HISTORY REBUILD).
        // Draining into a rebuild would be rejected by main as "active turn";
        // the queue simply waits until the backend is free.
        isBackendOccupied(busyBySession[sessionId]) ||
        // A loop owns its session, and it is idle BETWEEN iterations — exactly when
        // this drain would fire and slip a queued message between two loop turns.
        loopingIds.includes(sessionId) ||
        queueSendingRef.current.has(sessionId) ||
        (sessionId === currentSessionId && (
          switchingModel || switchingAgent
        )) ||
        /*
          从磁盘恢复的条目不抢跑（见 `QueuedMessage.restored`）：只有「那一轮还在跑」或者「你正打开着它」
          的时候才发。否则一个几天前排下的队列会在你刚打开应用的那一刻自己发出去。
        */
        (queue[0]?.restored
          && sessionId !== currentSessionId
          && !streamingIds.includes(sessionId)
          && !isBackendOccupied(busyBySession[sessionId]))
      ) continue;

      // Merge mode sends the whole queue as ONE turn. Bounded on purpose: without
      // a cap, a long queue becomes a single enormous prompt; the remainder simply
      // drains on the next turn.
      const MERGE_MAX_ITEMS = 10;
      const consumed = settings.mergeQueuedMessages ? queue.slice(0, MERGE_MAX_ITEMS) : [queue[0]];
      const consumedIds = new Set(consumed.map((item) => item.id));
      // Empty-content items are real (a busy Enter with attachments and no typed
      // text degrades to a queued item), and joining them blindly produced stray
      // blank paragraphs inside the merged prompt.
      const parts = consumed.map((item) => (item.content || '').trim()).filter(Boolean);
      const content = parts.length > 1
        ? `【已合并 ${parts.length} 条排队消息】\n\n${parts.join('\n\n')}`
        : (parts[0] ?? '');
      // Placeholders stay in `content` (display/transcript); the delivered prompt
      // gets the expanded text.
      const queuedPastes = consumed.flatMap((item) => item.pastes || []);
      const deliveredContent = queuedPastes.length ? expandPastes(content, queuedPastes) : content;
      // Same file queued twice must not be referenced twice in the file-ref block.
      const attachments = consumed
        .flatMap((item) => item.attachments)
        .filter((file, i, arr) => arr.findIndex((other) => other?.path === file?.path) === i);

      queueSendingRef.current.add(sessionId);
      setQueuesBySession((prev) => ({
        ...prev,
        [sessionId]: (prev[sessionId] || []).filter((item) => !consumedIds.has(item.id)),
      }));
      Promise.resolve(sendQueuedMessage(sessionId, deliveredContent, attachments, queuedPastes.length ? { displayText: content, pastes: queuedPastes } : undefined))
        .catch((error) => {
          // The backend remains authoritative. If the original turn (including
          // compaction) was still busy or delivery otherwise failed, restore the
          // exact items at the head and preserve FIFO order.
          console.error('Queued message delivery deferred:', error);
          setQueuesBySession((prev) => {
            const existing = prev[sessionId] || [];
            const existingIds = new Set(existing.map((item) => item.id));
            const restored = consumed.filter((item) => !existingIds.has(item.id));
            return { ...prev, [sessionId]: [...restored, ...existing] };
          });
        })
        .finally(() => {
          queueSendingRef.current.delete(sessionId);
        });
    }
  }, [
    queuesBySession,
    streamingIds,
    busyBySession,
    settings.mergeQueuedMessages,
    sendQueuedMessage,
    currentSessionId,
    switchingModel,
    switchingAgent,
  ]);

  // Drop queues whose sessions were deleted or archived.
  useEffect(() => {
    const liveIds = new Set(sessions.filter((session) => !session.archived).map((session) => session.id));
    setQueuesBySession((prev) => {
      const next = Object.fromEntries(Object.entries(prev).filter(([sessionId]) => liveIds.has(sessionId)));
      return Object.keys(next).length === Object.keys(prev).length ? prev : next;
    });
  }, [sessions]);

  const [sidebarWidth, setSidebarWidth] = useState(() => {
    try {
      const saved = uiGet('kirolex-sidebar-width');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 240;
  });
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const isResizingRef = useRef(false);
  // Resizable width for the right-side file panel (drag its left edge).
  const [fileViewerWidth, setFileViewerWidth] = useState(() => {
    try {
      const saved = uiGet('kirolex-fileviewer-width');
      if (saved) return parseInt(saved, 10);
    } catch {}
    return 520;
  });
  const handleFileResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = fileViewerWidth;
    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      // Panel sits on the RIGHT: dragging the left edge leftwards widens it.
      const newWidth = Math.max(320, Math.min(1100, startWidth + startX - ev.clientX));
      setFileViewerWidth(newWidth);
    };
    const onMouseUp = () => {
      isResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [fileViewerWidth]);
  useEffect(() => {
    try { uiSet('kirolex-fileviewer-width', String(fileViewerWidth)); } catch {}
  }, [fileViewerWidth]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isResizingRef.current = true;
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMouseMove = (ev: MouseEvent) => {
      if (!isResizingRef.current) return;
      const newWidth = Math.max(160, Math.min(500, startWidth + ev.clientX - startX));
      setSidebarWidth(newWidth);
    };

    const onMouseUp = () => {
      isResizingRef.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      try {
        uiSet('kirolex-sidebar-width', String(sidebarWidth));
      } catch {}
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [sidebarWidth]);

  // Save sidebar width when it changes
  useEffect(() => {
    try {
      uiSet('kirolex-sidebar-width', String(sidebarWidth));
    } catch {}
  }, [sidebarWidth]);

  /** One split pane = one fully interactive chat. Every prop is scoped to `sid`
   *  (messages, model, queue, attachments, permission request), and the write
   *  handlers focus that session first so the send pipeline stays single-path. */
  /** Per-pane fork/rerun callbacks with a STABLE identity.
   *
   *  These two are the only App callbacks handed to the MEMOISED message items, and as
   *  inline arrows (`onForkMessage={(id) => handleForkMessage(id, sid)}`) they were new
   *  on every App render -- so `memo` bailed out and all rendered groups re-rendered,
   *  markdown and syntax highlighting included. That happened on every focus switch and
   *  on every chunk arriving in ANY pane, which is the re-render Yinan kept seeing.
   *
   *  Created once per session id and never replaced; the current implementations are
   *  read through a ref, so a stable wrapper can never call a stale closure. */
  const paneCallbacksRef = useRef(new Map<string, { onFork: (messageId: string) => void; onRerun: (messageId: string, editedText: string) => void }>());
  const latestMessageApiRef = useRef({ handleForkMessage, handleRerunMessage });
  // No dep array: refresh after EVERY render, which is still before any user event can
  // fire one of the wrappers.

  /**
   * 校验一有问题就告诉那个会话 —— 「你需要让会话也知道报错」。
   *
   * 报错原来只画给人看:模型不知道「S7 产出的 ext:采集覆盖报告没人读」,你在那条对话里说「修一下」它只能猜,
   * 除非你手动按画布上那个「让它修」—— 最需要说话的时候会话恰好全聋。这里补上:有问题就发,一版结构只发一次。
   *
   * 等 1.2 秒再发:你在面板里改一个字就是一版新指纹,不缓一下就变成边打字边发提示词。
   */


  useEffect(() => { latestMessageApiRef.current = { handleForkMessage, handleRerunMessage }; });
  const paneMessageCallbacks = useCallback((sid: string | null) => {
    const key = sid ?? '__none__';
    const cache = paneCallbacksRef.current;
    let entry = cache.get(key);
    if (!entry) {
      entry = {
        onFork: (messageId: string) => latestMessageApiRef.current.handleForkMessage(messageId, sid || undefined),
        onRerun: (messageId: string, editedText: string) => latestMessageApiRef.current.handleRerunMessage(messageId, editedText, sid || undefined),
      };
      cache.set(key, entry);
    }
    return entry;
  }, []);

  const renderPane = (sid: string | null, wantFocused: boolean, withHeader: boolean, paneStyle?: React.CSSProperties) => {
    /**
     * 「聚焦」这件事只能由 `currentSessionId` 说了算 —— 「这个会话里为什么会出现 flow 会话的内容」。
     *
     * `focused=true` 的含义是「这一格渲染的是 hook 里那份**当前焦点会话**的 messages」(它是活的流)。
     * 而几个调用点是硬写 `true` 的:`renderPane(panes[0] || currentSessionId, true, …)`。一旦这两者不是同一条
     * 会话 —— 比如画布/注册刚把焦点切到 flow 会话,而这一格画的还是 `panes[0]` —— 那一格就会顶着**你这条会话
     * 的标题**,肚子里装着**flow 会话的消息**。这就是内容串台。
     *
     * 所以这里把它校正:声称聚焦但 id 不对,就按后台格渲染(读它自己的 paneViews/缓存)。调用点写错不再能
     * 造成串台,最多是这一格少一点实时性。
     */
    const focused = wantFocused && !!sid && sid === currentSessionId;
    const session = sid ? sessions.find((s) => s.id === sid) || null : null;
    // Stable identities, so the memoised message items can actually skip a re-render.
    const messageCallbacks = paneMessageCallbacks(sid);
    // `paneFallback` is not a nicety: on the render where focus LEAVES this chat its
    // PaneView does not exist yet (setPaneSessions runs in an effect), and the old
    // `paneViews[sid]` alone made the pane render as an EMPTY conversation for one
    // commit -- tearing down and re-creating every transcript row. See paneFallback.
    const view = sid && !focused ? (paneViews[sid] || paneFallback(sid)) : undefined;
    // `?? EMPTY_MESSAGES`, never `|| []`: a fresh [] each render is a new identity, and
    // identity is exactly what keeps the transcript from re-rendering. See paneFallback.
    const paneMessages = focused ? messages : (view?.messages ?? EMPTY_MESSAGES);
    const paneModel = focused
      ? selectedModel
      : ((session?.model && session.model !== 'auto') ? session.model : selectedModel);
    const inner = (
      <ChatArea
        paneFocused={focused}
        messages={paneMessages}
        // A history rebuild is a real, cancellable operation even though its turn is
        // hidden: without counting it here the composer showed no Stop button at
        // all, so the rebuild (and any pending auto-resend) could not be called off.
        //
        // `busyBySession[sid] === 'turn'` is the AUTHORITATIVE half. `streamingIds`
        // is renderer state, so it is wiped by any reload of this window -- an HMR
        // update during a live turn was enough. The composer then believed the turn
        // had ended: Enter stopped steering and sent a NEW message instead, which
        // main rejected ("wait for the active turn") after the bubble was already on
        // screen. Main always knows whether a turn is running; ask it too.
        isStreaming={!!sid && (streamingIds.includes(sid)
          || busyBySession[sid] === 'turn'
          || busyBySession[sid] === 'priming' || busyBySession[sid] === 'prime-pending')}
        status={status}
        sessionConnected={!!sid && attachedSessionIds.includes(sid) && !connectingSessionIds.includes(sid)}
        // Per CHAT, not per focus. Previously this was one app-wide string shown only
        // in the focused pane, so a failure in chat A appeared over chat B once focus
        // moved, and every focus switch mounted the banner in one pane and unmounted it
        // in another -- both transcripts changed height in the same frame, which is the
        // flash seen when clicking between panes. A pane with no chat yet shows the
        // app-level bucket (a backend connect can fail before any session exists).
        connectionError={(sid ? errorBySession[sid] : errorBySession[APP_ERROR_KEY]) || null}
        onDismissError={() => clearSessionError(sid)}
        turnInterrupted={!!sid && interruptedSessionIds.includes(sid)}
        attachedFiles={attachedFor(sid)}
        models={models}
        selectedModel={paneModel}
        activeToolCall={focused ? activeToolCall : (view?.activeTool || null)}
        activityStatus={focused ? activityStatus : (view?.activity || null)}
        stall={focused ? turnStall : (view?.stall || null)}
        permissionRequest={sid ? permissionRequests[sid] || null : null}
        onRespondPermission={respondPermission}
        usage={focused ? usage : (view?.usage || null)}
        // Mirrored per pane like `usage`/`stall`: a plan belongs to a chat, not to
        // whichever pane has focus. Reading it from the focused chat only meant the
        // panel appeared in one pane and vanished from another on every focus switch.
        plan={focused ? plan : (view?.plan || EMPTY_PLAN)}
        autoFoldThinking={settings.autoFoldThinking}
        autoFoldTools={settings.autoFoldTools}
        onManageContext={() => setUsageActionConfirm('contextMenu')}
        onResetCredits={() => setUsageActionConfirm('resetCredits')}
        commands={focused ? commands : EMPTY_COMMANDS}
        onModelChange={(model) => { void handleModelChange(model, sid || undefined); }}
        kiroAgent={session?.kiroAgent || selectedKiroAgent}
        kiroAgents={kiroAgents}
        switchingAgent={focused && switchingAgent}
        switchingModel={focused && switchingModel}
        permissionMode={session?.permissionMode || 'auto-approve'}
        onPermissionModeChange={(mode) => { void handlePermissionModeChange(mode, sid || undefined); }}
        /* 这条会话当前还在跑的子代理 —— 侧栏那个 `🤖 N` 用的是同一份数据，只是它只有 tooltip。
           会话里原来只能看到子代理**说过的话**，看不到"现在有几个在跑、各自卡在哪"。 */
        subagents={sid ? (subagents[sid] || []) : []}
        memoryWarnings={memoryWarnings({
          projectId: session?.projectId,
          sessionId: sid || undefined,
          bytes: {
            global: memoryBytes.global,
            project: session?.projectId ? (memoryBytes.project[session.projectId] ?? 0) : 0,
            session: sid ? (memoryBytes.session[sid] ?? 0) : 0,
          },
        })}
        compactingMemoryScope={compactingMemory}
        onCompactMemory={(scope) => {
          if (sid) void compactMemory(scope, sid, session?.projectId);
        }}
        onOpenMemory={() => setShowMemory(true)}
        onKiroAgentChange={(agentName) => { void handleKiroAgentChange(agentName, sid || undefined); }}
        onForkMessage={messageCallbacks.onFork}
        onRerunMessage={messageCallbacks.onRerun}
        onSend={(text, pastes) => { void handleSendMessage(text, pastes, sid || undefined); }}
        onSteerMessage={(text) => { void handleSteerMessage(text, undefined, sid || undefined); }}
        onCancel={() => { void handleStopStream(sid || undefined); }}
        onDropFiles={(files) => handleDropFiles(files, sid || undefined)}
        onRemoveFile={(id) => handleRemoveFile(id, sid || undefined)}
        currentSessionId={sid}
        isArchived={!!session?.archived}
        onUnarchive={() => { if (sid) archiveSession(sid, false); }}
        queuedMessages={sid ? queuesBySession[sid] || EMPTY_QUEUE : EMPTY_QUEUE}
        mergeQueuedMessages={settings.mergeQueuedMessages}
        /**
         * 「还没读出来」和「真的没有内容」要分开 —— 「这个会话为什么在分屏显示是空的」。
         *
         * 后台格的内容来自 `paneViews[sid]`,而它由 `setPaneSessions` 在**效果里**去读磁盘:比这一次渲染晚
         * 一个提交。于是这一格会先空一帧,而 `historyLoading` 那时还是 false —— 看着就是「空的」。
         * (在我把「借用焦点会话的 messages」堵掉之前,这一帧是用**别人的**内容填的,所以看不见。)
         *
         * 判据是「这一格这一轮还没有 view」:读完之后 view 就存在了(哪怕是空对话),提示自然消失,
         * 所以一条真的没有消息的会话不会一直转圈。
         */
        historyLoading={!!sid && (historyLoadingIds.includes(sid) || (!focused && !paneViews[sid]))}
        restoredQueueDraft={restoredQueueDraft}
            /* 交接是一次性的：接走就清（按 id 认）—— 不清就会每次输入框挂载重放一遍 */
            onConsumeRestoredDraft={(id) => setRestoredQueueDraft((cur) => consumeHandoff(cur, id))}
            onConsumeRestoredInputDraft={consumeRestoredInputDraft}
        restoredInputDraft={restoredInputDraft}
        onQueueMessage={(text, pastes) => handleQueueMessage(text, pastes, sid || undefined)}
        onCancelQueuedMessage={(queueId) => handleCancelQueuedMessage(queueId, sid || undefined)}
        onEditQueuedMessage={(queueId, content) => handleEditQueuedMessage(queueId, content, sid || undefined)}
        onMoveQueuedMessage={(queueId, direction) => handleMoveQueuedMessage(queueId, direction, sid || undefined)}
        importableSessions={sessions
          .filter((s) => s.id !== sid && !s.id.startsWith('pending_') && !s.archived)
          .map((s) => ({ id: s.id, title: s.title }))}
        contextLinks={focused ? contextLinks : (view?.contextLinks || EMPTY_LINKS)}
        onToggleContextSource={(sourceId) => toggleContextSource(sourceId, sid || undefined)}
        isLooping={!!sid && loopingIds.includes(sid)}
        onStartSchedule={(spec) => { if (sid) void createSchedule(sid, spec); }}
        scheduleSummary={scheduleSummaryFor(sid)}
        onPauseSchedule={(id, paused) => void pauseSchedule(id, paused)}
        onCancelSchedule={(id) => void cancelSchedule(id)}
        onStopLoop={() => { if (sid) void stopLoop(sid); }}
      />
    );
    if (!withHeader) return inner;
  return (
      <div
        key={sid || 'empty'}
        className={`chat-pane${focused ? ' focused' : ''}`}
        style={paneStyle}
        // Clicking anywhere in a pane (including its composer) focuses that
        // session, so Enter always sends to the pane you are looking at.
        onMouseDownCapture={(e) => {
          // Header buttons (✕) must not trigger a session switch: switching
          // re-renders this subtree and the follow-up click was getting lost,
          // which is why a pane sometimes could not be closed.
          if ((e.target as HTMLElement).closest('.chat-pane-header')) return;
          void focusSession(sid);
        }}
      >
        <div className="chat-pane-header">
          <span className="chat-pane-title" title={session?.title}>{session?.title || 'Untitled'}</span>
          <button
            className="chat-pane-btn"
            title={t('Remove from split view')}
            // pointerdown, not click: acting before any re-render means the
            // close can never be swallowed by a concurrent focus switch.
            onPointerDown={(e) => { e.stopPropagation(); e.preventDefault(); if (sid) toggleSplitSession(sid); }}
            onClick={(e) => { e.stopPropagation(); }}
          >✕</button>
        </div>
        {inner}
      </div>
    );
  };

  /** The empty-cell strip that advertises free split capacity.
   *
   *  It used to read just "＋ 加入分屏", which says what the cell IS but not what to
   *  DO -- the action (click a chat in the sidebar) happens somewhere else entirely,
   *  so the strip has to name it. Also states how many slots are left, since that
   *  is the one fact the strip is uniquely placed to report. */
  const renderAddStrip = (horizontal: boolean, style?: React.CSSProperties) => {
    const remaining = Math.max(0, splitCapacity - panes.length);
    const tip = [
      t('This pane is empty.'),
      t('Put a chat here: click any chat in the list on the left, or right-click it and pick 「⇆ Add to split」.'),
      // Deliberately does NOT restate the layout: it reported the CONFIGURED grid
      // (e.g. 2x2) while the panes on screen were arranged 1x2, so it contradicted
      // what the user could see. The remaining-slots count below is the honest part.
      `还能再放 ${remaining} 个会话。`,
      t('Remove a pane: click the ✕ at its top-right, or right-click the chat and pick 「⇆ Remove from split」.'),
      t('Resize: drag the divider between panes; double-click a divider to even them out.'),
      t('Change the layout: Settings → Split layout.'),
      t('Every pane is a full chat, each with its own composer, queue and attachments.'),
    ].join('\n');
    return (
      <div
        className={`chat-pane-add${horizontal ? ' horizontal' : ''}${style ? ' cell' : ''}`}
        title={tip}
        style={style}
      >
        <span className="chat-pane-add-plus">＋</span>
        <span className="chat-pane-add-label">
          {horizontal ? t('Click any chat in the list on the left to put it in this pane') : t('Click a chat on the left to fill this pane')}
        </span>
        <span className="chat-pane-add-hint">{t('{n} more can go here', { n: remaining })}</span>
      </div>
    );
  };

  return (
    <LangProvider lang={settings.language}>
      {/* One line, because 「什么都没出现」 is the one thing a registration must never do silently. */}
      <div className={`app-layout no-toolbar${isMac ? ' mac' : ''}`}>
        {isMac && <div className="mac-titlebar" />}
        {!sidebarCollapsed && (
          <div style={{ width: sidebarWidth, flexShrink: 0 }}>
            <Sidebar
              sessions={sessions}
              projects={projects}
              // `highlightSessionId`, not `currentSessionId`: after the last pane is
              // closed nothing is focused (on purpose), and the row you were on must
              // stay highlighted so you can click straight back into it.
              currentSessionId={highlightSessionId}
              status={status}
              streamingSessionIds={streamingIds}
              attachedSessionIds={attachedSessionIds}
              busyBySession={busyBySession}
              connectingSessionIds={connectingSessionIds}
              unreadSessionIds={unreadSessionIds}
              subagentsBySession={subagents}
              /* 先问名字再建 —— 建完才问就得再改一次，而"这次跑的是什么"通常在你点它之前就知道了 */
              executorCap={executorCap}
              onNewSession={() => { setNewChatProject(''); setNewChatNewProjectName(''); setShowNewChat(true); }}
              onCreateProject={createProject}
              onReorderProjects={reorderProjects}
              onNewSessionInProject={handleNewSessionInProject}
              onRenameProject={renameProject}
              onDeleteProject={handleDeleteProject}
              onSwitchSession={handleSwitchSession}
              onDeleteSession={handleDeleteSession}
              onRebuildContext={(id, mode) => { void rebuildContext(id, mode); }}
              onRenameSession={renameSession}
              onTogglePin={togglePin}
              // Only the EXPLICIT selection highlights rows. In single-chat mode
              // `panes` falls back to the focused chat, which must not look selected.
              /**
               * 只有**真的在分屏**时才有序号 —— 「为什么不分屏也有序号？」
               *
               * `panes` 在没分屏时会回落成 `[当前会话]`(单格模式下要渲染的就是它),所以直接拿 panes 编号,
               * 会给那个唯一的会话编上 ①:一个只有一格的「分屏」序号,毫无意义。判据是 splitSessionIds ——
               * 那才是「你挑了哪几个摆在一起」。全页视图不再清空它,所以进 flow 期间序号照样显示。
               */
              splitOrder={(id) => {
                if (splitSessionIds.length === 0) return 0;
                const i = panes.indexOf(id);
                return i < 0 ? 0 : i + 1;
              }}
              onToggleSplit={(id) => toggleSplitSession(id)}
              scheduleFor={scheduleSummaryFor}
              onAssignProject={assignProject}
              onMoveSession={moveSession}
              onArchiveSession={archiveSession}
              onSettings={() => setShowSettings(true)}
              workspaceOpen={showWorkspace}
              onOpenWorkspace={() => setShowWorkspace((visible) => !visible)}
              onOpenLogs={() => void handleOpenLogs()}
              onOpenMemory={() => setShowMemory(true)}
              // Flow 面板只列注册的 flow，所以这里不再去读 ~/.kiro/skills（那一块已从面板上撤掉）
              /**
               * OPENING AN IDLE PROJECT IS WHAT CONNECTS IT.
               *
               * Startup no longer warms projects untouched for a week (`projectActivity`), so this is
               * where their executors come from: 「等用户点开project再创建连接」. Best-effort and bounded by
               * the backend cap — a failure leaves the chat dormant, which is what clicking it fixes.
               */
              /**
               * 这个 project 现在有哪些 flow,以及哪些的定义已经被删了 —— 「为啥 flow 都删了 project 里面还是这些配置？」
               * 带状和这里都是从 run 推出来的,而删 flow 删的是注册表:不比一下,删掉的 flow 会一直以配置的身份挂着。
               */
              /* 这个 project 在哪儿干活 —— 菜单里显示当前值 */
              projectWorkspace={(project: string) => projectWorkspaces[project] || ''}
              /**
               * 改工作目录 —— 主进程校验（不存在 / 不是目录 / 不是绝对路径都当场说）。
               *
               * 用 prompt 而不是一个新对话框:这是一行绝对路径,而且改它的频率是「一个 project 一次」。
               * 改完清掉 cwd 缓存,否则下一条会话还起在旧目录里。
               */
              onSetProjectWorkspace={(project: string) => {
                void (async () => {
                  const now = projectWorkspaces[project] || '';
                  const next = window.prompt(
                    `「${project}」的会话在哪个目录里干活？\n\n留空 = 家目录。写绝对路径 = 这个 project 的所有会话（包括 flow 的每一步）都在那儿跑。`,
                    now,
                  );
                  if (next === null) return;
                  const res = await window.kiroApi.projectSetWorkspace?.(project, next.trim());
                  if (!res?.ok) { window.alert(`设不上：${res?.error || t('unknown reason')}`); return; }
                  projectCwdCache.current.delete(project);
                  setProjectWorkspaces((cur) => ({ ...cur, [project]: next.trim() }));
                })();
              }}
              /**
               * 移出一个 flow —— 两种情况,两种后果,都当场说清。
               *
               * 定义还在:只是**移出**(写名单)。历史一条不动,而它的主会话从此可删 —— 删主会话才是
               * 「一并删历史」那个决定(`flowMainDeletion`)。
               * 定义已经没了:这个 project 里没有主会话可作锚(SFDC 那三条就是),所以这里直接删历史,
               * 进回收站、报条数。
               */
              /**
               * 主会话删不删得动,由「这个 project 还在用这个 flow 吗」决定 —— 不再使用 = 移出了,或者定义已经没了。
               * 删得动的时候,删它就一并把这个 flow 在这个 project 里的运行历史带走(主进程那边级联,进回收站)。
               */
              /**
               * 展开一个 project = 预热它的会话 —— 「为什么我点开一个之前的项目没有自动预热」。
               *
               * 这里原来只 `loadSession` 了一下:后端可能连上了,但没有登记 attach、也没有 ensureContext,
               * 所以界面上那个点一直不变、历史也没被核对 —— 看着就是没预热。`warmSession` 走的是
               * `switchSession` 里那一整套(连接中 → load → attach → 核对历史)。
               */
              onWarmProject={(project) => {
                for (const s of sessions) {
                  if ((s.projectId || '') !== project || s.archived) continue;
                  void warmSession(s.id);
                }
              }}
              /**
               * ▸ 打开这个 project：有正在跑的就直接进运行视图，没有才落回工作台。
               * 「只把在运行中的skill归属到project」—— project 里最该先看见的就是它在跑什么。
               */
              // Agent config is global: one trigger in the sidebar, handled by the
              // focused pane so a split view never opens several editors.
            />
          </div>
        )}
        <div className="sidebar-resize-area">
          {!sidebarCollapsed && (
            <div className="sidebar-resize-handle" onMouseDown={handleResizeStart} />
          )}
          <button
            className="sidebar-collapse-btn"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            title={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'}
          >
            {sidebarCollapsed ? '▶' : '◀'}
          </button>
        </div>
        {/*
          THE CANVAS IS THE SKILL SESSION'S VIEW, so it is shown only while that session is in front.
          Rendered from 「有草稿」 alone it kept the whole main area after switching chats — 「切到别的会话
          之后为什么这个界面还会显示」.
        */}
        {!splitActive ? (
          // With nothing assigned AND nothing focused this resolves to null, i.e. the
          // ordinary opening screen -- which is where closing the last pane lands.
          renderPane(panes[0] || currentSessionId, true, false)
        ) : (
          // Nested flex: a column of rows, each row its own set of panes. Dividers
          // are real elements between them, so every split is draggable and the
          // "add" strip can sit in just the free corner instead of claiming the
          // whole right edge (a CSS grid forced every row to share columns).
          <div className="chat-grid">
            {paneRowsOfPanes.map((rowPanes, r) => (
              <React.Fragment key={`split-row-${r}`}>
                {r > 0 && (
                  // Always rendered: it also draws the hairline between rows. The
                  // switch only decides whether it is DRAGGABLE.
                  <div
                    className={`pane-resize-handle horizontal${dragSplits ? '' : ' locked'}`}
                    title={dragSplits ? t('Drag to resize (double-click to even out)') : t('Pane dragging is turned off in Settings')}
                    onMouseDown={dragSplits ? (e) => handlePaneResizeStart(e, 'row', 0, r - 1) : undefined}
                    onDoubleClick={dragSplits ? () => setSplitSizes(null) : undefined}
                  />
                )}
                <div className="chat-row" style={{ flexGrow: rowFlex(r), flexBasis: 0 }}>
                  {rowPanes.map((sid, c) => (
                    <React.Fragment key={sid || `split-pane-${r}-${c}`}>
                      {c > 0 && (
                        <div
                          className={`pane-resize-handle vertical${dragSplits ? '' : ' locked'}`}
                          title={dragSplits ? t('Drag to resize width (double-click to even out)') : t('Pane dragging is turned off in Settings')}
                          onMouseDown={dragSplits ? (e) => handlePaneResizeStart(e, 'col', r, c - 1) : undefined}
                          onDoubleClick={dragSplits ? () => setSplitSizes(null) : undefined}
                        />
                      )}
                      {renderPane(sid, sid === currentSessionId, true, {
                        flexGrow: colFlex(r, c),
                        flexBasis: 0,
                      })}
                    </React.Fragment>
                  ))}
                  {/* Free capacity to the RIGHT of a row is a slim strip, so the chat
                      in this row uses the full width. The cost is accepted knowingly:
                      filling this cell later halves that pane, and its right edge does
                      not line up with the divider above until then. A fully empty ROW
                      is the opposite case -- see the placeholder row below. */}
                  {stripRight && r === paneRowsOfPanes.length - 1 && renderAddStrip(false)}
                </div>
              </React.Fragment>
            ))}
            {/* Free capacity is ALWAYS a slim strip, below just as much as to the right:
                the panes on screen keep their full size and nothing moves when one is
                added. An earlier version had a fully empty row reserve a real row's
                height so a third chat would land exactly on it -- correct in theory,
                but with two chats it turned the bottom half of the window into an empty
                box, which is not worth the alignment it bought. */}
            {stripBelow && renderAddStrip(true)}
          </div>
        )}
        {showWorkspace && (
          <WorkspacePanel
            sessionId={currentSessionId}
            onClose={() => setShowWorkspace(false)}
            onOpenFile={(p) => void openFileInApp(p)}
          />
        )}
        {(fileViewerLoading || fileViewer) && (
          <div className="workspace-file-panel" role="complementary" aria-label="File preview" style={{ width: fileViewerWidth }}>
            <div className="file-resize-handle" onMouseDown={handleFileResizeStart} title={t('Drag to resize width')} />
            <div className="settings-header">
              <h3 title={fileViewer?.path} style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {fileViewer ? (fileViewer.path.split('/').pop() || fileViewer.path) : 'Loading…'}
                </span>
                {/* Say it rather than showing a stale copy as if it were current. */}
                {fileViewer?.gone && (
                  <span className="stat-del" title={t('This file is no longer on disk (deleted or renamed). What is shown below is the last content read.')}>
                    已删除
                  </span>
                )}
              </h3>
              <div className="workspace-file-actions">
                {fileViewer && !fileViewer.image && !fileViewer.binary && (isMarkdownPath(fileViewer.path) || !!viewerLangFor(fileViewer.path)) && (
                  <button
                    className="text-btn"
                    title={fileViewerRaw ? t('Show the rendered view (Markdown / syntax highlighting / formatted JSON)') : t('Show the raw file')}
                    onClick={() => setActiveTabRaw(!fileViewerRaw)}
                  >
                    {fileViewerRaw ? t('◉ Rendered') : t('◎ Raw')}
                  </button>
                )}
                {/* Manual refresh as well as the watcher: fs.watch does not fire for
                    every writer on every filesystem (network mounts, some containers),
                    and a button costs nothing when it does not. */}
                {fileViewer && !fileViewer.gone && (
                  <button
                    className="text-btn"
                    title={t('Re-read this file from disk (keeps scroll position and current view)')}
                    onClick={() => void refreshFileTab(fileViewer.id, fileViewer.path)}
                  >
                    ⟳ 刷新
                  </button>
                )}
                {/* Download no longer requires a connected chat -- it is a local
                    file copy through a save dialog. */}
                {fileViewer && (
                  <button
                    className="text-btn"
                    onClick={() => void window.kiroApi.workspaceDownload?.(currentSessionId, fileViewer.path)}
                  >
                    ⬇ Download
                  </button>
                )}
                <button className="settings-close" onClick={() => { setFileTabs([]); setActiveFileTabId(null); setFileViewerLoading(false); }} title={t('Close panel')}>
                  <IconClose size={16} />
                </button>
              </div>
            </div>
            {fileTabs.length > 1 && (
              <div className="file-tabs" role="tablist" aria-label="Open files">
                {fileTabs.map((tab) => (
                  <div
                    key={tab.id}
                    role="tab"
                    aria-selected={tab.id === activeFileTabId}
                    className={`file-tab ${tab.id === activeFileTabId ? 'active' : ''}`}
                    title={tab.path}
                    onClick={() => setActiveFileTabId(tab.id)}
                    onAuxClick={(e) => { if (e.button === 1) { e.preventDefault(); closeFileTab(tab.id); } }}
                  >
                    <span className="file-tab-name">
                      {tab.gone ? '⚠ ' : tab.stale ? '• ' : ''}{tab.path.split('/').pop() || tab.path}
                    </span>
                    <button
                      type="button"
                      className="file-tab-close"
                      title={t('Close tab')}
                      onClick={(e) => { e.stopPropagation(); closeFileTab(tab.id); }}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div
              className="workspace-file-modal-body"
              ref={fileBodyRef}
              onScroll={(e) => {
                // Remember where this tab was scrolled to; restored on switch back.
                if (activeFileTabId) fileScrollRef.current[activeFileTabId] = (e.target as HTMLDivElement).scrollTop;
              }}
            >
              {fileViewerLoading && <div className="workspace-hint">Loading file…</div>}
              {!fileViewerLoading && fileViewer && (
                <>
                  <div className="workspace-viewer-path" title={fileViewer.path}>{fileViewer.path}</div>
                  {fileViewer.image && fileViewer.dataUrl ? (
                    <div className="workspace-image-wrap">
                      <img className="workspace-image" src={fileViewer.dataUrl} alt={fileViewer.path.split('/').pop() || 'image'} />
                    </div>
                  ) : fileViewer.binary ? (
                    <div className="workspace-binary-hint">
                      <span>{fileViewer.content || 'This file type cannot be previewed. Download it to open it locally.'}</span>
                    </div>
                  ) : (
                    <>
                      {fileViewer.truncated && (
                        <div className="workspace-hint">⚠️ Preview truncated at 512 KB. Download for the complete file.</div>
                      )}
                      {isMarkdownPath(fileViewer.path) && !fileViewerRaw ? (
                        <div className="workspace-viewer-md">
                          <MarkdownView content={fileViewer.content} />
                        </div>
                      ) : (() => {
                        const hl = fileViewerRaw ? null : highlightForViewer(fileViewer.path, fileViewer.content);
                        if (!hl) return <pre className="workspace-viewer-content">{fileViewer.content}</pre>;
                        return (
                          <>
                            {hl.prettified && (
                              <div className="workspace-hint">{t('Formatted for display (the file itself is minified JSON). Click 「Raw」 to see it unformatted.')}</div>
                            )}
                            <pre className="workspace-viewer-content hljs">
                              <code
                                className={`language-${hl.lang}`}
                                dangerouslySetInnerHTML={{ __html: hl.html }}
                              />
                            </pre>
                          </>
                        );
                      })()}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {showSettings && (
        <SettingsDialog
          settings={settings}
          onChange={handleSettingsChange}
          onClose={() => setShowSettings(false)}
          confirmDeletes={!skipDeleteConfirm}
          onConfirmDeletesChange={(value) => {
            const skip = !value;
            setSkipDeleteConfirm(skip);
            try { uiSet('kirolex-skip-delete-confirm', String(skip)); } catch {}
          }}
        />
      )}
      {showNewChat && (
        <>
          <div className="overlay" onClick={() => setShowNewChat(false)} />
          <div className="permission-dialog">
            <h3>💬 New Chat</h3>
            <p style={{ marginBottom: 10 }}>Assign this chat to a project (optional). A project gives the chat its own memory.</p>
            <label style={{ display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 }}>Project</label>
            <select
              className="rename-popup-input"
              value={newChatProject}
              onChange={(e) => setNewChatProject(e.target.value)}
              style={{ marginBottom: 12 }}
            >
              <option value="">No project (unassigned)</option>
              {projects.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
              <option value="__new__">+ New project…</option>
            </select>
            {newChatProject === '__new__' && (
              <input
                autoFocus
                className="rename-popup-input"
                placeholder="New project name…"
                value={newChatNewProjectName}
                onChange={(e) => setNewChatNewProjectName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateChat(); }}
                style={{ marginBottom: 12 }}
              />
            )}
            <div className="actions">
              <button className="btn deny" onClick={() => setShowNewChat(false)}>Cancel</button>
              <button className="btn allow" onClick={handleCreateChat}>Create</button>
            </div>
          </div>
        </>
      )}
      {/*
        窗口级那条搜索条删了 —— 它长在这里（`position: fixed`，右上角）就注定说不清在搜哪一格,
        而且实测被 `.chat-grid`（z-index 1001）整个盖住、点不到。现在每一格自己有一条,
        见 `ChatArea` 里 `.pane-find` 那一段。
      */}
      {showSkill && <SkillDialog onClose={() => setShowSkill(false)} />}

      {showMemory && (
        <MemoryDialog
          projectId={sessions.find((s) => s.id === currentSessionId)?.projectId}
          sessionId={currentSessionId && !currentSessionId.startsWith('pending_') ? currentSessionId : undefined}
          onClose={() => setShowMemory(false)}
        />
      )}
      {showLogs && (
        <>
          <div className="overlay" onClick={() => setShowLogs(false)} />
          <div className="settings-dialog" style={{ width: 720, maxWidth: '90vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column' }}>
            <div className="settings-header">
              <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <IconLogs size={17} /> 日志
              </h3>
              <button className="settings-close" onClick={() => setShowLogs(false)} title={t('Close logs')}>
                <IconClose size={16} />
              </button>
            </div>
            <div className="settings-body" style={{ display: 'flex', flexDirection: 'column', gap: 8, overflow: 'hidden' }}>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button
                  className="btn deny"
                  style={{ padding: '6px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  onClick={async () => {
                    const result = await window.kiroApi.getLogs(logsLimit).catch(() => ({
                      text: '(failed to read logs)',
                      path: '',
                    }));
                    logsHasMoreRef.current = result.text.split('\n').length >= logsLimit;
                    setLogsText(result.text);
                    requestAnimationFrame(() => {
                      if (logsPreRef.current) logsPreRef.current.scrollTop = logsPreRef.current.scrollHeight;
                    });
                  }}
                >
                  刷新
                </button>
                <button
                  className="btn deny"
                  style={{ padding: '6px 12px', border: 'none', borderRadius: 6, cursor: 'pointer', background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}
                  onClick={() => void window.kiroApi.openLogs()}
                >
                  打开日志文件
                </button>
              </div>
              <pre style={{
                flex: 1,
                overflow: 'auto',
                margin: 0,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
                fontSize: 11,
                lineHeight: 1.5,
                background: 'var(--bg-tertiary)',
                padding: 12,
                borderRadius: 6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                maxHeight: '60vh',
              }}
                ref={logsPreRef}
                onScroll={(e) => {
                  if (e.currentTarget.scrollTop <= 40) void loadOlderLogs();
                }}
              >
                {logsHasMoreRef.current && (logsLoadingOlder ? '⋯ 加载更早的日志…\n' : '↑ 上拉加载更早的日志\n')}
                {logsText || '(no logs yet)'}
              </pre>
            </div>
          </div>
        </>
      )}
      {usageActionConfirm && (
        <>
          <div className="overlay" onClick={() => setUsageActionConfirm(null)} />
          <div className="permission-dialog">
            {usageActionConfirm === 'contextMenu' ? (
              <>
                <h3>Manage context</h3>
                <p>
                  Choose whether to summarize older context or clear the active
                  conversation context completely.
                </p>
                <div className="actions">
                  <button className="btn deny" onClick={() => setUsageActionConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn deny"
                    onClick={() => setUsageActionConfirm('clear')}
                    style={{ color: 'var(--error)' }}
                  >
                    Clear
                  </button>
                  <button
                    className="btn allow"
                    onClick={() => setUsageActionConfirm('compact')}
                  >
                    Compact
                  </button>
                </div>
              </>
            ) : (
              <>
                <h3>
                  {usageActionConfirm === 'compact'
                    ? 'Compact context?'
                    : usageActionConfirm === 'clear'
                    ? 'Clear context?'
                    : 'Reset Credits counter?'}
                </h3>
                <p>
                  {usageActionConfirm === 'compact'
                    ? 'Kiro CLI will summarize older conversation context to free context-window capacity. The original full context cannot be restored inside this active Kiro session.'
                    : usageActionConfirm === 'clear'
                    ? 'Kiro CLI will discard the active conversation context, and KiroLex will clear the currently displayed history. This cannot be undone inside this active chat.'
                    : 'This resets the Credits counter for the current KiroLex session to 0. It does not change actual account usage, billing, or Kiro credit records.'}
                </p>
                <div className="actions">
                  <button className="btn deny" onClick={() => setUsageActionConfirm(null)}>
                    Cancel
                  </button>
                  <button
                    className="btn allow"
                    onClick={() => void handleConfirmUsageAction()}
                    style={usageActionConfirm === 'clear' ? { background: 'var(--error)' } : undefined}
                  >
                    {usageActionConfirm === 'compact'
                      ? 'Compact'
                      : usageActionConfirm === 'clear'
                      ? 'Clear'
                      : 'Reset'}
                  </button>
                </div>
              </>
            )}
          </div>
        </>
      )}
      {rerunConfirm && (
        <>
          <div className="overlay" onClick={() => setRerunConfirm(null)} />
          <div className="permission-dialog">
            <h3>{t('Edit and rerun')}</h3>
            <p>
              将删除这条之后的 <strong>{rerunConfirm.deleteCount}</strong> 条记录并基于编辑后的消息重跑。
            </p>
            <div className="actions">
              <button className="btn deny" onClick={() => setRerunConfirm(null)}>{t('Cancel')}</button>
              <button className="btn allow" onClick={confirmRerun}>{t('Confirm and rerun')}</button>
            </div>
          </div>
        </>
      )}
      {/*
        给运行起名字 / 改名。一个对话框管两件事：`runId` 为空是新建，有值是改名。
        空名字是**合法**的：新建时表示"懒得起名，用 #N"；改名时表示"清掉名字，回到 #N"。
      */}
      {/* 删除被拒绝：只说明理由，没有「仍然删除」这个选项 —— 这条约束不是建议。 */}
      {deleteRefusal && (
        <>
          <div className="overlay" onClick={() => setDeleteRefusal(null)} />
          <div className="permission-dialog">
            <h3>{t('🔒 This chat cannot be deleted from here')}</h3>
            <p>{deleteRefusal}</p>
            <div className="permission-actions">
              <button className="btn allow" onClick={() => setDeleteRefusal(null)}>{t('Got it')}</button>
            </div>
          </div>
        </>
      )}
      {deleteConfirm && (
        <>
          <div className="overlay" onClick={() => setDeleteConfirm(null)} />
          <div className="permission-dialog">
            <h3>🗑️ Delete Session</h3>
            <p>
              Are you sure you want to delete <strong>"{deleteConfirm.title}"</strong>?
              This will permanently remove the session and its history.
            </p>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--text-secondary)', margin: '4px 0 14px', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={dontAskDelete}
                onChange={(e) => setDontAskDelete(e.target.checked)}
              />
              Don't ask again
            </label>
            <div className="actions">
              <button className="btn deny" onClick={() => { setDeleteConfirm(null); setDontAskDelete(false); }}>
                Cancel
              </button>
              <button className="btn allow" onClick={confirmDelete} style={{ background: '#ef5350' }}>
                Delete
              </button>
            </div>
          </div>
        </>
      )}
      {deleteProjectConfirm && (
        <>
          <div className="overlay" onClick={() => setDeleteProjectConfirm(null)} />
          <div className="permission-dialog">
            <h3>🗑️ Delete Project</h3>
            <p>
              Are you sure you want to delete the project <strong>"{deleteProjectConfirm.name}"</strong>?
              This permanently removes its memory{deleteProjectConfirm.memberCount > 0
                ? <> and <strong>{deleteProjectConfirm.memberCount} chat{deleteProjectConfirm.memberCount === 1 ? '' : 's'}</strong> inside it (with their history)</>
                : null}. This cannot be undone.
            </p>
            <div className="actions">
              <button className="btn deny" onClick={() => setDeleteProjectConfirm(null)}>
                Cancel
              </button>
              <button className="btn allow" onClick={confirmDeleteProject} style={{ background: '#ef5350' }}>
                Delete project
              </button>
            </div>
          </div>
        </>
      )}
    </LangProvider>
  );
};

export default App;
