<script lang="ts">
  /**
   * What a file drag looks like.
   *
   * Tauri owns drag events at the window level (see `installFileDrop`), so no pane can
   * paint its own hover state — nothing in the DOM ever hears about the drag. That is
   * why dropping a file used to look like it did nothing at all: it very often DID
   * work, and the only evidence was a path in a terminal the user was not looking at.
   *
   * So this lives at the window level too: a ring while files are overhead saying
   * which agent they will land on, and a short-lived toast afterwards saying what
   * happened. Both are pointer-events: none — a drag must never be blocked by the
   * thing drawn to describe it.
   */
  import { drag, landing } from "$lib/terminal/attachments.svelte";
  import { app } from "$lib/store/app.svelte";
  import Icon from "./Icon.svelte";

  const target = $derived(drag.agentId ? app.agents.find((a) => a.id === drag.agentId) : undefined);
</script>

{#if drag.over}
  <div class="veil" class:aimed={!!target}>
    <div class="badge">
      <Icon name="paperclip" size={16} />
      {#if target}
        <span>Drop to attach to <strong>{target.name}</strong></span>
      {:else}
        <span>Open an agent to attach files</span>
      {/if}
    </div>
  </div>
{/if}

{#if landing.text}
  <div class="toast" data-tone={landing.tone}>
    <Icon name={landing.tone === "warn" ? "alert" : "paperclip"} size={14} />
    <span>{landing.text}</span>
  </div>
{/if}

<style>
  .veil {
    position: fixed;
    inset: 0;
    z-index: 900;
    pointer-events: none;
    display: flex;
    align-items: center;
    justify-content: center;
    /* An inset ring rather than a wash: the agent's output stays readable underneath,
       which matters because you aim the drop by looking at it. */
    box-shadow: inset 0 0 0 2px var(--border-strong);
    background: color-mix(in oklab, var(--bg) 22%, transparent);
    /* Follows the window's own rounded corners. A square ring drawn to `inset: 0`
       runs straight across them, so the highlight reads as a rectangle sitting on
       the app rather than as the app's own edge lighting up. */
    border-radius: 10px;
  }
  .veil.aimed {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .badge {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border: 1px solid var(--border-strong);
    border-radius: 10px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 13px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  }
  .veil.aimed .badge {
    border-color: var(--accent);
  }
  .badge strong {
    font-weight: 600;
  }

  .toast {
    position: fixed;
    bottom: 18px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 901;
    pointer-events: none;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 8px 13px;
    border: 1px solid var(--border-strong);
    border-radius: 9px;
    background: var(--surface-2);
    color: var(--text);
    font-size: 12.5px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    animation: toast-in 0.16s ease-out;
  }
  .toast[data-tone="ok"] {
    border-color: var(--accent);
  }
  .toast[data-tone="wait"],
  .toast[data-tone="warn"] {
    border-color: var(--warn, var(--border-strong));
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
  }
</style>
