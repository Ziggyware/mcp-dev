let installed = false;

/** Avoid a noisy stack trace when `mcp-dev … | head` closes its pipe early. */
export function installRuntimeGuards() {
  if (installed) return;
  installed = true;

  const handleStreamError = (error) => {
    if (error?.code === "EPIPE") {
      process.exitCode = 0;
      return;
    }
    // Stream errors without a listener otherwise become an uncaught exception.
    process.exitCode = process.exitCode || 1;
  };

  process.stdout.on("error", handleStreamError);
  process.stderr.on("error", handleStreamError);
}

export function errorMessage(error) {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

export function isPromptExit(error) {
  return ["ExitPromptError", "AbortPromptError", "CancelPromptError"].includes(error?.name);
}
