export function getSqsQueueNames(): {
  main: string;
  dlq: string;
  results: string;
  resultsDlq: string;
} {
  const main = process.env.SQS_WAGER_QUEUE_NAME ?? 'wager-transactions.fifo';

  const dlq = process.env.SQS_WAGER_DLQ_NAME ?? 'wager-transactions-dlq.fifo';

  const results = process.env.SQS_RESULTS_QUEUE_NAME ?? 'wager-results.fifo';

  const resultsDlq = process.env.SQS_RESULTS_DLQ_NAME ?? 'wager-results-dlq.fifo';

  const names = [main, dlq, results, resultsDlq];

  if (names.some((name) => !name.endsWith('.fifo'))) {
    throw new Error('SQS FIFO queue names must end with .fifo');
  }

  if (new Set(names).size !== names.length) {
    throw new Error('SQS queue names must be unique');
  }

  return { main, dlq, results, resultsDlq };
}
