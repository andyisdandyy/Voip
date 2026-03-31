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
        <div className="h-screen bg-[#0a0e0a] text-green-500 font-mono flex flex-col items-center justify-center gap-4 p-8">
          <div className="text-red-400 text-lg font-bold">Something went wrong</div>
          <pre className="text-xs text-red-600 bg-[#0d120d] rounded-lg p-4 max-w-xl w-full overflow-auto max-h-64">
            {this.state.error.message}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            className="px-4 py-2 bg-green-900/40 hover:bg-green-900/60 text-green-400 rounded-lg text-sm transition-all">
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  return (
    <div className="h-screen bg-[#0a0e0a]">
      <ErrorBoundary>
        <TerminalForum />
      </ErrorBoundary>
    </div>
  );
}
