import { Component, type ErrorInfo, type ReactNode } from "react";
import { useDocumentStore } from "../state/useDocumentStore";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
  errorInfo: ErrorInfo | null;
  showDetails: boolean;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, errorInfo: null, showDetails: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });
    console.error("[ErrorBoundary]", error, errorInfo);
  }

  handleReset = (): void => {
    this.setState({ error: null, errorInfo: null, showDetails: false });
    try {
      useDocumentStore.getState().reset();
    } catch (err) {
      console.warn("[ErrorBoundary] reset failed:", err);
    }
  };

  handleReload = (): void => {
    window.location.reload();
  };

  toggleDetails = (): void => {
    this.setState((prev) => ({ showDetails: !prev.showDetails }));
  };

  render(): ReactNode {
    const { error, errorInfo, showDetails } = this.state;
    if (!error) {
      return this.props.children;
    }
    const stack = errorInfo?.componentStack ?? error.stack ?? "";
    return (
      <div className="flex h-full w-full items-center justify-center bg-gray-50 p-8">
        <div className="w-full max-w-xl rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h2 className="mb-3 text-xl font-semibold text-gray-900">
            Something went wrong
          </h2>
          <pre className="mb-4 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-gray-100 p-3 text-xs text-gray-700">
            {error.toString()}
          </pre>
          <div className="mb-4 flex items-center gap-2">
            <button
              type="button"
              onClick={this.toggleDetails}
              className="text-sm text-gray-500 underline hover:text-gray-700"
            >
              {showDetails ? "Hide details" : "Show details"}
            </button>
          </div>
          {showDetails ? (
            <pre className="mb-4 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-gray-50 p-3 text-xs text-gray-500">
              {stack}
            </pre>
          ) : null}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={this.handleReset}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={this.handleReload}
              className="rounded-md border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
            >
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
