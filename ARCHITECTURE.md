# Architecture — Distributed Wagering Processor

## 1. Visão geral

O Distributed Wagering Processor é um backend de processamento financeiro de apostas, desenvolvido com NestJS, TypeScript, Bun, PostgreSQL, MikroORM e Amazon SQS FIFO, utilizando LocalStack no ambiente local.

A arquitetura foi projetada para privilegiar consistência financeira, idempotência, controle de concorrência, rastreabilidade e recuperação de falhas.

O PostgreSQL é a fonte de verdade para o estado financeiro. As filas SQS são utilizadas para transportar comandos e eventos, não para armazenar o saldo das carteiras.

## 2. Componentes e fluxo

**Entrada HTTP:** controllers NestJS recebem solicitações e encaminham aos casos de uso da aplicação.

**Entrada SQS:** um consumer recebe mensagens da fila `wager-transactions.fifo`, valida o contrato, registra a Inbox e executa o processamento financeiro.

**Camada de aplicação:** casos de uso para criação de carteiras, BET, WIN, LOSS, REFUND, ROLLBACK e reconciliação.

**Persistência:** PostgreSQL mantém carteiras, transações, ledger, referências pendentes, Inbox e Outbox.

**Worker de referências:** reprocessa operações `PENDING_REFERENCE` com política de retry e limite de tentativas.

**Outbox Publisher:** consulta eventos persistidos, envia mensagens para `wager-results.fifo` e registra a confirmação da publicação.

Fluxo principal:

SQS de entrada → Consumer → Inbox → Transação PostgreSQL → Wallet + WagerTransaction + Ledger + Outbox → Outbox Publisher → SQS de resultados.

A API HTTP utiliza os mesmos casos de uso financeiros, sem depender da existência de uma mensagem SQS.

## 3. Decisões arquiteturais

| Decisão                          | Justificativa                                               | Trade-off                                                         |
| -------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- |
| PostgreSQL como fonte de verdade | Oferece transações ACID e constraints relacionais           | Concentra a consistência financeira no banco                      |
| Ledger append-only               | Preserva evidências das movimentações financeiras           | Correções exigem operações compensatórias                         |
| Lock por carteira                | Serializa alterações concorrentes no mesmo saldo            | Reduz paralelismo sobre uma carteira muito disputada              |
| Idempotência persistente         | Impede processamento financeiro repetido após retries       | Exige constraints e controle de conflitos                         |
| Transactional Inbox              | Vincula o registro da mensagem ao processamento financeiro  | Aumenta a quantidade de registros persistidos                     |
| Transactional Outbox             | Evita perder eventos após um commit financeiro bem-sucedido | Exige publisher independente e deduplicação no destino            |
| SQS FIFO                         | Agrupa mensagens por carteira e auxilia na ordenação        | A ordenação pode limitar o paralelismo por grupo                  |
| PENDING_REFERENCE                | Aceita reversões recebidas antes da operação original       | Introduz estados intermediários e processamento assíncrono        |
| Workers independentes            | Separa API, consumo, retries e publicação                   | Aumenta a complexidade de execução e monitoramento                |
| Privilégios mínimos              | Restringe alterações perigosas no PostgreSQL                | Exige provisionamento separado                                    |
| API Key para HTTP                | Autenticação simples de integração para o escopo do desafio | Não oferece identidade individual, RBAC ou isolamento por cliente |

## 4. Invariantes financeiras

As regras centrais são:

- O saldo armazenado deve corresponder ao resultado das movimentações do ledger.
- Uma carteira não pode possuir saldo negativo após uma operação financeira válida.
- Uma BET processada produz um débito; uma WIN processada produz um crédito.
- LOSS não movimenta o saldo.
- REFUND e ROLLBACK respeitam a operação original e impedem reversões financeiras incompatíveis.
- Transações rejeitadas ou pendentes não devem produzir movimentações financeiras.
- Uma transação financeira não deve gerar lançamentos duplicados no modelo atual.
- Um lançamento deve referenciar uma transação da mesma carteira, exceto o lançamento OPENING.
- Uma carteira pode ter no máximo um lançamento OPENING.

Essas invariantes são protegidas por uma combinação de lógica de domínio, transações PostgreSQL, constraints, índices únicos, foreign keys, triggers e testes de integração.

## 5. Concorrência e idempotência

O processamento financeiro utiliza bloqueio transacional da carteira para impedir que operações concorrentes consumam um saldo desatualizado.

A identidade de uma operação financeira é controlada por informações de provedor e identificador externo, com proteção contra reutilização incompatível.

A Inbox armazena a identidade das mensagens recebidas. Quando a mesma mensagem lógica reaparece, o processamento reconhece a duplicata sem repetir a movimentação financeira.

A deduplicação da Inbox e a idempotência da operação financeira são mecanismos complementares.

## 6. Recuperação de falhas

**Falha antes do commit:** as alterações financeiras e a Inbox são revertidas pela transação PostgreSQL.

**Falha após o commit, antes do ACK:** a mensagem pode ser entregue novamente. A Inbox impede a repetição do efeito financeiro.

**Falha na publicação de resultado:** o evento permanece pendente na Outbox e pode ser publicado posteriormente.

**Falha depois de o SQS aceitar o evento:** o publisher pode repetir o envio, preservando o mesmo `eventId`.

**Consumer lento:** o visibility heartbeat renova periodicamente a invisibilidade da mensagem.

**Mensagem não processável:** após o limite configurado de recebimentos, ela pode ser encaminhada à Dead Letter Queue.

O sistema adota entrega **at least once**, combinada com idempotência persistente. Não afirma garantia global de execução exactly once.

## 7. Ordenação de eventos

Mensagens de transações utilizam `MessageGroupId` por carteira.

A Outbox emprega identificadores ordenáveis internamente e um mecanismo de reserva que evita selecionar um evento mais recente de uma carteira enquanto existir um evento anterior não publicado.

Reservas têm validade temporal, permitindo recuperação após encerramento de publishers.

Em cenários extremos, a expiração de uma reserva durante uma publicação em andamento pode resultar em envios repetidos. Consumidores downstream devem ser idempotentes por `eventId`.

## 8. Segurança

A API HTTP utiliza autenticação por API Key compartilhada, enviada no header `x-api-key`.

A chave é configurada por variável de ambiente e não deve ser incluída no repositório.

O acesso normal ao PostgreSQL utiliza uma role restrita, com permissões específicas para cada tabela e coluna. Migrations e tarefas administrativas são executadas separadamente.

O ledger possui proteção contra alterações destrutivas. Inbox e Outbox têm restrições de atualização e exclusão.

Em um ambiente AWS real, o acesso ao SQS deve ser controlado por credenciais e permissões IAM apropriadas. As credenciais locais do LocalStack não representam uma configuração de segurança de produção.

## 9. Observabilidade e auditoria

`bun run ops:status` apresenta dados operacionais de Outbox, referências pendentes, filas SQS e triggers de proteção.

`bun run ops:audit` verifica consistência de saldos, aritmética, duplicidades, referências e correspondência semântica entre transações e lançamentos.

As contagens do SQS são aproximadas. A reconciliação financeira depende dos dados transacionais do PostgreSQL, não de métricas das filas.

## 10. Estratégia de testes

A implementação possui testes unitários, testes de integração com PostgreSQL, testes de infraestrutura SQS usando LocalStack e um teste E2E distribuído.

Na validação anterior à preparação da entrega, foram aprovados 57 testes unitários e 58 de integração, totalizando 115 testes.

O E2E verifica uma BET recebida por SQS, deduplicação pela Inbox, persistência financeira, publicação pela Outbox, recebimento do resultado e reconciliação do saldo.

Também foram realizados testes de redelivery, DLQ, falhas simuladas de publicação e renovação de visibilidade.

O histórico de migrations foi aplicado em um banco vazio para verificar a reconstrução do esquema.

## 11. Limitações conhecidas

**Autenticação:** a API Key é compartilhada. Não existem usuários individuais, RBAC, autorização por carteira, rate limiting específico de cliente nem rotação automatizada de chaves.

**Ledger:** os lançamentos possuem verificações aritméticas e de integridade, mas não uma sequência monotônica explícita por carteira para demonstrar toda a ordem histórica de movimentação.

**Modelo de resultados:** a vinculação obrigatória de WIN e LOSS a uma BET específica não foi implementada como requisito geral do contrato atual.

**Mensageria:** a entrega de eventos pode ser repetida. A deduplicação do consumidor de resultados é responsabilidade do sistema que receber esses eventos.

**DLQ:** existe tratamento de falha e encaminhamento às filas de mensagens problemáticas, mas não um procedimento automático de redrive seguro.

**Operação:** o ambiente demonstrativo utiliza Docker Compose e LocalStack. Não inclui orquestração de produção, autoscaling, monitoramento centralizado ou alertas externos.

**Desempenho:** testes funcionais e de concorrência não equivalem a um benchmark de capacidade. Qualquer resultado de carga deve informar ambiente, metodologia e medições reais.

## 12. Concorrência entre múltiplas instâncias

O comando `bun run test:multi-instance` executa dois processos Bun independentes, cada um com sua própria instância do MikroORM e conexões PostgreSQL, disputando a mesma carteira.

O cenário utiliza uma carteira com saldo inicial de R$ 50,00 e realiza 82 solicitações BET de R$ 1,00, incluindo uma mesma chave de idempotência enviada pelas duas instâncias.

O teste verifica ausência de saldo negativo, ausência de lost updates, persistência de uma única transação para a chave compartilhada, quantidade correta de lançamentos financeiros e consistência da auditoria.

A sincronização financeira depende dos locks e constraints do PostgreSQL, não de mutexes em memória no processo.

O experimento valida a concorrência entre processos independentes na camada de processamento financeiro. Não substitui um teste de duas instâncias completas da API HTTP atrás de um balanceador.

## 13. Considerações finais

A arquitetura privilegia segurança dos registros financeiros, previsibilidade das transações e recuperação de falhas em detrimento da simplicidade operacional absoluta.

A principal escolha foi manter a consistência financeira no PostgreSQL e tratar a mensageria como um mecanismo de entrega potencialmente repetida.

Essa separação permite demonstrar idempotência e recuperação sem depender de garantias irreais de exactly once entre banco de dados e SQS.
