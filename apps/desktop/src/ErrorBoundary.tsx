import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
}

// Top-level React error boundary (WP3). Without this, an uncaught render
// error anywhere in the tree unmounts everything and leaves the desktop
// window blank with no way to recover short of a full relaunch.
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: "error",
        msg: "[desktop] uncaught render error",
        error: error.message,
        stack: error.stack,
        componentStack: info.componentStack,
      }),
    );
  }

  handleReload = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            gap: "1rem",
            fontFamily: "system-ui, sans-serif",
          }}
        >
          <p>Something went wrong.</p>
          <button onClick={this.handleReload}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
