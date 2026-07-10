import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSession, type PermissionMode, type PermissionRequest } from "../agent/session.js";
import { History } from "../agent/history.js";
import type { ProviderConfig } from "../agent/providers.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { PermissionStore } from "../agent/permissionStore.js";
import { buildRegistry, } from "../commands/builtins.js";
import { parseSlash } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import { FileIndex } from "../commands/fileIndex.js";
import type { CompletionContext } from "../commands/completion.js";
import { toDisplayItems, streamDelta, type DisplayItem } from "./transcript.js";
import { MessageList } from "./MessageList.js";
import { InputBox } from "./InputBox.js";
import { PermissionDialog } from "./PermissionDialog.js";
import { StatusBar } from "./StatusBar.js";
import { ResumePicker } from "./ResumePicker.js";
import { WorkingIndicator } from "./WorkingIndicator.js";
import { useGitStatus } from "./useGitStatus.js";
import { loadMcpServers, formatMcpStatus } from "../agent/mcp.js";
import { loadSkills, formatSkillList, type Skill } from "../agent/skills.js";
import { mergeSkillCommands } from "../commands/skillCommands.js";

export interface AppProps {
  cwd: string;
  providers: Record<string, ProviderConfig>;
  initialProvider: string;
  resume?: string;
  sessionIndex: SessionIndex;
  queryFn?: typeof query;
  openResumeOnStart?: boolean;
}

type Phase = "idle" | "streaming" | "permission";

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];
const CONTEXT_WINDOW = 200_000;

export function App(props: AppProps) {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [providerName, setProviderName] = useState(props.initialProvider);
  const [model, setModel] = useState<string | undefined>(props.providers[props.initialProvider]?.model);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);
  const [showResumePicker, setShowResumePicker] = useState(props.openResumeOnStart ?? false);
  const [cost, setCost] = useState(0);
  const [tokens, setTokens] = useState(0);
  const [contextPct, setContextPct] = useState<number | undefined>(undefined);
  const [turnCount, setTurnCount] = useState(0);
  const startedAtRef = useRef(Date.now());
  const [elapsedMs, setElapsedMs] = useState(0);
  const [streamText, setStreamText] = useState("");
  const streamRef = useRef("");
  const [activeTool, setActiveTool] = useState<string | undefined>(undefined);
  const [workStartedAt, setWorkStartedAt] = useState(0);
  const firstMessageRef = useRef<string | undefined>(undefined);
  const sessionRef = useRef<AgentSession | null>(null);
  const lastCtrlCRef = useRef(0);
  const historyRef = useRef(new History());
  const permissionStoreRef = useRef(new PermissionStore(props.cwd));
  const [registry, setRegistry] = useState(() => buildRegistry());
  const skillsRef = useRef<Skill[]>([]);
  const fileIndexRef = useRef(new FileIndex(props.cwd));
  const mcpServersRef = useRef<Record<string, Record<string, unknown>>>({});
  const completionCtx: CompletionContext = {
    registry,
    providerNames: () => Object.keys(props.providers),
    listFiles: () => fileIndexRef.current.list(),
    refreshFiles: () => fileIndexRef.current.refresh()
  };

  const notice = (text: string) => setItems(prev => [...prev, { kind: "notice", text }]);
  const setStream = (text: string) => { streamRef.current = text; setStreamText(text); };

  function handleMessage(msg: SDKMessage): void {
    const delta = streamDelta(msg);
    if (delta) { setStream(streamRef.current + delta); return; }
    const mapped = toDisplayItems(msg);
    if (mapped.length > 0) setItems(prev => [...prev, ...mapped]);
    if (mapped.some(i => i.kind === "assistant")) { setStream(""); setActiveTool(undefined); }
    const lastTool = [...mapped].reverse().find(i => i.kind === "tool");
    if (lastTool && lastTool.kind === "tool") setActiveTool(lastTool.label.split(" ")[0]);
    const t = (msg as { type: string }).type;
    if (t === "result") {
      if (streamRef.current) {
        const text = streamRef.current;
        setItems(prev => [...prev, { kind: "assistant", text }]);
        setStream("");
      }
      setActiveTool(undefined);
      const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
      if (typeof cost === "number") setCost(prev => prev + cost);
      const usage = (msg as { usage?: Record<string, number> }).usage;
      if (usage) {
        const input = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        const output = usage.output_tokens ?? 0;
        setTokens(prev => prev + input + output);
        setContextPct(Math.min(100, Math.round((input / CONTEXT_WINDOW) * 100)));
      }
      setTurnCount(prev => prev + 1);
      setPhase("idle");
    }
  }

  function createSession(name: string, resume?: string): AgentSession {
    mcpServersRef.current = loadMcpServers(props.cwd);
    skillsRef.current = loadSkills(props.cwd);
    setRegistry(mergeSkillCommands(buildRegistry(), skillsRef.current));
    const session = new AgentSession({
      providerName: name,
      provider: props.providers[name],
      model: props.providers[name]?.model,
      permissionMode: mode,
      resume,
      cwd: props.cwd,
      mcpServers: mcpServersRef.current,
      onMessage: handleMessage,
      onPermissionRequest: req => {
        const filePath = typeof req.input.file_path === "string" ? req.input.file_path : undefined;
        if (filePath) {
          const decision = permissionStoreRef.current.check(req.toolName, filePath);
          if (decision) {
            req.resolve(decision === "allow");
            setItems(prev => [...prev, {
              kind: "notice",
              text: `auto-${decision === "allow" ? "allowed" : "denied"}: ${req.toolName} ${filePath} (rule)`
            }]);
            return;
          }
        }
        setPermissionQueue(q => [...q, req]);
        setPhase("permission");
      },
      onSessionId: id => {
        if (firstMessageRef.current) recordSession(id, name);
      },
      queryFn: props.queryFn
    });
    session.start();
    return session;
  }

  function recordSession(id: string, provider: string): void {
    props.sessionIndex.record({
      id,
      cwd: props.cwd,
      firstMessage: firstMessageRef.current ?? "",
      timestamp: new Date().toISOString(),
      provider
    });
  }

  useEffect(() => {
    sessionRef.current = createSession(props.initialProvider, props.resume);
    return () => { void sessionRef.current?.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 1000);
    return () => clearInterval(timer);
  }, []);

  const git = useGitStatus(props.cwd, turnCount);

  async function restartSession(name: string, resume?: string): Promise<void> {
    await sessionRef.current?.dispose();
    firstMessageRef.current = undefined;
    sessionRef.current = createSession(name, resume);
    setModel(props.providers[name]?.model);
  }

  const ctx: CommandContext = {
    notice,
    clearSession: async () => { setItems([]); setStream(""); setActiveTool(undefined); await restartSession(providerName); },
    setModel: async m => { await sessionRef.current?.setModel(m); setModel(m); },
    setPermissionMode: async m => {
      await sessionRef.current?.setPermissionMode(m as PermissionMode);
      setMode(m as PermissionMode);
    },
    switchProvider: async name => {
      if (!props.providers[name]) {
        notice(`Unknown provider: ${name}. Providers: ${Object.keys(props.providers).join(", ")}. Add custom providers in ~/.cloudcode/providers.json (see README).`);
        return;
      }
      const previous = providerName;
      try {
        await restartSession(name);
        setProviderName(name);
        setModel(props.providers[name]?.model);
        notice(`Provider: ${name}`);
      } catch (err) {
        notice(`Failed to switch provider: ${String(err)}. Staying on ${previous}.`);
        await restartSession(previous);
      }
    },
    openResumePicker: () => setShowResumePicker(true),
    costSummary: () => `Session cost: $${cost.toFixed(4)}`,
    providerNames: () => Object.keys(props.providers),
    exit: () => { void sessionRef.current?.dispose(); exit(); },
    listPermissionRules: () => {
      const rules = permissionStoreRef.current.list();
      if (rules.length === 0) return "No permission rules.";
      return rules.map(r => `${r.decision === "allow" ? "✓" : "✗"} ${r.tool} ${r.dir}`).join("\n");
    },
    clearPermissionRules: () => permissionStoreRef.current.clear(),
    mcpStatus: async () =>
      formatMcpStatus(
        Object.keys(mcpServersRef.current),
        (await sessionRef.current?.mcpStatus()) ?? [],
        sessionRef.current?.tools ?? []
      ),
    sendPrompt: text => sendUserMessage(text),
    listSkills: () => formatSkillList(skillsRef.current),
  };

  function sendUserMessage(text: string): void {
    if (!firstMessageRef.current) {
      firstMessageRef.current = text;
      if (sessionRef.current?.sessionId) recordSession(sessionRef.current.sessionId, providerName);
    }
    setItems(prev => [...prev, { kind: "user", text }]);
    setPhase("streaming");
    setWorkStartedAt(Date.now());
    sessionRef.current?.send(text);
  }

  function handleSubmit(text: string): void {
    const slash = parseSlash(text);
    if (slash) {
      const cmd = registry.get(slash.name);
      if (!cmd) { notice(`Unknown command: /${slash.name}`); return; }
      cmd.run(ctx, slash.args).catch(err => {
        setItems(prev => [...prev, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
      });
      return;
    }
    sendUserMessage(text);
  }

  useInput((_input, key) => {
    if (key.escape && phase === "streaming") void sessionRef.current?.interrupt();
    if (key.tab && key.shift) {
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
      ctx.setPermissionMode(next).catch(err => {
        setItems(prev => [...prev, { kind: "error", text: err instanceof Error ? err.message : String(err) }]);
      });
    }
    if (key.ctrl && _input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 2000) ctx.exit();
      else { lastCtrlCRef.current = now; void sessionRef.current?.interrupt(); notice("Press Ctrl+C again to exit."); }
    }
  });

  const activePermission = permissionQueue[0];

  function decidePermission(allow: boolean, rememberAs?: "allow" | "deny"): void {
    if (rememberAs && activePermission && typeof activePermission.input.file_path === "string") {
      try {
        permissionStoreRef.current.remember(activePermission.toolName, activePermission.input.file_path, rememberAs);
      } catch (err) {
        setItems(prev => [...prev, {
          kind: "error",
          text: `Failed to save permission rule: ${err instanceof Error ? err.message : String(err)}`
        }]);
      }
    }
    activePermission?.resolve(allow);
    setPermissionQueue(q => {
      const rest = q.slice(1);
      if (rest.length === 0) setPhase("streaming");
      return rest;
    });
  }

  return (
    <Box flexDirection="column">
      <MessageList items={items} />
      {streamText !== "" && <Text>{streamText}</Text>}
      {phase === "streaming" && <WorkingIndicator label={activeTool ? `Running ${activeTool}` : "Thinking"} startedAt={workStartedAt} />}
      {showResumePicker && (
        <ResumePicker
          entries={props.sessionIndex.list()}
          onPick={e => {
            setShowResumePicker(false);
            setItems([]);
            const provider = props.providers[e.provider] ? e.provider : providerName;
            setProviderName(provider);
            setModel(props.providers[provider]?.model);
            void restartSession(provider, e.id);
          }}
          onCancel={() => setShowResumePicker(false)}
        />
      )}
      {phase === "permission" && activePermission && (
        <PermissionDialog request={activePermission} onDecision={decidePermission} />
      )}
      {!showResumePicker && phase !== "permission" && (
        <InputBox completionCtx={completionCtx} onSubmit={handleSubmit} disabled={phase === "streaming"} history={historyRef.current} />
      )}
      <StatusBar
        provider={providerName} model={model} mode={mode} cwd={props.cwd} costUsd={cost}
        gitBranch={git.branch} gitDirty={git.dirty}
        tokens={tokens} contextPct={contextPct} elapsedMs={elapsedMs}
      />
    </Box>
  );
}
