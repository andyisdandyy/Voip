import { Component, type ErrorInfo, type ReactNode } from 'react';
import { TerminalForum } from './components/terminal-forum';

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="echo-shell h-screen bg-[#0a0e0a] text-green-500 flex items-center justify-center p-8" data-theme="light">
          <div className="w-full max-w-xl rounded-2xl border border-green-900/40 bg-[#0d120d]/80 backdrop-blur-sm p-6 shadow-2xl shadow-green-900/20">
            <div className="text-red-500 text-lg font-bold">Something went wrong</div>
            <pre className="mt-4 text-xs text-red-600 bg-[#0a0e0a]/60 border border-red-800/40 rounded-xl p-4 w-full overflow-auto max-h-64 font-mono">
              {this.state.error.message}
            </pre>
            <button
              onClick={() => this.setState({ error: null })}
              className="mt-4 px-4 py-2 bg-green-900/40 hover:bg-green-900/60 text-green-400 rounded-lg text-sm font-semibold transition-all">
              Reload App
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <ErrorBoundary>
      <TerminalForum />
    </ErrorBoundary>
  );
}
