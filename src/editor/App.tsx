import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { ServicesContext, type AppServices } from './context.ts';
import { installShortcuts } from './shortcuts.ts';
import { useObservable } from './state/observable.ts';
import { CanvasView } from './ui/CanvasView.tsx';
import { HelpDialog, ProjectsDialog } from './ui/Dialogs.tsx';
import { Inspector } from './ui/Inspector.tsx';
import { CircuitList, Palette } from './ui/Sidebar.tsx';
import { ProblemsPanel, StatusBar } from './ui/StatusBar.tsx';
import { Toolbar } from './ui/Toolbar.tsx';
import type { CanvasController } from './canvas/controller.ts';

export function App({ services, setController }: { services: AppServices; setController: (c: CanvasController | null) => void }): ReactElement {
  const dialog = useObservable(services.view.dialog);
  const [problemsOpen, setProblemsOpen] = useState(false);
  const closeDialog = useCallback(() => services.view.dialog.set(null), [services]);

  useEffect(() => installShortcuts(services), [services]);

  return (
    <ServicesContext.Provider value={services}>
      <div className="app">
        <Toolbar />
        <aside className="left">
          <CircuitList />
          <Palette />
        </aside>
        <CanvasView onController={setController} />
        <aside className="right">
          <Inspector />
          {problemsOpen && <ProblemsPanel onClose={() => setProblemsOpen(false)} />}
        </aside>
        <StatusBar problemsOpen={problemsOpen} onToggleProblems={() => setProblemsOpen((o) => !o)} />
      </div>
      {dialog === 'projects' && <ProjectsDialog onClose={closeDialog} />}
      {dialog === 'help' && <HelpDialog onClose={closeDialog} />}
    </ServicesContext.Provider>
  );
}
