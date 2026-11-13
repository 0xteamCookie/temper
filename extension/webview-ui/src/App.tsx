import { lazy, Suspense, useEffect, useReducer } from 'react';
import { Chat } from './components/Chat';
import { Composer } from './components/Composer';
import { Header, SubHeader } from './components/Header';
import { Models } from './components/Models';
import { Review } from './components/Review';
import { Icon } from './components/ui';
import { initialState, isRunning, reducer } from './state';
import { isVsCode, onHostMessage, postToHost } from './vscode';

const DevBar = lazy(() => import('./components/DevBar').then((m) => ({ default: m.DevBar })));

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const running = isRunning(state);
  const { view } = state;

  useEffect(() => {
    const off = onHostMessage((m) => dispatch({ t: 'host', m }));
    postToHost({ type: 'ready' });
    return off;
  }, []);

  // Dev harness only: lets the scripted demo inject a user message / reset.
  useEffect(() => {
    if (isVsCode) return;
    const h = (e: Event) => {
      const d = (e as CustomEvent).detail;
      dispatch({ t: 'userSend', text: d.text, mentions: d.mentions, mode: d.mode, selection: d.selection });
    };
    const r = () => dispatch({ t: 'reset' });
    window.addEventListener('temper-dev-user', h);
    window.addEventListener('temper-dev-reset', r);
    return () => {
      window.removeEventListener('temper-dev-user', h);
      window.removeEventListener('temper-dev-reset', r);
    };
  }, []);

  // Esc stops the run (popovers and the composer swallow Esc when they close).
  useEffect(() => {
    if (!running) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) postToHost({ type: 'run.cancel' });
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [running]);

  const toConversation = () => dispatch({ t: 'view', view: 'conversation' });
  const toReview = () => dispatch({ t: 'view', view: 'review' });
  const toModels = () => dispatch({ t: 'view', view: 'models' });

  const hunks = state.review?.changes.reduce((n, c) => n + c.hunks.length, 0) ?? 0;
  const files = state.review?.changes.length ?? 0;

  return (
    <div className="app">
      <Header state={state} onToggleModels={() => (view === 'models' ? toConversation() : toModels())} />
      {view !== 'conversation' && <SubHeader view={view} onBack={toConversation} />}

      <div className="scroll" hidden={view !== 'conversation'}>
        {state.review && (
          <div className="pending-bar" role="status">
            <Icon name="diff" />
            <span className="grow">
              {hunks} hunk{hunks === 1 ? '' : 's'} in {files} file{files === 1 ? '' : 's'} waiting for review
            </span>
            <button type="button" className="btn btn-sm btn-primary" onClick={toReview}>
              Review
            </button>
          </div>
        )}
        <Chat
          items={state.items}
          ledger={state.ledger}
          onBudget={(tokens) => dispatch({ t: 'localBudget', tokens })}
          onExample={(text) => dispatch({ t: 'fill', text })}
          hasReview={!!state.review}
          onOpenReview={toReview}
          canUndo={state.canUndo}
        />
      </div>

      {state.review && (
        <div className="scroll" hidden={view !== 'review'}>
          <Review
            changes={state.review.changes}
            active={view === 'review'}
            onDecide={(ids, decision) => dispatch({ t: 'decide', hunkIds: ids, decision })}
            onDecideAll={(decision) => dispatch({ t: 'decideAll', decision })}
          />
        </div>
      )}

      {view === 'models' && (
        <div className="scroll">
          <Models
            models={state.models}
            chain={state.chain}
            agentModel={state.agentModel}
            inlineModel={state.inlineModel}
            connected={state.connection.trueforge !== 'disconnected'}
            detail={state.connection.detail}
            providers={state.providers}
            onChain={(chain) => dispatch({ t: 'localChain', chain })}
            onPick={(mode, name) => dispatch({ t: 'localPick', mode, name })}
          />
        </div>
      )}

      <div hidden={view !== 'conversation'}>
        <Composer
          running={running}
          suggestions={state.suggestions}
          selection={state.selection}
          focus={state.focus}
          models={state.models}
          agentModel={state.agentModel}
          inlineModel={state.inlineModel}
          onSend={(text, mentions, mode, selection) => {
            dispatch({ t: 'userSend', text, mentions, mode, selection });
            postToHost({ type: 'chat.send', text, mentions, mode, selection });
          }}
          onClearSuggestions={() => dispatch({ t: 'clearSuggestions' })}
          onPickModel={(mode, name) => dispatch({ t: 'localPick', mode, name })}
          onManageModels={toModels}
        />
      </div>

      {!isVsCode && (
        <Suspense fallback={null}>
          <DevBar />
        </Suspense>
      )}
    </div>
  );
}
