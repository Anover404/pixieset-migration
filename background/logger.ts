export class Logger {
  info(message: string, data?: unknown) {
    console.info("[Migrator]", message, data ?? "");
  }

  warn(message: string, data?: unknown) {
    console.warn("[Migrator]", message, data ?? "");
  }

  error(message: string, data?: unknown) {
    console.error("[Migrator]", message, data ?? "");
  }
}

