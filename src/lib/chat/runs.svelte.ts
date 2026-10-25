/**
 * Script and runner executions started from the Chat view's Run rail.
 *
 * Each run is a PTY of its own (so Gradle gets a real terminal and the output keeps its
 * colours), shown in an output tab beside the Agent tab. The shell is told to exit when
 * the command ends, which is how the run's exit code arrives: the same `session-exited`
 * event the agent panes use. When a run finishes, the last screen rows are read out of
 * its terminal and handed to the chat session as a message, per the "Send run results"
 * setting.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { createTerminal, type TerminalHandle } from "$lib/terminal/createTerminal";
// (hosts: see attach)
import { app } from "$lib/store/app.svelte";
import { chatFor, setRunsCloser, type ChatSession, type RunItem } from "./session.svelte";

export interface RunTab {
  id: string;
  agentId: string;
  name: string;
  /** "dev" | "prod" | "local" — what the launch dialog chose. */
  target: string;
  command: string;
  cwd: string;
  env: Record<string, string>;
  status: "starting" | "running" | "done" | "error";
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
  /** Text of the last screen rows, captured at exit (what is sent to the session). */
  tail: string;
  /** Whether the result reached the session. */
  sent: boolean;
}

let seq = 0;
const handles = new Map<string, TerminalHandle>();
/** The element each run's terminal is mounted in; re-parented into whatever pane shows it. */
const hosts = new Map<string, HTMLElement>();
let listening = false;

class RunStore {
  tabs = $state<RunTab[]>([]);

  tabsFor(agentId: string): RunTab[] {
    return this.tabs.filter((t) => t.agentId === agentId);
  }

  runningCount(agentId: string): number {
    return this.tabsFor(agentId).filter((t) => t.status === "running" || t.status === "starting").length;
  }

  start(agentId: string, run: { name: string; target: string; command: string; cwd: string; env?: Record<string, string> }): RunTab {
    ensureListener();
    const tab: RunTab = {
      id: `run-${agentId}-${Date.now().toString(36)}-${(seq++).toString(36)}`,
      agentId,
      name: run.name,
      target: run.target,
      command: run.command,
      cwd: run.cwd,
      env: run.env ?? {},
      status: "starting",
      exitCode: null,
      startedAt: Date.now(),
      endedAt: null,
      tail: "",
      sent: false,
    };
    this.tabs.push(tab);
    return tab;
  }

  /**
   * Show the run's terminal inside `container`. The terminal is created once, in an
   * element this store owns; a pane that re-renders just re-appends that element.
   */
  async attach(tabId: string, container: HTMLElement): Promise<void> {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return;
    let host = hosts.get(tabId);
    if (host) {
      if (host.parentElement !== container) container.appendChild(host);
      requestAnimationFrame(() => handles.get(tabId)?.fit());
      return;
    }
    // A run that already ended without a terminal of its own (the PTY failed to start)
    // has nothing to show and must never be executed again by a remount.
    if (tab.endedAt) return;
    host = document.createElement("div");
    host.style.position = "absolute";
    host.style.inset = "0";
    hosts.set(tabId, host);
    container.appendChild(host);
    try {
      const handle = await createTerminal(host, tab.id, {
        cwd: tab.cwd,
        env: { ...tab.env, CODESU_RUN: "1" },
        // Exit the shell when the command ends (with its status: a bare `exit` does
        // that in bash, zsh and fish alike) so the run's end is observable.
        run: `${tab.command}; exit`,
      });
      if (!hosts.has(tabId)) {
        // The tab was closed while the terminal was being created.
        handle.dispose();
        return;
      }
      handles.set(tabId, handle);
      if (tab.endedAt) {
        // It finished before we got the handle back: keep the recorded end, grab the tail.
        if (!tab.tail) tab.tail = handle.screen(40);
        return;
      }
      tab.status = "running";
      requestAnimationFrame(() => handle.fit());
    } catch (e) {
      host.remove();
      hosts.delete(tabId);
      tab.status = "error";
      tab.endedAt = Date.now();
      tab.tail = String(e);
      finish(tab);
    }
  }

  fit(tabId: string): void {
    handles.get(tabId)?.fit();
  }

  /** Ctrl-C to the run's shell. */
  stop(tabId: string): void {
    if (!handles.has(tabId)) return;
    void invoke("write_pty", { id: tabId, data: "\u0003" }).catch(() => {});
  }

  close(tabId: string): void {
    const h = handles.get(tabId);
    h?.dispose();
    handles.delete(tabId);
    hosts.get(tabId)?.remove();
    hosts.delete(tabId);
    this.tabs = this.tabs.filter((t) => t.id !== tabId);
  }

  /** Hand a finished run to the session (the "Send to session" button when the setting is Ask). */
  send(tabId: string): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || tab.sent) return;
    deliver(tab);
  }

  /** The same, from the run's card in the transcript: works after its tab was closed too. */
  sendItem(session: ChatSession, item: RunItem): void {
    if (item.sent) return;
    session.sendRunResult(item);
    const tab = this.tabs.find((t) => t.id === item.tabId);
    if (tab) tab.sent = true;
  }

  onExit(tabId: string, code: number | null): void {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab || tab.endedAt) return;
    tab.exitCode = code;
    tab.status = code === 0 ? "done" : "error";
    tab.endedAt = Date.now();
    tab.tail = handles.get(tabId)?.screen(40) ?? "";
    finish(tab);
  }
}

function finish(tab: RunTab): void {
  const session = chatFor(tab.agentId);
  const item = session.addRun({
    name: tab.name,
    target: tab.target,
    exitCode: tab.exitCode,
    durationMs: (tab.endedAt ?? Date.now()) - tab.startedAt,
    tail: tab.tail,
    tabId: tab.id,
  });
  // Only a running session gets the result pushed; a stopped one must not be respawned
  // by a finishing run. The "Send to session" button stays for later.
  if (app.chatRunResults === "always" && session.running) {
    session.sendRunResult(item);
    tab.sent = true;
  }
}

function deliver(tab: RunTab): void {
  const session = chatFor(tab.agentId);
  const item = session.items.find((i) => i.kind === "run" && i.tabId === tab.id);
  if (item && item.kind === "run") session.sendRunResult(item);
  tab.sent = true;
}

function ensureListener(): void {
  if (listening) return;
  listening = true;
  void listen<{ id: string; code: number | null }>("session-exited", (e) => {
    if (e.payload.id.startsWith("run-")) runs.onExit(e.payload.id, e.payload.code);
  });
}

export const runs = new RunStore();
setRunsCloser((agentId) => {
  for (const t of runs.tabsFor(agentId)) runs.close(t.id);
});
