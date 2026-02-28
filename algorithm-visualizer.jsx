// ============================================================
// ALGORITHM VISUALIZER — PHASE 1: ARCHITECTURE & CORE ENGINE
// ============================================================
// 
// ARCHITECTURAL DECISIONS:
//
// 1. TYPE SYSTEM (types/algorithm.ts analogue)
//    AlgorithmStep uses a discriminated union via `type` field.
//    This allows exhaustive type-checking when renderers consume steps.
//    ExecutionTrace is a pure data structure — no methods, no side effects.
//    Separation from engine prevents circular dependencies.
//
// 2. PLAYBACK ENGINE (engine/playbackEngine.ts analogue)
//    Built as a useReducer state machine. Why useReducer over useState?
//    - All state transitions are pure functions: (state, action) => state
//    - Impossible states are impossible by construction (no isPlaying+noTrace)
//    - Easy to serialize/snapshot state for debugging
//    - Speed changes are O(1) mutations to a ref — no restarts needed
//    Speed is stored in a ref (not state) so interval ticks pick up
//    the latest value without needing to restart the interval loop.
//    A single setInterval drives playback; it reads speed from the ref
//    on each tick, enabling seamless mid-playback speed changes.
//
// 3. CONTEXT (context/PlaybackContext)
//    Engine state is distributed via React Context to avoid prop drilling.
//    Components only subscribe to what they need (future: split contexts).
//
// 4. LAYOUT SHELL (components/layout/)
//    Three-panel layout: Navbar / Sidebar / Main.
//    Components are purely presentational — zero engine knowledge.
//    Controls bridge engine ↔ UI via context hooks only.
//
// 5. MOCK TRACE (algorithms/mockTrace.ts analogue)
//    Fake trace exercises all step types defined in the type system.
//    This validates the engine without needing real algorithm logic.
// ============================================================

import { useReducer, useEffect, useRef, useCallback, createContext, useContext, useState } from "react";

// ============================================================
// SECTION 1: TYPES  (src/types/algorithm.ts)
// ============================================================

// AlgorithmStepType is a union of all possible step semantics.
// Adding a new algorithm operation means adding here first — forces
// all consumers to handle it (exhaustive switch) — prevents silent bugs.

// AlgorithmStep.payload is Record<string,any> intentionally:
// each step type will narrow this in Phase 2 via discriminated unions.
// For Phase 1 we keep it open to stay flexible before renderers exist.

// ExecutionMetadata is decoupled from steps — renderers can display
// complexity info without parsing the trace itself.


// ============================================================
// SECTION 2: MOCK TRACE  (src/algorithms/mockTrace.ts)
// ============================================================

const MOCK_TRACE = {
  steps: [
    { id: 0, type: "visit",   payload: { node: 1, label: "Start node" } },
    { id: 1, type: "compare", payload: { a: 1, b: 2, label: "Compare neighbors" } },
    { id: 2, type: "visit",   payload: { node: 2, label: "Move to node 2" } },
    { id: 3, type: "frontier",payload: { nodes: [3, 4], label: "Add to frontier" } },
    { id: 4, type: "compare", payload: { a: 2, b: 3, label: "Evaluate cost" } },
    { id: 5, type: "visit",   payload: { node: 3, label: "Visit node 3" } },
    { id: 6, type: "pivot",   payload: { node: 3, label: "Set as pivot" } },
    { id: 7, type: "swap",    payload: { i: 0, j: 3, label: "Swap elements" } },
    { id: 8, type: "visit",   payload: { node: 4, label: "Visit node 4" } },
    { id: 9, type: "path",    payload: { nodes: [1,2,3,4], label: "Final path found" } },
  ],
  metadata: {
    timeComplexity: "O(V + E)",
    spaceComplexity: "O(V)",
    notes: "Mock BFS-style trace for engine validation. No real algorithm runs here.",
  },
};


// ============================================================
// SECTION 3: PLAYBACK ENGINE  (src/engine/playbackEngine.ts)
// ============================================================

// State machine actions — exhaustive set for Phase 1
const PlaybackActions = {
  PLAY:       "PLAY",
  PAUSE:      "PAUSE",
  STEP_FWD:   "STEP_FWD",
  STEP_BACK:  "STEP_BACK",
  RESET:      "RESET",
  JUMP:       "JUMP",
  TICK:       "TICK",        // internal: fired by interval
  SET_TRACE:  "SET_TRACE",
};

const initialPlaybackState = {
  trace: null,
  currentStepIndex: 0,
  isPlaying: false,
  // speed is NOT in state — it lives in a ref to avoid interval restarts.
  // State here represents "what is true about the playback position",
  // not "how fast we're going" (orthogonal concern).
};

// Pure reducer — all transitions here, zero side effects.
// This makes the engine testable without React.
function playbackReducer(state, action) {
  const totalSteps = state.trace ? state.trace.steps.length : 0;

  switch (action.type) {
    case PlaybackActions.SET_TRACE:
      return { ...initialPlaybackState, trace: action.payload };

    case PlaybackActions.PLAY:
      if (!state.trace || state.currentStepIndex >= totalSteps - 1) return state;
      return { ...state, isPlaying: true };

    case PlaybackActions.PAUSE:
      return { ...state, isPlaying: false };

    case PlaybackActions.TICK:
    case PlaybackActions.STEP_FWD: {
      const next = state.currentStepIndex + 1;
      if (next >= totalSteps) return { ...state, isPlaying: false };
      return { ...state, currentStepIndex: next };
    }

    case PlaybackActions.STEP_BACK: {
      const prev = Math.max(0, state.currentStepIndex - 1);
      return { ...state, isPlaying: false, currentStepIndex: prev };
    }

    case PlaybackActions.RESET:
      return { ...state, currentStepIndex: 0, isPlaying: false };

    case PlaybackActions.JUMP: {
      const idx = Math.max(0, Math.min(totalSteps - 1, action.payload));
      return { ...state, currentStepIndex: idx, isPlaying: false };
    }

    default:
      return state;
  }
}

// usePlaybackEngine — the public API surface for the engine.
// Components never touch the reducer directly.
function usePlaybackEngine(initialTrace = null) {
  const [state, dispatch] = useReducer(playbackReducer, {
    ...initialPlaybackState,
    trace: initialTrace,
  });

  // Speed lives in a ref so the interval closure always reads
  // the latest value without needing to be recreated.
  // Valid range: 0.1x – 5x → mapped to ms delay: 2000ms – 40ms
  const speedRef = useRef(1.0);
  const intervalRef = useRef(null);

  // Convert speed multiplier to interval delay
  const speedToDelay = (spd) => Math.round(1000 / spd);

  // Interval management — starts/stops based on isPlaying state.
  // Uses a single long-lived interval. Speed changes are absorbed
  // by the ref without restarting.
  useEffect(() => {
    if (state.isPlaying) {
      intervalRef.current = setInterval(() => {
        dispatch({ type: PlaybackActions.TICK });
      }, speedToDelay(speedRef.current));
    } else {
      clearInterval(intervalRef.current);
    }
    return () => clearInterval(intervalRef.current);
  }, [state.isPlaying]);

  // Public API — memoized to prevent unnecessary re-renders downstream
  const play      = useCallback(() => dispatch({ type: PlaybackActions.PLAY }), []);
  const pause     = useCallback(() => dispatch({ type: PlaybackActions.PAUSE }), []);
  const stepFwd   = useCallback(() => dispatch({ type: PlaybackActions.STEP_FWD }), []);
  const stepBack  = useCallback(() => dispatch({ type: PlaybackActions.STEP_BACK }), []);
  const reset     = useCallback(() => dispatch({ type: PlaybackActions.RESET }), []);
  const jumpTo    = useCallback((i) => dispatch({ type: PlaybackActions.JUMP, payload: i }), []);
  const setTrace  = useCallback((t) => dispatch({ type: PlaybackActions.SET_TRACE, payload: t }), []);

  // Speed setter updates ref only — no state change, no restart
  const setSpeed  = useCallback((spd) => {
    speedRef.current = Math.max(0.1, Math.min(5, spd));
  }, []);

  const currentStep = state.trace?.steps[state.currentStepIndex] ?? null;
  const totalSteps  = state.trace?.steps.length ?? 0;
  const isAtEnd     = state.currentStepIndex >= totalSteps - 1;
  const isAtStart   = state.currentStepIndex === 0;

  return {
    // State
    currentStepIndex: state.currentStepIndex,
    isPlaying: state.isPlaying,
    currentStep,
    totalSteps,
    isAtEnd,
    isAtStart,
    trace: state.trace,
    // Actions
    play, pause, stepFwd, stepBack, reset, jumpTo, setTrace, setSpeed,
    speedRef, // exposed for slider sync
  };
}


// ============================================================
// SECTION 4: CONTEXT  (src/context/PlaybackContext.tsx)
// ============================================================

const PlaybackContext = createContext(null);

function PlaybackProvider({ children, trace }) {
  const engine = usePlaybackEngine(trace);
  return (
    <PlaybackContext.Provider value={engine}>
      {children}
    </PlaybackContext.Provider>
  );
}

// Hook for consuming context — enforces provider requirement
function usePlayback() {
  const ctx = useContext(PlaybackContext);
  if (!ctx) throw new Error("usePlayback must be used within PlaybackProvider");
  return ctx;
}


// ============================================================
// SECTION 5: COMPONENTS — CONTROLS  (src/components/controls/)
// ============================================================

// Step type color mapping — used in visualizer panel
const STEP_TYPE_CONFIG = {
  visit:    { color: "#60a5fa", bg: "rgba(96,165,250,0.15)",  icon: "◉", label: "Visit"    },
  compare:  { color: "#f59e0b", bg: "rgba(245,158,11,0.15)",  icon: "⟺", label: "Compare"  },
  swap:     { color: "#f87171", bg: "rgba(248,113,113,0.15)", icon: "⇄", label: "Swap"     },
  frontier: { color: "#a78bfa", bg: "rgba(167,139,250,0.15)", icon: "◈", label: "Frontier" },
  path:     { color: "#34d399", bg: "rgba(52,211,153,0.15)",  icon: "→", label: "Path"     },
  pivot:    { color: "#fb923c", bg: "rgba(251,146,60,0.15)",  icon: "⊛", label: "Pivot"    },
  custom:   { color: "#94a3b8", bg: "rgba(148,163,184,0.15)", icon: "◆", label: "Custom"   },
};

// PlaybackControls — pure UI, reads from context only
function PlaybackControls() {
  const {
    isPlaying, isAtEnd, isAtStart,
    play, pause, stepFwd, stepBack, reset, setSpeed, speedRef,
  } = usePlayback();

  const [speedDisplay, setSpeedDisplay] = useState(1.0);

  const handleSpeed = (e) => {
    const v = parseFloat(e.target.value);
    setSpeed(v);
    setSpeedDisplay(v);
  };

  const btnBase = "flex items-center justify-center rounded-lg transition-all duration-150 font-mono text-sm select-none";
  const btnPrimary = `${btnBase} w-10 h-10 bg-[#1e293b] border border-[#334155] text-slate-300 hover:bg-[#334155] hover:text-white hover:border-[#60a5fa] active:scale-95`;
  const btnDisabled = `${btnBase} w-10 h-10 bg-[#0f172a] border border-[#1e293b] text-slate-600 cursor-not-allowed`;

  return (
    <div className="flex flex-col gap-5 p-4">
      <div className="text-xs font-mono text-slate-500 uppercase tracking-widest mb-1">Playback</div>

      {/* Transport Controls */}
      <div className="flex items-center gap-2">
        <button
          onClick={reset}
          className={isAtStart ? btnDisabled : btnPrimary}
          disabled={isAtStart}
          title="Reset"
        >⏮</button>

        <button
          onClick={stepBack}
          className={isAtStart ? btnDisabled : btnPrimary}
          disabled={isAtStart}
          title="Step backward"
        >⏪</button>

        {isPlaying ? (
          <button onClick={pause} className={`${btnBase} w-12 h-12 rounded-xl bg-[#60a5fa] text-[#0f172a] hover:bg-[#93c5fd] active:scale-95 font-bold text-lg`} title="Pause">⏸</button>
        ) : (
          <button
            onClick={play}
            disabled={isAtEnd}
            className={isAtEnd
              ? `${btnBase} w-12 h-12 rounded-xl bg-[#1e293b] text-slate-600 cursor-not-allowed text-lg`
              : `${btnBase} w-12 h-12 rounded-xl bg-[#60a5fa] text-[#0f172a] hover:bg-[#93c5fd] active:scale-95 font-bold text-lg`}
            title="Play"
          >▶</button>
        )}

        <button
          onClick={stepFwd}
          className={isAtEnd ? btnDisabled : btnPrimary}
          disabled={isAtEnd}
          title="Step forward"
        >⏩</button>
      </div>

      {/* Speed Control */}
      <div className="flex flex-col gap-2">
        <div className="flex justify-between text-xs font-mono text-slate-500">
          <span>Speed</span>
          <span className="text-[#60a5fa]">{speedDisplay.toFixed(1)}×</span>
        </div>
        <input
          type="range"
          min="0.1" max="5" step="0.1"
          defaultValue="1.0"
          onChange={handleSpeed}
          className="w-full accent-[#60a5fa] cursor-pointer"
          style={{ accentColor: "#60a5fa" }}
        />
        <div className="flex justify-between text-[10px] font-mono text-slate-600">
          <span>0.1×</span><span>5×</span>
        </div>
      </div>
    </div>
  );
}

// StepTypeKey — legend for step types
function StepTypeKey() {
  return (
    <div className="p-4 border-t border-[#1e293b]">
      <div className="text-xs font-mono text-slate-500 uppercase tracking-widest mb-3">Step Types</div>
      <div className="flex flex-col gap-1.5">
        {Object.entries(STEP_TYPE_CONFIG).map(([type, cfg]) => (
          <div key={type} className="flex items-center gap-2">
            <span className="text-base" style={{ color: cfg.color }}>{cfg.icon}</span>
            <span className="text-xs font-mono text-slate-400">{cfg.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}


// ============================================================
// SECTION 6: COMPONENTS — VISUALIZER PANEL
// ============================================================

// StepCard — renders a single execution step
function StepCard({ step, isCurrent, index, onClick }) {
  const cfg = STEP_TYPE_CONFIG[step.type] ?? STEP_TYPE_CONFIG.custom;
  return (
    <button
      onClick={() => onClick(index)}
      className="w-full text-left rounded-lg p-3 transition-all duration-200 border"
      style={{
        background: isCurrent ? cfg.bg : "transparent",
        borderColor: isCurrent ? cfg.color : "#1e293b",
        boxShadow: isCurrent ? `0 0 12px ${cfg.color}33` : "none",
      }}
    >
      <div className="flex items-center gap-2 mb-1">
        <span className="text-sm" style={{ color: cfg.color }}>{cfg.icon}</span>
        <span className="text-xs font-mono uppercase tracking-wider" style={{ color: cfg.color }}>{step.type}</span>
        <span className="ml-auto text-[10px] font-mono text-slate-600">#{index}</span>
      </div>
      <div className="text-xs font-mono text-slate-400 pl-5">
        {step.payload.label ?? JSON.stringify(step.payload)}
      </div>
    </button>
  );
}

// PayloadInspector — shows current step detail
function PayloadInspector({ step }) {
  if (!step) return null;
  const cfg = STEP_TYPE_CONFIG[step.type] ?? STEP_TYPE_CONFIG.custom;
  return (
    <div
      className="rounded-xl p-4 border"
      style={{ borderColor: cfg.color + "44", background: cfg.bg }}
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="text-xl" style={{ color: cfg.color }}>{cfg.icon}</span>
        <span className="font-mono text-sm uppercase tracking-widest" style={{ color: cfg.color }}>{cfg.label}</span>
      </div>
      <pre className="text-xs font-mono text-slate-300 overflow-auto whitespace-pre-wrap">
        {JSON.stringify(step.payload, null, 2)}
      </pre>
    </div>
  );
}

// MetadataPanel — shows execution metadata
function MetadataPanel({ metadata }) {
  if (!metadata) return null;
  return (
    <div className="rounded-xl p-4 bg-[#0f172a] border border-[#1e293b]">
      <div className="text-xs font-mono text-slate-500 uppercase tracking-widest mb-3">Complexity</div>
      <div className="flex gap-4 mb-3">
        <div>
          <div className="text-[10px] text-slate-600 font-mono">Time</div>
          <div className="text-sm font-mono text-[#34d399]">{metadata.timeComplexity}</div>
        </div>
        <div>
          <div className="text-[10px] text-slate-600 font-mono">Space</div>
          <div className="text-sm font-mono text-[#a78bfa]">{metadata.spaceComplexity}</div>
        </div>
      </div>
      {metadata.notes && (
        <div className="text-xs font-mono text-slate-500 italic border-t border-[#1e293b] pt-3">
          {metadata.notes}
        </div>
      )}
    </div>
  );
}

// Progress bar + step counter
function ProgressBar() {
  const { currentStepIndex, totalSteps } = usePlayback();
  const pct = totalSteps > 1 ? (currentStepIndex / (totalSteps - 1)) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <div className="flex-1 h-1.5 bg-[#1e293b] rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-200"
          style={{
            width: `${pct}%`,
            background: "linear-gradient(90deg, #60a5fa, #a78bfa)",
          }}
        />
      </div>
      <span className="text-xs font-mono text-slate-500 whitespace-nowrap">
        {currentStepIndex + 1} / {totalSteps}
      </span>
    </div>
  );
}

// Main visualizer — step list + inspector
function VisualizerPanel() {
  const { trace, currentStepIndex, currentStep, jumpTo } = usePlayback();
  const scrollRef = useRef(null);

  // Auto-scroll active step into view
  useEffect(() => {
    if (scrollRef.current) {
      const active = scrollRef.current.querySelector(`[data-active="true"]`);
      active?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }, [currentStepIndex]);

  return (
    <div className="flex flex-col gap-4 h-full">
      {/* Metadata */}
      <MetadataPanel metadata={trace?.metadata} />

      {/* Current step inspector */}
      <div>
        <div className="text-xs font-mono text-slate-500 uppercase tracking-widest mb-2">Current Step</div>
        <PayloadInspector step={currentStep} />
      </div>

      {/* Step list */}
      <div className="flex-1 min-h-0 flex flex-col">
        <div className="text-xs font-mono text-slate-500 uppercase tracking-widest mb-2">Execution Trace</div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto pr-1 flex flex-col gap-1.5 min-h-0"
          style={{ scrollbarWidth: "thin", scrollbarColor: "#334155 transparent" }}
        >
          {trace?.steps.map((step, i) => (
            <div key={step.id} data-active={i === currentStepIndex ? "true" : "false"}>
              <StepCard
                step={step}
                isCurrent={i === currentStepIndex}
                index={i}
                onClick={jumpTo}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}


// ============================================================
// SECTION 7: LAYOUT SHELL  (src/components/layout/)
// ============================================================

// Navbar — top bar, title only (Phase 1)
function Navbar() {
  const { isPlaying, currentStepIndex, totalSteps } = usePlayback();
  return (
    <nav className="h-14 flex items-center px-6 border-b border-[#1e293b] bg-[#080f1a]" style={{ zIndex: 10 }}>
      {/* Logo mark */}
      <div className="flex items-center gap-3 mr-8">
        <div className="w-7 h-7 rounded-lg flex items-center justify-center"
          style={{ background: "linear-gradient(135deg, #60a5fa, #a78bfa)" }}>
          <span className="text-xs font-bold text-[#080f1a]">AV</span>
        </div>
        <span className="font-mono text-sm font-bold tracking-wider text-slate-200">
          ALGO<span className="text-[#60a5fa]">VIZ</span>
        </span>
        <span className="text-[10px] font-mono text-slate-600 border border-[#1e293b] rounded px-1.5 py-0.5">Phase 1</span>
      </div>

      {/* Center: phase label */}
      <div className="flex-1 flex items-center justify-center">
        <span className="text-xs font-mono text-slate-600">
          Architecture & Engine Validation
        </span>
      </div>

      {/* Right: live status */}
      <div className="flex items-center gap-3">
        {isPlaying && (
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-[#60a5fa] animate-pulse" />
            <span className="text-xs font-mono text-[#60a5fa]">PLAYING</span>
          </div>
        )}
        <span className="text-xs font-mono text-slate-600">
          {currentStepIndex + 1}/{totalSteps} steps
        </span>
      </div>
    </nav>
  );
}

// Sidebar — left panel, houses controls
function Sidebar() {
  return (
    <aside className="w-64 flex-shrink-0 flex flex-col border-r border-[#1e293b] bg-[#080f1a]">
      {/* Algorithm selector placeholder */}
      <div className="p-4 border-b border-[#1e293b]">
        <div className="text-xs font-mono text-slate-500 uppercase tracking-widest mb-2">Algorithm</div>
        <div className="rounded-lg bg-[#0f172a] border border-[#1e293b] px-3 py-2 flex items-center justify-between text-xs font-mono text-slate-400">
          <span>Mock BFS Trace</span>
          <span className="text-slate-600">▾</span>
        </div>
        <div className="mt-1 text-[10px] font-mono text-slate-600">Algorithm selector — Phase 2</div>
      </div>

      {/* Playback controls */}
      <PlaybackControls />

      {/* Progress */}
      <div className="px-4 pb-3 border-b border-[#1e293b]">
        <ProgressBar />
      </div>

      {/* Step type legend */}
      <StepTypeKey />

      {/* Footer */}
      <div className="mt-auto p-4 border-t border-[#1e293b]">
        <div className="text-[10px] font-mono text-slate-700 leading-relaxed">
          Engine: useReducer state machine<br />
          Speed range: 0.1× – 5×<br />
          Trace steps: {MOCK_TRACE.steps.length}<br />
          Phase 1 — Architecture only
        </div>
      </div>
    </aside>
  );
}

// AppLayout — root layout, coordinates all panels
function AppLayout() {
  return (
    <div className="flex flex-col h-screen bg-[#080f1a] text-slate-200 overflow-hidden"
      style={{ fontFamily: "'Courier New', monospace" }}>
      <Navbar />
      <div className="flex flex-1 overflow-hidden">
        <Sidebar />
        {/* Main panel */}
        <main className="flex-1 overflow-hidden p-5">
          <div className="h-full overflow-y-auto pr-1"
            style={{ scrollbarWidth: "thin", scrollbarColor: "#334155 transparent" }}>
            <VisualizerPanel />
          </div>
        </main>
      </div>
    </div>
  );
}


// ============================================================
// SECTION 8: ROOT APP
// ============================================================

export default function App() {
  return (
    <PlaybackProvider trace={MOCK_TRACE}>
      <AppLayout />
    </PlaybackProvider>
  );
}
