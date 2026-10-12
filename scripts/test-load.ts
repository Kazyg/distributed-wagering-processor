import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';

import { MikroORM } from '@mikro-orm/postgresql';

import config from '../src/infrastructure/database/mikro-orm.config';

interface Sample {
  status: number;
  latencyMs: number;
}

function percentile(values: number[], percentage: number): number | null {
  if (values.length === 0) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);

  return Number(sorted[index]!.toFixed(2));
}

async function main(): Promise<void> {
  const baseUrl = process.env.LOAD_BASE_URL ?? 'http://localhost:3000';
  const apiKey = process.env.API_KEY;

  const url = new URL(baseUrl);

  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(url.hostname) || !apiKey) {
    throw new Error('Load test requires local HTTP API and API_KEY');
  }

  const total = 100;
  const concurrency = 10;
  const amount = '1.00';

  const orm = await MikroORM.init(config);

  try {
    const target = await orm.em.fork().execute<{
      databaseName: string;
    }>('SELECT current_database() AS "databaseName"', [], 'get');

    if (target.databaseName !== 'wagering_db') {
      throw new Error('Unexpected load test database');
    }

    const headers = {
      'content-type': 'application/json',
      'x-api-key': apiKey,
    };

    const walletResponse = await fetch(`${baseUrl}/wallets`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        playerId: `load-${randomUUID()}`,
        currency: 'BRL',
        openingBalance: '1000.00',
      }),
    });

    if (!walletResponse.ok) {
      throw new Error(
        `Wallet creation failed: ${walletResponse.status} ${await walletResponse.text()}`,
      );
    }

    const wallet = (await walletResponse.json()) as {
      id: string;
    };

    const samples: Sample[] = [];
    let nextIndex = 0;

    async function worker(): Promise<void> {
      while (true) {
        const index = nextIndex++;

        if (index >= total) return;

        const started = performance.now();
        let status = 0;

        try {
          const response = await fetch(`${baseUrl}/wagering/transactions`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              walletId: wallet.id,
              providerId: 'load-test',
              externalTransactionId: `load-${randomUUID()}`,
              type: 'BET',
              amount,
              currency: 'BRL',
            }),
          });

          status = response.status;
          await response.text();
        } catch {
          status = 0;
        }

        samples.push({
          status,
          latencyMs: performance.now() - started,
        });
      }
    }

    const startedAt = performance.now();

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    const elapsedSeconds = (performance.now() - startedAt) / 1000;

    const successes = samples.filter(
      (sample) => sample.status >= 200 && sample.status < 300,
    ).length;

    const errors = samples.length - successes;
    const conflicts409 = samples.filter((sample) => sample.status === 409).length;

    // Permite que o publisher avance um pouco.
    // Outbox pendente permanecerá explicitada no relatório.
    await Bun.sleep(2000);

    const lag = await orm.em.fork().execute<{
      published: number;
      pending: number;
      p50Ms: string | null;
      p95Ms: string | null;
      p99Ms: string | null;
    }>(
      `
      SELECT
        COUNT(*) FILTER (
          WHERE published_at IS NOT NULL
        )::integer AS "published",
        COUNT(*) FILTER (
          WHERE published_at IS NULL
        )::integer AS "pending",
        ROUND((
          PERCENTILE_CONT(0.50) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (
              published_at - created_at
            )) * 1000
          )
        )::numeric, 2) AS "p50Ms",
        ROUND((
          PERCENTILE_CONT(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (
              published_at - created_at
            )) * 1000
          )
        )::numeric, 2) AS "p95Ms",
        ROUND((
          PERCENTILE_CONT(0.99) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (
              published_at - created_at
            )) * 1000
          )
        )::numeric, 2) AS "p99Ms"
      FROM public.wager_outbox_events
      WHERE wallet_id = ?::uuid
      `,
      [wallet.id],
      'get',
    );

    const latencies = samples.map((sample) => sample.latencyMs);

    const statusCounts: Record<string, number> = {};

    for (const sample of samples) {
      const key = String(sample.status);
      statusCounts[key] = (statusCounts[key] ?? 0) + 1;
    }

    const report = {
      executedAt: new Date().toISOString(),
      environment: {
        runtime: `Bun ${Bun.version}`,
        os: platform(),
        arch: arch(),
        cpu: cpus()[0]?.model ?? 'unknown',
        logicalCores: cpus().length,
        memoryGb: Number((totalmem() / 1024 ** 3).toFixed(2)),
        database: target.databaseName,
        infrastructure: 'Docker Compose / PostgreSQL / LocalStack',
      },
      methodology: {
        endpoint: 'POST /wagering/transactions',
        requests: total,
        concurrency,
        walletId: wallet.id,
        sameWallet: true,
        betAmount: amount,
        externalIds: 'unique for every request',
        clientSideLatency: true,
        outboxObservationDelayMs: 2000,
      },
      results: {
        durationSeconds: Number(elapsedSeconds.toFixed(3)),
        successful: successes,
        errors,
        errorRatePercent: Number(((errors / samples.length) * 100).toFixed(2)),
        http409: conflicts409,
        statusCounts,
        throughputRequestsPerSecond: Number((samples.length / elapsedSeconds).toFixed(2)),
        successfulRequestsPerSecond: Number((successes / elapsedSeconds).toFixed(2)),
        latencyMs: {
          p50: percentile(latencies, 50),
          p95: percentile(latencies, 95),
          p99: percentile(latencies, 99),
        },
        outboxLagMs: {
          publishedEvents: Number(lag.published),
          pendingEvents: Number(lag.pending),
          p50: lag.p50Ms === null ? null : Number(lag.p50Ms),
          p95: lag.p95Ms === null ? null : Number(lag.p95Ms),
          p99: lag.p99Ms === null ? null : Number(lag.p99Ms),
        },
      },
    };

    await mkdir('reports', { recursive: true });

    await Bun.write('reports/load-report.json', JSON.stringify(report, null, 2));

    console.log(JSON.stringify(report, null, 2));
    console.log('Report saved: reports/load-report.json');
  } finally {
    await orm.close(true);
  }
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
