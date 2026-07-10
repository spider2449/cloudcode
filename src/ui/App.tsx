import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, useApp, useInput } from "ink";
import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { AgentSession, type PermissionMode, type PermissionRequest } from "../agent/session.js";
import type { ProviderConfig } from "../agent/providers.js";
import { SessionIndex } from "../agent/sessionIndex.js";
import { buildRegistry, } from "../commands/builtins.js";
import { parseSlash } from "../commands/registry.js";
import type { CommandContext } from "../commands/types.js";
import { toDisplayItems, type DisplayItem } from "./transcript.js";
import { MessageList } from "./MessageList.js";
import { InputBox } from "./InputBox.js";
import { PermissionDialog } from "./PermissionDialog.js";
import { StatusBar } from "./StatusBar.js";
import { ResumePicker } from "./ResumePicker.js";

export interface AppProps {
  cwd: string;
  providers: Record<string, ProviderConfig>;
  initialProvider: string;
  resume?: string;
  sessionIndex: SessionIndex;
  queryFn?: typeof query;
}

type Phase = "idle" | "streaming" | "permission";

const MODE_CYCLE: PermissionMode[] = ["default", "acceptEdits", "bypassPermissions"];

export function App(props: AppProps) {
  const { exit } = useApp();
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [providerName, setProviderName] = useState(props.initialProvider);
  const [model, setModel] = useState<string | undefined>(props.providers[props.initialProvider]?.model);
  const [mode, setMode] = useState<PermissionMode>("default");
  const [permissionQueue, setPermissionQueue] = useState<PermissionRequest[]>([]);
  const [showResumePicker, setShowResumePicker] = useState(false);
  const costRef = useRef(0);
  const firstMessageRef = useRef<string | undefined>(undefined);
  const sessionRef = useRef<AgentSession | null>(null);
  const lastCtrlCRef = useRef(0);
  const registry = useMemo(() => buildRegistry(), []);

  const notice = (text: string) => setItems(prev => [...prev, { kind: "notice", text }]);

  function handleMessage(msg: SDKMessage): void {
    const mapped = toDisplayItems(msg);
    if (mapped.length > 0) setItems(prev => [...prev, ...mapped]);
    const t = (msg as { type: string }).type;
    if (t === "result") {
      const cost = (msg as { total_cost_usd?: number }).total_cost_usd;
      if (typeof cost === "number") costRef.current += cost;
      setPhase("idle");
    }
  }

  function createSession(name: string, resume?: string): AgentSession {
    const session = new AgentSession({
      providerName: name,
      provider: props.providers[name],
      model: props.providers[name]?.model,
      permissionMode: mode,
      resume,
      cwd: props.cwd,
      onMessage: handleMessage,
      onPermissionRequest: req => {
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

  async function restartSession(name: string, resume?: string): Promise<void> {
    await sessionRef.current?.dispose();
    firstMessageRef.current = undefined;
    sessionRef.current = createSession(name, resume);
  }

  const ctx: CommandContext = {
    notice,
    clearSession: async () => { setItems([]); await restartSession(providerName); },
    setModel: async m => { await sessionRef.current?.setModel(m); setModel(m); },
    setPermissionMode: async m => {
      await sessionRef.current?.setPermissionMode(m as PermissionMode);
      setMode(m as PermissionMode);
    },
    switchProvider: async name => {
      if (!props.providers[name]) { notice(`Unknown provider: ${name}. Providers: ${Object.keys(props.providers).join(", ")}`); return; }
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
    costSummary: () => `Session cost: $${costRef.current.toFixed(4)}`,
    providerNames: () => Object.keys(props.providers),
    exit: () => { void sessionRef.current?.dispose(); exit(); }
  };

  function handleSubmit(text: string): void {
    const slash = parseSlash(text);
    if (slash) {
      const cmd = registry.get(slash.name);
      if (!cmd) { notice(`Unknown command: /${slash.name}`); return; }
      void cmd.run(ctx, slash.args);
      return;
    }
    if (!firstMessageRef.current) {
      firstMessageRef.current = text;
      if (sessionRef.current?.sessionId) recordSession(sessionRef.current.sessionId, providerName);
    }
    setItems(prev => [...prev, { kind: "user", text }]);
    setPhase("streaming");
    sessionRef.current?.send(text);
  }

  useInput((_input, key) => {
    if (key.escape && phase === "streaming") void sessionRef.current?.interrupt();
    if (key.tab && key.shift) {
      const next = MODE_CYCLE[(MODE_CYCLE.indexOf(mode) + 1) % MODE_CYCLE.length];
      void ctx.setPermissionMode(next);
    }
    if (key.ctrl && _input === "c") {
      const now = Date.now();
      if (now - lastCtrlCRef.current < 2000) ctx.exit();
      else { lastCtrlCRef.current = now; void sessionRef.current?.interrupt(); notice("Press Ctrl+C again to exit."); }
    }
  });

  const activePermission = permissionQueue[0];

  function decidePermission(allow: boolean): void {
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
        <InputBox registry={registry} onSubmit={handleSubmit} disabled={phase === "streaming"} />
      )}
      <StatusBar provider={providerName} model={model} mode={mode} cwd={props.cwd} />
    </Box>
  );
}
