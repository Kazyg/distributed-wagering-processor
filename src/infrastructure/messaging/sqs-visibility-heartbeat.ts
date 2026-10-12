export interface VisibilityHeartbeatOptions {
  intervalMs: number;
  onRenewed?: () => void;
  onError?: (error: unknown) => void;
}

export async function withVisibilityHeartbeat<T>(
  work: () => Promise<T>,
  renewVisibility: () => Promise<void>,
  options: VisibilityHeartbeatOptions,
): Promise<T> {
  if (!Number.isInteger(options.intervalMs) || options.intervalMs <= 0) {
    throw new Error('Invalid visibility heartbeat interval');
  }

  let stopped = false;
  let inFlight: Promise<void> | undefined;

  const timer = setInterval(() => {
    // Não inicia duas renovações ao mesmo tempo.
    if (stopped || inFlight) {
      return;
    }

    inFlight = (async () => {
      try {
        await renewVisibility();
        options.onRenewed?.();
      } catch (error: unknown) {
        // Uma falha no heartbeat não desfaz
        // uma operação financeira já em andamento.
        options.onError?.(error);
      }
    })().finally(() => {
      inFlight = undefined;
    });
  }, options.intervalMs);

  try {
    return await work();
  } finally {
    stopped = true;
    clearInterval(timer);

    // Aguarda uma eventual renovação em andamento
    // antes de devolver o controle ao consumer.
    if (inFlight) {
      await inFlight;
    }
  }
}
