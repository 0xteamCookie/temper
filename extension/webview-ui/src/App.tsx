import { lazy, Suspense, useEffect, useReducer, useRef } from 'react';
import { Chat } from './components/Chat';
import { Composer } from './components/Composer';
import { ConnectionBanner, SubHeader } from './components/Header';
import { History } from './components/History';
import { Review } from './components/Review';
import { SettingsHome, SettingsPageView, sectionTitle } from './components/Settings';
import { PriceProvider, SessionUsage } from './components/Usage';
import { Icon } from './components/ui';
import { initialState, isRunning, reducer } from './state';
import type { SettingsPage } from './state';
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

  // Dev harness only: the DevBar switches views (the real header actions live in VS Code's view title).
  useEffect(() => {
    if (isVsCode) return;
    const h = (e: Event) => {
      const d = (e as CustomEvent<{ view: string; page?: SettingsPage }>).detail;
      if (d.view === 'history') toHistoryRef.current();
      else if (d.view === 'settings') dispatch({ t: 'settingsPage', page: d.page ?? null });
      else dispatch({ t: 'view', view: 'conversation' });
    };
    window.addEventListener('temper-dev-view', h);
    return () => window.removeEventListener('temper-dev-view', h);
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
  const toSettings = (page: SettingsPage | null = null) => {
    dispatch({ t: 'settingsPage', page });
    postToHost({ type: 'settings.refresh' });
  };
  const requestHistory = (pageToken?: string) => {
    dispatch({ t: 'historyLoading' });
    postToHost({ type: 'history.list', pageToken });
  };
  const toHistory = () => {
    dispatch({ t: 'view', view: 'history' });
    requestHistory();
  };
  const newChat = () => {
    // While a run is active the host refuses and says why; the chat stays as it is.
    if (!running) dispatch({ t: 'newChat' });
    postToHost({ type: 'session.new' });
  };
  // Native view-title commands arrive as `nav` messages (handlers kept fresh through a ref).
  const toHistoryRef = useRef(toHistory);
  const navRef = useRef({ newChat, toHistory, toSettings });
  toHistoryRef.current = toHistory;
  navRef.current = { newChat, toHistory, toSettings };
  useEffect(
    () =>
      onHostMessage((m) => {
        if (m.type !== 'nav') return;
        if (m.to === 'newChat') {
          dispatch({ t: 'view', view: 'conversation' });
          navRef.current.newChat();
        } else if (m.to === 'history') navRef.current.toHistory();
        else navRef.current.toSettings();
      }),
    [],
  );

  const hunks = state.review?.changes.reduce((n, c) => n + c.hunks.length, 0) ?? 0;
  const files = state.review?.changes.length ?? 0;

  return (
    <PriceProvider models={state.models}>
    <div className="app">
      {!(view === 'settings' && state.settingsPage === 'connection') && <ConnectionBanner state={state} />}
      {view === 'review' && <SubHeader backLabel="Conversation" title="Review" onBack={toConversation} />}
      {view === 'history' && <SubHeader backLabel="Conversation" title="History" onBack={toConversation} />}
      {view === 'settings' &&
        (state.settingsPage ? (
          <SubHeader backLabel="Settings" title={sectionTitle(state.settingsPage)} onBack={() => dispatch({ t: 'settingsPage', page: null })} />
        ) : (
          <SubHeader backLabel="Conversation" title="Settings" onBack={toConversation} />
        ))}

      <div className="scroll" hidden={view !== 'conversation'}>
        {state.notice && (
          <div className="callout callout-warn session-notice" role="status">
            <Icon name="warning" />
            <span>{state.notice}</span>
          </div>
        )}
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

      {view === 'history' && (
        <div className="scroll">
          <History
            history={state.history}
            sessionId={state.sessionId}
            running={running}
            onMore={() => requestHistory(state.history.next)}
          />
        </div>
      )}

      {view === 'settings' && (
        <div className="scroll">
          {state.settingsPage ? (
            <SettingsPageView
              page={state.settingsPage}
              state={state}
              onChain={(chain) => dispatch({ t: 'localChain', chain })}
              onPick={(mode, name) => dispatch({ t: 'localPick', mode, name })}
            />
          ) : (
            <SettingsHome state={state} onOpen={(p) => dispatch({ t: 'settingsPage', page: p })} />
          )}
        </div>
      )}

      <div hidden={view !== 'conversation'}>
        <SessionUsage items={state.items} />
        <Composer
          running={running}
          reviewPending={!!state.review}
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
          onManageModels={() => toSettings('fallback')}
        />
      </div>

      {!isVsCode && (
        <Suspense fallback={null}>
          <DevBar />
        </Suspense>
      )}
    </div>
    </PriceProvider>
  );
}
