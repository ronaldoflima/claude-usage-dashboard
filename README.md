# Claude · Ritmo de Uso

Dashboard local para acompanhar os limites do plano Claude e entender quais
sessões/modelos concentraram o uso em um intervalo de tempo.

## O que ele lê

- `~/.claude/projects/**/*.jsonl`: somente metadados, timestamps, modelo e
  contadores de tokens. Prompts, respostas e chamadas de ferramentas não são
  persistidos nem enviados ao navegador.
- `~/.claude/.credentials.json`: o token OAuth fica no processo local e é usado
  exclusivamente para consultar `https://api.anthropic.com/api/oauth/usage`.
  O token nunca aparece na resposta HTTP do dashboard.

O percentual do plano e os horários de reset são dados oficiais retornados pela
Anthropic. Os rankings locais mostram volume de tokens e não devem ser
interpretados como uma decomposição exata do percentual do plano: a ponderação
interna da cota não é pública.

## Rodar

Requer apenas Python 3.10+ e não instala dependências.

```bash
python3 app.py
```

Abra <http://127.0.0.1:8787>. Na primeira carga, a indexação do histórico pode
levar alguns segundos; depois, somente bytes novos dos JSONL são processados.

Opções:

```bash
python3 app.py --port 9000
python3 app.py --claude-dir /outro/caminho/.claude
```

Por segurança, o padrão escuta apenas em `127.0.0.1`. Não exponha o servidor na
rede sem adicionar autenticação.

## Segurança e privacidade

- O banco SQLite, o perfil gerado, caches e arquivos de ambiente são ignorados
  pelo Git.
- O token OAuth é lido em memória e enviado somente para `api.anthropic.com`.
- O endpoint OAuth de usage é interno e não documentado; ele pode mudar sem
  aviso. O dashboard mostra um estado de erro sem expor a credencial.
- Revise o código antes de alterar o bind para um endereço de rede.

## Perfil histórico de ritmo

Gere ou atualize a curva pessoal com:

```bash
python3 build_usage_profile.py
```

O script agrega 90 dias de ciclos já encerrados em 168 faixas horárias,
alinhadas ao reset de sábado às 19h em `America/Sao_Paulo`. O ciclo atual é
excluído integralmente para não contaminar a referência. Semanas recentes têm
mais peso (meia-vida de 28 dias). O JSON agregado fica em `.cache/usage-profile.json`; nenhum conteúdo
de conversa, nome de projeto ou identificador de sessão é incluído.

O dashboard usa essa curva no limite semanal e retorna automaticamente ao ritmo
linear se o perfil não existir. Recomenda-se regenerá-lo uma vez por semana.

## Métricas

- **Tokens processados:** input + output + cache criado + cache lido.
- **Tokens novos:** input + output + cache criado.
- **Saída / thinking:** contadores reportados em cada mensagem do assistente.
- Eventos repetidos pelo log de streaming são deduplicados por sessão e
  `message.id`.
