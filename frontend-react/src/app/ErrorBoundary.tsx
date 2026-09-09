import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = {
  children: ReactNode;
  fallback?: (error: Error, retry: () => void) => ReactNode;
};

type ErrorBoundaryState = {
  error: Error | null;
};

/** Keeps a render error inside the React shell from producing a blank screen. */
export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('React page gagal dirender:', error, info.componentStack);
  }

  retry = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback) return this.props.fallback(this.state.error, this.retry);
    return <main className="runtime-error-screen" role="alert"><h1>Aplikasi belum dapat dimuat</h1><p>Terjadi kesalahan pada tampilan. Data tersimpan tetap aman.</p><button type="button" className="runtime-error-retry" onClick={this.retry}>Coba lagi</button></main>;
  }
}
