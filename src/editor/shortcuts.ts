import type { AppServices } from './context.ts';

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/** Global keyboard shortcuts. Returns a function that removes them. */
export function installShortcuts(s: AppServices): () => void {
  const onKeyDown = (e: KeyboardEvent) => {
    if (isEditable(e.target) || s.view.dialog.get() !== null) return;
    const c = s.controller();
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    let handled = true;

    if (mod) {
      switch (lower) {
        case 'z':
          if (e.shiftKey) s.store.redo();
          else s.store.undo();
          break;
        case 'y':
          s.store.redo();
          break;
        case 'c':
          c?.copy();
          break;
        case 'x':
          c?.cut();
          break;
        case 'v':
          c?.paste();
          break;
        case 'd':
          c?.duplicate();
          break;
        case 'a':
          c?.selectAll();
          break;
        case 'g':
          s.actions.createComponent();
          break;
        case 's':
          if (e.shiftKey) s.actions.exportProject();
          else s.actions.saveNow();
          break;
        case 'o':
          s.actions.openProjects();
          break;
        case '0':
          c?.setZoom(1);
          break;
        default:
          handled = false;
      }
    } else if (e.altKey) {
      handled = false;
    } else {
      switch (lower) {
        case 'Delete':
        case 'Backspace':
          c?.deleteSelection();
          break;
        case 'Escape': {
          const state = s.store.getState();
          if (c?.cancel()) break;
          if (state.tool.kind !== 'select') s.store.setTool({ kind: 'select' });
          else if (state.selection.components.size + state.selection.wires.size > 0) s.store.setSelection({ components: new Set(), wires: new Set() });
          else if (state.path.length > 0) s.store.exitTo(state.path.length - 1);
          break;
        }
        case 'r':
          c?.rotate(!e.shiftKey);
          break;
        case 'v':
          s.store.setTool({ kind: 'select' });
          break;
        case 'w':
          s.store.setTool({ kind: 'wire' });
          break;
        case 'f':
          c?.fitToContent();
          break;
        case '+':
        case '=':
          c?.zoomBy(1.25);
          break;
        case '-':
        case '_':
          c?.zoomBy(1 / 1.25);
          break;
        case 'ArrowLeft':
          c?.nudge(e.shiftKey ? -5 : -1, 0);
          break;
        case 'ArrowRight':
          c?.nudge(e.shiftKey ? 5 : 1, 0);
          break;
        case 'ArrowUp':
          c?.nudge(0, e.shiftKey ? -5 : -1);
          break;
        case 'ArrowDown':
          c?.nudge(0, e.shiftKey ? 5 : 1);
          break;
        case 'p':
          s.host.setRunning(!s.host.getStatus().running);
          break;
        case 't':
          if (!s.host.getStatus().running) s.host.tickOnce();
          break;
        case '.':
          s.host.step();
          break;
        case '?':
          s.actions.openHelp();
          break;
        case ' ':
          c?.setSpaceHeld(true);
          break;
        default:
          handled = false;
      }
    }
    if (handled) e.preventDefault();
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === ' ') s.controller()?.setSpaceHeld(false);
  };
  const onBlur = () => s.controller()?.setSpaceHeld(false);
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
