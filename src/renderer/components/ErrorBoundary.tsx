import React from 'react';

interface State { error: Error | null; }

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State { return { error }; }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('Renderer crash caught by ErrorBoundary:', error, info);
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { error } = this.state;
    return (
      <div className="error-boundary">
        <h2>Something broke in the UI</h2>
        <p>KiroLex caught a rendering error instead of leaving a blank window.</p>
        <pre>{error.message}{'\n'}{error.stack}</pre>
        <div className="error-boundary-actions">
          <button className="btn allow" onClick={() => window.location.reload()}>Reload</button>
          <button className="btn deny" onClick={() => this.setState({ error: null })}>Try to continue</button>
        </div>
      </div>
    );
  }
}
