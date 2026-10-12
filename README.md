# Distributed Wagering Processor

Backend para processamento distribuído de transações financeiras de apostas, com foco em consistência, idempotência, concorrência e recuperação de falhas.

O projeto utiliza NestJS, TypeScript, Bun, PostgreSQL, MikroORM e AWS SQS FIFO (simulado localmente com LocalStack).

## Funcionalidades

- Criação de carteiras com saldo inicial
- Processamento de BET, WIN, LOSS, REFUND e ROLLBACK
- Idempotência por provedor e identificador externo
- Controle de concorrência e proteção contra saldo negativo
- Ledger financeiro append-only
- Reconciliação entre saldo armazenado e lançamentos
- Tratamento de referências fora de ordem (PENDING_REFERENCE)
- Worker para retry de referências pendentes
- Consumer SQS com Inbox transacional
- Transactional Outbox para publicação de resultados
- Publisher independente com retries e controle de concorrência
- Filas FIFO, Dead Letter Queues e visibility heartbeat
- Diagnósticos operacionais e auditoria financeira

## Arquitetura

O sistema oferece dois caminhos de entrada:

1. API REST do NestJS
2. Fila SQS FIFO de transações

Ambos utilizam a mesma lógica financeira.

```text
                         HTTP API
                            |
                            v
SQS Transactions --> Consumer + Inbox
                            |
                            v
                       Application
                            |
                            v
                        PostgreSQL
                    /       |       \
                 Wallet   Ledger   Outbox
                            |          |
                   Reference Worker    v
                                  Outbox Publisher
                                         |
                                         v
                                  SQS Results FIFO
```

### Garantias financeiras

- Transações financeiras e lançamentos do ledger são persistidos atomicamente.
- Idempotência financeira é garantida no PostgreSQL.
- Mensagens recebidas são deduplicadas pela Inbox.
- A confirmação SQS ocorre somente após o commit financeiro.
- Eventos de resultado são registrados na Outbox na mesma transação financeira.
- O publisher pode reenviar eventos após falhas.
- Operações concorrentes na mesma carteira são serializadas por mecanismos de bloqueio no PostgreSQL.
- Constraints, Foreign Keys e triggers reforçam a integridade dos dados.

A arquitetura assume entrega **at least once** pelas filas. Não depende de garantias de entrega exatamente uma vez do SQS.

## Tecnologias

- Bun e TypeScript
- NestJS
- PostgreSQL 17
- MikroORM
- Docker Compose
- AWS SDK for JavaScript v3
- LocalStack / Amazon SQS FIFO
- Zod
- Bun Test

## Pré-requisitos

- Bun (projeto desenvolvido com Bun 1.4.x)
- Docker e Docker Compose
- PowerShell ou terminal equivalente
- Git

## Configuração do ambiente

Clone o repositório e entre no diretório:

```bash
git clone <https://github.com/Kazyg/distributed-wagering-processor>
cd distributed-wagering-processor
```

Instale as dependências:

```bash
bun install --frozen-lockfile
```

Crie os arquivos de ambiente a partir dos exemplos.

No PowerShell:

```powershell
Copy-Item .env.example .env
Copy-Item .env.test.example .env.test
```

Revise as variáveis de PostgreSQL, SQS e LocalStack conforme os arquivos de exemplo.

Os arquivos `.env` contêm configurações locais e não devem ser versionados.

## Inicialização

Inicie a infraestrutura:

```bash
docker compose up -d
docker compose ps
```

Aguarde os containers do PostgreSQL e do LocalStack ficarem saudáveis.

Aplique as migrations no banco de desenvolvimento:

```bash
bun run db:migrate
```

Configure o usuário de aplicação com privilégios mínimos:

```bash
bun run db:provision
```

Crie e configure as filas SQS:

```bash
bun run sqs:setup
```

### Serviços da aplicação

Inicie cada processo em um terminal separado.

**API NestJS:**

```bash
bun run dev
```

**Consumer de transações SQS:**

```bash
bun run worker:sqs
```

**Worker de referências pendentes:**

```bash
bun run worker:references
```

**Publisher da Outbox:**

```bash
bun run worker:outbox
```

## Operações financeiras

| Operação | Comportamento                                         |
| -------- | ----------------------------------------------------- |
| BET      | Debita o valor da carteira                            |
| WIN      | Credita o valor do ganho                              |
| LOSS     | Registra o resultado sem movimentação                 |
| REFUND   | Reembolsa uma BET elegível                            |
| ROLLBACK | Reverte o efeito financeiro da transação referenciada |

Reversões cuja referência ainda não chegou podem ser registradas como `PENDING_REFERENCE`.

Um worker independente executa tentativas posteriores com backoff exponencial. Ao atingir o limite de tentativas, a operação é finalizada conforme as regras de negócio.

## Mensageria

### Fila de entrada

`wager-transactions.fifo`

Recebe solicitações de transações financeiras.

Exemplo:

```json
{
  "schemaVersion": 1,
  "kind": "WAGER_TRANSACTION",
  "messageId": "8b159d6f-a26b-4eaa-a08d-d720402cd536",
  "payload": {
    "type": "BET",
    "walletId": "83d9a208-4624-42a6-9f89-7dd318b4e448",
    "providerId": "provider-demo",
    "externalTransactionId": "bet-001",
    "amount": "30.00",
    "currency": "BRL"
  }
}
```

O `messageId` identifica a mensagem para a Inbox.

A combinação de provedor e identificador externo representa a identidade da transação financeira.

### Fila de resultados

`wager-results.fifo`

Recebe eventos financeiros finais:

`WAGER_TRANSACTION_FINALIZED`

Os eventos contêm identificador da transação, identificador do evento, operação, status, valor, moeda, saldo resultante e motivo, quando aplicável.

### Dead Letter Queues

- `wager-transactions-dlq.fifo`
- `wager-results-dlq.fifo`

Mensagens que excedem as tentativas de entrega configuradas podem ser encaminhadas às respectivas DLQs.

O reprocessamento de mensagens da DLQ deve ocorrer após análise da causa da falha, respeitando as regras de idempotência e ordenação.

## Testes

Prepare o banco de testes:

```bash
bun run db:test:migrate
bun run db:test:provision
```

Execute os testes:

```bash
bun run test:unit
bun run test:integration
```

Valide o código:

```bash
bun run typecheck
bun run typecheck:test
bun run lint
bun run build
```

Na última validação do desenvolvimento foram aprovados:

- 57 testes unitários
- 58 testes de integração
- 115 testes no total

### Teste E2E distribuído

```bash
bun run test:e2e
```

Esse teste utiliza PostgreSQL de testes e filas temporárias no LocalStack.

Ele valida o caminho:

SQS de entrada → Inbox → processamento financeiro → ledger → Outbox → SQS de resultados.

Também valida uma entrega duplicada, garantindo que ela não gere um novo débito.

### Testes de resiliência

```bash
bun run sqs:heartbeat
bun run sqs:resilience
```

Esses testes cobrem renovação de visibilidade, redelivery, deduplicação e encaminhamento de mensagens inválidas à DLQ.

## Diagnóstico operacional

Estado do banco e das filas:

```bash
bun run ops:status
```

Auditoria da integridade financeira:

```bash
bun run ops:audit
```

O diagnóstico apresenta informações de Outbox, referências pendentes, DLQs e triggers de proteção.

A auditoria verifica a correspondência entre saldos e ledger, referências financeiras, duplicidades e semântica das movimentações.

As contagens do SQS são aproximadas e não substituem a reconciliação financeira no PostgreSQL.

## Segurança e integridade

O processamento normal utiliza uma role PostgreSQL de privilégios mínimos.

As migrations e o provisionamento administrativo são executados separadamente.

O esquema inclui:

- Proteções contra alterações indevidas no ledger
- Restrições de transições de status
- Constraints de consistência monetária
- Foreign Keys entre operações e lançamentos financeiros
- Restrições de unicidade para idempotência e OPENING
- Proteções sobre registros de Inbox e Outbox

Valores financeiros são representados sem depender de aritmética de ponto flutuante.

## Migrations

As migrations estão versionadas no repositório e são aplicadas em ordem pelo MikroORM.

O esquema foi validado também por meio da aplicação do histórico de migrations em um banco vazio e isolado.

Não é necessário importar um dump do PostgreSQL utilizado durante o desenvolvimento.

## Limitações e decisões

- As filas SQS garantem entrega potencialmente repetida; a idempotência financeira é persistida no PostgreSQL.
- O processamento de referências fora de ordem utiliza uma política limitada de retries.
- A continuidade histórica de saldos no ledger não possui uma sequência monotônica explícita por carteira.
- O processamento de resultados SQS por sistemas externos deve aplicar sua própria deduplicação por `eventId`.
- Os scripts de demonstração e os serviços LocalStack são destinados ao ambiente local.

## Estrutura

```text
src/
  application/       Casos de uso e regras de aplicação
  domain/            Modelos e regras financeiras
  infrastructure/    PostgreSQL, mensageria e diagnóstico

scripts/             Setup, workers e ferramentas operacionais
tests/
  unit/              Testes unitários
  integration/       Testes de integração

compose.yaml         Infraestrutura local
```

## Considerações finais

O projeto demonstra o uso conjunto de transações PostgreSQL, controle de concorrência, idempotência persistente, ledger append-only e padrões Inbox/Outbox para processamento financeiro distribuído.

O foco principal é preservar a consistência financeira mesmo diante de mensagens repetidas, referências fora de ordem e falhas temporárias de infraestrutura.
