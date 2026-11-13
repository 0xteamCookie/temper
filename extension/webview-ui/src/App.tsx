import { lazy, Suspense, useEffect, useReducer } from 'react';
import { Chat } from './components/Chat';
import { Composer } from './components/Composer';
import { Header } from './components/Header';
import { Ledger } from './components/Ledger';
import { Models } from './components/Models';
import { Review } from './components/Review';
import { Section } from './components/ui';
import { initialState, isRunning, reducer } from './state';
import { isVsCode, onHostMessage, postToHost } from './vscode';

const DevBar = lazy(() => import('./components/DevBar').then((m) => ({ default: m.DevBar })));

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const running = isRunning(state);

  useEffect(() => {
    const off = onHostMessage((m) => dispatch({ t: 'host', m }));
    postToHost({ type: 'ready' });
    return off;
  }, []);

  // Dev harness only: lets the scripted demo inject a user message.
  useEffect(() => {
    if (isVsCode) return;
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      dispatch({ t: 'userSend', text: d.text, mentions: d.mentions });
    };
    window.addEventListener('temper-dev-user', h);
    return () => window.removeEventListener('temper-dev-user', h);
  }, []);

  // Esc stops the run (the composer swallows Esc when it closes its mention list).
  useEffect(() => {
    if (!running) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) postToHost({ type: 'run.cancel' });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [running]);

  const openModels = () => {
    dispatch({ t: 'toggle', id: 'models', open: true });
    requestAnimationFrame(() => document.getElementById('sec-models')?.scrollIntoView({ block: 'start' }));
  };
  const toggle = (id: string) => () => dispatch({ t: 'toggle', id });

  return (
    <div className="app">
      <Header state={state} onOpenModels={openModels} />
      <div className="scroll">
        {state.toast && (
          <div className="toast" role="status">
            <span>
              Applied {state.toast.applied} hunk{state.toast.applied === 1 ? '' : 's'}
              {state.toast.rejected ? ` · ${state.toast.rejected} rejected` : ''}
            </span>
            {state.canUndo && (
              <>
                {' · '}
                <button className="link" onClick={() => postToHost({ type: 'undo.last' })}>
                  Undo
                </button>
              </>
            )}
            <button className="icon-btn" aria-label="Dismiss" onClick={() => dispatch({ t: 'dismissToast' })}>
              ✕
            </button>
          </div>
        )}
        <Chat items={state.items} />
        {state.canUndo && !state.toast && (
          <div className="undo-bar">
            <button className="btn btn-sm" onClick={() => postToHost({ type: 'undo.last' })}>
              Undo last{state.undoLabel ? `: ${state.undoLabel}` : ''}
            </button>
          </div>
        )}
        {state.review && (
          <Section id="review" title="Review" open={state.open.review !== false} onToggle={toggle('review')}
            badge={state.review.changes.reduce((n, c) => n + c.hunks.length, 0)}>
            <Review
              changes={state.review.changes}
              onDecide={(ids, decision) => dispatch({ t: 'decide', hunkIds: ids, decision })}
              onDecideAll={(decision) => dispatch({ t: 'decideAll', decision })}
            />
          </Section>
        )}
        {state.ledger && (
          <Section id="ledger" title="Context Ledger" open={!!state.open.ledger} onToggle={toggle('ledger')}
            badge={`${state.ledger.entries.filter((e) => e.included && !e.evicted).length}`}>
            <Ledger snapshot={state.ledger} onBudget={(tokens) => dispatch({ t: 'localBudget', tokens })} />
          </Section>
        )}
        <Section id="models" title="Models" open={!!state.open.models} onToggle={toggle('models')}>
          <Models
            models={state.models}
            chain={state.chain}
            agentModel={state.agentModel}
            inlineModel={state.inlineModel}
            onChain={(chain) => dispatch({ t: 'localChain', chain })}
            onPick={(mode, name) => dispatch({ t: 'localPick', mode, name })}
          />
        </Section>
      </div>
      <Composer
        running={running}
        suggestions={state.suggestions}
        onSend={(text, mentions) => {
          dispatch({ t: 'userSend', text, mentions });
          postToHost({ type: 'chat.send', text, mentions });
        }}
        onClearSuggestions={() => dispatch({ t: 'clearSuggestions' })}
      />
      {!isVsCode && (
        <Suspense fallback={null}>
          <DevBar />
        </Suspense>
      )}
    </div>
  );
}
