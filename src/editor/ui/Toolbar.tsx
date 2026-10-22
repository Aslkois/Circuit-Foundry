import { useState, type ReactElement, type ReactNode } from 'react';
import { useObservable } from '../state/observable.ts';
import { TICK_RATES } from '../sim/SimulationHost.ts';
import { selectionSize } from '../state/store.ts';
import { useEditor, useServices, useSimStatus } from '../context.ts';
import { Icon } from './icons.tsx';

function ToolButton({
  icon,
  label,
  shortcut,
  onClick,
  disabled,
  active,
  children,
  testId,
}: {
  icon: string;
  label: string;
  shortcut?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children?: ReactNode;
  testId?: string;
}): ReactElement {
  return (
    <button
      className={`tool-button${active ? ' active' : ''}`}
      onClick={onClick}
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-pressed={active}
      data-testid={testId}
    >
      <Icon name={icon} />
      {children}
    </button>
  );
}

function SaveIndicator(): ReactElement {
  const { repo } = useServices();
  const status = useEditor((s) => s.saveStatus);
  const error = useEditor((s) => s.saveError);
  if (!repo.persistent) {
    return (
      <span className="save-indicator error" title="This browser is not allowing local storage. Use Export to keep your work.">
        Not stored — export to keep
      </span>
    );
  }
  const text = status === 'saved' ? 'Saved locally' : status === 'error' ? 'Save failed' : 'Saving…';
  return (
    <span className={`save-indicator ${status}`} title={error ?? 'Changes are saved in this browser automatically.'} data-testid="save-status">
      {text}
    </span>
  );
}

function ProjectName(): ReactElement {
  const { store } = useServices();
  const name = useEditor((s) => s.project.name);
  const [editing, setEditing] = useState(false);
  if (editing) {
    return (
      <input
        className="project-name-input"
        autoFocus
        defaultValue={name}
        aria-label="Project name"
        onBlur={(e) => {
          const v = e.target.value.trim();
          const project = store.getState().project;
          if (v && v !== project.name) store.commit({ ...project, name: v });
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') setEditing(false);
        }}
      />
    );
  }
  return (
    <button className="project-name" onClick={() => setEditing(true)} title="Rename project">
      {name}
    </button>
  );
}

export function Toolbar(): ReactElement {
  const { store, host, controller, actions, view } = useServices();
  const canUndo = useEditor((s) => s.canUndo);
  const canRedo = useEditor((s) => s.canRedo);
  const tool = useEditor((s) => s.tool.kind);
  const hasSelection = useEditor((s) => selectionSize(s.selection) > 0);
  const sim = useSimStatus();
  const zoom = useObservable(view.zoom);

  return (
    <header className="toolbar" role="toolbar" aria-label="Main toolbar">
      <div className="brand">
        <span className="logo" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24">
            <path d="M4 7h7a5 5 0 010 10H4z" fill="none" stroke="#4ade80" strokeWidth="2" />
            <path d="M16 12h5M1 10h3M1 14h3" stroke="#4ade80" strokeWidth="2" />
          </svg>
        </span>
        <span className="brand-name">Circuit Foundry</span>
        <ProjectName />
        <SaveIndicator />
      </div>

      <div className="tool-group" aria-label="Project">
        <ToolButton icon="folder" label="Projects and examples" shortcut="Ctrl+O" onClick={actions.openProjects} testId="projects-button">
          <span className="tool-text">Projects</span>
        </ToolButton>
        <ToolButton icon="download" label="Export project file" shortcut="Ctrl+Shift+E" onClick={actions.exportProject} />
        <ToolButton icon="upload" label="Import project file" shortcut="Ctrl+Shift+I" onClick={actions.importProject} />
      </div>

      <div className="tool-group" aria-label="Edit">
        <ToolButton icon="undo" label="Undo" shortcut="Ctrl+Z" onClick={() => store.undo()} disabled={!canUndo} />
        <ToolButton icon="redo" label="Redo" shortcut="Ctrl+Shift+Z" onClick={() => store.redo()} disabled={!canRedo} />
        <ToolButton icon="rotate" label="Rotate" shortcut="R" onClick={() => controller()?.rotate(true)} disabled={!hasSelection && tool !== 'place'} />
        <ToolButton icon="trash" label="Delete" shortcut="Del" onClick={() => controller()?.deleteSelection()} disabled={!hasSelection} />
      </div>

      <div className="tool-group" aria-label="Tools">
        <ToolButton icon="select" label="Select and move" shortcut="V" onClick={() => store.setTool({ kind: 'select' })} active={tool === 'select'} />
        <ToolButton icon="wire" label="Draw wires" shortcut="W" onClick={() => store.setTool({ kind: 'wire' })} active={tool === 'wire'} testId="wire-tool" />
      </div>

      <div className="tool-group sim-group" aria-label="Simulation">
        <ToolButton
          icon={sim.running ? 'pause' : 'play'}
          label={sim.running ? 'Pause clocks' : 'Run clocks'}
          shortcut="P"
          onClick={() => host.setRunning(!sim.running)}
          disabled={!sim.hasClocks || !sim.autoPropagate || sim.state === 'oscillating'}
          active={sim.running}
          testId="run-button"
        >
          <span className="tool-text">{sim.running ? 'Pause' : 'Run'}</span>
        </ToolButton>
        <ToolButton icon="tick" label="Advance clocks one tick" shortcut="T" onClick={() => host.tickOnce()} disabled={sim.running} testId="tick-button" />
        <ToolButton icon="step" label="Step one gate delay" shortcut="." onClick={() => host.step()} disabled={sim.autoPropagate || sim.pendingEvents === 0} />
        <ToolButton icon="reset" label="Reset simulation (all state and inputs)" onClick={() => host.reset()} />
        <label className="toggle" title="Propagate changes immediately. Turn off to step through gate delays one at a time.">
          <input type="checkbox" checked={sim.autoPropagate} onChange={(e) => host.setAutoPropagate(e.target.checked)} />
          <span>Auto-propagate</span>
        </label>
        <label className="rate" title="Clock ticks per second while running">
          <select value={sim.tickRate} onChange={(e) => host.setTickRate(Number(e.target.value))} aria-label="Tick rate">
            {TICK_RATES.map((r) => (
              <option key={r} value={r}>
                {r >= 1024 ? `${r / 1024}k` : r} Hz
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="tool-group" aria-label="View">
        <ToolButton icon="zoomOut" label="Zoom out" shortcut="-" onClick={() => controller()?.zoomBy(1 / 1.25)} />
        <button className="zoom-label" onClick={() => controller()?.setZoom(1)} title="Reset zoom to 100%">
          {Math.round(zoom * 100)}%
        </button>
        <ToolButton icon="zoomIn" label="Zoom in" shortcut="+" onClick={() => controller()?.zoomBy(1.25)} />
        <ToolButton icon="fit" label="Fit circuit in view" shortcut="F" onClick={() => controller()?.fitToContent()} />
      </div>

      <div className="tool-group end">
        <ToolButton icon="help" label="Help and keyboard shortcuts" shortcut="?" onClick={actions.openHelp} />
      </div>
    </header>
  );
}
